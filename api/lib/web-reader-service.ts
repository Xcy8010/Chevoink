import { Agent, fetch } from 'undici'
import { env } from '../config/env.js'
import { decodeWebPageBuffer } from './html-extract.js'
import { getPublicHttpBytes, parsePublicHttpUrl, publicEgressLookup, PublicHttpError, readBoundedPublicBody } from './public-http.js'
import { assessReaderText, assessReaderEvidence, extractReaderHtml, extractReaderLinks, extractReaderNavigationHtml, type ReaderQualityResult, type ReaderEvidence, type ReaderTarget } from './web-reader-quality.js'
import { getToolModelRuntime, ToolModelConfigurationError, type ToolModelRuntime } from './tool-model-config.js'
import { requestWebTool, webToolEndpoint } from './web-tool-provider.js'
import { extractMarkdownReaderLinks } from './web-reader-markdown.js'

export const WEB_READER_MAX_BYTES = 2 * 1024 * 1024
export type WebReadResult = Omit<ReaderQualityResult, 'status'> & {
  status: ReaderQualityResult['status'] | 'transient_error'
  finalUrl: string
  provider: 'direct' | 'jina' | 'firecrawl' | 'deepseek'
  retryable: boolean
  retryAfter?: string | null
  /** An observed response status distinguishes refusal from transport unknown. */
  httpStatus?: number
  contentKind: 'article' | 'metadata'
  purpose?: 'navigation'
  canonicalUrl?: string
  links?: Array<{ url: string; title: string }>
  evidence?: ReaderEvidence
}

/** Ordinary public GET only. Navigation cannot activate configured paid tools
 * or hosted readers, nor attest that metadata/commentary is a chapter body. */
export async function readPublicWebNavigation(value: string, signal: AbortSignal, expectedTarget?: ReaderTarget): Promise<WebReadResult> {
  signal.throwIfAborted()
  let finalUrl = value
  const navigation = (result: WebReadResult): WebReadResult => ({ ...result, contentKind: 'metadata', purpose: 'navigation' })
  try {
    const page = await getPublicHttpBytes(value, { signal, timeoutMs: 12000, maxBytes: WEB_READER_MAX_BYTES,
      allowHttp: true, maxRedirects: 5, acceptedContentTypes: ['text/html', 'application/xhtml+xml'] })
    finalUrl = page.finalUrl
    signal.throwIfAborted()
    if (!['text/html', 'application/xhtml+xml'].includes(page.contentType.split(';')[0].trim())) return navigation(failure('WEB_READ_UNSUPPORTED_TYPE', finalUrl))
    let outcome: ReturnType<typeof extractReaderNavigationHtml>
    try { outcome = extractReaderNavigationHtml(decodeWebPageBuffer(page.bytes, page.contentType), finalUrl, expectedTarget) }
    catch { return navigation(failure('WEB_READ_PARSE_ERROR', finalUrl)) }
    signal.throwIfAborted()
    return navigation({ ...outcome, finalUrl, provider: 'direct', retryable: false, contentKind: 'metadata' })
  } catch (error) {
    signal.throwIfAborted()
    return navigation(networkFailure(error, finalUrl))
  }
}

function failure(code: string, finalUrl: string, status: ReaderQualityResult['status'] = 'unreadable'): WebReadResult {
  return { ...assessReaderText(''), status, code, finalUrl, provider: 'direct', retryable: false, contentKind: 'article' }
}

function networkFailure(error: unknown, finalUrl: string): WebReadResult {
  const codes: string[] = []
  let current = error
  for (let i = 0; i < 5 && current && typeof current === 'object'; i++) {
    if ('code' in current && typeof current.code === 'string') codes.push(current.code)
    if ('message' in current && typeof current.message === 'string') codes.push(current.message)
    current = 'cause' in current ? current.cause : undefined
  }
  if (codes.includes('PUBLIC_BODY_TOO_LARGE')) return failure('WEB_READ_TOO_LARGE', finalUrl)
  if (codes.some(code => /PUBLIC_URL_INVALID|PUBLIC_EGRESS_DENIED|PUBLIC_REDIRECT_DOWNGRADE|ERR_INVALID_URL/.test(code))) return failure('WEB_READ_UNSAFE_URL', finalUrl, 'blocked')
  if (codes.includes('PUBLIC_CONTENT_TYPE_REJECTED')) return failure('WEB_READ_UNSUPPORTED_TYPE', finalUrl)
  if (error instanceof PublicHttpError) {
    if (error.status === 404 || error.status === 410) return failure('WEB_READ_NOT_FOUND', finalUrl, 'not_found')
    if (error.status === 401 || error.status === 403 || error.status === 451) return failure('WEB_READ_BLOCKED', finalUrl, 'blocked')
    if (error.status === 429) return { ...failure('WEB_READ_RATE_LIMITED', finalUrl), status: 'transient_error', retryable: true, retryAfter: error.retryAfter, httpStatus: error.status }
    if (error.status && error.status < 500) return failure('WEB_READ_HTTP_ERROR', finalUrl)
    if (error.status && error.status >= 500) return { ...failure('WEB_READ_UNAVAILABLE', finalUrl), status: 'transient_error', retryable: true, httpStatus: error.status }
  }
  return { ...failure('WEB_READ_UNAVAILABLE', finalUrl), status: 'transient_error', retryable: true }
}

function checkHostedTarget(url: URL, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    publicEgressLookup(url.hostname, { all: true }, error => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else if (error) reject(error)
      else resolve()
    })
  })
}

function hostedTargetFailure(status: number): ReaderQualityResult | null {
  if (status >= 200 && status < 300) return null
  const result = assessReaderText('')
  if (status === 404 || status === 410) return { ...result, status: 'not_found', code: 'WEB_READ_NOT_FOUND' }
  if ([401, 403, 451].includes(status)) return { ...result, status: 'blocked', code: 'WEB_READ_BLOCKED' }
  return { ...result, code: status === 429 ? 'WEB_READ_RATE_LIMITED' : 'WEB_READ_SOURCE_ERROR' }
}

/** Provider endpoints are fixed, never taken from the model. No provider redirects. */
async function readHosted(url: URL, provider: 'jina' | 'firecrawl', external: AbortSignal): Promise<ReaderQualityResult & { retryAfter?: string | null; httpStatus?: number }> {
  external.throwIfAborted()
  // Provider-side resolution cannot be pinned by this client. Reject unsafe targets
  // locally as well; the configured vendor remains responsible for its own egress.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('HOSTED_READER_TIMEOUT')), 8000)
  const signal = AbortSignal.any([external, controller.signal])
  const dispatcher = new Agent({ connections: 1, maxHeaderSize: 16384, allowH2: false, connect: { lookup: publicEgressLookup, timeout: 8000 } })
  let response: Awaited<ReturnType<typeof fetch>> | undefined
  try {
    await checkHostedTarget(url, signal)
    signal.throwIfAborted()
    const endpoint = provider === 'jina' ? `https://r.jina.ai/${url.href}` : 'https://api.firecrawl.dev/v1/scrape'
    const headers: Record<string, string> = provider === 'jina' ? { 'X-Respond-With': 'markdown' } : { 'Content-Type': 'application/json' }
    const key = provider === 'jina' ? env.webReaderJinaApiKey : env.webReaderFirecrawlApiKey
    if (key) headers.Authorization = `Bearer ${key}`
    response = await fetch(endpoint, {
      dispatcher, signal, redirect: 'manual', headers,
      method: provider === 'jina' ? 'GET' : 'POST',
      body: provider === 'firecrawl' ? JSON.stringify({ url: url.href, formats: ['markdown'] }) : undefined,
    })
    if (response.status === 429) return { ...assessReaderText(''), code: 'WEB_READ_RATE_LIMITED', retryAfter: response.headers.get('retry-after'), httpStatus: response.status }
    if (!response.ok) return { ...assessReaderText(''), code: 'WEB_READ_HOSTED_UNAVAILABLE', httpStatus: response.status }
    const raw = (await readBoundedPublicBody(response, WEB_READER_MAX_BYTES)).toString('utf8')
    let text = raw, title = ''
    if (provider === 'firecrawl') {
      const payload: unknown = JSON.parse(raw)
      if (!payload || typeof payload !== 'object' || !('success' in payload) || payload.success !== true || !('data' in payload) || !payload.data || typeof payload.data !== 'object' || !('markdown' in payload.data) || typeof payload.data.markdown !== 'string') throw new Error('HOSTED_READER_PROTOCOL_ERROR')
      if ('metadata' in payload.data && payload.data.metadata && typeof payload.data.metadata === 'object') {
        const metadata = payload.data.metadata
        if ('statusCode' in metadata) {
          if (typeof metadata.statusCode !== 'number' || !Number.isInteger(metadata.statusCode)) throw new Error('HOSTED_READER_PROTOCOL_ERROR')
          const denied = hostedTargetFailure(metadata.statusCode)
          if (denied) return denied
        }
        if ('error' in metadata && metadata.error) throw new Error('HOSTED_READER_PROTOCOL_ERROR')
        if ('title' in metadata && typeof metadata.title === 'string') title = metadata.title.slice(0, 300)
      }
      text = payload.data.markdown
    } else {
      // Jina's plain format may include a metadata envelope, not part of the body.
      const marker = text.indexOf('Markdown Content:')
      if (marker >= 0) {
        const preamble = text.slice(0, marker)
        title = (preamble.match(/^Title:\s*(.*)$/m)?.[1] ?? '').slice(0, 300)
        const targetError = preamble.match(/(?:Target URL returned error|status code|HTTP)\s*:?\s*(401|403|404|410|429|451|5\d\d)/i)
        if (targetError) return hostedTargetFailure(Number(targetError[1]))!
        text = text.slice(marker + 'Markdown Content:'.length)
      }
    }
    signal.throwIfAborted()
    return assessReaderText(text.replace(/^#{1,6}\s+/gm, ''), title)
  } finally {
    clearTimeout(timer)
    try { if (response?.body && !response.body.locked) await response.body.cancel() }
    finally { await dispatcher.destroy() }
  }
}

async function readDeepSeek(value: string, configured: ToolModelRuntime, external: AbortSignal, expectedTarget?: ReaderTarget): Promise<WebReadResult> {
  const provider = 'deepseek' as const
  const fail = (code: string, retryable = false, status: WebReadResult['status'] = 'unreadable'): WebReadResult =>
    ({ ...failure(code, value), provider, retryable, status })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('HOSTED_READER_TIMEOUT')), 12000)
  const signal = AbortSignal.any([external, controller.signal])
  try {
    const endpoint = webToolEndpoint(configured, 'fetch')
    const target = parsePublicHttpUrl(value, true)
    if (target.hostname === 'sec.douban.com' && /^\/c(?:\/|$)/.test(target.pathname)) return fail('WEB_READ_BLOCKED', false, 'blocked')
    if ([...target.searchParams.keys()].some(key => /token|secret|signature|credential|auth|api.?key/i.test(key))) return fail('WEB_READ_HOSTED_TARGET_RESTRICTED')
    await checkHostedTarget(target, signal)
    // One ordinary public GET may corroborate a named-work extraction. This is
    // not a reader/provider retry: it uses the same bounded call and never
    // solves a challenge, decodes protected glyphs or changes network identity.
    let sourceHtml: string | undefined
    let sourceFinalUrl = target.href
    let sourceLinks: Array<{ url: string; title: string }> = []
    if (expectedTarget) {
      try {
        const source = await getPublicHttpBytes(target.href, { signal, timeoutMs: 5000, maxBytes: WEB_READER_MAX_BYTES,
          allowHttp: true, maxRedirects: 5, acceptedContentTypes: ['text/html', 'application/xhtml+xml', 'text/plain'] })
        const sourceUrl = new URL(source.finalUrl)
          sourceFinalUrl = source.finalUrl
        if (sourceUrl.hostname === 'sec.douban.com' && /^\/c(?:\/|$)/.test(sourceUrl.pathname)) return failure('WEB_READ_BLOCKED', source.finalUrl, 'blocked')
        if (source.contentType.startsWith('text/html') || source.contentType.startsWith('application/xhtml+xml')) {
          sourceHtml = decodeWebPageBuffer(source.bytes, source.contentType)
          const sourceQuality = extractReaderHtml(sourceHtml, false)
          if (['WEB_READ_GARBLED', 'WEB_READ_BLOCKED', 'WEB_READ_NOT_FOUND'].includes(sourceQuality.code)) {
            return { ...sourceQuality, provider: 'direct', finalUrl: source.finalUrl, contentKind: 'article', retryable: false }
          }
          sourceLinks = extractReaderLinks(sourceHtml, source.finalUrl)
          const sourceEvidence = assessReaderEvidence(sourceQuality.text, sourceQuality.title, expectedTarget, sourceHtml, source.finalUrl)
          if (sourceQuality.status === 'ok' && sourceEvidence.identity.status === 'verified'
            && sourceEvidence.identity.pageType === 'chapter' && sourceEvidence.integrity.status === 'source_compared') {
            return { ...sourceQuality, provider: 'direct', finalUrl: source.finalUrl, contentKind: 'article', retryable: false,
              evidence: sourceEvidence, links: extractReaderLinks(sourceHtml, source.finalUrl) }
          }
        }
      } catch (error) {
        signal.throwIfAborted()
        const sourceFailure = networkFailure(error, target.href)
        if (['blocked', 'not_found'].includes(sourceFailure.status) || ['WEB_READ_TOO_LARGE', 'WEB_READ_RATE_LIMITED'].includes(sourceFailure.code)) return sourceFailure
        // An unavailable direct representation proves neither absence nor
        // corruption. Keep provider evidence explicitly unverified.
      }
    }
    const request = await requestWebTool(endpoint, configured.apiKey, { url: target.href }, signal)
    try {
      const { response } = request
      if (!response.ok) {
        // Provider 404 means no extractable content, not proof the target is missing.
        if (response.status === 403) return fail('WEB_READ_BLOCKED', false, 'blocked')
        if (response.status === 404) return fail('WEB_READ_HOSTED_NO_CONTENT')
        if ([400, 401, 402].includes(response.status)) return fail(`WEB_READ_PROVIDER_${response.status}`)
        const retryable = [408, 429].includes(response.status) || response.status >= 500
        return { ...fail(response.status === 429 ? 'WEB_READ_RATE_LIMITED' : 'WEB_READ_HOSTED_UNAVAILABLE', retryable,
          retryable ? 'transient_error' : 'unreadable'), retryAfter: response.headers.get('retry-after'), httpStatus: response.status }
      }
      const payload: unknown = JSON.parse((await readBoundedPublicBody(response, WEB_READER_MAX_BYTES)).toString('utf8'))
      if (!payload || typeof payload !== 'object' || !('title' in payload) || typeof payload.title !== 'string' ||
        !('content' in payload) || typeof payload.content !== 'string') return fail('WEB_READ_PROVIDER_PROTOCOL_ERROR')
      signal.throwIfAborted()
      const quality = assessReaderText(payload.content.replace(/^#{1,6}\s+/gm, ''), payload.title.slice(0, 300))
      const evidence = assessReaderEvidence(quality.text, quality.title, expectedTarget, sourceHtml, sourceFinalUrl)
      if (quality.status === 'ok' && evidence.integrity.status === 'damaged') {
        return { ...quality, status: 'unreadable', code: 'WEB_READ_INCOMPLETE', text: '', quality: { ...quality.quality, readable: false },
          evidence, provider, retryable: false, finalUrl: target.href, contentKind: 'article' }
      }
      const bookMetadata = /^(?:www\.)?fanqienovel\.com$/i.test(target.hostname) && /^\/(?:page|keyword)\//i.test(target.pathname)
      const sourceLinkUrls = new Set(sourceLinks.map(link => link.url))
      return { ...quality, provider, retryable: false, finalUrl: target.href, contentKind: bookMetadata ? 'metadata' : 'article',
        evidence,
        ...(quality.status === 'ok' ? { links: [...sourceLinks, ...extractMarkdownReaderLinks(payload.content, target.href)
          .filter(link => !sourceLinkUrls.has(link.url))].slice(0, 4096) } : {}) }
    } finally { await request.close() }
  } catch (error) {
    external.throwIfAborted()
    if (error instanceof ToolModelConfigurationError) return fail(error.code)
    if (error instanceof SyntaxError) return fail('WEB_READ_PROVIDER_PROTOCOL_ERROR')
    const denied = networkFailure(error, value)
    if (['WEB_READ_UNSAFE_URL', 'WEB_READ_TOO_LARGE'].includes(denied.code)) return { ...denied, provider }
    return fail('WEB_READ_HOSTED_UNAVAILABLE', true, 'transient_error')
  } finally { clearTimeout(timer) }
}

export async function readPublicWebPage(value: string, signal: AbortSignal, configuredInput?: ToolModelRuntime | null, expectedTarget?: ReaderTarget): Promise<WebReadResult> {
  signal.throwIfAborted()
  let configured: ToolModelRuntime | null
  try { configured = configuredInput === undefined ? await getToolModelRuntime('tool:web-fetch') : configuredInput }
  catch (error) {
    if (error instanceof ToolModelConfigurationError) return failure(error.code, value)
    throw error
  }
  signal.throwIfAborted()
  if (configured) return readDeepSeek(value, configured, signal, expectedTarget)
  let finalUrl = value
  try {
    const page = await getPublicHttpBytes(value, {
      signal, timeoutMs: 12000, maxBytes: WEB_READER_MAX_BYTES, allowHttp: true, maxRedirects: 5,
      acceptedContentTypes: ['text/html', 'application/xhtml+xml', 'text/plain', 'application/json', 'application/xml', 'text/xml'],
    })
    finalUrl = page.finalUrl
    // A successful HTTP redirect to a known challenge endpoint is not an
    // article. Never send this access gate to a hosted reader as a JS shell.
    const destination = new URL(finalUrl)
    if (destination.hostname === 'sec.douban.com' && /^\/c(?:\/|$)/.test(destination.pathname)) {
      return failure('WEB_READ_BLOCKED', finalUrl, 'blocked')
    }
    const isJson = page.contentType.split(';')[0].trim() === 'application/json'
    const raw = decodeWebPageBuffer(page.bytes, page.contentType)
    let outcome: ReaderQualityResult
    if (isJson) {
      let payload: unknown
      try { payload = JSON.parse(raw) } catch { return failure('WEB_READ_PROTOCOL_ERROR', finalUrl) }
      if (payload && typeof payload === 'object' && (('error' in payload && payload.error) || ('success' in payload && payload.success === false))) return failure('WEB_READ_SOURCE_ERROR', finalUrl)
      outcome = assessReaderText(JSON.stringify(payload))
    } else if (page.contentType.startsWith('text/plain')) outcome = assessReaderText(raw)
    else {
      try { outcome = extractReaderHtml(raw, env.webReadUseReadability) }
      catch { return failure('WEB_READ_PARSE_ERROR', finalUrl) }
    }
    signal.throwIfAborted()
    const pageUrl = new URL(finalUrl)
    const bookMetadata = /^(?:www\.)?fanqienovel\.com$/i.test(pageUrl.hostname) && /^\/(?:page|keyword)\//i.test(pageUrl.pathname)
    const direct: WebReadResult = { ...outcome, finalUrl, provider: 'direct', retryable: false, contentKind: isJson || bookMetadata ? 'metadata' : 'article',
      evidence: assessReaderEvidence(outcome.text, outcome.title, expectedTarget, !isJson && !page.contentType.startsWith('text/plain') ? raw : undefined, finalUrl),
      ...(!isJson && outcome.status === 'ok' ? { links: extractReaderLinks(raw, finalUrl) } : {}) }
    // No fallback for access gates, soft 404, garbled fonts or oversized documents.
    // Only the existing opt-in JS-shell path may ask a configured vendor.
    const mode = env.webReaderFallback
    if (outcome.code !== 'WEB_READ_INSUFFICIENT' || !/<script\b/i.test(raw) || (mode !== 'jina' && mode !== 'firecrawl')) return direct
    if (mode === 'firecrawl' && !env.webReaderFirecrawlApiKey) return direct
    const target = parsePublicHttpUrl(finalUrl, true)
    if ([...target.searchParams.keys()].some(key => /token|secret|signature|credential|auth|api.?key/i.test(key))) return { ...direct, code: 'WEB_READ_HOSTED_TARGET_RESTRICTED' }
    try {
      const hosted = await readHosted(target, mode, signal)
      return { ...hosted, ...(hosted.code === 'WEB_READ_RATE_LIMITED' ? { status: 'transient_error' as const } : {}),
        evidence: assessReaderEvidence(hosted.text, hosted.title, expectedTarget, raw, finalUrl),
        provider: mode, finalUrl, retryable: hosted.code === 'WEB_READ_RATE_LIMITED' || (hosted.httpStatus ?? 0) >= 500, contentKind: bookMetadata ? 'metadata' : 'article',
        ...(hosted.status === 'ok' ? { links: extractReaderLinks(raw, finalUrl) } : {}) }
    } catch (error) {
      signal.throwIfAborted()
      const denied = networkFailure(error, finalUrl)
      if (denied.code === 'WEB_READ_UNSAFE_URL') return denied
      return { ...direct, status: 'transient_error', code: 'WEB_READ_HOSTED_UNAVAILABLE', retryable: true }
    }
  } catch (error) {
    signal.throwIfAborted()
    return networkFailure(error, finalUrl)
  }
}
