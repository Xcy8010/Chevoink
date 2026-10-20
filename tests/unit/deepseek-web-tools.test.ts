import dns from 'node:dns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../api/config/env.js'
import { searchWeb } from '../../api/lib/web-search-service.js'
import { readPublicWebPage, WEB_READER_MAX_BYTES } from '../../api/lib/web-reader-service.js'
import { webToolEndpoint } from '../../api/lib/web-tool-provider.js'
import { extractMarkdownReaderLinks } from '../../api/lib/web-reader-markdown.js'
import type { ToolModelRuntime } from '../../api/lib/tool-model-config.js'

const config: ToolModelRuntime = { provider: 'deepseek', modelName: 'deepseek-search', baseUrl: 'https://api.deepseek.com', apiKey: 'offline-fixture-secret' }
const article = 'A well formed article about reading contracts and preserving source evidence. '.repeat(12)
const item = { title: 'Source title', url: 'https://example.com/book?id=19', snippet: 'Short display snippet', summary: 'Long model summary', content: '', site_name: 'Example' }
const transport = vi.hoisted(() => vi.fn())
vi.mock('undici', async importOriginal => ({ ...await importOriginal<typeof import('undici')>(),
  fetch: (...args: unknown[]) => transport(...args),
}))
const originalProvider = env.webSearchProvider
beforeEach(() => {
  env.webSearchProvider = 'auto'
  transport.mockReset()
  vi.stubGlobal('fetch', transport)
  vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _options: dns.LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => callback(null, [{ address: '1.1.1.1', family: 4 }])) as typeof dns.lookup)
})
afterEach(() => { env.webSearchProvider = originalProvider; vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('explicit web tool endpoints', () => {
  it.each(['https://api.deepseek.com', 'https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1/tools/search'])('resolves search endpoint %s without chat-path inference', baseUrl => {
    expect(webToolEndpoint({ ...config, baseUrl }, 'search')).toBe('https://api.deepseek.com/v1/tools/search')
  })
  it.each(['https://api.deepseek.com/chat/completions', 'https://api.deepseek.com/v1/tools/fetch', 'http://api.deepseek.com', 'https://127.0.0.1/v1', 'https://user:password@api.deepseek.com', 'https://api.deepseek.com?api_key=private', 'https://api.deepseek.com#private', 'https://api.deepseek.com:8443'])('rejects unsafe or cross-operation endpoint %s', baseUrl => {
    expect(() => webToolEndpoint({ ...config, baseUrl }, 'search')).toThrow('WEB_TOOL_ENDPOINT_INVALID')
  })
  it('rejects an unknown provider instead of treating its schema as Bocha', async () => {
    await expect(searchWeb('query', 2, undefined, { ...config, provider: 'openai' })).rejects.toThrow('WEB_TOOL_PROVIDER_UNSUPPORTED')
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('DeepSeek Search JSON contract', () => {
  it('preserves longer legacy Bocha queries rather than applying DeepSeek-specific limits globally', async () => {
    transport.mockResolvedValue(Response.json({ code: 200, data: { webPages: { value: [{ name: 'Source', url: item.url, summary: 'summary' }] } } }))
    const query = '界'.repeat(129)
    expect((await searchWeb(query, 2, undefined, { ...config, provider: 'bocha', baseUrl: 'https://api.bochaai.com/v1/web-search' })).provider).toBe('bocha')
    expect(JSON.parse(transport.mock.calls[0][1].body).query).toBe(query)
  })
  it('sends the documented request and maps results[] with summary, public filtering and deduplication', async () => {
    transport.mockResolvedValue(Response.json({ results: [item, item, { ...item, url: 'http://127.0.0.1/private' }] }, { headers: { 'x-request-id': 'request-19' } }))
    const outcome = await searchWeb('public query', 2, undefined, config)
    expect(outcome).toMatchObject({ provider: 'deepseek', results: [{ title: item.title, url: item.url, snippet: item.summary, source: 'Example' }],
      attempts: [expect.objectContaining({ provider: 'deepseek', outcome: 'results', httpStatus: 200, providerRequestId: 'request-19' })] })
    expect(transport).toHaveBeenCalledOnce()
    const [endpoint, options] = transport.mock.calls[0]
    expect(endpoint).toBe('https://api.deepseek.com/v1/tools/search')
    expect(JSON.parse(options.body)).toEqual({ query: 'public query', count: 2, need_content: false })
    expect(options.headers.Authorization).toBe('Bearer offline-fixture-secret')
    expect(options.redirect).toBe('error')
    expect(options.dispatcher.destroyed).toBe(true)
    expect(JSON.stringify(outcome)).not.toContain(config.apiKey)
  })
  it.each([{ results: 'invalid' }, { data: { results: [] } }, { results: [{ title: 'bad', url: item.url }] }, { error: { message: 'private-secret-provider-prose' } }, { results: [{ ...item, url: 'https://localhost/private' }] }])('retains failed-attempt evidence for malformed/unsafe response %j', async payload => {
    transport.mockResolvedValueOnce(Response.json(payload)).mockImplementation(async () => new Response('private-secret-provider-prose', { status: 503 }))
    const error = await searchWeb('query', 2, undefined, config).catch((error: unknown) => error)
    expect(error).toMatchObject({ attempts: [expect.objectContaining({ provider: 'deepseek', outcome: 'failed' }),
      expect.objectContaining({ provider: 'sogou', outcome: 'failed' }), expect.objectContaining({ provider: 'bing', outcome: 'failed' })] })
    expect(JSON.stringify(error)).not.toContain('private-secret-provider-prose')
  })
  it('keeps genuinely empty search evidence if fallback fails', async () => {
    transport.mockResolvedValueOnce(Response.json({ results: [] })).mockImplementation(async () => new Response('', { status: 503 }))
    expect(await searchWeb('query', 2, undefined, config)).toMatchObject({ provider: 'deepseek', results: [], attempts: [expect.objectContaining({ outcome: 'empty' }), expect.anything(), expect.anything()] })
  })
  it.each([' ', '界'.repeat(129)])('rejects invalid query before dispatch', async query => {
    await expect(searchWeb(query, 2, undefined, config)).rejects.toThrow('WEB_SEARCH_QUERY_INVALID')
    expect(transport).not.toHaveBeenCalled()
  })
  it('counts the documented limit as Unicode characters', async () => {
    transport.mockResolvedValue(Response.json({ results: [item] }))
    expect((await searchWeb('😀'.repeat(128), 2, undefined, config)).provider).toBe('deepseek')
  })
})

describe('independent DeepSeek Fetch contract', () => {
  it('rejects source-proven deletion before persistence without another provider or guessed repair', async () => {
    const target = { title: '河谷纪事', author: '林青' }
    const original = Array.from({ length: 18 }, (_, index) => `第${index + 1}次清晨观察记录了水位，村民逐一核对木桩编号，随后带着不同意见返回村庄。`).join('\n\n')
    const metadata = { '@type': 'Chapter', articleBody: original, isPartOf: { '@type': 'Book', name: target.title, author: target.author } }
    transport.mockResolvedValueOnce(new Response(`<script type="application/ld+json">${JSON.stringify(metadata)}</script><script src="app.js"></script>`, { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(Response.json({ title: `${target.title}第1章`, content: original.replaceAll('逐一核对', '') }))
    const result = await readPublicWebPage('https://example.com/chapter/1', new AbortController().signal, config, target)
    expect(result).toMatchObject({ status: 'unreadable', code: 'WEB_READ_INCOMPLETE', text: '', quality: { readable: false },
      evidence: { identity: { status: 'verified' }, integrity: { status: 'damaged', code: 'SOURCE_TEXT_DELETION' } } })
    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport.mock.calls.filter(([url]) => String(url).includes('/tools/fetch'))).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain(config.apiKey)
  })
  it('uses already-readable verified public chapter text without buying a provider extraction', async () => {
    const target = { title: '河谷纪事', author: '林青' }
    const metadata = { '@type': 'Chapter', articleBody: article, isPartOf: { '@type': 'Book', name: target.title, author: target.author } }
    transport.mockResolvedValue(new Response(`<title>河谷纪事第1章</title><script type="application/ld+json">${JSON.stringify(metadata)}</script><article><h1>清晨</h1><p>${article}</p></article>`, { headers: { 'content-type': 'text/html' } }))
    expect(await readPublicWebPage('https://example.com/chapter/1', new AbortController().signal, config, target))
      .toMatchObject({ status: 'ok', provider: 'direct', evidence: { identity: { status: 'verified', pageType: 'chapter' }, integrity: { status: 'source_compared' } } })
    expect(transport).toHaveBeenCalledOnce()
    expect(transport.mock.calls[0][1].headers).not.toHaveProperty('Authorization')
  })
  it('stops on an ordinary direct-source access gate before purchasing a provider extraction', async () => {
    transport.mockResolvedValue(new Response('denied', { status: 403 }))
    expect(await readPublicWebPage('https://example.com/chapter/1', new AbortController().signal, config, { title: '河谷纪事' }))
      .toMatchObject({ status: 'blocked', provider: 'direct', code: 'WEB_READ_BLOCKED' })
    expect(transport).toHaveBeenCalledOnce()
    expect(transport.mock.calls[0][1].headers).not.toHaveProperty('Authorization')
  })
  it('honors direct-source rate limiting and Retry-After before any paid provider dispatch', async () => {
    transport.mockResolvedValue(new Response('limited', { status: 429, headers: { 'retry-after': '120' } }))
    expect(await readPublicWebPage('https://example.com/chapter/1', new AbortController().signal, config, { title: '河谷纪事' }))
      .toMatchObject({ status: 'transient_error', provider: 'direct', code: 'WEB_READ_RATE_LIMITED', retryable: true, retryAfter: '120' })
    expect(transport).toHaveBeenCalledOnce()
    expect(transport.mock.calls[0][1].headers).not.toHaveProperty('Authorization')
  })
  it('sends only the target URL, extracts real links and preserves metadata classification', async () => {
    transport.mockResolvedValue(Response.json({ title: 'Book details', content: `# Book details\n\n${article}\n[Chapter 1](/reader/987)\n[Private](http://127.0.0.1/private)\n[Other](https://other.example/chapter)` }))
    const result = await readPublicWebPage('https://fanqienovel.com/page/123', new AbortController().signal, { ...config, modelName: 'deepseek-fetch' })
    expect(result).toMatchObject({ status: 'ok', provider: 'deepseek', title: 'Book details', contentKind: 'metadata', links: [{ url: 'https://fanqienovel.com/reader/987', title: 'Chapter 1' }] })
    const [endpoint, options] = transport.mock.calls[0]
    expect(endpoint).toBe('https://api.deepseek.com/v1/tools/fetch')
    expect(JSON.parse(options.body)).toEqual({ url: 'https://fanqienovel.com/page/123' })
    expect(options.redirect).toBe('error')
    expect(options.dispatcher.destroyed).toBe(true)
  })
  it.each([{ markdown: article }, { title: 'Bad', content: {} }, { title: 'Bad' }])('rejects malformed successful responses %j', async payload => {
    transport.mockResolvedValue(Response.json(payload))
    expect(await readPublicWebPage(item.url, new AbortController().signal, config)).toMatchObject({ code: 'WEB_READ_PROVIDER_PROTOCOL_ERROR', status: 'unreadable', text: '', retryable: false })
    expect(transport).toHaveBeenCalledOnce()
  })
  it.each([[401, 'WEB_READ_PROVIDER_401', false], [402, 'WEB_READ_PROVIDER_402', false], [403, 'WEB_READ_BLOCKED', false],
    [404, 'WEB_READ_HOSTED_NO_CONTENT', false], [429, 'WEB_READ_RATE_LIMITED', true], [503, 'WEB_READ_HOSTED_UNAVAILABLE', true]] as const)('reports HTTP %i explicitly without a silent reader retry', async (status, code, retryable) => {
    transport.mockResolvedValue(new Response('private-secret-provider-prose', { status, headers: { 'retry-after': '30' } }))
    const result = await readPublicWebPage(item.url, new AbortController().signal, config)
    expect(result).toMatchObject({ code, provider: 'deepseek', text: '', retryable })
    expect(JSON.stringify(result)).not.toContain('private-secret-provider-prose')
    expect(transport).toHaveBeenCalledOnce()
  })
  it.each(['http://127.0.0.1/private', 'https://example.com/chapter?signature=private', 'https://sec.douban.com/c?r=article'])('rejects restricted target %s before provider dispatch', async url => {
    expect((await readPublicWebPage(url, new AbortController().signal, config)).status).not.toBe('ok')
    expect(transport).not.toHaveBeenCalled()
  })
  it('rejects private DNS answers before sending the target to the vendor', async () => {
    vi.mocked(dns.lookup).mockImplementation(((_host: string, _options: dns.LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => callback(null, [{ address: '127.0.0.1', family: 4 }])) as typeof dns.lookup)
    expect(await readPublicWebPage(item.url, new AbortController().signal, config)).toMatchObject({ code: 'WEB_READ_UNSAFE_URL', status: 'blocked' })
    expect(transport).not.toHaveBeenCalled()
  })
  it('bounds a successful provider body and does not fall back on oversize', async () => {
    transport.mockResolvedValue(new Response('x'.repeat(WEB_READER_MAX_BYTES + 1)))
    expect(await readPublicWebPage(item.url, new AbortController().signal, config)).toMatchObject({ code: 'WEB_READ_TOO_LARGE', text: '' })
    expect(transport).toHaveBeenCalledOnce()
  })
  it('propagates cancellation and never retries', async () => {
    const controller = new AbortController()
    transport.mockImplementation(async () => { controller.abort(new Error('fixture stop')); throw controller.signal.reason })
    await expect(readPublicWebPage(item.url, controller.signal, config)).rejects.toThrow('fixture stop')
    expect(transport).toHaveBeenCalledOnce()
  })
  it('times out a stalled Fetch request without starting another reader or leaving a timer', async () => {
    vi.useFakeTimers()
    try {
      transport.mockImplementation(async (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
      }))
      const pending = readPublicWebPage(item.url, new AbortController().signal, config)
      await vi.advanceTimersByTimeAsync(12000)
      expect(await pending).toMatchObject({ code: 'WEB_READ_HOSTED_UNAVAILABLE', status: 'transient_error', retryable: true })
      expect(transport).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('does not discover Markdown examples inside code or images', () => {
    expect(extractMarkdownReaderLinks('`[fake](/reader/fake)`\n![image](/reader/image)\n[real][book]\n\n[book]: /reader/real', 'https://example.com/page/1'))
      .toEqual([{ url: 'https://example.com/reader/real', title: 'real' }])
  })
})
