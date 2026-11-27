import type { AgentToolDisplayPayload } from '../../../../../shared/contracts/index.js'
import { getAgentToolPresentation } from '../../../../../shared/agent-tool-presentation.js'

type ReviewBatch = Extract<AgentToolDisplayPayload, { kind: 'reviewBatch' }>
const reviewLabels = { continuity: '章节衔接复查', quality: '行文自然度复查', custom: '自定义复查' }

function reviewRange(orderIndexes: number[]) {
  const orders = [...new Set(orderIndexes)].sort((a, b) => a - b)
  const first = orders[0]
  const last = orders.at(-1)
  return !first ? '' : first === last ? `第 ${first} 章 · `
    : last === first + orders.length - 1 ? `第 ${first}–${last} 章 · ` : `${orders.length} 章 · `
}

/** Failed calls have no report. Only use a known review type and directory-backed chapter numbers. */
export function reviewBatchFailureHeadline(args: unknown, chapters?: ReadonlyMap<string, { orderIndex: number }>) {
  const input = args as { reviewType?: unknown; chapterIds?: unknown } | null
  const type = input?.reviewType
  const label = type === 'continuity' || type === 'quality' || type === 'custom'
    ? reviewLabels[type] : getAgentToolPresentation('chapter_review_batch').label
  const ids = input?.chapterIds
  const orders = Array.isArray(ids) ? [...new Set<unknown>(ids)].map(id => typeof id === 'string' ? chapters?.get(id)?.orderIndex : undefined) : []
  const range = orders.length >= 2 && orders.every((order): order is number => typeof order === 'number' && Number.isSafeInteger(order) && order > 0)
    ? reviewRange(orders) : ''
  return `${range}${label}未完成`
}

export function isOpenReviewFinding(finding: NonNullable<ReviewBatch['chapters'][number]['findings']>[number]) {
  return !finding.disposition && finding.severity !== 'advisory'
}

export function reviewBatchHeadline(display: ReviewBatch) {
  const label = reviewLabels[display.reviewType]
  const { chapters } = display
  const range = reviewRange(chapters.map(chapter => chapter.orderIndex))
  const incomplete = chapters.filter(chapter => chapter.status === 'incomplete').length
  const stale = chapters.filter(chapter => chapter.status === 'stale').length
  const current = chapters.filter(chapter => chapter.status === 'complete')
  const findings = current.flatMap(chapter => chapter.findings ?? [])
  const repaired = findings.filter(finding => finding.disposition === 'repaired').length
  const pending = findings.filter(isOpenReviewFinding).length
  const notes = findings.filter(finding => !finding.disposition && finding.severity === 'advisory').length
  const outcome = incomplete + stale === 0 ? '完成' : incomplete === chapters.length ? '未完成' : ''
  return [
    `${range}${label}${outcome}`,
    !outcome && current.length > 0 ? `${current.length} 章完成` : null,
    !outcome && incomplete > 0 ? `${incomplete} 章未完成` : null,
    stale ? stale === chapters.length ? '旧版报告' : `${stale} 章有新版正文` : null,
    pending ? `${pending} 处待核对` : null,
    repaired ? `${repaired} 处已修正` : null,
    notes ? `${notes} 条建议` : null,
  ].filter(Boolean).join(' · ')
}
