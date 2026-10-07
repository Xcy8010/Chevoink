import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { runtimeJson } from './runtime-common.js'
import { buildHumanityQualityContext, HUMANITY_CRITIC_VERSION, qualityReviewContextHash } from './humanity-quality.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const qualityUnavailableProofSchema = z.object({
  version: z.literal(1), code: z.literal('QUALITY_REPORT_INCOMPLETE'),
  source: z.enum(['legacy', 'durable']), witnessIds: z.array(z.string().min(1)).min(3), evidenceHash: hash,
}).strict()
type Report = Prisma.ChapterQualityReportGetPayload<{ include: { findings: true } }>
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const jsonHash = (value: unknown) => runtimeJson(JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item))).hash
const formatClasses = new Set(['json_invalid', 'incomplete_json', 'envelope_invalid', 'ambiguous_envelope', 'duplicate_keys', 'findings_invalid', 'source_invalid'])

/** A tool error label is not proof of a received paid response. Bind the current
 * failed report to authoritative events/receipts and settled response evidence.
 * Nothing here retries a request, changes a report or certifies the assessment. */
export async function readQualityUnavailableProof(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, runIds: string[], report: Report,
  chapter: { id: string; revision: number; content: string }, taskRootId: string | null) {
  const metrics = object(report.deterministicMetrics)
  if (report.status !== 'failed' || report.criticVersion !== HUMANITY_CRITIC_VERSION || !report.runId || !runIds.includes(report.runId)
    || report.chapterId !== chapter.id || report.chapterRevision !== chapter.revision || !report.compilationId
    || metrics.independentCheck !== 'unavailable' || metrics.contentHash !== createHash('sha256').update(chapter.content).digest('hex')) return null
  const context = await buildHumanityQualityContext(subject.userId, subject.novelId, chapter.id, report.runId, tx)
  if (context.compilation?.id !== report.compilationId || metrics.qualityContextHash !== qualityReviewContextHash(context)) return null
  const audit = metrics.criticResponse === undefined ? null : object(metrics.criticResponse)
  if (audit && (audit.version !== 1 || !formatClasses.has(String(audit.classification))
    || !hash.safeParse(audit.contentHash).success || !Number.isSafeInteger(audit.characterCount) || Number(audit.characterCount) <= 0)) return null
  if (taskRootId) {
    const operations = await tx.agentOperation.findMany({ where: { taskRootId, originRunId: report.runId, action: 'quality_analyze', status: 'succeeded' },
      include: { effectReceipt: true, children: { include: { attempts: { include: { usageReceipt: true } } } } } })
    const matches = operations.filter(operation => {
      const result = object(object(operation.effectReceipt?.result).toolResult), display = object(result.display)
      return result.outcome === 'failed' && result.failureCode === 'QUALITY_REPORT_INCOMPLETE' && display.kind === 'qualityReport'
        && display.reportId === report.id && display.chapterId === chapter.id && display.chapterRevision === chapter.revision
    })
    if (matches.length !== 1) return null
    const operation = matches[0], receipt = operation.effectReceipt!
    if (audit && audit.operationId !== operation.id) return null
    const work = object(object(operation.inputSnapshot).input).work
    const frozen = object(work), frozenChapter = object(frozen.chapter), compiler = object(frozen.compiler)
    if (jsonHash(operation.inputSnapshot) !== operation.inputHash || jsonHash(receipt.result) !== receipt.resultHash || receipt.runId !== report.runId
      || frozen.kind !== 'check' || frozenChapter.id !== chapter.id || frozenChapter.revision !== chapter.revision
      || frozenChapter.content !== chapter.content || compiler.id !== report.compilationId) return null
    const paid = operation.children.flatMap(child => child.attempts.map(attempt => ({ child, attempt })))
    const critics = paid.filter(item => item.child.action === 'quality_critic')
    if (critics.length !== 1 || paid.some(({ child, attempt }) => child.status !== 'succeeded' || attempt.status !== 'succeeded'
      || !attempt.resultHash || jsonHash(attempt.result) !== attempt.resultHash || attempt.usageReceipt?.source !== 'reported'
      || attempt.usageReceipt.settlementStatus !== 'settled')) return null
    const witnesses = []
    for (const { child, attempt } of paid) {
      const usage = attempt.usageReceipt!
      const measurement = { source: usage.source, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
        cacheHitTokens: usage.cacheHitTokens, cacheMissTokens: usage.cacheMissTokens }
      if (attempt.runId !== report.runId || usage.promptTokens === null || usage.completionTokens === null
        || jsonHash(measurement) !== usage.observationHash || object(attempt.result).outcome !== 'succeeded'
        || jsonHash(child.inputSnapshot) !== child.inputHash) return null
      const responseEvent = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `result:${attempt.id}:${attempt.resultHash}` } })
      const settlement = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `settlement:${child.id}` } })
      const charge = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: `operation:${child.id}` } })
      if (!responseEvent || responseEvent.operationId !== child.id || responseEvent.taskRootId !== operation.taskRootId
        || responseEvent.runId !== report.runId || responseEvent.type !== 'provider.result.recorded'
        || jsonHash(responseEvent.payload) !== jsonHash({ attemptId: attempt.id, status: 'succeeded', resultHash: attempt.resultHash })
        || !settlement || settlement.operationId !== child.id || settlement.taskRootId !== operation.taskRootId
        || settlement.runId !== report.runId || settlement.type !== 'credit.settled'
        || object(settlement.payload).attemptId !== attempt.id || object(settlement.payload).usageRevision !== usage.revision
        || !charge || charge.userId !== subject.userId || charge.referenceId !== child.id
        || object(charge.metadata).attemptId !== attempt.id || object(charge.metadata).requestHash !== attempt.requestHash
        || object(charge.metadata).usageRevision !== usage.revision || object(charge.metadata).observationHash !== usage.observationHash) return null
      witnesses.push({ responseEvent, settlement, charge })
    }
    const response = object(object(critics[0].attempt.result).result)
    if (typeof response.content !== 'string' || !response.content.length || response.finishReason !== 'stop'
      || !Array.isArray(response.toolCalls) || response.toolCalls.length
      || audit && (audit.contentHash !== createHash('sha256').update(response.content).digest('hex') || audit.characterCount !== response.content.length)) return null
    return qualityUnavailableProofSchema.parse({ version: 1, code: 'QUALITY_REPORT_INCOMPLETE', source: 'durable',
      witnessIds: [operation.id, ...paid.map(item => item.attempt.id), ...witnesses.flatMap(item => [item.responseEvent.id, item.settlement.id, item.charge.id])],
      evidenceHash: jsonHash({ operation, receipt, paid, witnesses }) })
  }
  const events = await tx.agentRunEvent.findMany({ where: { runId: report.runId, type: { in: ['tool.call', 'tool.result'] } }, orderBy: { seq: 'asc' }, take: 2001 })
  if (events.length >= 2001) return null
  const pairs = events.flatMap(result => {
    const payload = object(result.payload)
    if (result.type !== 'tool.result' || payload.toolName !== 'quality_analyze' || payload.ok !== false
      || payload.failureCode !== 'QUALITY_REPORT_INCOMPLETE' || typeof payload.callId !== 'string') return []
    const calls = events.filter(call => call.type === 'tool.call' && object(call.payload).callId === payload.callId && object(call.payload).toolName === 'quality_analyze')
    if (calls.length !== 1) return []
    const call = calls[0], args = object(object(call.payload).args)
    if (call.seq >= result.seq || call.createdAt > report.createdAt || result.createdAt < report.createdAt
      || (args.compilationId !== report.compilationId && args.chapterId !== chapter.id)
      || (args.chapterId !== undefined && args.chapterId !== chapter.id)
      || (args.compilationId !== undefined && args.compilationId !== report.compilationId)) return []
    return [{ call, result }]
  })
  if (pairs.length !== 1) return null
  const { call, result } = pairs[0]
  if (audit && audit.callId !== object(call.payload).callId) return null
  // Older tool results lacked reportId. Only a unique, noninterleaved interval
  // can bridge that historical gap; a nearest-time guess never authorizes it.
  if (events.some(event => event.type === 'tool.call' && event.seq > call.seq && event.seq < result.seq
    && ['quality_analyze', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_rename'].includes(String(object(event.payload).toolName)))) return null
  if (events.some(other => other.type === 'tool.call' && other.id !== call.id && other.seq < result.seq
    && ['quality_analyze', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_rename'].includes(String(object(other.payload).toolName))
    && !events.some(end => end.type === 'tool.result' && object(end.payload).callId === object(other.payload).callId && end.seq < call.seq))) return null
  const interval = { gte: call.createdAt, lte: result.createdAt }
  const reports = await tx.chapterQualityReport.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    chapterId: chapter.id, createdAt: interval }, select: { id: true } })
  if (reports.length !== 1 || reports[0].id !== report.id) return null
  const paid = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId, targetType: 'chapter', targetId: chapter.id,
    action: { startsWith: 'agent3Humanity' }, createdAt: interval } })
  const critics = paid.filter(item => item.action === 'agent3HumanityCritic')
  if (critics.length !== 1 || paid.some(item => item.billingStatus !== 'settled' || item.usageSource !== 'reported'
    || item.requestTokens === null || item.responseTokens === null || item.responseTokens <= 0)) return null
  return qualityUnavailableProofSchema.parse({ version: 1, code: 'QUALITY_REPORT_INCOMPLETE', source: 'legacy',
    witnessIds: [call.id, result.id, ...paid.map(item => item.id)], evidenceHash: jsonHash({ call, result, paid }) })
}
