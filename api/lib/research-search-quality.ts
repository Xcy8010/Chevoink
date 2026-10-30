import { createHash } from 'node:crypto'
import { parsePublicHttpUrl } from './public-http.js'
import type { WebSearchResult } from './web-search-service.js'

/** Supplied by the frozen server task, never by search-result text. */
export type ResearchSearchTarget = { title: string; author?: string; sourceHosts?: readonly string[] }
export type ResearchSearchCandidate = {
  index: number
  eligible: boolean
  hostMatch: boolean
  siteMatch: boolean
  titleMatch: 'exact' | 'related' | 'absent' | 'unconstrained'
  authorMatch: 'mentioned' | 'conflicting' | 'unknown' | 'unconstrained'
  pageType: 'book' | 'chapter' | 'secondary' | 'homepage' | 'unknown'
  reasons: string[]
}
export type ResearchSearchEvaluation = {
  version: 1
  queryHash: string
  hasHardConstraints: boolean
  resultCount: number
  eligibleCount: number
  eligibleResults: WebSearchResult[]
  candidates: ResearchSearchCandidate[]
}
type SiteConstraint = { host: string; path: string; exclude: boolean }
export const searchQueryHash = (query: string) => createHash('sha256').update(query).digest('hex')
const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
const hostMatches = (actual: string, expected: string) => actual === expected || actual.endsWith(`.${expected}`)

function siteConstraints(query: string): { sites: SiteConstraint[]; invalid: boolean } {
  const sites: SiteConstraint[] = []
  let invalid = false
  for (const match of query.matchAll(/(?:^|[\s(])(-?)site:\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))/giu)) {
    const value = match[2] ?? match[3] ?? match[4]
    try {
      const url = parsePublicHttpUrl(/^https?:\/\//iu.test(value) ? value : `https://${value}`)
      if (url.search || url.hash || sites.length >= 8) { invalid = true; continue }
      sites.push({ host: url.hostname.toLowerCase(), path: url.pathname.replace(/\/+$/u, '') || '/', exclude: match[1] === '-' })
    } catch { invalid = true }
  }
  // An incomplete operator must not silently erase a requested site boundary.
  if (/(?:^|[\s(])-?site:/iu.test(query) && sites.length === 0) invalid = true
  return { sites, invalid }
}

function resultPageType(url: URL, title: string): ResearchSearchCandidate['pageType'] {
  if (url.pathname === '/' || !url.pathname) return 'homepage'
  if (/(?:^|\/)(?:reader|read|chapter|chapters)(?:\/|[-_.]|$)/iu.test(url.pathname)) return 'chapter'
  if (/(?:^|\.)(?:baike|wapbaike|wikipedia)\./iu.test(url.hostname)
    || /(?:^|\/)(?:article|articles|news|bbs|review|reviews|comment|comments|item|kol)(?:\/|[-_.]|$)/iu.test(url.pathname)
    || /^(?:\[?(?:推荐|推薦|书评|書評)|新闻[:：|]|网文独家|更新少却|番茄大神)/u.test(title)) return 'secondary'
  if (/第[零〇一二三四五六七八九十百千万\d]+章|\bchapter\s+\d+/iu.test(title)) return 'chapter'
  if (/(?:^|\/)(?:page|book|books|novel|novels)(?:\/|[-_.]|$)/iu.test(url.pathname)
    || /(?:最新章节|全文阅读|在线阅读|作品详情|作品目录|book details)/iu.test(title)) return 'book'
  return 'unknown'
}

function titleMatch(title: string, snippet: string, target: ResearchSearchTarget): ResearchSearchCandidate['titleMatch'] {
  const text = normalized(title), wanted = normalized(target.title)
  const derivativeSuffix = /^(?:\s*[-_|:：()（）]\s*)*(?:同人|衍生|番外|续篇|续传)/u
  const quoted = [...text.matchAll(/《([^》]+)》/gu)].filter(match => normalized(match[1]) === wanted)
  if (text === wanted || quoted.some(match => !derivativeSuffix.test(text.slice(match.index! + match[0].length)))) return 'exact'
  if (text.startsWith(wanted)) {
    const suffix = text.slice(wanted.length)
    const labeled = suffix.replace(/^\s*[-_|]\s*/u, '')
    const wrapperParts = labeled.split(/\s*[_|－-]\s*/u)
    const readingWrapper = /^(?:完整版)?(?:在线免费阅读|全文阅读|在线阅读|免费阅读)$/u.test(wrapperParts[0])
      && wrapperParts.slice(1).every(part => part === `${wanted}小说`
        || /^(?:[\p{Script=Han}a-z]{1,16}小说官网|官方网站|官网|official website)$/u.test(part) && !/同人|衍生|番外|续篇|续传/u.test(part))
    if (!derivativeSuffix.test(suffix) && (/^(?:第[零〇一二三四五六七八九十百千万\d]+章|最新章节|全文阅读|在线免费阅读|在线阅读|免费阅读)/iu.test(suffix)
      || readingWrapper
      || (target.author && labeled.startsWith(normalized(target.author)))
      || /^(?:作者[:：]|官网|官方网站|official\b)/iu.test(labeled))) return 'exact'
  }
  return text.includes(wanted) || normalized(snippet).includes(wanted) ? 'related' : 'absent'
}

/** Eligibility means a bounded candidate to read next, never verified identity,
 * chapter completeness, semantic progress, or permission to write a report. */
export function evaluateResearchSearchCandidates(query: string, results: readonly WebSearchResult[], target?: ResearchSearchTarget): ResearchSearchEvaluation {
  const { sites, invalid } = siteConstraints(query)
  const hosts: string[] = []
  let invalidHosts = false
  for (const value of target?.sourceHosts ?? []) {
    try {
      const url = parsePublicHttpUrl(`https://${value}`)
      if (url.pathname !== '/' || url.search || url.hash || hosts.length >= 8) { invalidHosts = true; continue }
      hosts.push(url.hostname.toLowerCase())
    } catch { invalidHosts = true }
  }
  const hasHardConstraints = Boolean(target?.title || sites.length || invalid || invalidHosts || target?.sourceHosts?.length)
  const candidates = results.map((result, index): ResearchSearchCandidate => {
    let url: URL
    try { url = parsePublicHttpUrl(result.url, true) }
    catch { return { index, eligible: false, hostMatch: false, siteMatch: false, titleMatch: 'absent', authorMatch: 'unknown', pageType: 'unknown', reasons: ['UNSAFE_SOURCE_URL'] } }
    const hostMatch = !invalidHosts && (!hosts.length || hosts.some(host => hostMatches(url.hostname.toLowerCase(), host)))
    const matchesSite = (site: SiteConstraint) => hostMatches(url.hostname.toLowerCase(), site.host)
      && (site.path === '/' || url.pathname === site.path || url.pathname.startsWith(`${site.path}/`))
    const positive = sites.filter(site => !site.exclude)
    const siteMatch = !invalid && (!positive.length || positive.some(matchesSite)) && !sites.some(site => site.exclude && matchesSite(site))
    const match = target?.title ? titleMatch(result.title, result.snippet, target) : 'unconstrained'
    const authorText = normalized(`${result.title}\n${result.snippet}`)
    const declaredAuthor = authorText.match(/(?:作者|author)\s*[:：]\s*([^\s，,。;；|_<>《》]{1,80})/iu)?.[1]
    const authorMatch = !target?.author ? 'unconstrained' : declaredAuthor && normalized(declaredAuthor) !== normalized(target.author)
      ? 'conflicting' : authorText.includes(normalized(target.author)) ? 'mentioned' : 'unknown'
    const pageType = resultPageType(url, result.title)
    const reasons: string[] = []
    if (!hostMatch) reasons.push('FROZEN_SOURCE_HOST_MISMATCH')
    if (!siteMatch) reasons.push(invalid ? 'QUERY_SITE_CONSTRAINT_INVALID' : 'QUERY_SITE_CONSTRAINT_MISMATCH')
    if (target?.title && match !== 'exact') reasons.push(match === 'related' ? 'TARGET_TITLE_RELATED_ONLY' : 'TARGET_TITLE_ABSENT')
    if (authorMatch === 'conflicting') reasons.push('TARGET_AUTHOR_CONFLICT')
    if (target?.title && pageType !== 'book' && pageType !== 'chapter') reasons.push(pageType === 'secondary' ? 'SECONDARY_SOURCE_ONLY' : pageType === 'homepage' ? 'PLATFORM_HOME_ONLY' : 'BOOK_PAGE_TYPE_UNCONFIRMED')
    return { index, eligible: reasons.length === 0, hostMatch, siteMatch, titleMatch: match, authorMatch, pageType, reasons }
  })
  const eligibleResults = results.filter((_result, index) => candidates[index].eligible)
  return { version: 1, queryHash: searchQueryHash(query), hasHardConstraints, resultCount: results.length,
    eligibleCount: eligibleResults.length, eligibleResults, candidates }
}

/** A navigation hint is neither a body candidate nor verified identity. Query
 * path operators guide recall; only original author site boundaries authorize
 * a navigation hop. No URL is generated from an ID or a title. */
export function evaluateResearchNavigationCandidates(results: readonly WebSearchResult[], target?: ResearchSearchTarget, sourceSites: readonly string[] = [], allowAlternative = false) {
  if (!target) return []
  const checked = evaluateResearchSearchCandidates(sourceSites.join(' '), results, target)
  return checked.candidates.filter(candidate => candidate.hostMatch && candidate.siteMatch
    && ((allowAlternative || !target.title) && candidate.pageType === 'book' || target.title && candidate.authorMatch !== 'conflicting' && candidate.titleMatch !== 'absent')
    && candidate.pageType !== 'homepage').map(candidate => ({ ...results[candidate.index], index: candidate.index,
      purpose: 'navigation' as const, verifiedOriginalText: false as const }))
}
