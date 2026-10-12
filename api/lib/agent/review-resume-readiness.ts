import type { AgentRun, Prisma } from '@prisma/client'
import type { AgentReviewReceiptWait } from '../../../shared/contracts/index.js'
import { runCheckpointSchema } from './checkpoint.js'
import { readReviewRequestRecoveryEvidence } from './review-request-recovery.js'
import { readSettledQualityReviews } from './quality-review-admission.js'
import { readLegacyContinuityRecovery } from './legacy-continuity-recovery.js'
import { originalTaskRunIds, readOriginalTaskRequest } from './original-request.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** This is a denial-only receipt probe. It grants neither recovery nor a new
 * paid attempt; the existing readers recheck real admission inside the loop. */
export async function readReviewReceiptWait(tx: Prisma.TransactionClient, run: AgentRun): Promise<AgentReviewReceiptWait | null> {
  if (run.taskRootId || run.runtimeProtocolVersion !== 0) return null
  const checkpoint = runCheckpointSchema.safeParse(object(run.usage).checkpoint)
  const pending = checkpoint.success ? checkpoint.data.pendingReviews ?? [] : []
  if (!pending.length) return null
  const subject = { userId: run.userId, novelId: run.novelId, runId: run.id }
  const evidence = await readReviewRequestRecoveryEvidence(tx, subject, pending)
  const settled = await readSettledQualityReviews(tx, subject, pending)
  const continuity = pending.some(item => item.toolName === 'continuity_validate')
    ? await readLegacyContinuityRecovery(tx, subject, checkpoint.success ? checkpoint.data.toolRestrictions ?? [] : [], pending) : null
  const confirmed = new Set([...evidence, ...settled, ...(continuity?.settled ?? [])].map(item => item.callId))
  const unresolved = pending.filter(item => !confirmed.has(item.callId))
  if (!unresolved.length) return null
  const original = await readOriginalTaskRequest(tx, subject)
  const runIds = await originalTaskRunIds(tx, subject, original)
  const history = await tx.agentRunEvent.findMany({ where: { runId: { in: runIds }, type: { in: ['tool.call', 'tool.result'] },
    OR: unresolved.map(item => ({ payload: { path: ['callId'], equals: item.callId } })) }, orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }] })
  const waiting: typeof unresolved = []
  for (const item of unresolved) {
    const calls = history.filter(event => event.type === 'tool.call' && object(event.payload).callId === item.callId
      && object(event.payload).toolName === item.toolName)
    if (calls.length !== 1) continue
    const call = calls[0]
    const args = object(object(call.payload).args)
    if (args.chapterId !== item.chapterId && (!item.compilationId || args.compilationId !== item.compilationId)) continue
    const results = history.filter(event => event.type === 'tool.result' && event.runId === call.runId
      && object(event.payload).callId === item.callId && event.seq > call.seq)
    if (results.length > 1) continue
    const result = results[0]
    // Reports/format/local-effect failures still go through their original
    // authenticated recovery readers, rather than being blocked by this probe.
    if (result && (object(result.payload).ok !== false || !String(object(result.payload).failureCode).startsWith('AI_PROVIDER_'))) continue
    const family = item.toolName === 'quality_analyze' ? 'agent3Humanity' : 'agent3Continuity'
    const usage = await tx.aiUsageLog.findMany({ where: { userId: run.userId, novelId: run.novelId, action: { startsWith: family },
      createdAt: { gte: call.createdAt, ...(result ? { lte: result.createdAt } : {}) },
      OR: [{ agentRunId: call.runId }, { chapterId: item.chapterId }, { targetId: { in: [item.chapterId, ...(item.compilationId ? [item.compilationId] : [])] } }] },
      select: { usageSource: true, billingStatus: true, requestTokens: true, responseTokens: true, reservedCreditMilli: true } })
    // Complete token counts are not a settled bill. Unreconciled response or
    // settlement observations deny launch; cancelled exempt reviews retain
    // their separate, authenticated retirement semantics.
    if (usage.some(row => ['pending_usage', 'pending_settlement', 'observed'].includes(row.billingStatus ?? ''))) waiting.push(item)
  }
  if (!waiting.length) return null
  const checks = [...new Set(waiting.map(item => item.toolName === 'quality_analyze' ? 'quality' as const : 'continuity' as const))]
  return { kind: 'waiting_for_original_receipt', checks,
    message: `${checks.map(check => check === 'quality' ? '质量' : '连续性').join('、')}检查正在等待原请求的结果或用量确认。正文和已完成的检查已保留；确认后才能继续，避免重复收费。` }
}
