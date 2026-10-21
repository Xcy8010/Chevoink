import type { AgentToolDisplayPayload } from './contracts/index.js'

export type AppliedQualityBodyChange = NonNullable<Extract<AgentToolDisplayPayload, { kind: 'qualityReport' }>['appliedBodyChange']>
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** Presentation data only. This never grants write authority or creates a pending author review. */
export function qualityAppliedBodyChange(display: unknown): AppliedQualityBodyChange | null {
  const report = object(display), change = object(report?.appliedBodyChange)
  if (report?.kind !== 'qualityReport' || report.status !== 'repaired' || !change || change.version !== 1
    || typeof change.chapterId !== 'string' || !change.chapterId || change.chapterId !== report.chapterId
    || typeof change.chapterTitle !== 'string' || typeof change.before !== 'string' || typeof change.after !== 'string'
    || change.before === change.after || typeof change.sourceRevision !== 'number' || !Number.isSafeInteger(change.sourceRevision) || change.sourceRevision < 1
    || typeof change.targetRevision !== 'number' || !Number.isSafeInteger(change.targetRevision) || change.targetRevision !== change.sourceRevision + 1
    || change.targetRevision !== report.chapterRevision || typeof report.repairRound !== 'number' || report.repairRound < 1) return null
  return { version: 1, chapterId: change.chapterId, chapterTitle: change.chapterTitle, before: change.before, after: change.after,
    sourceRevision: change.sourceRevision, targetRevision: change.targetRevision }
}
