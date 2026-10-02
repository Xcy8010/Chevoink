import dns from 'node:dns'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Agent, fetch } from 'undici'

// Conservative public egress policy. Special-purpose ranges are intentionally
// excluded, even when a particular address within one is globally reachable.
const blockedV4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(address, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const blockedV6 = new BlockList()
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) blockedV6.addSubnet(address, prefix, 'ipv6')

export function isPublicEgressAddress(address: string): boolean {
  if (address.includes('%')) return false
  const family = isIP(address)
  if (family === 4) return !blockedV4.check(address, 'ipv4')
  return family === 6 && globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6')
}

/** The checked answers ARE the socket's lookup result: no second DNS lookup. */
export const publicEgressLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error || !Array.isArray(addresses) || !addresses.length || addresses.length > 64 || addresses.some(entry =>
      !isPublicEgressAddress(entry.address) || entry.family !== isIP(entry.address))) {
      callback(Object.assign(new Error('Public address resolution rejected'), { code: 'PUBLIC_EGRESS_DENIED' }), '', 4)
      return
    }
    const filtered = options.family === 4 || options.family === 6
      ? addresses.filter(entry => entry.family === options.family) : addresses
    if (!filtered.length) {
      callback(Object.assign(new Error('No public address for requested family'), { code: 'PUBLIC_EGRESS_DENIED' }), '', 4)
      return
    }
    if (options.all) callback(null, filtered)
    else callback(null, filtered[0].address, filtered[0].family)
  })
}

export function parsePublicHttpUrl(value: string, allowHttp = false): URL {
  if (value.length > 8192) throw new Error('PUBLIC_URL_INVALID')
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if ((url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) ||
    url.username || url.password || url.port || !hostname.includes('.') ||
    isIP(hostname) || hostname.includes(':') ||
    /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(hostname)) {
    throw new Error('PUBLIC_URL_INVALID')
  }
  url.hash = ''
  return url
}

type ByteResponse = {
  headers: { get(name: string): string | null }
  body: { getReader(): {
    read(): Promise<ReadableStreamReadResult<Uint8Array>>
    cancel(): Promise<void>
    releaseLock(): void
  } } | null
}

/** Limit the decoded stream too: Content-Length may be absent, false or compressed. */
export async function readBoundedPublicBody(response: ByteResponse, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error('PUBLIC_BODY_LIMIT_INVALID')
  if (!response.body) throw new Error('PUBLIC_BODY_EMPTY')
  const reader = response.body.getReader()
  let completed = false
  try {
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) {
      throw new Error('PUBLIC_BODY_TOO_LARGE')
    }
    // A fixed byte buffer also bounds metadata overhead for one-byte chunk streams.
    const storage = Buffer.allocUnsafe(maxBytes)
    let size = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) { completed = true; break }
      if (chunk.value.byteLength > maxBytes - size) throw new Error('PUBLIC_BODY_TOO_LARGE')
      storage.set(chunk.value, size)
      size += chunk.value.byteLength
    }
    if (!size) throw new Error('PUBLIC_BODY_EMPTY')
    return Buffer.from(storage.subarray(0, size))
  } finally {
    try { if (!completed) await reader.cancel() } finally { reader.releaseLock() }
  }
}

export class PublicHttpError extends Error {
  constructor(readonly code: string, readonly status?: number, readonly retryAfter?: string | null) {
    super(code)
    this.name = 'PublicHttpError'
  }
}

/** Bounded GET with opt-in redirects. Every hop is parsed and every socket uses checked DNS. */
export async function getPublicHttpBytes(value: string, options: {
  maxBytes: number
  timeoutMs: number
  signal?: AbortSignal
  allowHttp?: boolean
  maxRedirects?: number
  acceptedContentTypes?: readonly string[]
}): Promise<{ bytes: Buffer; contentType: string; finalUrl: string }> {
  options.signal?.throwIfAborted()
  let url = parsePublicHttpUrl(value, options.allowHttp)
  const maxRedirects = options.maxRedirects ?? 0
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) throw new Error('PUBLIC_REDIRECT_LIMIT_INVALID')
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 16 * 1024 * 1024) throw new Error('PUBLIC_BODY_LIMIT_INVALID')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000) throw new Error('PUBLIC_TIMEOUT_INVALID')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('PUBLIC_FETCH_TIMEOUT')), options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const dispatcher = new Agent({
    connections: 1, pipelining: 1, maxHeaderSize: 16384, allowH2: false,
    connect: { lookup: publicEgressLookup, timeout: Math.min(options.timeoutMs, 10000) },
  })
  let response: Awaited<ReturnType<typeof fetch>> | undefined
  try {
    const visited = new Set<string>()
    for (let hop = 0; ; hop++) {
      signal.throwIfAborted()
      if (visited.has(url.href)) throw new PublicHttpError('PUBLIC_REDIRECT_LOOP')
      visited.add(url.href)
      response = await fetch(url, {
        dispatcher, redirect: 'manual', signal,
        // No Referer: a previous signed URL/query must not leak to another origin.
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', accept: '*/*', 'accept-language': 'zh-CN,zh;q=0.9' },
      })
      if ([301, 302, 303, 307, 308].includes(response.status) && maxRedirects > 0) {
        if (hop >= maxRedirects) throw new PublicHttpError('PUBLIC_REDIRECT_LIMIT')
        const location = response.headers.get('location')
        if (!location) throw new PublicHttpError('PUBLIC_REDIRECT_LOCATION_MISSING')
        const next = parsePublicHttpUrl(new URL(location, url).href, options.allowHttp)
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw new PublicHttpError('PUBLIC_REDIRECT_DOWNGRADE')
        await response.body?.cancel()
        response = undefined
        url = next
        continue
      }
      if (!response.ok) throw new PublicHttpError(`PUBLIC_HTTP_${response.status}`, response.status, response.headers.get('retry-after'))
      // Preserve charset for GBK/GB18030 decoding; media-type comparisons exclude parameters.
      const contentType = (response.headers.get('content-type') ?? '').trim().toLowerCase()
      const mediaType = contentType.split(';')[0].trim()
      if (mediaType && options.acceptedContentTypes && !options.acceptedContentTypes.includes(mediaType)) throw new PublicHttpError('PUBLIC_CONTENT_TYPE_REJECTED')
      const bytes = await readBoundedPublicBody(response, options.maxBytes)
      signal.throwIfAborted()
      return { bytes, contentType, finalUrl: url.href }
    }
  } finally {
    clearTimeout(timer)
    try { if (response?.body && !response.body.locked) await response.body.cancel() }
    finally { await dispatcher.destroy() }
  }
}
