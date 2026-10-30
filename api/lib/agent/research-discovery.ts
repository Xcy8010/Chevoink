import type { ReaderTarget } from '../web-reader-quality.js'
import { normalizeResearchSearchQuery, researchSourceWithinScope } from './research-sources.js'

export type DiscoverySource = {
  id: string; url: string; title: string; failed: boolean
  pageType?: 'chapter' | 'book' | 'unknown'; eligible: boolean
  versions: Array<{ contentKind: string; verifiedChapter: boolean; links: Array<{ url: string; title: string }> }>
}
export type ResearchDiscoveryStep =
  | { name: 'web_read'; args: { sourceId: string; purpose?: 'navigation' }; reason: string }
  | { name: 'web_search'; args: { query: string; maxResults: number }; reason: string }

export const researchDiscoveryStepKey = (step: { name: string; args: Record<string, unknown> }) =>
  JSON.stringify([step.name, Object.keys(step.args).sort().map(key => [key, step.args[key]])])

/** Source acquisition decisions, not claims that a model has read the work.
 * Both branches use the same saved source/identity/integrity outcomes. */
export function planResearchDiscovery(input: {
  target: ReaderTarget; sources: DiscoverySource[]; queries: string[]; sourceSites?: readonly string[]
  consumed: Set<string>; searchRemaining: number; readRemaining: number
  navigation: boolean; allowedTools: readonly string[]
}): ResearchDiscoveryStep | null {
  const { target } = input
  const sites = input.sourceSites ?? []
  const sources = input.sources.filter(source => researchSourceWithinScope(source.url, target, sites))
  if (!target.title.trim() || sources.some(source => source.versions.some(version => version.verifiedChapter))) return null
  const allowed = (name: string) => input.allowedTools.includes(name)
  const positiveSites = sites.filter(site => site.startsWith('site:'))
  const preferredSites = positiveSites.length ? positiveSites : (target.sourceHosts?.length ? target.sourceHosts : ['fanqienovel.com'])
    .filter(host => researchSourceWithinScope(`https://${host}/`, target, sites)).map(host => `site:${host}`)
  const preferred = preferredSites.map(site => new URL(`https://${site.slice(5)}`).hostname)
  const rank = (url: string) => preferred.some(host => new URL(url).hostname === host || new URL(url).hostname.endsWith(`.${host}`)) ? 0 : 1
  if (allowed('web_read') && input.readRemaining > 0) {
    const parents = sources.flatMap(source => source.versions.flatMap(version => version.links.map(link => link.url)))
    const candidates = sources.filter(source => !source.failed && !source.versions.length && (source.eligible || parents.includes(source.url)))
      .sort((left, right) => rank(left.url) - rank(right.url))
    for (const source of candidates) {
      const step: ResearchDiscoveryStep = { name: 'web_read', args: { sourceId: source.id,
        ...(input.navigation && source.pageType === 'book' ? { purpose: 'navigation' as const } : {}) },
      reason: '沿搜索结果或已保存作品页的真实链接核对正文，摘要和链接本身不是已读内容。' }
      if (!input.consumed.has(researchDiscoveryStepKey(step))) return step
    }
  }
  if (!allowed('web_search') || input.searchRemaining <= 0) return null
  const book = `《${target.title}》`, author = target.author ? ` ${target.author}` : ''
  const base = `${book}${author}`
  const chapter = target.chapterTitle ? ` ${target.chapterTitle}` : ''
  const scoped = preferredSites.map(site => `${base}${chapter} ${site}`)
  const hardHosts = Boolean(target.sourceHosts?.length || positiveSites.length)
  const candidates = [
    ...scoped,
    ...preferredSites.map(site => `${base}${chapter || ' 第一章'}${chapter ? ' 正文' : ''} ${site}`),
    ...(hardHosts ? preferredSites.flatMap(site => [`${base}${chapter} 正文 ${site}`, `${base} 目录 ${site}`])
      : [`${base}${chapter} 正文`, `${base} 章节目录`, `${base}${chapter || ' 第一章'}`,
        ...[...new Set(sources.filter(source => source.eligible).map(source => new URL(source.url).hostname))]
          .filter(host => !preferred.includes(host)).map(host => `${base}${chapter} 正文 site:${host}`)]),
  ]
  const searched = new Set(input.queries.map(normalizeResearchSearchQuery))
  for (const candidate of candidates) {
    const query = [candidate, ...sites.filter(site => site.startsWith('-site:'))].join(' ')
    const step: ResearchDiscoveryStep = { name: 'web_search', args: { query, maxResults: 8 },
      reason: sources.some(source => source.failed) || sources.some(source => source.versions.length)
        ? '原来源未取得身份和完整性均合格的章节正文，保留原证据并切换检索方向或来源。'
        : '定位目标原作及其公开正文，优先原站并核对书名与作者。' }
    if (!searched.has(normalizeResearchSearchQuery(query)) && !input.consumed.has(researchDiscoveryStepKey(step))) return step
  }
  return null
}
