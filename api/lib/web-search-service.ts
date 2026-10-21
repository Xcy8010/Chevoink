import { env } from '../config/env.js'
import { z } from 'zod'
import { parsePublicHttpUrl, readBoundedPublicBody } from './public-http.js'
import { getToolModelRuntime, ToolModelConfigurationError, type ToolModelRuntime } from './tool-model-config.js'
import { requestWebTool, webToolEndpoint } from './web-tool-provider.js'
import { parseHTML } from 'linkedom'
import { evaluateResearchSearchCandidates, evaluateResearchNavigationCandidates, searchQueryHash, type ResearchSearchEvaluation, type ResearchSearchTarget } from './research-search-quality.js'

export { evaluateResearchSearchCandidates } from './research-search-quality.js'
export type { ResearchSearchEvaluation, ResearchSearchTarget } from './research-search-quality.js'

/**
 * 联网搜索服务（Agent web_search 工具的后端）：
 * - bocha 主引擎：博查 AI Web Search API（境内稳定、结构化摘要），需 WEB_SEARCH_BOCHA_API_KEY
 * - sogou/bing 兜底引擎：无 key 直接抓取结果页解析（best-effort，借鉴 open-websearch 的无 key 引擎思路）；
 *   境内 IP 访问 www.bing.com 会 302 到 cn.bing.com 降级索引，故搜狗优先、Bing 末位兜底
 * 域名硬编码在服务层，模型只传 query，无 SSRF 面。
 */

export type WebSearchResult = {
  title: string
  url: string
  snippet: string
  /** 来源域名（前端卡片右侧展示） */
  source: string
}

export type WebSearchOutcome = {
  provider: 'bocha' | 'deepseek' | 'sogou' | 'bing'
  results: WebSearchResult[]
  attempts?: SearchAttempt[]
  quality?: ResearchSearchEvaluation
  /** Supplementary navigation retains its actual engine; result/fee owner stays unchanged. */
  navigation?: { provider: WebSearchOutcome['provider']; results: WebSearchResult[] }
}

type SearchAttempt = {
  provider: WebSearchOutcome['provider']
  outcome: 'results' | 'empty' | 'failed' | 'aborted'
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

export function assertWebSearchConfiguration(configured: ToolModelRuntime | null, query?: string): void {
  if (configured) webToolEndpoint(configured, 'search')
  if (!['auto', 'bocha', 'sogou', 'bing', 'disabled'].includes(env.webSearchProvider)) throw new ToolModelConfigurationError('WEB_SEARCH_PROVIDER_UNSUPPORTED')
  if (configured?.provider.trim().toLowerCase() === 'deepseek' && query !== undefined &&
    (!query.trim() || [...query].length > 128)) throw new WebSearchError('WEB_SEARCH_QUERY_INVALID')
}

const SNIPPET_MAX = 300
const deepseekSearchSchema = z.object({ results: z.array(z.object({
  title: z.string(), url: z.string(), snippet: z.string(), summary: z.string(), content: z.string(),
  site_name: z.string().nullable().optional(),
})).max(50) })
const bochaResponseSchema = z.object({
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
  return text.length > max ? `${text.slice(0, max)}…` : text
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
        snippet: truncate(stripTags(item.summary || item.snippet || ''), SNIPPET_MAX),
        source: item.siteName || hostOf(item.url ?? ''),
      })), maxResults)
    if (values.length && !results.length) throw new WebSearchError('博查未返回可用的公开来源')
    return results
  } finally { await request.close() }
}

async function searchDeepSeek(query: string, maxResults: number, signal: AbortSignal, configured: ToolModelRuntime, metadata: AttemptResponse): Promise<WebSearchResult[]> {
  const request = await requestWebTool(webToolEndpoint(configured, 'search'), configured.apiKey,
    { query, count: maxResults, need_content: false }, signal)
  try {
    const { response } = request
    captureSearchResponse(response, metadata)
    if (!response.ok) return await rejectSearchResponse(response, 'DeepSeek')
    if (metadata.queryHash) metadata.parseCode = 'DEEPSEEK_INVALID_JSON'
    const raw: unknown = JSON.parse((await readBoundedPublicBody(response, 2 * 1024 * 1024)).toString('utf8'))
    const payload = deepseekSearchSchema.safeParse(raw)
    if (metadata.queryHash) metadata.parseCode = payload.success ? 'DEEPSEEK_RESULTS_SCHEMA_OK' : 'DEEPSEEK_SCHEMA_REJECTED'
    if (!payload.success) throw new WebSearchError('DEEPSEEK_SEARCH_PROTOCOL_ERROR')
    // Keep the original count until publicResults runs: unsafe-only results are
    // a failed contract, never evidence of a genuinely empty search.
    return payload.data.results.map(item => ({ title: stripTags(item.title), url: item.url,
      snippet: truncate(stripTags(item.summary || item.snippet), SNIPPET_MAX), source: item.site_name || hostOf(item.url) }))
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
    results.push({ title, url: href, snippet: truncate(snippet, SNIPPET_MAX), source: hostOf(href) })
  }

  if (metadata.queryHash) metadata.parseCode = results.length ? 'SOGOU_RESULTS_PARSED' : blocks.length ? 'SOGOU_NO_USABLE_LINKS' : 'SOGOU_NO_RESULT_BLOCKS'
  if (results.length === 0) {
    throw new WebSearchError('搜狗页面未发现可用公开结果链接')
  }

  return results
}

/** 无 key 末位兜底：抓取 Bing 结果页，正则提取 b_algo 块（标题链接 + 摘要段落） */
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
  captureSearchHtml(html, metadata, query)
  const blocks = [...html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)]
  const results: WebSearchResult[] = []

  for (const block of blocks) {
    if (results.length >= maxResults) {
      break
    }
    // b_algo 块首个链接可能是面包屑站点链接（标题=域名），逐个候选取第一个像真实标题的
    const anchors = [...block[0].matchAll(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    let picked: { href: string; title: string } | null = null
    for (const anchor of anchors) {
      const title = stripTags(anchor[2])
      // 面包屑链接特征：文本内嵌 URL（含不带协议头的短域名）、带 › 分隔、或以域名开头
      if (!title || /https?:\/\//.test(title) || title.includes(' › ') || /^([a-z0-9-]+\.)+[a-z]{2,}/i.test(title)) {
        continue
      }
      picked = { href: anchor[1], title }
      break
    }
    if (!picked) {
      continue
    }
    const snippetMatch = block[0].match(/<p[^>]*>([\s\S]*?)<\/p>/)
    results.push({
      title: picked.title,
      url: picked.href,
      snippet: truncate(stripTags(snippetMatch?.[1] ?? ''), SNIPPET_MAX),
      source: hostOf(picked.href),
    })
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
): Promise<WebSearchOutcome> {
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 8) {
    throw new WebSearchError('搜索结果数量必须为 1–8')
  }
  const { signal: merged, cleanup } = withTimeout(signal, env.webSearchTimeoutMs)
  const attempts: SearchAttempt[] = []

  try {
    const configured = configuredInput === undefined ? await getToolModelRuntime('tool:web-search') : configuredInput
    assertWebSearchConfiguration(configured, query)
    const primary = configured ? configured.provider.trim().toLowerCase() as 'bocha' | 'deepseek'
      : env.webSearchProvider === 'bocha' || (env.webSearchProvider === 'auto' && env.webSearchBochaApiKeyConfigured) ? 'bocha' : null

    if (env.webSearchProvider === 'disabled') {
      throw new WebSearchError('联网搜索已禁用（WEB_SEARCH_PROVIDER=disabled）')
    }

    const providers: WebSearchOutcome['provider'][] = primary ? [primary, 'sogou', 'bing'] : ['sogou', 'bing']
    const constrained = evaluateResearchSearchCandidates(query, [], expectedTarget).hasHardConstraints
    let constrainedResult: Pick<WebSearchOutcome, 'provider' | 'results' | 'quality'> | undefined
    let emptyProvider: WebSearchOutcome['provider'] | undefined
    let navigation: WebSearchOutcome['navigation']
    for (const provider of providers) {
      merged.throwIfAborted()
      const started = Date.now()
      const metadata: AttemptResponse = constrained ? { queryHash: searchQueryHash(query) } : {}
      // A slow provider must leave time for fallback; all attempts still share the overall deadline.
      const local = withTimeout(merged, Math.max(1, Math.floor(env.webSearchTimeoutMs / 2)))
      try {
        const raw = provider === 'deepseek' ? await searchDeepSeek(query, maxResults, local.signal, configured!, metadata)
          : provider === 'bocha' ? await searchBocha(query, maxResults, local.signal, configured, metadata)
          : provider === 'sogou' ? await searchSogou(query, maxResults, local.signal, metadata)
            : await searchBing(query, maxResults, local.signal, metadata)
        local.signal.throwIfAborted()
        const results = publicResults(raw, maxResults)
        if (raw.length && !results.length) {
          if (constrained) metadata.parseCode = 'PUBLIC_SOURCE_FILTER_REJECTED'
          throw new WebSearchError('搜索未返回可用的公开来源')
        }
        const quality = constrained ? evaluateResearchSearchCandidates(query, results, expectedTarget) : undefined
        const hints = navigationPolicy ? evaluateResearchNavigationCandidates(results, expectedTarget, navigationPolicy.sourceSites, navigationPolicy.alternativeAvailable).slice(0, 2)
          .map(({ title, url, snippet, source }) => ({ title, url, snippet, source })) : []
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
        emptyProvider = provider
      } catch (error) {
        attempts.push({ provider, outcome: merged.aborted ? 'aborted' : 'failed', durationMs: Date.now() - started, ...metadata })
        if (merged.aborted) {
          if (!signal?.aborted && constrainedResult) return { ...constrainedResult, attempts, ...(navigation ? { navigation } : {}) }
          if (!signal?.aborted && emptyProvider) return { provider: emptyProvider, results: [], attempts }
          throw error
        }
      } finally {
        local.cleanup()
      }
    }
    if (constrainedResult) return { ...constrainedResult, attempts, ...(navigation ? { navigation } : {}) }
    if (emptyProvider) return { provider: emptyProvider, results: [], attempts }
    throw new WebSearchError('所有搜索引擎均未返回有效响应', attempts)
  } catch (error) {
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
