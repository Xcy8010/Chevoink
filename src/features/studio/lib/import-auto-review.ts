import type { NovelImportReportDto } from '../../../../shared/contracts/novel-import-preview.js'
import type { ImportReviewEdit } from '../import-preview-api'

const coverageCodes = new Set(['IMPORT_NATIVE_COVERAGE', 'IMPORT_NATIVE_INCOMPLETE_CONTENT'])

/** Match the server's review gate; resolved issues still constrain valid decisions. */
export function canHumanReviewImportItem(item: NovelImportReportDto['items'][number], issues: NovelImportReportDto['issues']) {
  const blocking = issues.filter(issue => issue.blocking && !coverageCodes.has(issue.code) && issue.itemIds.includes(item.id))
  return item.status !== 'failed' && item.status !== 'excluded' && blocking.length > 0
    && blocking.every(issue => issue.resolution === 'review')
}

/** Never manufacture human review. Only exact file/page exclusions are automatic. */
export function planImportAutoReview(report: NovelImportReportDto): { decisions: ImportReviewEdit['decisions']; reason: string | null } {
  const candidates = new Set<string>()
  const items = new Map(report.items.map(item => [item.id, item]))
  const excluded = new Set(report.decisions.filter(decision => decision.action === 'exclude').map(decision => decision.itemId))
  const blocked = (reason: string) => ({ decisions: [], reason })
  if (items.size !== report.items.length) return blocked('来源编号重复，无法安全定位排除项目，请重新解析。')
  for (const issue of report.issues) {
    if (!issue.blocking || issue.resolved) continue
    if (!issue.itemIds.length || issue.itemIds.some(id => !items.has(id))) return blocked('无法定位问题来源，不能安全自动排除。请在预览中核对或重新解析。')
    // Aggregate coverage includes healthy pages: never exclude its entire itemIds list.
    if (coverageCodes.has(issue.code)) continue
    if (issue.resolution !== 'exclude') return blocked(`${issue.message}：需要人工处理，自动流程不会代替人工核对。`)
    for (const id of issue.itemIds) if (!excluded.has(id)) candidates.add(id)
  }
  for (const item of report.items) {
    if (excluded.has(item.id) || item.status === 'excluded') continue
    if (item.status === 'failed') candidates.add(item.id)
    if (item.status === 'needs_review' && !candidates.has(item.id)
      && !report.decisions.some(decision => decision.itemId === item.id && decision.action === 'review')) {
      return blocked('来源仍需人工核对；自动流程不会声明已对照原文。请在预览中处理。')
    }
  }
  const decisions: ImportReviewEdit['decisions'] = []
  for (const id of candidates) {
    const item = items.get(id)!
    if (!item.excludable || !item.source.trim() || !['file', 'page'].includes(item.kind)
      || (item.kind === 'page' && report.items.some(other => other.id !== item.id && ['file', 'page'].includes(other.kind) && other.source === item.source))) {
      return blocked('缺失或失败项目无法安全定位到可排除的整页或文件。请在预览中选择来源处理，不会扩大排除范围。')
    }
    decisions.push({ itemId: id, action: 'exclude', reason: '自动排除缺失或处理失败的来源；未进行人工核对，须在预览确认部分导入。' })
  }
  if (decisions.length > 1000) return blocked('待排除来源超过单次处理上限，请在预览中分批处理。')
  return { decisions, reason: null }
}
