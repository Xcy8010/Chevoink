import dns from 'node:dns'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../api/config/env.js'
import { webReadTool } from '../../api/lib/agent/tools/search-tools.js'
import { readPublicWebPage } from '../../api/lib/web-reader-service.js'
import iconv from 'iconv-lite'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const transport = vi.hoisted(() => vi.fn())
vi.mock('../../api/lib/billing/web-tool-calls.js', () => ({
  findWebToolCallOutcome: vi.fn(async () => null), saveWebToolCacheOutcome: vi.fn(async () => {}),
  executeWebToolCall: vi.fn(async (_ctx, _kind, _request, _paid, dispatch) => dispatch()),
  refundCancelledWebToolCall: vi.fn(async () => {}),
}))
vi.mock('../../api/lib/tool-model-config.js', async original => ({ ...await original<object>(), getToolModelRuntime: vi.fn(async () => null) }))
const stored = vi.hoisted(() => ({ page: null as import('../../api/lib/web-reader-service.js').WebReadResult | null,
  find: vi.fn(), failure: vi.fn(), recordFailure: vi.fn(), save: vi.fn() }))
// Transport/quality unit cases isolate storage; task ACL and immutable windows
// are exercised against real PostgreSQL in agent-research-sources.test.ts.
vi.mock('../../api/lib/agent/research-sources.js', async original => ({
  ...await original<typeof import('../../api/lib/agent/research-sources.js')>(),
  reserveResearchRequest: vi.fn(async () => true),
  settleResearchRequest: vi.fn(async () => {}),
  recordResearchReadOutcome: vi.fn(async () => {}),
  recordResearchWindow: vi.fn(async () => {}),
  assertResearchUrlProvenance: vi.fn(async () => {}),
  getResearchReadTarget: vi.fn(async () => undefined),
  findSavedResearchContent: vi.fn(async () => null),
  registerResearchSources: async (_scope: unknown, links: Array<{ url: string; title: string }>) => links.map((link, index) => ({ id: `link-${index}`, canonicalUrl: link.url })),
  registerResearchSource: async (_scope: unknown, url: string) => ({ id: 'fixture-source', canonicalUrl: url }),
  resolveResearchSource: vi.fn(),
  findResearchSource: stored.find,
  getResearchReadFailure: stored.failure,
  recordResearchReadFailure: stored.recordFailure,
  saveResearchContent: async (_scope: unknown, _source: string, page: import('../../api/lib/web-reader-service.js').WebReadResult) => {
    await stored.save()
    stored.page = page
    return { id: 'fixture-content', revision: 'a'.repeat(64) }
  },
  readResearchContent: async () => {
    const page = stored.page!
    return { sourceId: 'fixture-source', contentRef: 'fixture-content', revision: 'a'.repeat(64),
      finalUrl: page.finalUrl, provider: page.provider, contentKind: page.contentKind, links: page.links ?? [], text: page.text.slice(0, 6000),
      evidence: page.evidence,
      returnedRange: { start: 0, end: Math.min(page.text.length, 6000), total: page.text.length },
      truncated: page.text.length > 6000, nextCursor: page.text.length > 6000 ? '6000' : null }
  },
}))
vi.mock('undici', async original => ({ ...await original<typeof import('undici')>(), fetch: transport }))
const originalFallback = env.webReaderFallback
const originalFirecrawlKey = env.webReaderFirecrawlApiKey
const ctx = (): ToolContext => ({ userId: 'fixture', novelId: 'fixture', chapterId: null,
  sessionId: 'fixture', runId: randomUUID(), callId: randomUUID(), mode: 'build',
  creativeFreedom: 'balanced', qualityMode: 'premium', emit: vi.fn(), signal: new AbortController().signal })
const article = '春天的山谷逐渐回暖，河水穿过村庄流向远处。居民修整道路，准备下一季的种植工作。'
async function fixtureLookup(_host: string, options?: number | dns.LookupOptions): Promise<dns.LookupAddress | dns.LookupAddress[]> {
  const address = { address: '1.1.1.1', family: 4 }
  return typeof options === 'object' && options.all ? [address] : address
}
beforeEach(() => {
  stored.find.mockReset().mockResolvedValue(null)
  stored.save.mockReset()
  stored.failure.mockReset().mockResolvedValue(null)
  stored.recordFailure.mockReset().mockResolvedValue(undefined)
  env.webReaderFallback = 'off'
  vi.stubGlobal('fetch', transport)
  vi.spyOn(dns.promises, 'lookup').mockImplementation(fixtureLookup as typeof dns.promises.lookup)
  vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _options: dns.LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => callback(null, [{ address: '1.1.1.1', family: 4 }])) as typeof dns.lookup)
})
afterEach(() => { env.webReaderFallback = originalFallback; env.webReaderFirecrawlApiKey = originalFirecrawlKey; vi.restoreAllMocks(); vi.unstubAllGlobals(); transport.mockReset() })

describe('web_read trustworthy outcomes', () => {
  it('refunds a cancellation arriving after fetch completes while saved content is being persisted', async () => {
    const { refundCancelledWebToolCall } = await import('../../api/lib/billing/web-tool-calls.js')
    const controller = new AbortController()
    const context = { ...ctx(), signal: controller.signal }
    transport.mockResolvedValueOnce(new Response(article.repeat(15), { headers: { 'content-type': 'text/plain; charset=utf-8' } }))
    stored.save.mockImplementationOnce(async () => { controller.abort(new Error('late fetch stop')) })
    await expect(webReadTool.execute(context, { url: 'https://example.com/chapter' })).rejects.toThrow('late fetch stop')
    expect(refundCancelledWebToolCall).toHaveBeenCalledWith(context, 'fetch', { url: 'https://example.com/chapter', sourceId: null, refresh: false })
  })
  it('recognizes a Douban security redirect and never sends it to a hosted reader', async () => {
    env.webReaderFallback = 'jina'
    transport.mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'https://sec.douban.com/c?r=article' } }))
    transport.mockResolvedValueOnce(new Response('<html><title>豆瓣</title><script src="challenge.js"></script><body>请完成验证</body></html>', { headers: { 'content-type': 'text/html' } }))
    expect(await readPublicWebPage('https://www.douban.com/note/1/', new AbortController().signal))
      .toMatchObject({ status: 'blocked', code: 'WEB_READ_BLOCKED', text: '', provider: 'direct' })
    expect(transport).toHaveBeenCalledTimes(2)
  })
  it('releases a fetch reservation cancelled before network dispatch', async () => {
    const { reserveResearchRequest, settleResearchRequest } = await import('../../api/lib/agent/research-sources.js')
    const controller = new AbortController()
    const context = { ...ctx(), signal: controller.signal }
    vi.mocked(reserveResearchRequest).mockImplementationOnce(async () => { controller.abort(new Error('cancel during reservation')); return true })
    await expect(webReadTool.execute(context, { url: 'https://example.com/chapter' })).rejects.toThrow('cancel during reservation')
    expect(settleResearchRequest).toHaveBeenCalledWith(context, 'released')
    expect(transport).not.toHaveBeenCalled()
  })
  it('reuses a saved page without fetching or spending quota, but permits explicit refresh', async () => {
    const { findSavedResearchContent } = await import('../../api/lib/agent/research-sources.js')
    const context = ctx()
    stored.find.mockResolvedValue({ id: 'fixture-source', canonicalUrl: 'https://example.com/chapter' })
    transport.mockImplementation(async () => new Response(`<article><p>${article.repeat(8)}</p></article>`, { headers: { 'content-type': 'text/html' } }))
    await webReadTool.execute(context, { url: 'https://example.com/chapter' })
    for (let index = 0; index < 10; index++) {
      vi.mocked(findSavedResearchContent).mockResolvedValueOnce({ id: 'fixture-content', revision: 'a'.repeat(64) })
      const result = await webReadTool.execute(context, { url: 'https://example.com/chapter' })
      expect(result.output).toContain('本次未重新联网')
    }
    expect(transport).toHaveBeenCalledOnce()
    await webReadTool.execute(context, { url: 'https://example.com/chapter', refresh: true })
    expect(transport).toHaveBeenCalledTimes(2)
    stored.failure.mockResolvedValue({ code: 'WEB_READ_NOT_FOUND', retryAt: '2099-01-01T00:00:00.000Z' })
    vi.mocked(findSavedResearchContent).mockResolvedValueOnce({ id: 'fixture-content', revision: 'a'.repeat(64) })
    const restored = await webReadTool.execute(context, { url: 'https://example.com/chapter' })
    expect(restored.output).toContain('本次未重新联网')
    await expect(webReadTool.execute(context, { url: 'https://example.com/chapter', refresh: true }))
      .rejects.toMatchObject({ code: 'WEB_READ_NOT_FOUND' })
    expect(transport).toHaveBeenCalledTimes(2)
  })
  it('labels Fanqie book/keyword pages as metadata, not chapter text, and returns their actual links', async () => {
    transport.mockResolvedValue(new Response(`<article><h1>作品介绍</h1><p>${article.repeat(8)}</p><a href="/reader/987">第1章</a></article>`, { headers: { 'content-type': 'text/html' } }))
    const result = await webReadTool.execute(ctx(), { url: 'https://fanqienovel.com/keyword/123' })
    expect(stored.page?.contentKind).toBe('metadata')
    expect(result.output).toContain('https://fanqienovel.com/reader/987')
    expect(result.output).toContain('sourceId: link-0')
  })
  it('refuses an undiscovered research URL before fetching or consuming the network budget', async () => {
    const { assertResearchUrlProvenance } = await import('../../api/lib/agent/research-sources.js')
    const { DataAccessError } = await import('../../api/lib/prisma.js')
    vi.mocked(assertResearchUrlProvenance).mockRejectedValueOnce(new DataAccessError(422, 'WEB_READ_UNDISCOVERED_URL', 'unobserved link'))
    await expect(webReadTool.execute(ctx(), { url: 'https://www.xs599.com/novel/12345.html' }))
      .rejects.toMatchObject({ code: 'WEB_READ_UNDISCOVERED_URL' })
    expect(transport).not.toHaveBeenCalled()
  })
  it('does not fetch or spend fetch quota on a cached denial', async () => {
    const context = ctx()
    stored.find.mockResolvedValue({ id: 'fixture-source', canonicalUrl: 'https://example.com/chapter' })
    stored.failure.mockResolvedValue({ code: 'WEB_READ_BLOCKED', retryAt: '2099-01-01T00:00:00.000Z' })
    for (let index = 0; index < 10; index++) {
      await expect(webReadTool.execute(context, { url: 'https://example.com/chapter' })).rejects.toMatchObject({ code: 'WEB_READ_BLOCKED' })
    }
    expect(transport).not.toHaveBeenCalled()
    stored.failure.mockResolvedValue(null)
    transport.mockResolvedValue(new Response(`<article><p>${article.repeat(8)}</p></article>`, { headers: { 'content-type': 'text/html' } }))
    await expect(webReadTool.execute(context, { url: 'https://example.com/chapter' })).resolves.toHaveProperty('output')
    expect(transport).toHaveBeenCalledOnce()
  })
  it.each([200, 403, 404])('uses Firecrawl target status %i rather than provider HTTP 200 as proof', async statusCode => {
    env.webReaderFallback = 'firecrawl'
    env.webReaderFirecrawlApiKey = 'fixture-not-a-real-key'
    transport.mockResolvedValueOnce(new Response('<script src="app.js"></script>'))
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { markdown: article.repeat(8), metadata: { statusCode, title: '水渠观察' } } }), { headers: { 'content-type': 'application/json' } }))
    const result = await readPublicWebPage('https://example.com/chapter', new AbortController().signal)
    expect(result.status).toBe(statusCode === 200 ? 'ok' : statusCode === 403 ? 'blocked' : 'not_found')
    const [endpoint, options] = transport.mock.calls[1]
    expect(endpoint).toBe('https://api.firecrawl.dev/v1/scrape')
    expect(options.headers.Authorization).toBe('Bearer fixture-not-a-real-key')
    expect(options.redirect).toBe('manual')
    expect(transport.mock.calls[0][1].headers).not.toHaveProperty('Authorization')
    expect(options.dispatcher.destroyed).toBe(true)
  })
  it('rejects malformed hosted business responses without treating them as target text', async () => {
    env.webReaderFallback = 'firecrawl'
    env.webReaderFirecrawlApiKey = 'fixture-not-a-real-key'
    transport.mockResolvedValueOnce(new Response('<script src="app.js"></script>'))
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, data: { markdown: article.repeat(8) } })))
    const result = await readPublicWebPage('https://example.com/chapter', new AbortController().signal)
    expect(result.status).toBe('transient_error')
    expect(result.code).toBe('WEB_READ_HOSTED_UNAVAILABLE')
    expect(result.text).toBe('')
  })
  it('does not promote a Fanqie book introduction to chapter text after hosted extraction', async () => {
    env.webReaderFallback = 'firecrawl'
    env.webReaderFirecrawlApiKey = 'fixture-not-a-real-key'
    transport.mockResolvedValueOnce(new Response('<script src="app.js"></script><a href="/reader/987">第1章</a>'))
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { markdown: article.repeat(8), metadata: { statusCode: 200 } } })))
    const result = await readPublicWebPage('https://fanqienovel.com/page/123', new AbortController().signal)
    expect(result).toMatchObject({ status: 'ok', contentKind: 'metadata', provider: 'firecrawl' })
    expect(result.links).toContainEqual({ url: 'https://fanqienovel.com/reader/987', title: '第1章' })
  })
  it('preserves hosted rate-limit delay rather than disguising it as empty content', async () => {
    env.webReaderFallback = 'jina'
    transport.mockResolvedValueOnce(new Response('<script src="app.js"></script>'))
    transport.mockResolvedValueOnce(new Response('limited', { status: 429, headers: { 'retry-after': '3600' } }))
    const result = await readPublicWebPage('https://example.com/chapter', new AbortController().signal)
    expect(result).toMatchObject({ status: 'transient_error', code: 'WEB_READ_RATE_LIMITED', provider: 'jina', retryable: true, retryAfter: '3600', text: '' })
    expect(transport).toHaveBeenCalledTimes(2)
  })
  it.each([401, 403, 404, 410, 429, 451, 500])('classifies HTTP %i and never uses hosted fallback for it', async status => {
    env.webReaderFallback = 'jina'
    transport.mockResolvedValue(new Response('denied', { status, headers: { 'retry-after': '30' } }))
    const result = await readPublicWebPage('https://example.com/chapter', new AbortController().signal)
    expect(result.status).toBe([401, 403, 451].includes(status) ? 'blocked' : [404, 410].includes(status) ? 'not_found' : 'transient_error')
    expect(result.retryable).toBe(status === 429 || status === 500)
    if (status === 429) expect(result.retryAfter).toBe('30')
    expect(transport).toHaveBeenCalledOnce()
  })
  it('preserves quoted GB18030 headers including supplementary Chinese characters', async () => {
    const text = `春日的村庄𠮷祥安宁。${article.repeat(8)}`
    transport.mockResolvedValue(new Response(iconv.encode(`<article><p>${text}</p></article>`, 'gb18030'), { headers: { 'content-type': 'text/html; charset="gb18030"' } }))
    const result = await readPublicWebPage('https://example.com/chapter', new AbortController().signal)
    expect(result.status).toBe('ok')
    expect(result.text).toContain(text)
  })
  it('marks JSON as metadata rather than chapter text and rejects business errors', async () => {
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ title: '书目信息', description: article.repeat(8) }), { headers: { 'content-type': 'application/json' } }))
    const result = await webReadTool.execute(ctx(), { url: 'https://example.com/meta' })
    expect(result.output).toContain('目录、简介或结构化元数据（不是章节正文）')
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: article.repeat(8) }), { headers: { 'content-type': 'application/json' } }))
    await expect(webReadTool.execute(ctx(), { url: 'https://example.com/meta' })).rejects.toMatchObject({ code: 'WEB_READ_SOURCE_ERROR' })
  })
  it('does not call hosted Reader for a PUA page even if enabled', async () => {
    env.webReaderFallback = 'jina'
    transport.mockResolvedValue(new Response(`<article>${'\ue123'.repeat(400)}</article><script src="a.js"></script>`, { headers: { 'content-type': 'text/html' } }))
    await expect(webReadTool.execute(ctx(), { url: 'https://example.com/chapter' })).rejects.toMatchObject({ code: 'WEB_READ_GARBLED' })
    expect(transport).toHaveBeenCalledOnce()
  })
  it('uses the existing opt-in hosted path only for a public JS shell and checks its body', async () => {
    env.webReaderFallback = 'jina'
    transport.mockResolvedValueOnce(new Response('<div id="root"></div><script src="app.js"></script>', { headers: { 'content-type': 'text/html' } }))
    transport.mockResolvedValueOnce(new Response(`Title: 春日村庄\nURL Source: https://example.com/chapter\n\nMarkdown Content:\n${article.repeat(8)}`))
    const result = await readPublicWebPage('https://example.com/chapter', new AbortController().signal)
    expect(result.status).toBe('ok')
    expect(result.provider).toBe('jina')
    expect(result.text).toBe(article.repeat(8))
    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport.mock.calls[1][0]).toBe('https://r.jina.ai/https://example.com/chapter')
    expect(transport.mock.calls[1][1].redirect).toBe('manual')
    expect(transport.mock.calls[1][1].dispatcher.destroyed).toBe(true)
  })
  it('distinguishes a hosted provider error from a missing target chapter', async () => {
    env.webReaderFallback = 'jina'
    transport.mockResolvedValueOnce(new Response('<script src="app.js"></script>'))
    transport.mockResolvedValueOnce(new Response('provider unavailable', { status: 404 }))
    const result = await readPublicWebPage('https://example.com/chapter', new AbortController().signal)
    expect(result.status).toBe('transient_error')
    expect(result.code).toBe('WEB_READ_HOSTED_UNAVAILABLE')
  })
  it('rejects a target access warning inside a successful hosted envelope', async () => {
    env.webReaderFallback = 'jina'
    transport.mockResolvedValueOnce(new Response('<script src="app.js"></script>'))
    transport.mockResolvedValueOnce(new Response(`Title: Chapter\nWarning: Target URL returned error 403: Forbidden\nMarkdown Content:\n${article.repeat(8)}`))
    const result = await readPublicWebPage('https://example.com/chapter', new AbortController().signal)
    expect(result.status).toBe('blocked')
    expect(result.text).toBe('')
  })
  it('does not delegate signed URLs to third parties', async () => {
    env.webReaderFallback = 'jina'
    transport.mockResolvedValueOnce(new Response('<script src="app.js"></script>'))
    const result = await readPublicWebPage('https://example.com/chapter?signature=private', new AbortController().signal)
    expect(result.code).toBe('WEB_READ_HOSTED_TARGET_RESTRICTED')
    expect(transport).toHaveBeenCalledOnce()
  })
  it('rejects cancellation without issuing a request or reporting success', async () => {
    const controller = new AbortController()
    controller.abort(new Error('fixture stop'))
    await expect(webReadTool.execute({ ...ctx(), signal: controller.signal }, { url: 'https://example.com/chapter' })).rejects.toThrow('fixture stop')
    expect(transport).not.toHaveBeenCalled()
  })
  it('makes truncation and the current-page scope explicit', async () => {
    transport.mockResolvedValue(new Response(`<article><p>${article.repeat(200)}</p></article>`, { headers: { 'content-type': 'text/html' } }))
    const result = await webReadTool.execute(ctx(), { url: 'https://example.com/chapter' })
    expect(result.summary).toContain('片段')
    expect(result.output).toContain('尚有后续内容')
    expect(result.output).toContain('offset=6000')
  })
  it.each([
    { label: 'private use glyphs', code: 'WEB_READ_GARBLED', html: `<article><h1>第一章</h1><p>${'\ue123\ue456'.repeat(200)}</p></article>` },
    { label: 'replacement glyphs', code: 'WEB_READ_GARBLED', html: `<article><p>${'\ufffd'.repeat(300)}</p></article>` },
    { label: 'login wall', code: 'WEB_READ_BLOCKED', html: `<title>登录后阅读</title><main><h1>请登录后继续阅读</h1>${'<p>请登录后继续阅读，暂时无法访问本章节正文。</p>'.repeat(20)}<form><input type="password"></form></main>` },
    { label: 'soft 404', code: 'WEB_READ_NOT_FOUND', html: `<title>404 - 页面不存在</title><h1>页面不存在</h1>${'<p>你请求的章节已被删除，返回首页查看推荐内容。</p>'.repeat(20)}` },
    { label: 'navigation only', code: 'WEB_READ_INSUFFICIENT', html: `<header>网站目录</header><nav>${Array.from({ length: 40 }, (_, i) => `<a href="/c/${i}">第${i}章 故事章节目录 下一章</a>`).join('')}</nav>` },
  ])('does not mark $label as a successful read', async ({ html, code }) => {
    transport.mockResolvedValue(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    await expect(webReadTool.execute(ctx(), { url: 'https://example.com/chapter' })).rejects.toMatchObject({ code })
  })
  it('does not buffer an oversized HTML body before checking its size', async () => {
    transport.mockResolvedValue(new Response(`<article>${article.repeat(50000)}</article>`, { headers: { 'content-type': 'text/html' } }))
    await expect(webReadTool.execute(ctx(), { url: 'https://example.com/chapter' })).rejects.toMatchObject({ code: 'WEB_READ_TOO_LARGE' })
  })
  it('retains a legitimate article', async () => {
    transport.mockResolvedValue(new Response(`<article><h1>春日村庄</h1><p>${article.repeat(8)}</p></article>`, { headers: { 'content-type': 'text/html' } }))
    const result = await webReadTool.execute(ctx(), { url: 'https://example.com/chapter' })
    expect(result.output).toContain(article)
    expect(result.summary).toContain('已读取')
  })
})
