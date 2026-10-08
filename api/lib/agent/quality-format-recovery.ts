import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { buildHumanityQualityContext, getLatestQualityReport, qualityReviewContextHash } from './humanity-quality.js'
import { readQualityUnavailableProof } from './quality-unavailable-proof.js'
import { runtimeJson } from './runtime-common.js'

type Subject = { userId: string; novelId: string; runId: string }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const hashText = (value: string) => createHash('sha256').update(value).digest('hex')
const formatClasses = new Set(['json_invalid', 'incomplete_json', 'envelope_invalid', 'ambiguous_envelope', 'duplicate_keys', 'findings_invalid'])
export const qualityFormatRecoverySchema = z.object({ version: z.literal(1), key: z.string(), taskId: z.string(), reportId: z.string(),
  chapterId: z.string(), chapterRevision: z.number().int().positive(), compilationId: z.string().nullable(), contextHash: z.string(), evidenceHash: z.string() }).strict()
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
  const reports = await tx.chapterQualityReport.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    chapterId, runId: { in: ids } }, select: { deterministicMetrics: true } })
  if (reports.some(item => {
    const claim = object(object(item.deterministicMetrics).formatRecovery)
    return claim.taskId === original.taskId && claim.chapterId === chapterId && claim.chapterRevision === chapterRevision
      && (!exceptOperationId || claim.operationId !== exceptOperationId)
  })) return true
  const operations = await tx.agentOperation.findMany({ where: { originRunId: { in: ids }, action: 'quality_format_recovery',
    kind: 'provider' }, include: { parent: true } })
  return operations.some(item => {
    if (item.parentOperationId === exceptOperationId) return false
    const work = object(object(item.parent?.inputSnapshot).input).work
    const chapter = object(object(work).chapter)
    return object(work).kind === 'check' && object(work).version === 5
      && chapter.id === chapterId && chapter.revision === chapterRevision
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
  if (!report || report.status !== 'failed' || !report.runId || !ids.includes(report.runId)) return null
  const metrics = object(report.deterministicMetrics), audit = object(metrics.criticResponse)
  const contextHash = qualityReviewContextHash(bundle)
  if (report.chapterRevision !== bundle.chapter.revision || metrics.qualityContextHash !== contextHash
    || metrics.contentHash !== hashText(bundle.chapter.content) || metrics.independentCheck !== 'unavailable'
    || !formatClasses.has(String(audit.classification))) return null
  const key = runtimeJson({ taskId: original.taskId, chapterId: target, revision: bundle.chapter.revision }).hash
  // Claims live on the source report. A later failed recovery report cannot
  // create a new allowance, including after process restart or another run.
  if (await hasQualityFormatRecoveryClaim(tx, subject, target, bundle.chapter.revision)) return null
  if (await tx.aiUsageLog.count({ where: { userId: subject.userId, novelId: subject.novelId, agentRunId: { in: ids }, billingStatus: 'pending_usage' } })
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
  } else {
    const hydrated = await tx.chapterQualityReport.findUniqueOrThrow({ where: { id: report.id }, include: { findings: true } })
    const proof = await readQualityUnavailableProof(tx, subject, ids, hydrated, bundle.chapter, run.taskRootId)
    if (!proof) return null
    evidenceHash = proof.evidenceHash
  }
  return qualityFormatRecoverySchema.parse({ version: 1, key, taskId: original.taskId, reportId: report.id, chapterId: target,
    chapterRevision: bundle.chapter.revision, compilationId: report.compilationId, contextHash, evidenceHash })
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
  await tx.chapterQualityReport.update({ where: { id: current.reportId }, data: { deterministicMetrics: runtimeJson({ ...object(source.deterministicMetrics),
    formatRecovery: { ...current, state: 'claimed', claimRunId: subject.runId } }).value } })
  return true
}

export async function claimCurrentQualityFormatRecovery(tx: Prisma.TransactionClient, subject: Subject, chapterId: string, live: CurrentQualityFormatWitness) {
  await lockNovelActiveScope(tx, subject.novelId)
  const expected = await readRecovery(tx, subject, chapterId, live)
  return expected && await claimQualityFormatRecovery(tx, subject, expected, live) ? expected : null
}

/** Same frozen operation may finish its original reservation on recovery;
 * another operation or run cannot claim it again. The caller holds its lease. */
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
