import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import iconv from 'iconv-lite'
import { createHash } from 'node:crypto'
import { assessReaderEvidence, assessReaderText, extractReaderHtml, extractReaderNavigationHtml } from '../../api/lib/web-reader-quality.js'
import { PublicHttpError } from '../../api/lib/public-http.js'
import { readPublicWebNavigation, readPublicWebPage, WEB_READER_MAX_BYTES } from '../../api/lib/web-reader-service.js'

const mocks = vi.hoisted(() => ({ get: vi.fn(), runtime: vi.fn(), provider: vi.fn(), hosted: vi.fn() }))
vi.mock('../../api/lib/public-http.js', async original => ({ ...await original<object>(), getPublicHttpBytes: mocks.get }))
vi.mock('../../api/lib/tool-model-config.js', async original => ({ ...await original<object>(), getToolModelRuntime: mocks.runtime }))
vi.mock('../../api/lib/web-tool-provider.js', async original => ({ ...await original<object>(), requestWebTool: mocks.provider }))
vi.mock('undici', async original => ({ ...await original<object>(), fetch: mocks.hosted }))

const url = 'https://publisher.example/books/source?from=list', target = { title: '霜河档案', author: '周禾' }
const metadata = `<meta property="og:type" content="book"><meta property="og:title" content="${target.title}"><meta name="author" content="${target.author}">`
const ld = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`
const book = { '@type': 'Book', name: target.title, author: { '@type': 'Person', name: target.author } }
const html = (body = '<nav><a href="/chapters/first">第一章 冰河</a></nav>', head = metadata) => `<html><head><title>${target.title}</title>${head}</head><body>${body}</body></html>`
const response = (source: string, finalUrl = url, contentType = 'text/html; charset=utf-8') => ({ bytes: Buffer.from(source), finalUrl, contentType })
const read = (source: string, expected = target) => {
  mocks.get.mockResolvedValueOnce(response(source))
  return readPublicWebNavigation(url, new AbortController().signal, expected)
}

beforeEach(() => { Object.values(mocks).forEach(mock => mock.mockReset()); mocks.runtime.mockResolvedValue(null) })
afterEach(() => { vi.restoreAllMocks() })

describe('public metadata navigation without provider dispatch', () => {
  it.each([429, 503])('retains an observed HTTP %s refusal independently of transport uncertainty', async status => {
    mocks.get.mockRejectedValueOnce(new PublicHttpError(`PUBLIC_HTTP_${status}`, status))
    expect(await readPublicWebPage(url, new AbortController().signal, null)).toMatchObject({ status: 'transient_error', httpStatus: status, retryable: true })
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.hosted).not.toHaveBeenCalled()
  })
  it('keeps a response-less connection failure distinct from an HTTP refusal', async () => {
    mocks.get.mockRejectedValueOnce(new PublicHttpError('PUBLIC_FETCH_TIMEOUT'))
    const result = await readPublicWebPage(url, new AbortController().signal, null)
    expect(result).toMatchObject({ status: 'transient_error', code: 'WEB_READ_UNAVAILABLE' })
    expect(result.httpStatus).toBeUndefined()
  })
  it('uses one bounded ordinary GET and preserves genuinely short metadata as metadata only', async () => {
    const controller = new AbortController(), source = html()
    mocks.get.mockResolvedValueOnce(response(source))
    const result = await readPublicWebNavigation(url, controller.signal, target)
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(url, { signal: controller.signal, timeoutMs: 12000, maxBytes: WEB_READER_MAX_BYTES,
      allowHttp: true, maxRedirects: 5, acceptedContentTypes: ['text/html', 'application/xhtml+xml'] })
    expect(result).toMatchObject({ status: 'ok', code: 'WEB_READ_OK', finalUrl: url, provider: 'direct', retryable: false,
      purpose: 'navigation', contentKind: 'metadata', evidence: { identity: { status: 'verified', title: target.title, author: target.author,
        pageType: 'book', basis: 'structured_metadata' }, integrity: { status: 'unverified', code: 'METADATA_ONLY' } },
      links: [{ url: 'https://publisher.example/chapters/first', title: '第一章 冰河' }] })
    expect(result.text.length).toBeLessThan(150)
    expect(assessReaderText(result.text).code).toBe('WEB_READ_INSUFFICIENT')
    expect(result.evidence!.integrity).toEqual({ status: 'unverified', code: 'METADATA_ONLY', extractedHash: createHash('sha256').update(result.text).digest('hex') })
    expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.hosted).not.toHaveBeenCalled()
  })

  it.each(['Book', 'Novel'])('accepts explicit %s source metadata without treating its description as prose', async kind => {
    const description = '这是来源说明，不是章节正文。', result = await read(html(`<main>${description}</main>`, ld({ ...book, '@type': kind, description })))
    expect(result).toMatchObject({ status: 'ok', contentKind: 'metadata', evidence: { identity: { status: 'verified', pageType: 'book' } } })
    expect(result.text).not.toContain(description)
  })

  it('accepts a WebPage whose explicit main entity is the book', async () => {
    expect(await read(html('<main>公开作品目录</main>', ld({ '@type': 'WebPage', mainEntity: book }))))
      .toMatchObject({ status: 'ok', evidence: { identity: { status: 'verified', pageType: 'book' } } })
  })

  it('does not add standard OG recognition to the old evidence or ordinary reader branch', async () => {
    const source = html(), previous = assessReaderEvidence('', target.title, target, source, url)
    expect(previous.identity).toMatchObject({ status: 'unknown', pageType: 'unknown' })
    expect(previous.identity).not.toHaveProperty('title')
    expect(assessReaderEvidence('', target.title, target, source, url, 'navigation').identity).toMatchObject({ status: 'verified', pageType: 'book' })
    mocks.get.mockResolvedValueOnce(response(source))
    const ordinary = await readPublicWebPage(url, new AbortController().signal, null, target)
    expect(ordinary).not.toHaveProperty('purpose'); expect(ordinary).not.toHaveProperty('canonicalUrl')
    expect(ordinary.status).not.toBe('ok')
    expect(ordinary.evidence?.identity).toEqual(previous.identity)
  })

  it.each(['different author', 'different title', 'different source host'])('retains the existing identity mismatch for %s', async scenario => {
    const expected = scenario === 'different author' ? { ...target, author: '陈舟' } : scenario === 'different title' ? { ...target, title: '霜河档案续篇' }
      : { ...target, sourceHosts: ['other.example'] }
    expect(await read(html(), expected)).toMatchObject({ evidence: { identity: { status: 'mismatch' }, integrity: { code: 'METADATA_ONLY' } } })
  })

  it('never promotes a review naming the book and a chapter to book or chapter body', async () => {
    const comment = '读者评论：霜河档案第一章的结构很好。'.repeat(20)
    const result = await read(html(`<article><h1>霜河档案 第一章书评</h1>${comment}</article>`, metadata.replace('content="book"', 'content="article"')
      + ld({ '@type': 'Review', itemReviewed: book, reviewBody: comment })))
    expect(result).toMatchObject({ status: 'ok', purpose: 'navigation', contentKind: 'metadata',
      evidence: { identity: { pageType: 'unknown' }, integrity: { status: 'unverified', code: 'METADATA_ONLY' } } })
    expect(result.text).not.toContain(comment)
  })

  it('keeps a bare chapter title and author mention unknown without a structured book object', async () => {
    const result = await read('<html><head><title>霜河档案第2章 读者讨论</title></head><body><p>作者是周禾。</p></body></html>')
    expect(result).toMatchObject({ status: 'ok', contentKind: 'metadata', evidence: { identity: { status: 'unknown', pageType: 'unknown' } } })
    expect(result.evidence!.identity).not.toHaveProperty('title')
    expect(result.text).toBe('页面标题：霜河档案第2章 读者讨论')
  })

  it.each(['\ue123', '\u{f0123}', '\ufffd'])('retains independent legal metadata and directory while omitting opaque glyph %s', async glyph => {
    const source = html(`<main><div>${glyph.repeat(500)}</div><nav><a href="/chapters/first">第一章 冰河</a><a href="/chapters/unreadable">${glyph.repeat(12)}</a></nav></main>`)
    expect(extractReaderHtml(source).code).toBe('WEB_READ_GARBLED')
    const result = await read(source)
    expect(result).toMatchObject({ status: 'ok', purpose: 'navigation', quality: { privateUseRatio: 0, replacementRatio: 0 },
      links: [{ url: 'https://publisher.example/chapters/first', title: '第一章 冰河' }] })
    expect(result.text).not.toContain(glyph)
    expect(JSON.stringify(result.evidence)).not.toContain(glyph)
  })

  it.each(['', '<script>window.readerPayload="not public prose"</script>', '<html><title>\ue123</title><a href="/one">\ue123</a></html>'])('requires usable actual metadata or links: %j', async source => {
    expect(await read(source)).toMatchObject({ status: 'unreadable', code: 'WEB_READ_INSUFFICIENT', text: '', purpose: 'navigation', contentKind: 'metadata' })
    expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.hosted).not.toHaveBeenCalled()
  })

  it('permits a link-only page and bounds returned metadata text and links', async () => {
    const result = await read(`<html><body>${Array.from({ length: 4100 }, (_, i) => `<a href="/chapter/${i}">${'章节'.repeat(100)}${i}</a>`).join('')}</body></html>`)
    expect(result.status).toBe('ok'); expect(result.links).toHaveLength(4096); expect(result.text.length).toBeLessThan(8000)
    expect(result.evidence!.identity).toMatchObject({ status: 'unknown', pageType: 'unknown' })
  })

  it('preserves charset decoding with the same bounded bytes', async () => {
    const source = html()
    mocks.get.mockResolvedValueOnce({ ...response(source, url, 'text/html; charset=gb18030'), bytes: iconv.encode(source, 'gb18030') })
    expect(await readPublicWebNavigation(url, new AbortController().signal, target)).toMatchObject({ status: 'ok', evidence: { identity: { title: target.title, author: target.author } } })
  })
})

describe('actual public same-origin navigation relations', () => {
  it('preserves the actual canonical relation without replacing the final URL or synthesizing book IDs', async () => {
    const result = await read(html('<a href="/chapter/7?from=toc#heading">第7章</a><a href="/books/canonical">作品页</a>', metadata
      + '<link rel="canonical" href="/books/canonical#top">'))
    expect(result.finalUrl).toBe(url)
    expect(result.canonicalUrl).toBe('https://publisher.example/books/canonical')
    expect(result.links).toEqual([{ url: 'https://publisher.example/books/canonical', title: 'canonical关系' },
      { url: 'https://publisher.example/chapter/7?from=toc', title: '第7章' }])
    expect(result.links?.some(link => /reader|page\/\d/u.test(link.url))).toBe(false)
  })

  it.each(['https://other.example/books/one', 'http://127.0.0.1/internal', 'http://localhost/', 'javascript:run()',
    'https://name:secret@publisher.example/books/one', 'https://publisher.example:8443/one', 'http://publisher.example/one'])('ignores unsafe or cross-origin canonical declarations: %s', async href => {
    const result = await read(html('<a href="/chapter/1">第1章</a>', metadata + `<link rel="canonical" href="${href}">`))
    expect(result).not.toHaveProperty('canonicalUrl')
    expect(result.links).toEqual([{ url: 'https://publisher.example/chapter/1', title: '第1章' }])
  })

  it('does not discover script, private, credentialed, hidden or off-origin anchors', async () => {
    const result = await read(html('<a href="/chapter/1">第1章</a><a href="/books/source?from=list#anchor">本页</a>'
      + '<a href="javascript:run()">脚本</a><a href="https://other.example/chapter/1">外站</a><a href="http://127.0.0.1/internal">内网</a>'
      + '<a href="https://user:secret@publisher.example/one">凭据</a><a href="/hidden" hidden>隐藏</a><a href="/empty"></a>'))
    expect(result.links).toEqual([{ url: 'https://publisher.example/chapter/1', title: '第1章' }])
  })

  it('resolves a real same-origin base and rejects relative links whose actual base is cross-origin', async () => {
    expect((await read(html('<a href="chapter/1">第1章</a>', metadata + '<base href="/actual/">'))).links)
      .toEqual([{ url: 'https://publisher.example/actual/chapter/1', title: '第1章' }])
    const result = await read(html('<a href="chapter/1">外站相对</a><a href="https://publisher.example/real">实际同源</a>', metadata
      + '<base href="https://other.example/"><link rel="canonical" href="relative">'))
    expect(result).not.toHaveProperty('canonicalUrl')
    expect(result.links).toEqual([{ url: 'https://publisher.example/real', title: '实际同源' }])
  })
})

describe('navigation preserves access and failure boundaries', () => {
  it.each(['请先登录后阅读本章', '必须在APP内阅读本章', '本章为SVIP专享内容', '订阅后才能阅读', '请完成安全验证', 'Sign in to continue',
    '<form><input type="password"></form>', '<form><input name="captcha"></form>'])('rejects an actual main-content gate despite valid book metadata: %s', async gate => {
    expect(await read(html(`<main><h1>${target.title}</h1><p>${gate}</p></main>`))).toMatchObject({ status: 'blocked', code: 'WEB_READ_BLOCKED', text: '', contentKind: 'metadata', purpose: 'navigation' })
  })

  it.each(['下载APP阅读更方便，VIP可使用书签。', '这一页介绍APP、SVIP、登录与验证码的设计。'])('does not equate an incidental promotion or mention with access requirements: %s', async mention => {
    expect(await read(html(`<header><form><input type="password"></form></header><main><h1>${target.title}</h1><p>${mention}</p><nav><a href="/chapter/1">第1章</a></nav></main>`)))
      .toMatchObject({ status: 'ok', links: [{ url: 'https://publisher.example/chapter/1', title: '第1章' }] })
  })

  it('ignores a site-wide app download banner while retaining a public directory', async () => {
    expect(await read(html('<aside><p>请下载APP阅读全文</p></aside><main><h1>作品目录</h1><nav><a href="/chapter/1">第1章</a></nav></main>')))
      .toMatchObject({ status: 'ok', contentKind: 'metadata', links: [{ url: 'https://publisher.example/chapter/1', title: '第1章' }] })
  })

  it('preserves soft-404 and explicit title gates', async () => {
    expect(await read(html('<main><h1>404 Not Found</h1></main>'))).toMatchObject({ status: 'not_found', code: 'WEB_READ_NOT_FOUND', text: '' })
    expect(await read(html().replace(`<title>${target.title}</title>`, '<title>访问受限</title>'))).toMatchObject({ status: 'blocked', text: '' })
  })

  it('recognizes a leaf main-content access requirement alongside a long opaque body', async () => {
    expect(await read(html(`<main><div>${'\ue123'.repeat(1000)}</div><section><div>必须在APP内阅读本章</div></section></main>`)))
      .toMatchObject({ status: 'blocked', code: 'WEB_READ_BLOCKED', text: '' })
  })

  it.each([
    [new PublicHttpError('PUBLIC_HTTP_403', 403), 'blocked', 'WEB_READ_BLOCKED'],
    [new PublicHttpError('PUBLIC_HTTP_404', 404), 'not_found', 'WEB_READ_NOT_FOUND'],
    [new PublicHttpError('PUBLIC_BODY_TOO_LARGE'), 'unreadable', 'WEB_READ_TOO_LARGE'],
    [new PublicHttpError('PUBLIC_CONTENT_TYPE_REJECTED'), 'unreadable', 'WEB_READ_UNSUPPORTED_TYPE'],
    [new PublicHttpError('PUBLIC_EGRESS_DENIED'), 'blocked', 'WEB_READ_UNSAFE_URL'],
    [new PublicHttpError('PUBLIC_REDIRECT_DOWNGRADE'), 'blocked', 'WEB_READ_UNSAFE_URL'],
    [new PublicHttpError('PUBLIC_FETCH_TIMEOUT'), 'transient_error', 'WEB_READ_UNAVAILABLE'],
  ] as const)('keeps existing public transport failure %s', async (error, status, code) => {
    mocks.get.mockRejectedValueOnce(error)
    expect(await readPublicWebNavigation(url, new AbortController().signal)).toMatchObject({ status, code, text: '', contentKind: 'metadata', purpose: 'navigation' })
    expect(mocks.get).toHaveBeenCalledTimes(1); expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.hosted).not.toHaveBeenCalled()
  })

  it('rejects non-HTML and complex documents without provider fallback', async () => {
    mocks.get.mockResolvedValueOnce(response('{"name":"not HTML"}', url, 'application/json'))
    expect(await readPublicWebNavigation(url, new AbortController().signal)).toMatchObject({ code: 'WEB_READ_UNSUPPORTED_TYPE', status: 'unreadable' })
    expect(extractReaderNavigationHtml(html('<main>' + '<span>字</span>'.repeat(20001) + '</main>'), url)).toMatchObject({ code: 'WEB_READ_COMPLEX_DOCUMENT', text: '' })
    expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.hosted).not.toHaveBeenCalled()
  })

  it('propagates abort before dispatch and after receiving bytes', async () => {
    const controller = new AbortController(); controller.abort(new Error('offline stop'))
    await expect(readPublicWebNavigation(url, controller.signal)).rejects.toThrow('offline stop')
    expect(mocks.get).not.toHaveBeenCalled()
    const late = new AbortController()
    mocks.get.mockImplementationOnce(async () => { late.abort(new Error('after bytes')); return response(html()) })
    await expect(readPublicWebNavigation(url, late.signal)).rejects.toThrow('after bytes')
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })
})
