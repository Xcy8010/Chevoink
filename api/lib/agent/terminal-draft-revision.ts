import type { Prisma } from '@prisma/client'
import type { AgentMessagePart } from '../../../shared/contracts/index.js'
import { runtimeJson } from './runtime-common.js'
import { readNewDraftRevision, readNewDraftWritingAuthority } from './writing-scope.js'
import { recoverQualityBodyChange } from './quality-body-change-history.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Read an already consumed, single quality repair. This certifies a historical
 * body transition only; it never grants a write or consumes another allowance. */
export async function authenticatedTerminalDraftRevision(db: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string; compilationId: string; signal?: AbortSignal },
  taskId: string, runIds: string[], chapter: { id: string; revision: number; orderIndex: number; content: string },
  validation: unknown, before: { revision: number; content: string }) {
  subject.signal?.throwIfAborted()
  const receipt = readNewDraftRevision(validation)
  if (!receipt || receipt.taskId !== taskId || receipt.chapterId !== chapter.id || receipt.compilationId !== subject.compilationId
    || receipt.checkedRevision !== before.revision || chapter.revision !== before.revision + 1
    || receipt.beforeHash !== runtimeJson({ content: before.content }).hash || receipt.afterHash !== runtimeJson({ content: chapter.content }).hash
    || before.content === chapter.content) return false
  if ((await readNewDraftWritingAuthority(db, subject, chapter))?.taskId !== taskId) return false
  const [reports, artifacts, messages] = await Promise.all([
    db.chapterQualityReport.findMany({ where: { userId: subject.userId, novelId: subject.novelId, runId: { in: runIds },
      compilationId: subject.compilationId, chapterId: chapter.id, chapterRevision: chapter.revision, status: 'repaired', repairRound: 1 },
    include: { findings: true, chapter: { select: { title: true } } }, take: 2 }),
    db.agentArtifact.findMany({ where: { runId: { in: runIds }, run: { userId: subject.userId, novelId: subject.novelId }, artifactType: 'rewriteSelection',
      metadata: { path: ['phase'], equals: 'humanity_revision_auto' } }, take: 1001 }),
    db.agentMessage.findMany({ where: { runId: { in: runIds }, run: { userId: subject.userId, novelId: subject.novelId }, role: 'assistant' },
      select: { runId: true, parts: true }, take: 1001 }),
  ])
  if (reports.length !== 1 || artifacts.length > 1000 || messages.length > 1000) return false
  const report = reports[0], metrics = object(report.deterministicMetrics)
  if (report.userId !== subject.userId || report.novelId !== subject.novelId || report.compilationId !== subject.compilationId
    || report.chapterId !== chapter.id || report.chapterRevision !== chapter.revision || report.status !== 'repaired' || report.repairRound !== 1
    || !report.runId || !runIds.includes(report.runId) || metrics.independentCheck !== 'complete'
    || metrics.sourceRevision !== before.revision || report.findings.some(finding => finding.userId !== subject.userId || finding.novelId !== subject.novelId)) return false
  const selected = artifacts.filter(row => object(row.metadata).reportId === report.id)
  if (selected.length !== 1 || selected[0].runId !== report.runId) return false
  const parts = messages.flatMap(message => Array.isArray(message.parts) ? (message.parts as AgentMessagePart[]).flatMap(part =>
    part.type === 'tool-call' && part.toolName === 'quality_analyze' && part.status === 'success'
      && part.display?.kind === 'qualityReport' && part.display.status === 'repaired' && part.display.reportId === report.id
      ? [{ runId: message.runId, part }] : []) : [])
  if (parts.length !== 1 || parts[0].runId !== report.runId || parts[0].part.snapshot?.previousValue !== before.content) return false
  // Existing presentation data is not an attestation. Strip it and rebuild
  // every patch ID/range/evidence hash and non-overlap check from owned rows.
  const part = parts[0].part, display = part.display!
  if (display.kind !== 'qualityReport') return false
  const rebuilt = recoverQualityBodyChange(report.runId, { ...part, display: { ...display, appliedBodyChange: undefined } }, report, selected)
  const change = rebuilt.display?.kind === 'qualityReport' ? rebuilt.display.appliedBodyChange : undefined
  subject.signal?.throwIfAborted()
  return !!change && change.sourceRevision === before.revision && change.targetRevision === chapter.revision
    && change.before === before.content && change.after === chapter.content
}
