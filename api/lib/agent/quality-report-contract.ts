import { createHash } from 'node:crypto'

type RepairFinding = { severity: string; startOffset: number; endOffset: number; disposition?: string; authorFeedback?: string | null }

/** 自动修订的可预期拦截：保留报告与正文；通道关闭类只提示、不判失败；
 * 过期证据或范围冲突仍返回失败，不能冒充已修复。 */
export const REPAIR_BLOCK_CODES = new Set([
  'QUALITY_REPAIR_LIMIT',
  'QUALITY_REPORT_STALE',
  'QUALITY_EVIDENCE_STALE',
  'QUALITY_PATCH_OVERLAP',
  'QUALITY_FINDING_SCOPE_INVALID',
  'QUALITY_REPAIR_NO_CHANGE',
  'QUALITY_COMPILATION_SCOPE_INVALID',
  'QUALITY_RUN_SCOPE_INVALID',
  'REPAIR_NOT_AUTHORIZED',
  'REVIEW_AUTOMATION_STOPPED',
  'REVIEW_REPAIR_RECHECK_REQUIRED',
])

/** 通道关闭类不是证据失效：只提示原因，不把工具标成失败。 */
export const REPAIR_CHANNEL_CODES = new Set([
  'QUALITY_REPAIR_LIMIT',
  'QUALITY_REPAIR_NO_CHANGE',
  'REPAIR_NOT_AUTHORIZED',
  'REVIEW_AUTOMATION_STOPPED',
  'REVIEW_REPAIR_RECHECK_REQUIRED',
])

/** 严谨模式一次集中处理警告与建议；保留优先级、作者拒绝、重叠和数量保护。 */
export function selectAutomaticQualityFindings<T extends RepairFinding>(findings: T[]): T[] {
  const selected: T[] = []
  const rank = (severity: string) => severity === 'error' ? 0 : severity === 'warning' ? 1 : 2
  for (const finding of [...findings].sort((a, b) => rank(a.severity) - rank(b.severity) || a.startOffset - b.startOffset)) {
    if (finding.disposition === 'repaired' || finding.authorFeedback === 'rejected') continue
    if (selected.some(item => finding.startOffset < item.endOffset && item.startOffset < finding.endOffset)) continue
    selected.push(finding)
    if (selected.length === 8) break
  }
  return selected
}

/** 检查报告缓存不等于已执行修订；失败/已尝试/已改文的报告均不得重新派发。 */
export function qualityAutoRepairPending(report: { status: string; repairRound: number; deterministicMetrics: unknown; findings: RepairFinding[] }): boolean {
  const metrics = report.deterministicMetrics
  return ['passed', 'needs_repair'].includes(report.status) && report.repairRound === 0
    && !!metrics && typeof metrics === 'object' && !Array.isArray(metrics)
    && (metrics as Record<string, unknown>).autoRepairAttempted !== true
    && selectAutomaticQualityFindings(report.findings).length > 0
}

/** Revision alone cannot certify a failed critic or an unreviewed replacement. */
export function qualityReportMatchesContent(report: { status: string; chapterRevision: number; deterministicMetrics: unknown }, revision: number, content: string): boolean {
  const metrics = report.deterministicMetrics
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return false
  const value = metrics as Record<string, unknown>
  const expected = report.status === 'repaired' ? value.repairedContentHash : value.contentHash
  return report.chapterRevision === revision && ['passed', 'needs_repair', 'repaired'].includes(report.status)
    && value.independentCheck === 'complete' && expected === createHash('sha256').update(content).digest('hex')
}

/** A repair receipt certifies a patch, not a critic assessment of its result. */
export function qualityReportCheckedCurrentContent(report: { status: string; chapterRevision: number; deterministicMetrics: unknown }, revision: number, content: string): boolean {
  const metrics = report.deterministicMetrics
  return !!metrics && typeof metrics === 'object' && !Array.isArray(metrics)
    && ['passed', 'needs_repair'].includes(report.status) && report.chapterRevision === revision
    && (metrics as Record<string, unknown>).independentCheck === 'complete'
    && (metrics as Record<string, unknown>).contentHash === createHash('sha256').update(content).digest('hex')
}
