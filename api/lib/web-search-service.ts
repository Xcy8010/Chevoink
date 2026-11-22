import { env } from '../config/env.js'
import { z } from 'zod'
import { parsePublicHttpUrl, readBoundedPublicBody } from './public-http.js'
import { getToolModelRuntime, ToolModelConfigurationError, type ToolModelRuntime } from './tool-model-config.js'
import { requestWebTool, webToolEndpoint, resolveWebToolProtocol } from './web-tool-provider.js'
import { parseHTML } from 'linkedom'
import { evaluateResearchSearchCandidates, evaluateResearchNavigationCandidates, quotedBookLookupQuery, rankResearchSearchResults, searchQueryHash, type ResearchSearchEvaluation, type ResearchSearchTarget } from './research-search-quality.js'
import { searchAuthoritySchema, searchPublicationDateSchema, searchRerankScoreSchema, WEB_SEARCH_SNIPPET_CHARS, WEB_SEARCH_SUMMARY_CHARS, type WebSearchResult } from './web-search-result.js'

export { evaluateResearchSearchCandidates } from './research-search-quality.js'
export type { ResearchSearchEvaluation, ResearchSearchTarget } from './research-search-quality.js'

/**
 * 联网搜索服务（Agent web_search 工具的后端）：
 * - bocha 主引擎：博查 AI Web Search API（境内稳定、结构化摘要），需 WEB_SEARCH_BOCHA_API_KEY
 * - sogou/bing 兜底引擎：无 key 直接抓取结果页解析（best-effort，借鉴 open-websearch 的无 key 引擎思路）；
 *   境内 IP 访问 www.bing.com 会 302 到 cn.bing.com 降级索引，故搜狗优先、Bing 末位兜底
 * 域名硬编码在服务层，模型只传 query，无 SSRF 面。
 */

export type { WebSearchResult } from './web-search-result.js'

export type WebSearchOutcome = {
  provider: 'bocha' | 'deepseek' | 'sogou' | 'bing' | 'qidian'
  results: WebSearchResult[]
  /** Dispatch-time scope for matching equivalent queries after recovery. */
  contextKey?: string
  attempts?: SearchAttempt[]
  quality?: ResearchSearchEvaluation
  /** Supplementary navigation retains its actual engine; result/fee owner stays unchanged. */
  navigation?: { provider: WebSearchOutcome['provider']; results: WebSearchResult[] }
}

type SearchAttempt = {
  provider: WebSearchOutcome['provider']
  outcome: 'results' | 'empty' | 'failed' | 'aborted' | 'unknown'
  durationMs: number
  httpStatus?: number
  providerRequestId?: string
  providerCode?: string
  queryHash?: string
  resultCount?: number
  eligibleCount?: number
  constraintCodes?: string[]
  parseCode?: string
  responseFinalUrl?: { origin: string; path?: string; pathHash?: string; queryHash?: string }
  queryEcho?: { state: 'matches' | 'differs' | 'absent'; hash?: string }
}

type AttemptResponse = Pick<SearchAttempt, 'httpStatus' | 'providerRequestId' | 'providerCode' | 'queryHash' | 'parseCode' | 'responseFinalUrl' | 'queryEcho'>
// Transport completeness is internal; preserve existing public attempt shapes.
const completeSearchResponses = new WeakSet<AttemptResponse>()
function captureSearchResponse(response: { status: number; url?: string; headers: { get(name: string): string | null } }, metadata: AttemptResponse) {
  metadata.httpStatus = response.status
  const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id')
  if (requestId && /^[a-zA-Z0-9_.:-]{1,128}$/.test(requestId)) metadata.providerRequestId = requestId
  if (metadata.queryHash && response.url) {
    try {
      const url = new URL(response.url)
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        // Redirect diagnostics retain no credentials, query strings or arbitrary
        // path tokens. Known search paths are useful; other paths stay hashed.
        metadata.responseFinalUrl = { origin: url.origin,
          ...(/^\/(?:search|web|v1\/(?:tools\/search|web-search))\/?$/u.test(url.pathname) ? { path: url.pathname } : { pathHash: searchQueryHash(url.pathname) }),
          ...(url.search ? { queryHash: searchQueryHash(url.searchParams.get('q') ?? url.searchParams.get('query') ?? url.search) } : {}) }
      }
    } catch { /* A malformed response URL is not exposed as provider prose. */ }
  }
}

function captureSearchHtml(html: string, metadata: AttemptResponse, query: string) {
  if (!metadata.queryHash) return
  metadata.queryEcho = { state: 'absent' }
  try {
    const { document } = parseHTML(html.slice(0, 256_000))
    const input = document.querySelector('input[name="q"],input[name="query"],textarea[name="q"],textarea[name="query"]')
    const echo = input?.getAttribute('value') ?? input?.textContent
    if (echo && echo.length <= 8192) {
      const normalize = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim()
      metadata.queryEcho = { state: normalize(echo) === normalize(query) ? 'matches' : 'differs', hash: searchQueryHash(echo) }
    }
  } catch { /* Echo absence is diagnostic, not an invented transport error. */ }
}

async function rejectSearchResponse(response: { status: number; body: { cancel(): Promise<unknown> } | null }, provider: string): Promise<never> {
  // A rejected HTTP response may still stream a large body. Do not leave it
  // occupying the connection while the next fallback request starts.
  try { await response.body?.cancel() } catch { /* Preserve the HTTP failure. */ }
  throw new WebSearchError(`${provider}返回 ${response.status}`)
}

export class WebSearchError extends Error {
  constructor(message: string, readonly attempts: SearchAttempt[] = []) {
    super(message)
    this.name = 'WebSearchError'
  }
}

export class WebSearchUnknownError extends WebSearchError {
  constructor(attempts: SearchAttempt[]) { super('原搜索请求结果未知，未切换引擎或重新请求。', attempts); this.name = 'WebSearchUnknownError' }
}

export function assertWebSearchConfiguration(configured: ToolModelRuntime | null, query?: string): void {
  if (configured) webToolEndpoint(configured, 'search')
  if (!['auto', 'bocha', 'sogou', 'bing', 'disabled'].includes(env.webSearchProvider)) throw new ToolModelConfigurationError('WEB_SEARCH_PROVIDER_UNSUPPORTED')
  if (configured && resolveWebToolProtocol(configured) === 'deepseek' && query !== undefined &&
    (!query.trim() || [...query].length > 128)) throw new WebSearchError('WEB_SEARCH_QUERY_INVALID')
}

export const deepseekSearchSchema = z.object({ results: z.array(z.object({
  title: z.string(), url: z.string(), snippet: z.string(), summary: z.string(), content: z.string(),
  site_name: z.string().nullable().optional(),
  rerank_score: searchRerankScoreSchema.optional().catch(undefined),
  authority: searchAuthoritySchema.optional().catch(undefined),
  date: searchPublicationDateSchema.nullish().catch(undefined),
})).max(50) })
export const bochaResponseSchema = z.object({
  code: z.literal(200),
  data: z.object({ webPages: z.object({ value: z.array(z.object({
    name: z.string(), url: z.string(), snippet: z.string().nullish(),
    summary: z.string().nullish(), siteName: z.string().nullish(),
  })) }) }),
})

function publicResults(results: WebSearchResult[], limit: number): WebSearchResult[] {
  const seen = new Set<string>()
  return results.filter(result => {
    try {
      const url = parsePublicHttpUrl(result.url, true).href
      if (!result.title.trim() || seen.has(url)) return false
      seen.add(url)
      return true
    } catch { return false }
  }).slice(0, limit)
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;|&ensp;|&#0?160;/g, ' ')
    .replace(/&#0?183;|&middot;/g, '·')
    .replace(/&amp;/g, '&')
}

function stripTags(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function searchDescriptions(snippet: string, summary = '') {
  const cleanSnippet = stripTags(snippet), cleanSummary = stripTags(summary)
  const short = truncate(cleanSnippet || cleanSummary, WEB_SEARCH_SNIPPET_CHARS)
  const long = truncate(cleanSummary || cleanSnippet, WEB_SEARCH_SUMMARY_CHARS)
  return { snippet: short, ...(long !== short ? { summary: long } : {}) }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** 外部 signal 与超时合并（兼容无 AbortSignal.any 的 Node 版本） */
function withTimeout(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const onAbort = () => controller.abort(external?.reason)

  if (external) {
    if (external.aborted) {
      onAbort()
    } else {
      external.addEventListener('abort', onAbort, { once: true })
    }
  }

  const cleanup = () => {
    clearTimeout(timer)
    external?.removeEventListener('abort', onAbort)
  }

  return { signal: controller.signal, cleanup }
}

async function searchBocha(query: string, maxResults: number, signal: AbortSignal, configured: ToolModelRuntime | null, metadata: AttemptResponse): Promise<WebSearchResult[]> {
  const request = await requestWebTool(configured ? webToolEndpoint(configured, 'search') : 'https://api.bochaai.com/v1/web-search',
    configured?.apiKey ?? env.webSearchBochaApiKey, { query, count: maxResults, summary: true }, signal)
  const { response } = request
  try {

    captureSearchResponse(response, metadata)

    if (!response.ok) {
      // Observe rejection before finally awaits dispatcher shutdown. Returning
      // the pending promise here can surface an unhandled rejection meanwhile.
      return await rejectSearchResponse(response, '博查')
    }

    const body = await readBoundedPublicBody(response, 2 * 1024 * 1024)
    completeSearchResponses.add(metadata)
    if (metadata.queryHash) metadata.parseCode = 'BOCHA_INVALID_JSON'
    const raw: unknown = JSON.parse(body.toString('utf8'))
    if (raw && typeof raw === 'object') {
      if ('log_id' in raw && typeof raw.log_id === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(raw.log_id)) metadata.providerRequestId = raw.log_id
      if ('code' in raw && (typeof raw.code === 'string' || typeof raw.code === 'number') && /^[a-zA-Z0-9_-]{1,32}$/.test(String(raw.code))) metadata.providerCode = String(raw.code)
    }
    const payload = bochaResponseSchema.safeParse(raw)
    if (metadata.queryHash) metadata.parseCode = payload.success ? 'BOCHA_RESULTS_SCHEMA_OK' : 'BOCHA_SCHEMA_REJECTED'
    if (!payload.success) throw new WebSearchError('博查响应格式或业务状态异常')
    const values = payload.data.data.webPages.value

    const results = publicResults(values
      .filter((item) => item.url && item.name)
      .map((item) => ({
        title: stripTags(item.name ?? ''),
        url: item.url ?? '',
        ...searchDescriptions(item.snippet ?? '', item.summary ?? ''),
        source: item.siteName || hostOf(item.url ?? ''),
      })), maxResults)
    if (values.length && !results.length) throw new WebSearchError('博查未返回可用的公开来源')
    return results
  } finally { await request.close() }
}

async function searchDeepSeek(query: string, maxResults: number, signal: AbortSignal, configured: ToolModelRuntime, metadata: AttemptResponse, originalQuestion?: string): Promise<WebSearchResult[]> {
  const request = await requestWebTool(webToolEndpoint(configured, 'search'), configured.apiKey,
    { query, count: maxResults, need_content: false, ...(originalQuestion ? { ori_question: originalQuestion } : {}) }, signal)
  try {
    const { response } = request
    captureSearchResponse(response, metadata)
    if (!response.ok) return await rejectSearchResponse(response, 'DeepSeek')
    if (metadata.queryHash) metadata.parseCode = 'DEEPSEEK_INVALID_JSON'
    const body = await readBoundedPublicBody(response, 2 * 1024 * 1024)
    completeSearchResponses.add(metadata)
    const raw: unknown = JSON.parse(body.toString('utf8'))
    const payload = deepseekSearchSchema.safeParse(raw)
    if (metadata.queryHash) metadata.parseCode = payload.success ? 'DEEPSEEK_RESULTS_SCHEMA_OK' : 'DEEPSEEK_SCHEMA_REJECTED'
    if (!payload.success) throw new WebSearchError('DEEPSEEK_SEARCH_PROTOCOL_ERROR')
    // Keep the original count until publicResults runs: unsafe-only results are
    // a failed contract, never evidence of a genuinely empty search.
    return payload.data.results.map(item => ({
      title: truncate(stripTags(item.title), 300), url: item.url, source: truncate(item.site_name || hostOf(item.url), 300),
      ...searchDescriptions(item.snippet, item.summary),
      ...(item.rerank_score === undefined ? {} : { rerankScore: item.rerank_score }),
      ...(item.authority === undefined ? {} : { authority: item.authority }),
      ...(item.date ? { publishedAt: new Date(item.date).toISOString() } : {}),
    }))
  } finally { await request.close() }
}

/** 无 key 兜底：抓取搜狗结果页，按 vrwrap 块提取标题 + data-url 真实链接 + 摘要 */
async function searchSogou(query: string, maxResults: number, signal: AbortSignal, metadata: AttemptResponse): Promise<WebSearchResult[]> {
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'text/html',
    },
    signal,
  })

  captureSearchResponse(response, metadata)
  if (!response.ok) {
    return rejectSearchResponse(response, '搜狗')
  }

  const html = (await readBoundedPublicBody(response, 2 * 1024 * 1024)).toString('utf8')
  completeSearchResponses.add(metadata)
  captureSearchHtml(html, metadata, query)
  // Parse observed DOM attributes, including class lists and single-quoted
  // HTML. Relative tracking links alone are not a discovered destination.
  const { document } = parseHTML(html)
  const blocks = [...document.querySelectorAll('.vrwrap')]
  const results: WebSearchResult[] = []
  for (const block of blocks) {
    if (results.length >= maxResults) break
    const anchor = block.querySelector('h3.vr-title a[href]')
    const title = anchor?.textContent?.replace(/\s+/gu, ' ').trim() ?? ''
    if (!title || /https?:\/\//u.test(title) || title.includes(' › ')) continue
    const destinations = [block.getAttribute('data-url'), ...[...block.querySelectorAll('[data-url]')].map(node => node.getAttribute('data-url')), anchor?.getAttribute('href')]
    let href: string | undefined
    for (const destination of destinations) {
      if (!destination || !/^https?:\/\//iu.test(destination)) continue
      try {
        const parsed = parsePublicHttpUrl(destination, true)
        if (/(?:^|\.)sogou\.com$/iu.test(parsed.hostname)) continue
        href = parsed.href
        break
      } catch { /* Malformed or private destinations never become sources. */ }
    }
    if (!href) continue
    const snippet = block.querySelector('.str-text,.text-layout,.space-txt,p')?.textContent?.replace(/\s+/gu, ' ').trim() ?? ''
    results.push({ title, url: href, snippet: truncate(snippet, WEB_SEARCH_SNIPPET_CHARS), source: hostOf(href) })
  }

  if (metadata.queryHash) metadata.parseCode = results.length ? 'SOGOU_RESULTS_PARSED' : blocks.length ? 'SOGOU_NO_USABLE_LINKS' : 'SOGOU_NO_RESULT_BLOCKS'
  if (results.length === 0) {
    throw new WebSearchError('搜狗页面未发现可用公开结果链接')
  }

  return results
}

/** Bing may expose the publisher URL in the u=a1<base64url> field of a
 * tracking link. Decode only this observed destination, without following redirects. */
/** The publisher's public catalogue links each exact title to its reading entry. */
async function searchQidian(title: string, signal: AbortSignal, metadata: AttemptResponse): Promise<WebSearchResult[]> {
  const origin = 'https://m.qidian.com'
  const response = await fetch(`${origin}/soushu/${encodeURIComponent(title)}.html`, { signal, redirect: 'error' })
  captureSearchResponse(response, metadata)
  if (!response.ok) return rejectSearchResponse(response, '起点书目 ')
  const html = (await readBoundedPublicBody(response, 2 * 1024 * 1024)).toString('utf8')
  completeSearchResponses.add(metadata)
  const { document } = parseHTML(html)
  const results: WebSearchResult[] = []
  for (const anchor of document.querySelectorAll('a[data-bid][href]')) {
    const book = anchor.querySelector('h2')?.textContent?.trim()
    const id = anchor.getAttribute('data-bid')
    if (book !== title || !id || !/^\d+$/u.test(id)) continue
    let url: URL
    try { url = new URL(anchor.getAttribute('href')!, origin) } catch { continue }
    if (url.origin !== origin || url.username || url.password || url.pathname !== `/chapter/${id}/0/`) continue
    const author = anchor.querySelector('[class*="searchBookAuthor"]')?.textContent?.trim().slice(0, 80)
    results.push({ title: `《${book}》在线阅读 - 起点中文网`, url: url.href, source: '起点中文网',
      snippet: author ? `起点中文网书目，作者：${author}` : '起点中文网书目' })
    if (results.length === 8) break
  }
  return results
}

function bingDestination(href: string) {
  try {
    const url = parsePublicHttpUrl(new URL(href, 'https://www.bing.com').href, true)
    if (url.hostname !== 'bing.com' && !url.hostname.endsWith('.bing.com')) return url.href
    const encoded = url.pathname === '/ck/a' ? url.searchParams.get('u') : null
    if (!encoded || !/^a1[A-Za-z0-9_-]+={0,2}$/u.test(encoded)) return
    const destination = parsePublicHttpUrl(Buffer.from(encoded.slice(2), 'base64url').toString('utf8'), true)
    if (destination.hostname !== 'bing.com' && !destination.hostname.endsWith('.bing.com')) return destination.href
  } catch { /* Malformed or non-public destinations never become sources. */ }
}

async function searchBing(query: string, maxResults: number, signal: AbortSignal, metadata: AttemptResponse): Promise<WebSearchResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'text/html',
    },
    signal,
  })

  captureSearchResponse(response, metadata)
  if (!response.ok) {
    return rejectSearchResponse(response, 'Bing ')
  }

  const html = (await readBoundedPublicBody(response, 2 * 1024 * 1024)).toString('utf8')
  completeSearchResponses.add(metadata)
  captureSearchHtml(html, metadata, query)
  const { document } = parseHTML(html)
  const blocks = [...document.querySelectorAll('li.b_algo')]
  const results: WebSearchResult[] = []

  for (const block of blocks) {
    if (results.length >= maxResults) {
      break
    }
    const anchor = block.querySelector('h2 a[href]')
    const title = anchor?.textContent?.replace(/\s+/gu, ' ').trim()
    const href = anchor?.getAttribute('href')
    const destination = href && bingDestination(href)
    if (!title || !destination) continue
    const snippet = block.querySelector('p')?.textContent?.replace(/\s+/gu, ' ').trim() ?? ''
    results.push({ title, url: destination, source: hostOf(destination), snippet: truncate(snippet, WEB_SEARCH_SNIPPET_CHARS) })
  }

  if (metadata.queryHash) metadata.parseCode = results.length ? 'BING_RESULTS_PARSED' : blocks.length ? 'BING_NO_USABLE_LINKS' : 'BING_NO_RESULT_BLOCKS'
  if (results.length === 0) {
    throw new WebSearchError('Bing 结果解析为空（可能触发反爬或结构变化）')
  }

  return results
}

/**
 * 联网搜索入口：auto = 有博查 key 用博查、失败依次降搜狗、Bing；显式 bocha/bing 也带降级；disabled 直接不可用。
 * 全部引擎失败抛 WebSearchError，由工具层转成对模型的如实回填。
 */
export async function searchWeb(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
  configuredInput?: ToolModelRuntime | null,
  expectedTarget?: ResearchSearchTarget,
  navigationPolicy?: { version: 1; sourceSites?: readonly string[]; alternativeAvailable?: boolean },
  durable?: { stopOnUnknown: true },
  /** Supplied only by the server from an author-approved public question. */
  originalQuestion?: string,
): Promise<WebSearchOutcome> {
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 8) {
    throw new WebSearchError('搜索结果数量必须为 1–8')
  }
  const { signal: merged, cleanup } = withTimeout(signal, env.webSearchTimeoutMs)
  const attempts: SearchAttempt[] = []

  try {
    const configured = configuredInput === undefined ? await getToolModelRuntime('tool:web-search') : configuredInput
    assertWebSearchConfiguration(configured, query)
    const primary = configured ? resolveWebToolProtocol(configured)
      : env.webSearchProvider === 'bocha' || (env.webSearchProvider === 'auto' && env.webSearchBochaApiKeyConfigured) ? 'bocha' : null

    if (env.webSearchProvider === 'disabled') {
      throw new WebSearchError('联网搜索已禁用（WEB_SEARCH_PROVIDER=disabled）')
    }

    // Spend the existing free fallback slot on the named publisher when the
    // request is a book lookup. The paid route and total request cap stay intact.
    const catalogue = expectedTarget?.purpose === 'lookup' && /起点|\bqidian\.com\b/iu.test(query)
      && !expectedTarget.sourceSites?.length && !/(?:site:|(?:排除|不要|不含|除了)\s*起点)/iu.test(query)
    const fallback = catalogue ? 'qidian' : 'sogou'
    const providers: WebSearchOutcome['provider'][] = primary ? [primary, fallback, 'bing'] : [fallback, 'bing']
    const constrained = evaluateResearchSearchCandidates(query, [], expectedTarget).hasHardConstraints
    let constrainedResult: Pick<WebSearchOutcome, 'provider' | 'results' | 'quality'> | undefined
    let emptyResult: Pick<WebSearchOutcome, 'provider' | 'results' | 'quality'> | undefined
    let navigation: WebSearchOutcome['navigation']
    for (const provider of providers) {
      merged.throwIfAborted()
      const started = Date.now()
      const freeProvider = provider === 'sogou' || provider === 'bing'
      const providerQuery = provider === 'qidian' ? expectedTarget!.title : freeProvider ? quotedBookLookupQuery(query, expectedTarget) : query
      const metadata: AttemptResponse = constrained || durable ? { queryHash: searchQueryHash(providerQuery) } : {}
      // An HTML result list can contain useful candidates below the visible
      // result count. Rank a bounded pool from the same already-fetched page.
      const htmlCandidates = constrained ? Math.max(20, maxResults) : maxResults
      // A slow provider must leave time for fallback; all attempts still share the overall deadline.
      const local = withTimeout(merged, Math.max(1, Math.floor(env.webSearchTimeoutMs / 2)))
      try {
        const raw = provider === 'deepseek' ? await searchDeepSeek(query, maxResults, local.signal, configured!, metadata, originalQuestion)
          : provider === 'bocha' ? await searchBocha(query, maxResults, local.signal, configured, metadata)
          : provider === 'qidian' ? await searchQidian(providerQuery, local.signal, metadata)
          : provider === 'sogou' ? await searchSogou(providerQuery, htmlCandidates, local.signal, metadata)
            : await searchBing(providerQuery, htmlCandidates, local.signal, metadata)
        local.signal.throwIfAborted()
        const results = rankResearchSearchResults(query, publicResults(raw, raw.length), expectedTarget).slice(0, maxResults)
        if (raw.length && !results.length) {
          if (constrained) metadata.parseCode = 'PUBLIC_SOURCE_FILTER_REJECTED'
          throw new WebSearchError('搜索未返回可用的公开来源')
        }
        const quality = constrained ? evaluateResearchSearchCandidates(query, results, expectedTarget) : undefined
        const hints = navigationPolicy ? evaluateResearchNavigationCandidates(results, expectedTarget, navigationPolicy.sourceSites, navigationPolicy.alternativeAvailable).slice(0, 2)
          .map(({ index }) => results[index]) : []
        if (hints.length > (navigation?.results.length ?? 0)) navigation = { provider, results: hints }
        attempts.push({ provider, outcome: results.length ? 'results' : 'empty', durationMs: Date.now() - started, ...metadata,
          ...(quality ? { resultCount: results.length, eligibleCount: quality.eligibleCount,
            constraintCodes: [...new Set(quality.candidates.flatMap(candidate => candidate.reasons))] } : {}) })
        if (results.length) {
          if (!quality || quality.eligibleCount > 0) return { provider, results, attempts, ...(quality ? { quality } : {}) }
          // A valid, irrelevant paid response stays a real result. Free fallback
          // can improve discovery within this call, but never turn it into an
          // empty/error refund if every provider lacks a qualified candidate.
          constrainedResult ??= { provider, results, quality }
          continue
        }
        emptyResult = { provider, results: [], ...(quality ? { quality } : {}) }
      } catch (error) {
        const unknown = durable && !completeSearchResponses.has(metadata) && !(metadata.httpStatus !== undefined && (metadata.httpStatus < 200 || metadata.httpStatus >= 300))
        attempts.push({ provider, outcome: unknown ? 'unknown' : merged.aborted ? 'aborted' : 'failed', durationMs: Date.now() - started, ...metadata })
        if (unknown) throw new WebSearchUnknownError(attempts)
        if (merged.aborted) {
          if (!signal?.aborted && constrainedResult) return { ...constrainedResult, attempts, ...(navigation ? { navigation } : {}) }
          if (!signal?.aborted && emptyResult) return { ...emptyResult, attempts }
          throw error
        }
      } finally {
        local.cleanup()
      }
    }
    if (constrainedResult) return { ...constrainedResult, attempts, ...(navigation ? { navigation } : {}) }
    if (emptyResult) return { ...emptyResult, attempts }
    throw new WebSearchError('所有搜索引擎均未返回有效响应', attempts)
  } catch (error) {
    if (error instanceof WebSearchUnknownError) throw error
    if (error instanceof ToolModelConfigurationError) throw new WebSearchError(error.code, attempts)
    // Preserve attempted-request evidence for cancellation settlement. A
    // pre-request cancellation still propagates unchanged and cannot refund.
    if (signal?.aborted && attempts.length) throw new WebSearchError('搜索已取消', attempts)
    if (signal?.aborted || error instanceof WebSearchError) throw error
    throw new WebSearchError('搜索服务未完成有效请求', attempts)
  } finally {
    cleanup()
  }
}
