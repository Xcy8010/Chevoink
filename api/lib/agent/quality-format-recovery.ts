import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { buildHumanityQualityContext, getLatestQualityReport, qualityReviewContextHash } from './humanity-quality.js'
import { readQualityUnavailableProof } from './quality-unavailable-proof.js'
import { runtimeJson } from './runtime-common.js'
import { readQualityReviewAdmission } from './quality-review-admission.js'
import { readOrphanQualityRecoveryProofs } from './quality-orphan-recovery.js'

type Subject = { userId: string; novelId: string; runId: string }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const hashText = (value: string) => createHash('sha256').update(value).digest('hex')
const formatClasses = new Set(['json_invalid', 'incomplete_json', 'envelope_invalid', 'ambiguous_envelope', 'duplicate_keys', 'findings_invalid', 'source_invalid'])
export const qualityFormatRecoverySchema = z.object({ version: z.literal(1), key: z.string(), taskId: z.string(), reportId: z.string(),
  chapterId: z.string(), chapterRevision: z.number().int().positive(), compilationId: z.string().nullable(), contextHash: z.string(), evidenceHash: z.string(),
  admissionId: z.string().optional() }).strict()
export type QualityFormatRecovery = z.infer<typeof qualityFormatRecoverySchema>
/** This witness can only originate inside the server's current tool execution,
 * after a completed response. Old reports always require persisted call/result proof. */
export type CurrentQualityFormatWitness = { callId: string; startedAt: Date; contentHash: string; characterCount: number }

/** A compilation is context, not a new format-recovery allowance. Provider
 * admission is itself a durable claim, even if its later report effect rolls back. */
export async function hasQualityFormatRecoveryClaim(tx: Prisma.TransactionClient, subject: Subject,
  chapterId: string, chapterRevision: number, exceptOperationId?: string) {
  const original = await readOriginalTaskRequest(tx, subject)
  const ids = await originalTaskRunIds(tx, subject, original)
  const run = await tx.agentRun.findFirstOrThrow({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  const admission = await readQualityReviewAdmission(tx, run)
  const orphanProofs = admission ? await readOrphanQualityRecoveryProofs(tx, subject, ids, original.taskId, chapterId, chapterRevision) : new Map()
  const reports = await tx.chapterQualityReport.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    chapterId, OR: [{ runId: { in: ids } }, { id: { in: [...orphanProofs.keys()] } }] }, select: { id: true, runId: true, deterministicMetrics: true, updatedAt: true } })
  if (reports.some(item => {
    const metrics = object(item.deterministicMetrics)
    return [metrics.formatRecovery, ...(Array.isArray(metrics.formatRecoveryHistory) ? metrics.formatRecoveryHistory : [])].some(value => {
      const claim = object(value)
      const oldAdmission = admission && (claim.admissionId ? claim.admissionId !== admission.id
        : (typeof claim.claimedAt === 'string' ? new Date(claim.claimedAt) : item.updatedAt) < admission.at)
      const finished = claim.state !== 'claimed' || reports.some(final => {
        const finalMetrics = object(final.deterministicMetrics)
        return final.id !== item.id && (final.runId === claim.claimRunId || (orphanProofs.get(final.id)?.sourceReportId === item.id
          && orphanProofs.get(final.id)?.key === claim.key && orphanProofs.get(final.id)?.claimRunId === claim.claimRunId))
          && [finalMetrics.formatRecovery, ...(Array.isArray(finalMetrics.formatRecoveryHistory) ? finalMetrics.formatRecoveryHistory : [])].some(value => {
            const link = object(value)
            return ['failed', 'completed'].includes(String(link.state)) && link.reportId === item.id
              && link.key === claim.key && link.evidenceHash === claim.evidenceHash
          })
      })
      return claim.taskId === original.taskId && claim.chapterId === chapterId && claim.chapterRevision === chapterRevision
      && (!exceptOperationId || claim.operationId !== exceptOperationId)
      && (!oldAdmission || !finished)
    })
  })) return true
  const operations = await tx.agentOperation.findMany({ where: { originRunId: { in: ids }, action: 'quality_format_recovery',
    kind: 'provider' }, include: { parent: true } })
  return operations.some(item => {
    if (item.parentOperationId === exceptOperationId) return false
    const work = object(object(item.parent?.inputSnapshot).input).work
    const chapter = object(object(work).chapter)
    return object(work).kind === 'check' && [5, 6, 7].includes(Number(object(work).version))
      && chapter.id === chapterId && chapter.revision === chapterRevision
      && (!admission || item.createdAt >= admission.at || item.status !== 'succeeded' || item.parent?.status !== 'succeeded')
  })
}

async function readRecovery(tx: Prisma.TransactionClient, subject: Subject, chapterId?: string, live?: CurrentQualityFormatWitness): Promise<QualityFormatRecovery | null> {
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId }, include: { session: true } })
  if (!run || run.session.spawnedFromRunId || !['running', 'paused', 'queued'].includes(run.status)) return null
  const original = await readOriginalTaskRequest(tx, subject)
  if (original.parentRunId) return null
  const ids = await originalTaskRunIds(tx, subject, original)
  const candidate = chapterId ? null : await tx.chapterQualityReport.findFirst({ where: { userId: subject.userId, novelId: subject.novelId,
    runId: { in: ids } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { chapterId: true } })
  const target = chapterId ?? candidate?.chapterId
  if (!target) return null
  const bundle = await buildHumanityQualityContext(subject.userId, subject.novelId, target, subject.runId, tx)
  const report = await getLatestQualityReport(subject.userId, subject.novelId, target, tx, bundle.compilation?.id ?? null)
  if (!report || report.status !== 'failed') return null
  const admission = await readQualityReviewAdmission(tx, run)
  const orphanProof = !report.runId && admission && admission.at > report.createdAt
    ? (await readOrphanQualityRecoveryProofs(tx, subject, ids, original.taskId, target, bundle.chapter.revision)).get(report.id) : null
  if (!orphanProof && (!report.runId || !ids.includes(report.runId))) return null
  const metrics = object(report.deterministicMetrics), audit = object(metrics.criticResponse)
  const contextHash = qualityReviewContextHash(bundle)
  if (report.chapterRevision !== bundle.chapter.revision || metrics.qualityContextHash !== contextHash
    || metrics.contentHash !== hashText(bundle.chapter.content) || metrics.independentCheck !== 'unavailable'
    || !formatClasses.has(String(audit.classification))) return null
  const key = runtimeJson({ taskId: original.taskId, chapterId: target, revision: bundle.chapter.revision,
    ...(admission ? { admissionId: admission.id } : {}) }).hash
  // Keep automatic recovery bounded within one real author admission. A later
  // explicit continue can check again; restart/new compilation cannot mint it.
  if (await hasQualityFormatRecoveryClaim(tx, subject, target, bundle.chapter.revision)) return null
  const firstRun = await tx.agentRun.findFirstOrThrow({ where: { id: { in: ids } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  // Legacy auxiliary usage is chapter-bound and often has no agentRunId.
  if (await tx.aiUsageLog.count({ where: { userId: subject.userId, novelId: subject.novelId,
    OR: [{ agentRunId: { in: ids }, billingStatus: 'pending_usage' },
      { targetType: 'chapter', targetId: target, action: { startsWith: 'agent3Humanity' }, createdAt: { gte: firstRun.createdAt },
        OR: [{ billingStatus: 'pending_usage' }, { usageSource: 'unknown' }] }] } })
    || await tx.agentProviderAttempt.count({ where: { runId: { in: ids }, status: { in: ['dispatching', 'unknown'] } } })) return null
  let evidenceHash: string
  if (live) {
    if (run.taskRootId || report.runId !== subject.runId || audit.callId !== live.callId || audit.contentHash !== live.contentHash
      || audit.characterCount !== live.characterCount || report.createdAt < live.startedAt || live.characterCount <= 0) return null
    const paid = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId, targetType: 'chapter', targetId: target,
      action: { startsWith: 'agent3HumanityCritic' }, createdAt: { gte: live.startedAt, lte: report.createdAt } } })
    if (paid.length < 1 || paid.length > 2 || paid.filter(item => item.action === 'agent3HumanityCritic').length !== 1
      || paid.some(item => !['agent3HumanityCritic', 'agent3HumanityCriticOutputRecovery', 'agent3HumanityCriticEmptyRecovery'].includes(item.action)
      || item.billingStatus !== 'settled' || item.usageSource !== 'reported'
      || item.requestTokens === null || item.responseTokens === null || item.responseTokens <= 0)) return null
    evidenceHash = runtimeJson({ callId: live.callId, contentHash: live.contentHash, usageIds: paid.map(item => item.id) }).hash
  } else if (orphanProof) {
    evidenceHash = orphanProof.evidenceHash
  } else {
    const hydrated = await tx.chapterQualityReport.findUniqueOrThrow({ where: { id: report.id }, include: { findings: true } })
    const proof = await readQualityUnavailableProof(tx, subject, ids, hydrated, bundle.chapter, run.taskRootId, { allowFormatRecovery: true })
    if (!proof) return null
    evidenceHash = proof.evidenceHash
  }
  return qualityFormatRecoverySchema.parse({ version: 1, key, taskId: original.taskId, reportId: report.id, chapterId: target,
    chapterRevision: bundle.chapter.revision, compilationId: report.compilationId, contextHash, evidenceHash,
    ...(admission ? { admissionId: admission.id } : {}) })
}

/** Read-only eligibility, suitable for precise legacy restriction recovery. */
export async function readQualityFormatRecovery(tx: Prisma.TransactionClient, subject: Subject, input: { chapterId?: string } = {}) {
  return readRecovery(tx, subject, input.chapterId)
}

/** Serialize the once-only claim before any new payment. Lost/unknown attempts
 * consume this reservation rather than being replayed on another invocation. */
export async function claimQualityFormatRecovery(tx: Prisma.TransactionClient, subject: Subject,
  expected: QualityFormatRecovery, live?: CurrentQualityFormatWitness) {
  await lockNovelActiveScope(tx, subject.novelId)
  await assertAgentManuscriptCurrent(tx, subject)
  await tx.$queryRaw`SELECT id FROM chapter_quality_reports WHERE id = ${expected.reportId} AND user_id = ${subject.userId} FOR UPDATE`
  const current = await readRecovery(tx, subject, expected.chapterId, live)
  if (!current || runtimeJson(current).hash !== runtimeJson(expected).hash) return false
  const source = await tx.chapterQualityReport.findUniqueOrThrow({ where: { id: current.reportId } })
  const metrics = object(source.deterministicMetrics)
  const history = Array.isArray(metrics.formatRecoveryHistory) ? metrics.formatRecoveryHistory : []
  await tx.chapterQualityReport.update({ where: { id: current.reportId }, data: { deterministicMetrics: runtimeJson({ ...metrics,
    ...(metrics.formatRecovery ? { formatRecoveryHistory: [...history, { ...object(metrics.formatRecovery),
      claimedAt: object(metrics.formatRecovery).claimedAt ?? source.updatedAt.toISOString() }] } : {}),
    formatRecovery: { ...current, state: 'claimed', claimRunId: subject.runId, claimedAt: new Date().toISOString() } }).value } })
  return true
}

export async function claimCurrentQualityFormatRecovery(tx: Prisma.TransactionClient, subject: Subject, chapterId: string, live: CurrentQualityFormatWitness) {
  await lockNovelActiveScope(tx, subject.novelId)
  const expected = await readRecovery(tx, subject, chapterId, live)
  return expected && await claimQualityFormatRecovery(tx, subject, expected, live) ? expected : null
}

/** Same frozen operation may finish its original reservation on recovery;
 * this admission cannot claim it twice. The caller holds its lease. */
export async function claimDurableQualityFormatRecovery(tx: Prisma.TransactionClient, subject: Subject, expected: QualityFormatRecovery, operationId: string) {
  await lockNovelActiveScope(tx, subject.novelId)
  await assertAgentManuscriptCurrent(tx, subject)
  const source = await tx.chapterQualityReport.findFirst({ where: { id: expected.reportId, userId: subject.userId, novelId: subject.novelId } })
  const claim = object(object(source?.deterministicMetrics).formatRecovery)
  if (claim.operationId === operationId && claim.key === expected.key && claim.evidenceHash === expected.evidenceHash) {
    const original = await readOriginalTaskRequest(tx, subject)
    const current = await buildHumanityQualityContext(subject.userId, subject.novelId, expected.chapterId, subject.runId, tx)
    return original.taskId === expected.taskId && current.chapter.revision === expected.chapterRevision && qualityReviewContextHash(current) === expected.contextHash
  }
  if (!await claimQualityFormatRecovery(tx, subject, expected)) return false
  const report = await tx.chapterQualityReport.findUniqueOrThrow({ where: { id: expected.reportId } })
  await tx.chapterQualityReport.update({ where: { id: expected.reportId }, data: { deterministicMetrics: runtimeJson({ ...object(report.deterministicMetrics),
    formatRecovery: { ...object(object(report.deterministicMetrics).formatRecovery), operationId } }).value } })
  return true
}

/** Append audit linkage only; do not clear failure, mark findings repaired or
 * alter the original source report, claim identity or paid history. */
export async function bindQualityFormatRecovery(tx: Prisma.TransactionClient, reportId: string, recovery: QualityFormatRecovery) {
  const report = await tx.chapterQualityReport.findUniqueOrThrow({ where: { id: reportId } })
  await tx.chapterQualityReport.update({ where: { id: reportId }, data: { deterministicMetrics: runtimeJson({ ...object(report.deterministicMetrics),
    formatRecovery: { ...recovery, state: report.status === 'failed' ? 'failed' : 'completed' } }).value } })
}
