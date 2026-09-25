import { createHash } from 'node:crypto'

type RepairFinding = { severity: string; startOffset: number; endOffset: number; disposition?: string; authorFeedback?: string | null }

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
