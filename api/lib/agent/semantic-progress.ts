import type { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import type { AgentMessagePart } from '../../../shared/contracts/index.js'

export function persistedContentHash(content: string): string {
  return createHash('sha256').update(JSON.stringify({ content })).digest('hex')
}

/** Seed both sides so returning A -> B -> A does not buy another recovery.
 * The caller supplies the authorized persisted target, never an audit/report ID. */
export function observeSemanticTransition(seen: Set<string>, target: string, beforeHash: string, afterHash: string): boolean {
  const key = (hash: string) => `content:${target}:${hash}`
  seen.add(key(beforeHash))
  const fresh = beforeHash !== afterHash && !seen.has(key(afterHash))
  seen.add(key(afterHash))
  return fresh
}

/** First actual verification of a required result is progress even when the
 * body is unchanged. Stage strings, report IDs and revision counters are not. */
export function observeRequiredResult(seen: Set<string>, target: string, contentHash: string): boolean {
  const key = `required:${target}:${contentHash}`
  const fresh = !seen.has(key)
  seen.add(key)
  return fresh
}

const contentReads = new Set(['chapter_read', 'plan_read', 'novel_get_context', 'chapter_list_summaries',
  'memory_search', 'volume_list', 'structure_outline', 'web_read', 'platform_novel_read', 'research_report_read',
  'project_search', 'entity_resolve', 'impact_analyze', 'directive_list', 'story_charter_get', 'character_voice_get', 'experience_anchor_get',
  'research_dossier_get', 'first_three_prototype_get', 'style_profile_get', 'retrieval_trace_read', 'memory_review_list', 'structure_validate'])

export type ChapterReadEvidence = { targetId: string; contentHash: string; start: number; end: number }

/** Track actual newly observed character ranges, not changing offset/limit labels.
 * The server supplies the full body hash; revisions and rereading subsets cannot
 * manufacture progress. The compact union survives checkpoint restoration. */
export function observeSemanticReadProgress(seen: Set<string>, action: string, output: string, chapter?: ChapterReadEvidence): boolean {
  if (action === 'chapter_read' && chapter) {
    if (!chapter.targetId || !/^[a-f0-9]{64}$/.test(chapter.contentHash)
      || !Number.isSafeInteger(chapter.start) || !Number.isSafeInteger(chapter.end)
      || chapter.start < 0 || chapter.end <= chapter.start) return false
    const prefix = `read-range:${JSON.stringify([chapter.targetId, chapter.contentHash])}:`
    const prior = [...seen].filter(key => key.startsWith(prefix))
    const ranges = prior.flatMap(key => {
      const match = /^(\d+)-(\d+)$/.exec(key.slice(prefix.length))
      return match ? [{ start: Number(match[1]), end: Number(match[2]) }] : []
    })
    const fresh = !ranges.some(range => range.start <= chapter.start && range.end >= chapter.end)
    ranges.push({ start: chapter.start, end: chapter.end })
    ranges.sort((a, b) => a.start - b.start || a.end - b.end)
    const merged: Array<{ start: number; end: number }> = []
    for (const range of ranges) {
      const last = merged.at(-1)
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
      else merged.push({ ...range })
    }
    prior.forEach(key => seen.delete(key))
    merged.forEach(range => seen.add(`${prefix}${range.start}-${range.end}`))
    return fresh
  }
  const identity = semanticReadIdentity(action, output)
  if (!identity) return false
  const fresh = !seen.has(identity)
  seen.add(identity)
  return fresh
}

/** Exact tool-owned wrappers only. Preserve source/body text and raw receipts. */
export function semanticReadIdentity(action: string, output: string): string | null {
  if (!contentReads.has(action)) return null
  // Exact empty results from these tool-owned views are workflow advice, not
  // a newly obtained research fact. A successful lookup alone is not progress.
  const emptyPrefixes: Record<string, string> = {
    research_dossier_get: '当前作品尚无研究档案。', first_three_prototype_get: '当前作品尚无前三章试制。',
    style_profile_get: '当前作品尚无已确认的作者 Style DNA。', memory_review_list: '记忆审核箱为空。',
    character_voice_get: '没有匹配的 Voice DNA。', experience_anchor_get: '没有确认经历锚点；',
    directive_list: '当前作品没有 active 指令。', story_charter_get: '当前作品尚未建立 Story Charter。',
  }
  if (emptyPrefixes[action] && output.startsWith(emptyPrefixes[action])) return null
  let content = output
  if (action === 'project_search') {
    const newline = content.indexOf('\n')
    const header = newline < 0 ? content : content.slice(0, newline)
    const body = newline < 0 ? '' : content.slice(newline)
    content = header.replace(/本次返回结果已保存为 artifactId=[A-Za-z0-9_-]+，/u, '本次返回结果已保存，')
      + body.replace(/^(- [^\n]*? \[(?:content|title|summary)@[0-9]+, chapterId=[A-Za-z0-9_-]+, )revision=[0-9]+(\])/gmu, '$1revision=已记录$2')
  }
  if (action === 'directive_list') content = content.replace(/^(- )directiveId=[A-Za-z0-9_-]+ /gmu, '$1')
  if (action === 'memory_review_list') content = content.replace(/^(- )memoryId=[A-Za-z0-9_-]+ /gmu, '$1')
  if (action === 'character_voice_get') content = content.replace(/^(.*?)@r[0-9]+ (\[[^\]]+\]：)/gmu, '$1 $2')
  if (action === 'style_profile_get') content = content.replace(/^Style DNA profileId=[A-Za-z0-9_-]+，/u, 'Style DNA，')
  if (action === 'retrieval_trace_read') {
    const selected = content.match(/^选择结果：(.*)$/mu)
    if (!selected) return null
    try { const value: unknown = JSON.parse(selected[1]); if (!Array.isArray(value) || value.length === 0) return null }
    catch { return null }
    content = content.replace(/\n记录时间：[^\n]+$/u, '')
  }
  if (action === 'research_dossier_get' || action === 'first_three_prototype_get' || action === 'story_charter_get') {
    // The tool owns this top-level view. Audit/version/stage fields do not make
    // the underlying research/planning content a new observation.
    try {
      const value: unknown = JSON.parse(content)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const view = value as Record<string, unknown>
        if (action === 'story_charter_get' && view.charter === null) return null
        if (action === 'story_charter_get') {
          const material = (item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).filter(([key]) => !['id', 'userId', 'novelId', 'revision', 'createdAt', 'updatedAt'].includes(key))) : item
          view.charter = material(view.charter)
          if (Array.isArray(view.promises)) view.promises = view.promises.map(material)
        }
        content = JSON.stringify(Object.fromEntries(Object.entries(view)
          .filter(([key]) => !['id', 'version', 'revision', 'status', 'createdAt', 'updatedAt', 'expiresAt', 'searchCount', 'reusedCount', 'reused', 'dossierId'].includes(key))))
      }
    } catch { /* Legacy text output retains body/source text; normalize its owned header only. */ }
    content = content.replace(/^Research Dossier v[0-9]+（[^\n]+）已复用，本次无需联网。dossierId=[A-Za-z0-9_-]+/u, 'Research Dossier 已复用，本次无需联网。')
      .replace(/^前三章试制 v[0-9]+（[^\n]+），prototypeId=[A-Za-z0-9_-]+。/u, '前三章试制。')
  }
  if (action === 'story_charter_get') content = content.replace(/^Story Charter r[0-9]+$/mu, 'Story Charter').replace(/promiseId=[A-Za-z0-9_-]+，/gu, '')
  if (action === 'research_report_read') {
    try {
      const view: unknown = JSON.parse(content)
      if (!view || typeof view !== 'object' || Array.isArray(view)) return null
      const { artifactId: _artifactId, revision: _revision, ...material } = view as Record<string, unknown>
      // Stable report/range and actual ordered contents remain; these IDs and
      // versions are authoritative read/CAS receipts, not fresh research facts.
      content = JSON.stringify(material)
    } catch { return null }
  }
  if (action === 'plan_read') {
    const newline = content.indexOf('\n')
    const header = newline < 0 ? content : content.slice(0, newline)
    content = header.replace(/planId=[A-Za-z0-9_-]+，/u, '') + (newline < 0 ? '' : content.slice(newline))
  }
  if (action === 'memory_search') content = content.replace(/（ID：[A-Za-z0-9_-]+；融合分 [0-9.]+）/gu, '（已检索）')
  if (action === 'web_read') {
    const footer = content.lastIndexOf('\n来源编号 sourceId=')
    if (footer >= 0) content = content.slice(0, footer) + content.slice(footer)
      .replace(/sourceId=[A-Za-z0-9_-]+/gu, 'sourceId=已保存')
      .replace(/contentRef=[A-Za-z0-9_-]+/gu, 'contentRef=已保存')
      .replace(/revision=[0-9]+/gu, 'revision=已记录')
  }
  return `read:${action}:${createHash('sha256').update(content).digest('hex')}`
}

/** Consecutive same-state batches, not a cumulative task allowance. */
export function nextStagnantBatch(previous: number, progressed: boolean, healthyChildWaiting = false): number {
  if (healthyChildWaiting) return previous
  return progressed ? 0 : previous + 1
}

/** Legacy cards contain actual before/after bodies. New plan artifact IDs are
 * audit identity; recreating the same plan content is not fresh work. */
export function observeLegacyContentProgress(seen: Set<string>, part: Extract<AgentMessagePart, { type: 'tool-call' }>): boolean {
  if (part.status !== 'success') return false
  const display = part.display
  if (display?.kind === 'chapterDiff' && display.appliedDirectly) return observeSemanticTransition(seen, `chapter:${display.chapterId}`,
    persistedContentHash(display.before), persistedContentHash(display.after))
  if (display?.kind === 'planDiff') return observeSemanticTransition(seen, 'plan', persistedContentHash(display.before), persistedContentHash(display.after))
  if (display?.kind === 'planFile' && display.content.trim()) return observeSemanticTransition(seen, 'plan', persistedContentHash(''), persistedContentHash(display.content))
  return false
}

/** Only actual layout/content fields; revision and audit IDs remain in admission receipts. */
export async function readSemanticStructureHash(tx: Pick<Prisma.TransactionClient, 'volume' | 'chapter'>, novelId: string): Promise<string> {
  const volumes = await tx.volume.findMany({ where: { novelId, archivedAt: null }, orderBy: { id: 'asc' },
    select: { id: true, title: true, summary: true, orderIndex: true } })
  const chapters = await tx.chapter.findMany({ where: { novelId, archivedAt: null, volume: { novelId, archivedAt: null } }, orderBy: { id: 'asc' },
    select: { id: true, title: true, content: true, volumeId: true, orderIndex: true, orderInVolume: true } })
  return createHash('sha256').update(JSON.stringify({ volumes, chapters: chapters.map(({ content, ...chapter }) => ({ ...chapter, contentHash: persistedContentHash(content) })) })).digest('hex')
}
