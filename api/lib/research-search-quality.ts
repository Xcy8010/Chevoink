import { createHash } from 'node:crypto'
import { parsePublicHttpUrl } from './public-http.js'
import type { WebSearchResult } from './web-search-service.js'

/** Supplied by the frozen server task, never by search-result text. */
export type ResearchSearchTarget = { title: string; author?: string; sourceHosts?: readonly string[]; purpose?: 'lookup'; sourceSites?: readonly string[] }
export type ResearchSearchCandidate = {
  index: number
  eligible: boolean
  hostMatch: boolean
  siteMatch: boolean
  titleMatch: 'exact' | 'related' | 'absent' | 'unconstrained'
  authorMatch: 'mentioned' | 'conflicting' | 'unknown' | 'unconstrained'
  publicationMatch?: 'within' | 'outside' | 'unknown'
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

/** A plain book lookup needs a complete name, even outside the chapter-
 * research workflow. The goal supplies a local results filter, never query text. */
export function bookLookupTarget(query: string, goals: readonly string[] = []): ResearchSearchTarget | undefined {
  const named = (text: string) => [...text.matchAll(/《([^《》\r\n]{1,120})》/gu)].map(match => match[1].trim()).filter(Boolean)
  const colloquial = (text: string) => [...text.matchAll(/(?:查找|寻找|检索|搜索|搜搜|找找|查查|搜|找|查)(?:一下|一找|一查|一搜|一部|一本)?\s*(?:名为|名叫|叫做|叫作)?\s*([^《》“”"'，,。！？!?；;\r\n]{1,80}?)\s*(?:这本(?:小说|书)|这部(?:小说|作品))/gu)].map(match => match[1].trim())
  const names = (text: string) => [...named(text), ...colloquial(text)]
  const authorTitles = [...new Set(goals.flatMap(names))]
  const titles = new Set((authorTitles.length ? authorTitles : names(query)).filter(title => title && normalized(query).includes(normalized(title))))
  const bookWords = /小说|这本书|书名|作者|书目|搜书|找书|图书|正版|出版社|阅读入口|作品页|中文网|书城|连载|\b(?:novel|book|publisher)\b/iu
  if (!titles.size && authorTitles.length === 1 && (bookWords.test(query) || named(query).length)) titles.add(authorTitles[0])
  if (titles.size !== 1) return
  const title = [...titles][0]
  if (!bookWords.test([query, ...goals].join('\n').split(title).join(''))) return
  return { title, purpose: 'lookup' }
}

/** Strengthen one existing free fallback without adding a call or relaxing any operator. */
export function quotedBookLookupQuery(query: string, target?: ResearchSearchTarget) {
  const title = target?.title
  if (target?.purpose !== 'lookup' || !title || /["\r\n]/u.test(title) || query.includes(`"${title}"`)) return query
  const wrapped = `《${title}》`
  // Never quote text inside an operator, URL, negative term or an existing phrase.
  const protectedTerms = [...query.matchAll(/-?[\w-]+:\s*(?:"[^"]*"|'[^']*'|[^\s)]+)|-[^\s)]+|"[^"]*"|'[^']*'/gu)]
  for (const name of [wrapped, title]) {
    for (let at = query.indexOf(name); at >= 0; at = query.indexOf(name, at + name.length)) {
      const end = at + name.length
      if (protectedTerms.some(term => at < term.index + term[0].length && end > term.index)) continue
      if (name === title && (/[\p{L}\p{N}_]$/u.test(query.slice(0, at)) || /^[\p{L}\p{N}_]/u.test(query.slice(end)))) continue
      return query.slice(0, at) + '"' + title + '"' + query.slice(end)
    }
  }
  return query
}

function publicationBounds(query: string) {
  let from = -Infinity, before = Infinity
  const operators = query.replace(/"[^"]*"/gu, ' ')
  for (const [, op, text] of operators.matchAll(/(?:^|[\s(])(after|before):(\d{4}(?:-\d{2}-\d{2})?)(?=$|[\s)])/giu)) {
    const day = text.length === 4 ? `${text}-01-01` : text
    const time = Date.parse(day)
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== day) continue
    if (op.toLowerCase() === 'after') from = Math.max(from, time)
    else before = Math.min(before, time)
  }
  return { from, before, constrained: from !== -Infinity || before !== Infinity }
}

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

function lookupNamesWork(title: string, description: string, target: string, pageType: ResearchSearchCandidate['pageType']) {
  const wanted = normalized(target), label = normalized(title)
  const otherEdition = /^\s*[-_:·]?\s*(?:同人|衍生|番外|续篇|续传|第[二三四五六七八九十\d]+部|[2-9]|ii\b|iii\b)/iu
  const quoted = [...label.matchAll(/《([^》]+)》/gu)]
  if (quoted.length) return quoted.some(book => book[1].trim() === wanted && !otherEdition.test(label.slice(book.index! + book[0].length)))
  if (label.includes(wanted)) {
    for (let at = label.indexOf(wanted); at >= 0; at = label.indexOf(wanted, at + wanted.length)) {
      const suffix = label.slice(at + wanted.length)
      if (/[\p{L}\p{N}]$/u.test(label.slice(0, at)) || otherEdition.test(suffix)) continue
      if (!/^[\p{L}\p{N}]/u.test(suffix) || (at === 0 && titleMatch(title, '', { title: target }) === 'exact')) return true
    }
    return false
  }
  return pageType === 'book' && normalized(description).includes(`《${wanted}》`)
}

/** Eligibility means a bounded candidate to read next, never verified identity,
 * chapter completeness, semantic progress, or permission to write a report. */
export function evaluateResearchSearchCandidates(query: string, results: readonly WebSearchResult[], target?: ResearchSearchTarget): ResearchSearchEvaluation {
  const querySites = siteConstraints(query)
  const siteScopes = target?.sourceSites?.length ? [querySites, siteConstraints(target.sourceSites.join(' '))] : [querySites]
  const invalid = siteScopes.some(scope => scope.invalid)
  const publication = publicationBounds(query)
  const hosts: string[] = []
  let invalidHosts = false
  for (const value of target?.sourceHosts ?? []) {
    try {
      const url = parsePublicHttpUrl(`https://${value}`)
      if (url.pathname !== '/' || url.search || url.hash || hosts.length >= 8) { invalidHosts = true; continue }
      hosts.push(url.hostname.toLowerCase())
    } catch { invalidHosts = true }
  }
  const hasHardConstraints = Boolean(target?.title || siteScopes.some(scope => scope.sites.length) || invalid || invalidHosts || target?.sourceHosts?.length || publication.constrained)
  const candidates = results.map((result, index): ResearchSearchCandidate => {
    let url: URL
    try { url = parsePublicHttpUrl(result.url, true) }
    catch { return { index, eligible: false, hostMatch: false, siteMatch: false, titleMatch: 'absent', authorMatch: 'unknown', pageType: 'unknown', reasons: ['UNSAFE_SOURCE_URL'] } }
    const hostMatch = !invalidHosts && (!hosts.length || hosts.some(host => hostMatches(url.hostname.toLowerCase(), host)))
    const matchesSite = (site: SiteConstraint) => hostMatches(url.hostname.toLowerCase(), site.host)
      && (site.path === '/' || url.pathname === site.path || url.pathname.startsWith(`${site.path}/`))
    const siteMatch = !invalid && siteScopes.every(({ sites }) => {
      const positive = sites.filter(site => !site.exclude)
      return (!positive.length || positive.some(matchesSite)) && !sites.some(site => site.exclude && matchesSite(site))
    })
    const descriptions = `${result.snippet}\n${result.summary ?? ''}`
    const match = target?.title ? titleMatch(result.title, descriptions, target) : 'unconstrained'
    const authorText = normalized(`${result.title}\n${descriptions}`)
    const declaredAuthor = authorText.match(/(?:作者|author)\s*[:：]\s*([^\s，,。;；|_<>《》]{1,80})/iu)?.[1]
    const authorMatch = !target?.author ? 'unconstrained' : declaredAuthor && normalized(declaredAuthor) !== normalized(target.author)
      ? 'conflicting' : authorText.includes(normalized(target.author)) ? 'mentioned' : 'unknown'
    const pageType = resultPageType(url, result.title)
    const publishedAt = result.publishedAt ? Date.parse(result.publishedAt) : NaN
    const publicationMatch = !publication.constrained ? undefined : !Number.isFinite(publishedAt) ? 'unknown'
      : publishedAt >= publication.from && publishedAt < publication.before ? 'within' : 'outside'
    const reasons: string[] = []
    if (!hostMatch) reasons.push('FROZEN_SOURCE_HOST_MISMATCH')
    if (!siteMatch) reasons.push(invalid ? 'QUERY_SITE_CONSTRAINT_INVALID' : 'QUERY_SITE_CONSTRAINT_MISMATCH')
    const lookup = target?.purpose === 'lookup'
    if (target?.title && (lookup ? !lookupNamesWork(result.title, descriptions, target.title, pageType) : match !== 'exact')) reasons.push(match === 'related' ? 'TARGET_TITLE_RELATED_ONLY' : 'TARGET_TITLE_ABSENT')
    if (authorMatch === 'conflicting') reasons.push('TARGET_AUTHOR_CONFLICT')
    if (publicationMatch === 'outside') reasons.push('PUBLICATION_DATE_OUTSIDE_QUERY')
    const needsReadingEntry = lookup && /正版|阅读入口|官方|全文阅读|作品页|书籍详情/u.test(query) && !/访谈|公告|新闻|采访/u.test(query)
    if (target?.title && pageType !== 'book' && pageType !== 'chapter' && (!lookup || needsReadingEntry || pageType === 'homepage')) reasons.push(pageType === 'secondary' ? 'SECONDARY_SOURCE_ONLY' : pageType === 'homepage' ? 'PLATFORM_HOME_ONLY' : 'BOOK_PAGE_TYPE_UNCONFIRMED')
    return { index, eligible: reasons.length === 0, hostMatch, siteMatch, titleMatch: match, authorMatch, pageType,
      ...(publicationMatch ? { publicationMatch } : {}), reasons }
  })
  const eligibleResults = results.filter((_result, index) => candidates[index].eligible)
  return { version: 1, queryHash: searchQueryHash(query), hasHardConstraints, resultCount: results.length,
    eligibleCount: eligibleResults.length, eligibleResults, candidates }
}

/** Order candidates for inspection. Provider scores and dates are discovery
 * signals; the actual source text still determines what it supports. */
export function rankResearchSearchResults(query: string, results: readonly WebSearchResult[], target?: ResearchSearchTarget): WebSearchResult[] {
  const evaluated = evaluateResearchSearchCandidates(query, results, target)
  const rank = (candidate: ResearchSearchCandidate) => {
    const { authority = -1, rerankScore = -1 } = results[candidate.index]
    // Eligibility and known target identity outrank supplier quality. Use
    // supplier reranking and authority jointly within otherwise suitable hits.
    return [Number(candidate.eligible), Number(candidate.eligible && candidate.authorMatch === 'mentioned'),
      Number(target?.purpose === 'lookup' && candidate.eligible && candidate.pageType === 'book'),
      Number(candidate.publicationMatch === 'within'), Number(rerankScore >= 1.5), Number(authority >= 3), rerankScore, authority]
  }
  return evaluated.candidates.map(candidate => ({ index: candidate.index, rank: rank(candidate) }))
    .sort((a, b) => {
      for (let i = 0; i < a.rank.length; i++) {
        const difference = b.rank[i] - a.rank[i]
        if (difference) return difference
      }
      return a.index - b.index
    }).map(({ index }) => results[index])
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
