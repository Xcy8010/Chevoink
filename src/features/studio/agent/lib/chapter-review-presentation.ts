import type { AgentToolDisplayPayload } from '../../../../../shared/contracts/index.js'

type ReviewBatch = Extract<AgentToolDisplayPayload, { kind: 'reviewBatch' }>

export function isOpenReviewFinding(finding: NonNullable<ReviewBatch['chapters'][number]['findings']>[number]) {
  return !finding.disposition && finding.severity !== 'advisory'
}

export function reviewBatchHeadline(display: ReviewBatch) {
  const label = { continuity: '章节衔接复查', quality: '行文自然度复查', custom: '自定义复查' }[display.reviewType]
  const { chapters } = display
  const orders = [...new Set(chapters.map(chapter => chapter.orderIndex))].sort((a, b) => a - b)
  const first = orders[0]
  const last = orders.at(-1)
  const range = !first ? '' : first === last ? `第 ${first} 章 · `
    : last === first + orders.length - 1 ? `第 ${first}–${last} 章 · ` : `${orders.length} 章 · `
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
