import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bookLookupTarget, evaluateResearchSearchCandidates, quotedBookLookupQuery, searchQueryHash, type ResearchSearchTarget } from '../../api/lib/research-search-quality.js'
import { searchWeb, type WebSearchResult } from '../../api/lib/web-search-service.js'
import { env } from '../../api/config/env.js'

const target: ResearchSearchTarget = { title: '我不是戏神', author: '三九音域', sourceHosts: ['fanqienovel.com'] }
const result = (title: string, url: string, snippet = ''): WebSearchResult => ({ title, url, snippet, source: new URL(url).hostname })
const official = result('我不是戏神最新章节在线阅读_三九音域_番茄小说官网', 'https://fanqienovel.com/page/123', '作者：三九音域，作品目录。')
const derivative = result('我不是戏神：同人番外第1章', 'https://fanqienovel.com/reader/456', '作者：其他人，衍生作品。')
const secondary = result('三九音域《我不是戏神》创作访谈', 'https://news.example.com/article/42', '作品与作者的访谈，不是小说正文。')
const wrongBook = result('我不是戏神123456三九音域番茄小说', 'https://book.qq.com/kol/example', '学戏十六年，登台斩鬼神。')
const generic = [result('我（汉语汉字）_百科', 'https://baike.example.com/item/wo'), result('《我的世界》官网 Minecraft', 'https://minecraft.example.com/')]

describe('bounded research search candidate facts', () => {
  const bookGoal = '帮我联网找一下雾港长昼这本书'
  it('quotes only a standalone free search term, including titles contained in operators and URLs', () => {
    const target = { title: 'it', purpose: 'lookup' as const }
    expect(quotedBookLookupQuery('site:book.example.com/book/it it novel', target)).toBe('site:book.example.com/book/it "it" novel')
    expect(quotedBookLookupQuery('site:"book.example.com/book/it" -it edit novel', target)).toBe('site:"book.example.com/book/it" -it edit novel')
  })
  it('does not match a partial unquoted name inside a different book title', () => {
    const query = '雾港长昼 小说', target = bookLookupTarget(query, [bookGoal])
    const distinct = result('重生之雾港长昼传奇', 'https://publisher.example/book/other', '与《雾港长昼》有关')
    const correct = result('雾港长昼 - 作者访谈', 'https://publisher.example/book/right')
    expect(evaluateResearchSearchCandidates(query, [distinct, correct], target).eligibleResults).toEqual([correct])
  })
  it.each(['《雾港长昼》 青衣客 正版 小说 阅读 起点中文网', '青衣客 雾港长昼 起点中文网 作品 官方',
    'site:qidian.com/book "雾港长昼" "青衣客"', '雾港长昼 小说 青衣客 正版阅读 起点 纵横', '青衣客作品 雾港长昼 小说 阅读 官方'])('retains an unquoted author lookup across query rewrites: %s', query => {
    const target = bookLookupTarget(query, [bookGoal])
    expect(target).toEqual({ title: '雾港长昼', purpose: 'lookup' })
    expect(quotedBookLookupQuery(query, target)).toContain('"雾港长昼"')
    expect(evaluateResearchSearchCandidates(query, generic, target)).toMatchObject({ hasHardConstraints: true, eligibleCount: 0 })
  })
  it('keeps private or ambiguous titles out of outgoing queries and distinguishes a sequel from the named book', () => {
    expect(bookLookupTarget('公开资料 查找', [bookGoal])).toBeUndefined()
    expect(bookLookupTarget('《甲书》 《乙书》 小说', [])).toBeUndefined()
    expect(bookLookupTarget('帮我查一下水位这两天的变化', [])).toBeUndefined()
    const query = '雾港长昼 正版入口'
    const target = bookLookupTarget(query, [bookGoal])
    const real = result('《雾港长昼》 - 官方阅读', 'https://publisher.example.com/book/15')
    const sequel = result('《雾港长昼2》', 'https://publisher.example.com/book/17', '《雾港长昼》的续集')
    const review = result('访谈：《雾港长昼》', 'https://paper.example.org/article/42')
    expect(evaluateResearchSearchCandidates(query, [sequel, review, real], target).eligibleResults).toEqual([real])
    expect(quotedBookLookupQuery('site:publisher.example.com/book -site:other.example.org 雾港长昼 官方', target))
      .toBe('site:publisher.example.com/book -site:other.example.org "雾港长昼" 官方')
  })
  it('separates generic hits, wrong books, related secondary evidence and exact official candidates', () => {
    const chapter = result('我不是戏神第1章 赤色流星', 'https://fanqienovel.com/reader/789', '三九音域')
    const assessment = evaluateResearchSearchCandidates('site:fanqienovel.com 我不是戏神 三九音域', [...generic, wrongBook, secondary, derivative, official, chapter], target)
    expect(assessment.eligibleResults).toEqual([official, chapter])
    expect(assessment).toMatchObject({ hasHardConstraints: true, resultCount: 7, eligibleCount: 2 })
    expect(assessment.candidates[0]).toMatchObject({ eligible: false, titleMatch: 'absent', pageType: 'secondary' })
    expect(assessment.candidates[2]).toMatchObject({ eligible: false, titleMatch: 'related', pageType: 'secondary' })
    expect(assessment.candidates[3]).toMatchObject({ eligible: false, titleMatch: 'exact', pageType: 'secondary', hostMatch: false })
    expect(assessment.candidates[4]).toMatchObject({ eligible: false, titleMatch: 'related', authorMatch: 'conflicting' })
    expect(assessment.candidates[5]).toMatchObject({ eligible: true, titleMatch: 'exact', authorMatch: 'mentioned', pageType: 'book' })
  })
  it('enforces explicit site path and frozen publisher host as an intersection', () => {
    const candidates = [official, result(target.title, 'https://fanqienovel.com/pageview/123'),
      result(target.title, 'https://fanqienovel.com.evil.example/page/123'), result(target.title, 'https://evilfanqienovel.com/page/123'),
      result(target.title, 'https://www.fanqienovel.com/page/234'), result(target.title, 'https://other.example.com/page/1')]
    const assessment = evaluateResearchSearchCandidates('SITE:"fanqienovel.com/page" 我不是戏神', candidates, target)
    expect(assessment.eligibleResults).toEqual([official, candidates[4]])
    expect(assessment.candidates[1].siteMatch).toBe(false)
    expect(assessment.candidates[2].hostMatch).toBe(false)
    expect(evaluateResearchSearchCandidates('site:other.example.com 我不是戏神', [candidates[5]], target).eligibleCount).toBe(0)
  })
  it('allows a discovery candidate with unknown author but rejects an explicitly different author', () => {
    const unknown = result('我不是戏神第2章', 'https://fanqienovel.com/reader/2')
    const conflicting = { ...unknown, snippet: '作者：另一个作者，在线阅读。' }
    const assessment = evaluateResearchSearchCandidates(target.title, [unknown, conflicting], target)
    expect(assessment.candidates.map(candidate => [candidate.eligible, candidate.authorMatch])).toEqual([[true, 'unknown'], [false, 'conflicting']])
  })
  it('does not promote a quoted derivative or a chapter review to an original chapter', () => {
    const quoted = result('《我不是戏神》同人第1章', 'https://fanqienovel.com/reader/1', '三九音域')
    const separated = result('我不是戏神 - 同人第1章', 'https://fanqienovel.com/reader/2', '三九音域')
    const review = result('《我不是戏神》第1章手法分析', 'https://fanqienovel.com/article/3', '三九音域')
    const assessment = evaluateResearchSearchCandidates(target.title, [quoted, separated, review], target)
    expect(assessment.eligibleCount).toBe(0)
    expect(assessment.candidates.map(candidate => candidate.pageType)).toEqual(['chapter', 'chapter', 'secondary'])
  })
  it('handles site-only searches without inventing a novel requirement and fails closed on malformed sites', () => {
    const doc = result('API guide', 'https://docs.example.com/guide')
    expect(evaluateResearchSearchCandidates('site:docs.example.com API', [doc]).eligibleResults).toEqual([doc])
    expect(evaluateResearchSearchCandidates('site:localhost API', [doc])).toMatchObject({ hasHardConstraints: true, eligibleCount: 0 })
    expect(evaluateResearchSearchCandidates('site: API', [doc])).toMatchObject({ hasHardConstraints: true, eligibleCount: 0 })
    expect(evaluateResearchSearchCandidates('API', [doc]).hasHardConstraints).toBe(false)
  })
  it('respects alternative positive sites and explicit exclusions without host-prefix matches', () => {
    const doc = result('API guide', 'https://docs.example.com/guide'), blocked = result('API guide', 'https://docs.example.com/private/a')
    expect(evaluateResearchSearchCandidates('(site:docs.example.com OR site:help.example.com) -site:docs.example.com/private API', [doc, blocked]).eligibleResults).toEqual([doc])
  })
})

const transport = vi.hoisted(() => vi.fn())
vi.mock('undici', async original => ({ ...await original<typeof import('undici')>(), fetch: (...args: unknown[]) => transport(...args) }))
const config = { provider: 'deepseek', modelName: 'deepseek-search', baseUrl: 'https://api.deepseek.com', apiKey: 'offline-private-fixture' }
const nativeItem = (item: WebSearchResult) => ({ ...item, summary: item.snippet, content: '', site_name: item.source })
const sogou = (items: WebSearchResult[], echo?: string) => new Response(`${echo === undefined ? '' : `<input name="query" value="${echo.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`}${items.map(item => `<div class="vrwrap" data-url="${item.url}"><h3 class="vr-title"><a href="${item.url}">${item.title}</a></h3><p>${item.snippet}</p></div>`).join('')}`)
const bing = (items: WebSearchResult[], echo?: string) => new Response(`${echo === undefined ? '' : `<input name="q" value="${echo.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`}${items.map(item => `<li class="b_algo"><h2><a href="${item.url}">${item.title}</a></h2><p>${item.snippet}</p></li>`).join('')}`)
const originalProvider = env.webSearchProvider
beforeEach(() => { env.webSearchProvider = 'auto'; transport.mockReset(); vi.stubGlobal('fetch', transport) })
afterEach(() => { env.webSearchProvider = originalProvider; vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('constrained provider selection preserves billing and transport facts', () => {
  it('finds the publisher below off-topic Bing hits through a checked tracking href without sending a second paid request', async () => {
    const query = '雾港长昼 正版入口', target = bookLookupTarget(query, ['帮我联网找一下雾港长昼这本书'])
    const officialUrl = 'https://publisher.example.com/book/108'
    const href = (value: string) => '/ck/a?x=1&amp;u=a1' + Buffer.from(value).toString('base64url')
    const block = (title: string, url: string) => `<li data-rank='2' class='result b_algo'><a href='https://ads.example.com/'>面包屑</a><h2><a href='${url}'>${title}</a></h2></li>`
    const html = [block('《雾港长昼》', href('http://127.0.0.1/book/1')), block('《雾港长昼》', '/ck/a?u=bad'),
      ...Array.from({ length: 7 }, (_, n) => block('雾（汉字释义）', 'https://dict.example.com/item/' + n)),
      block('《<b>雾港长昼</b>》 官方阅读', href(officialUrl))].join('')
    transport.mockResolvedValueOnce(Response.json({ results: [nativeItem(generic[0])] }))
      .mockResolvedValueOnce(sogou(generic)).mockResolvedValueOnce(new Response(html))
    const outcome = await searchWeb(query, 5, undefined, config, target)
    expect(outcome.quality?.eligibleResults).toMatchObject([{ title: '《雾港长昼》 官方阅读', url: officialUrl, source: 'publisher.example.com' }])
    expect(outcome.results[0].url).toBe(officialUrl)
    expect(outcome.attempts?.map(attempt => [attempt.provider, attempt.eligibleCount])).toEqual([['deepseek', 0], ['sogou', 0], ['bing', 1]])
    expect(transport).toHaveBeenCalledTimes(3)
    expect(JSON.parse(transport.mock.calls[0][1].body).query).toBe(query)
    expect(new URL(transport.mock.calls[2][0]).searchParams.get('q')).toBe('"雾港长昼" 正版入口')
    expect(outcome.attempts?.[2].queryHash).toBe(searchQueryHash('"雾港长昼" 正版入口'))
  })
  const query = 'site:fanqienovel.com/page 我不是戏神 三九音域'
  it('continues free fallback after valid paid secondary hits, then adopts an actual eligible result', async () => {
    transport.mockResolvedValueOnce(Response.json({ results: [nativeItem(secondary), nativeItem(wrongBook)] }))
      .mockResolvedValueOnce(sogou([official], query))
    const outcome = await searchWeb(query, 6, undefined, config, target)
    expect(outcome).toMatchObject({ provider: 'sogou', quality: { eligibleCount: 1 }, attempts: [
      { provider: 'deepseek', outcome: 'results', resultCount: 2, eligibleCount: 0, parseCode: 'DEEPSEEK_RESULTS_SCHEMA_OK' },
      { provider: 'sogou', outcome: 'results', resultCount: 1, eligibleCount: 1, queryEcho: { state: 'matches', hash: searchQueryHash(query) } },
    ] })
    expect(outcome.results[0].url).toBe(official.url)
    expect(transport).toHaveBeenCalledTimes(2)
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({ query, count: 6, need_content: false })
    expect(new URL(transport.mock.calls[1][0]).searchParams.get('query')).toBe(query)
  })
  it('retains paid provider and its actual nonempty result when all free alternatives violate constraints', async () => {
    transport.mockResolvedValueOnce(Response.json({ results: [nativeItem(secondary), nativeItem(wrongBook)] }))
      .mockResolvedValueOnce(sogou(generic)).mockResolvedValueOnce(bing(generic, '我'))
    const outcome = await searchWeb(query, 8, undefined, config, target)
    expect(outcome.provider).toBe('deepseek')
    expect(outcome.results.map(item => item.url)).toEqual([secondary.url, wrongBook.url])
    expect(outcome.quality?.eligibleCount).toBe(0)
    expect(outcome.attempts?.map(attempt => [attempt.provider, attempt.outcome, attempt.resultCount, attempt.eligibleCount])).toEqual([
      ['deepseek', 'results', 2, 0], ['sogou', 'results', 2, 0], ['bing', 'results', 2, 0],
    ])
    expect(outcome.attempts?.[2].queryEcho).toEqual({ state: 'differs', hash: searchQueryHash('我') })
    expect(transport).toHaveBeenCalledTimes(3)
  })
  it('distinguishes genuine DeepSeek empty, Sogou parser failure and unrelated Bing results', async () => {
    const fallback = bing(generic, '我')
    Object.defineProperty(fallback, 'url', { value: 'https://www.bing.com/search?q=%E6%88%91&token=not-for-diagnostics' })
    transport.mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(new Response('<html>no expected result structure</html>')).mockResolvedValueOnce(fallback)
    const outcome = await searchWeb(query, 6, undefined, config, target)
    expect(outcome).toMatchObject({ provider: 'bing', quality: { eligibleCount: 0 }, attempts: [
      { provider: 'deepseek', outcome: 'empty', resultCount: 0, eligibleCount: 0 },
      { provider: 'sogou', outcome: 'failed', httpStatus: 200, parseCode: 'SOGOU_NO_RESULT_BLOCKS' },
      { provider: 'bing', outcome: 'results', responseFinalUrl: { origin: 'https://www.bing.com', path: '/search', queryHash: searchQueryHash('我') } },
    ] })
    expect(JSON.stringify(outcome)).not.toContain('not-for-diagnostics')
    expect(JSON.stringify(outcome)).not.toContain(config.apiKey)
  })
  it('keeps HTTP and malformed-response errors distinct rather than relabeling them as relevance failures', async () => {
    transport.mockResolvedValueOnce(Response.json({ results: 'bad', secret: 'never-store-provider-prose' }))
      .mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(bing([official]))
    expect(await searchWeb(query, 6, undefined, config, target)).toMatchObject({ provider: 'bing', quality: { eligibleCount: 1 }, attempts: [
      { provider: 'deepseek', outcome: 'failed', parseCode: 'DEEPSEEK_SCHEMA_REJECTED', httpStatus: 200 },
      { provider: 'sogou', outcome: 'failed', httpStatus: 503 }, { provider: 'bing', outcome: 'results' },
    ] })
  })
  it('redacts arbitrary final URL paths, credentials and query strings in diagnostic metadata', async () => {
    const response = Response.json({ results: [nativeItem(official)] })
    Object.defineProperty(response, 'url', { value: 'https://user:password@api.deepseek.com/private-credential-path?api_key=private-value' })
    transport.mockResolvedValue(response)
    const outcome = await searchWeb(query, 6, undefined, config, target)
    expect(outcome.attempts?.[0].responseFinalUrl).toEqual({ origin: 'https://api.deepseek.com', pathHash: searchQueryHash('/private-credential-path'), queryHash: searchQueryHash('?api_key=private-value') })
    for (const secret of ['password', 'private-credential-path', 'private-value', config.apiKey]) expect(JSON.stringify(outcome)).not.toContain(secret)
    expect(transport).toHaveBeenCalledOnce()
  })
  it('retains a known paid result when the bounded free fallback deadline expires', async () => {
    vi.useFakeTimers()
    const timeout = env.webSearchTimeoutMs
    env.webSearchTimeoutMs = 1000
    try {
      transport.mockResolvedValueOnce(Response.json({ results: [nativeItem(wrongBook)] }))
        .mockImplementation(async (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
        }))
      const pending = searchWeb(query, 6, undefined, config, target)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await pending).toMatchObject({ provider: 'deepseek', results: [{ url: wrongBook.url }], quality: { eligibleCount: 0 }, attempts: [
        { provider: 'deepseek', outcome: 'results' }, { provider: 'sogou', outcome: 'failed' }, { provider: 'bing', outcome: 'aborted' },
      ] })
      expect(transport).toHaveBeenCalledTimes(3)
      expect(vi.getTimerCount()).toBe(0)
    } finally { env.webSearchTimeoutMs = timeout; vi.useRealTimers() }
  })
  it('propagates an external stop during relevance fallback and does not return a paid result as delivered', async () => {
    const controller = new AbortController()
    transport.mockResolvedValueOnce(Response.json({ results: [nativeItem(wrongBook)] }))
      .mockImplementationOnce(async () => { controller.abort(new Error('author stopped')); throw controller.signal.reason })
    await expect(searchWeb(query, 6, controller.signal, config, target)).rejects.toMatchObject({ attempts: [
      { provider: 'deepseek', outcome: 'results' }, { provider: 'sogou', outcome: 'aborted' },
    ] })
    expect(transport).toHaveBeenCalledTimes(2)
  })
})

describe('anchored reading-title wrappers', () => {
  it.each(['河谷纪事完整版在线免费阅读', '河谷纪事完整版在线免费阅读_河谷纪事小说_番茄小说官网'])('admits discovery only for %s', title => {
    expect(evaluateResearchSearchCandidates('河谷纪事', [result(title, 'https://fanqienovel.com/page/123')], { title: '河谷纪事', sourceHosts: ['fanqienovel.com'] }).eligibleCount).toBe(1)
  })
  it.each(['河谷纪事完整版在线免费阅读_同人番外', '河谷纪事完整版在线免费阅读_其他书名', '河谷纪事完整版在线免费阅读指南', '河谷纪事：同人完整版在线免费阅读'])('rejects ambiguous wrapper %s', title => {
    expect(evaluateResearchSearchCandidates('河谷纪事', [result(title, 'https://fanqienovel.com/page/123')], { title: '河谷纪事' }).eligibleCount).toBe(0)
  })
  it('does not make a titled comment into an original chapter', () => {
    expect(evaluateResearchSearchCandidates('河谷纪事', [result('《河谷纪事》第1章', 'https://fanqienovel.com/comment/123')], { title: '河谷纪事' }).candidates[0]).toMatchObject({ eligible: false, pageType: 'secondary' })
  })
})
