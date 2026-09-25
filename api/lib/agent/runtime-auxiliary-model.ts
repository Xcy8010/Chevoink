import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { runtimeError, runtimeJson } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionFrame, readExecutionStateInTransaction } from './runtime-state.js'
import { argumentNormalizationSchema } from './runtime-tool-cursor.js'
import { assertToolApproval } from './runtime-approval.js'
import { durableChatResultSchema } from './runtime-common.js'
import { preparePricedProviderOperationInTransaction, type DurableTokenPrice } from './runtime-settlement.js'
import { compilerStateHash, compilerObservationSchema } from './runtime-compiler-observation.js'
import { qualityAutoRepairPending, qualityReportMatchesContent } from './quality-report-contract.js'

const steps = {
  continuity_critic: { parent: 'continuity_validate', previous: null },
  continuity_repair: { parent: 'continuity_validate', previous: 'continuity_critic' },
  continuity_repair_retry: { parent: 'continuity_validate', previous: 'continuity_repair' },
  quality_critic: { parent: 'quality_analyze', previous: null },
  quality_evidence_correction: { parent: 'quality_analyze', previous: 'quality_critic' },
  quality_repair: { parent: 'quality_analyze', previous: 'quality_critic' },
  quality_repair_retry: { parent: 'quality_analyze', previous: 'quality_repair' },
} as const
export type AuxiliaryModelStep = keyof typeof steps
const stepSchema = z.enum(['continuity_critic', 'continuity_repair', 'continuity_repair_retry', 'quality_critic', 'quality_evidence_correction', 'quality_repair', 'quality_repair_retry'])
const parentInput = z.object({ input: z.object({ callId: z.string(), args: z.record(z.string(), z.unknown()), normalization: argumentNormalizationSchema }) })
const isolatedRequest = z.object({ body: z.object({
  messages: z.array(z.object({ role: z.enum(['system', 'user']), content: z.string() })).min(1),
  tools: z.array(z.never()).optional(),
}) })

/** 缓存报告只能替代首个修订步骤的 Critic 前置；仍核验原任务、报告哈希和正文版本。 */
async function hasFrozenRepairReport(tx: Prisma.TransactionClient, lease: RunLeaseToken, snapshot: unknown, step: AuxiliaryModelStep) {
  if (step !== 'quality_repair' && step !== 'continuity_repair') return false
  const parsed = z.object({ input: z.object({ work: z.object({ kind: z.literal('check'), version: z.literal(1), repair: z.literal(true),
    compiler: compilerObservationSchema.nullable(), chapter: z.object({ id: z.string(), revision: z.number(), content: z.string() }),
    cached: z.unknown(), coverage: z.unknown().optional() }) }) }).safeParse(snapshot)
  if (!parsed.success) return false
  const work = parsed.data.input.work
  const run = await tx.agentRun.findFirst({ where: { id: lease.runId, userId: lease.userId, taskRootId: lease.taskRootId }, select: { novelId: true } })
  if (!run) return false
  const novelId = run.novelId
  if (work.compiler && await compilerStateHash(tx, lease.userId, novelId, lease.taskRootId, work.compiler.id) !== work.compiler.hash) return false
  if (step === 'quality_repair') {
    const cached = z.object({ id: z.string(), hash: z.string() }).safeParse(work.cached)
    if (!cached.success) return false
    const report = await tx.chapterQualityReport.findFirst({ where: { id: cached.data.id, userId: lease.userId, novelId: novelId },
      include: { chapter: true, findings: { orderBy: { startOffset: 'asc' } } } })
    return !!report && report.compilationId === (work.compiler?.id ?? null) && (!!work.compiler || report.runId === lease.runId)
      && report.chapterId === work.chapter.id && report.chapter.revision === work.chapter.revision && report.chapter.content === work.chapter.content
      && runtimeJson(JSON.parse(JSON.stringify(report))).hash === cached.data.hash && qualityAutoRepairPending(report)
      && qualityReportMatchesContent(report, work.chapter.revision, work.chapter.content)
  }
  if (!work.compiler || !Array.isArray(work.cached)) return false
  const compilation = await tx.storyCompilation.findFirst({ where: { id: work.compiler.id, userId: lease.userId, novelId: novelId,
    status: 'active', run: { taskRootId: lease.taskRootId } }, include: { chapter: true } })
  const validation = z.object({ independentCheck: z.literal('complete'), checkedRevision: z.number(), findings: z.array(z.unknown()), coverage: z.unknown() }).safeParse(compilation?.validation)
  return !!compilation?.chapter && compilation.chapterId === work.chapter.id && compilation.chapter.revision === work.chapter.revision
    && compilation.chapter.content === work.chapter.content && validation.success && validation.data.checkedRevision === work.chapter.revision
    && runtimeJson(validation.data.findings).hash === runtimeJson(work.cached).hash && !!work.coverage
    && runtimeJson(validation.data.coverage).hash === runtimeJson(work.coverage).hash
}

/** Only server-defined steps of an admitted pending tool can call a critic.
 * Child requests have independent immutable inputs/prices/usage; they do not
 * advance the main chat cursor or turn into a new user task. */
export async function prepareAuxiliaryModelOperation(token: RunLeaseToken, input: {
  parentOperationId: string; step: AuxiliaryModelStep; key: string; action: string; request: Prisma.InputJsonValue; price: DurableTokenPrice
}) {
  const lease = { ...token }, captured = { ...input, request: runtimeJson(input.request).value, price: { ...input.price } }
  if (!stepSchema.safeParse(captured.step).success || captured.key !== `aux:${captured.parentOperationId}:${captured.step}`
    || captured.action !== captured.step || captured.price.version !== 'credits-v2-itemized') return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '独立模型必须使用原工具的固定步骤身份和V2价目。')
  if (!isolatedRequest.safeParse(captured.request).success) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '独立复核只能接收隔离的文本输入，不携带主对话工具历史或执行工具权限。')
  return withRunLease(lease, async tx => {
    const state = await readExecutionStateInTransaction(tx, lease.taskRootId)
    const contract = steps[captured.step]
    const parent = await tx.agentOperation.findFirst({ where: { id: captured.parentOperationId, taskRootId: lease.taskRootId, kind: 'tool', status: 'prepared' } })
    if (!parent || state.frame.state.phase !== 'awaiting_operation' || state.frame.state.pendingOperationId !== parent.id) return runtimeError('RUNTIME_STATE_CONFLICT', '独立模型不属于当前待执行工具。')
    if (parent.action !== contract.parent) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '独立模型步骤不能借用另一类工具的执行权限。')
    const parsed = parentInput.safeParse(parent.inputSnapshot)
    if (!parsed.success || runtimeJson(parent.inputSnapshot).hash !== parent.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原工具准入快照损坏。')
    const original = parsed.data.input, source = await readExecutionFrame(tx, lease.taskRootId, original.normalization.sourceRevision)
    let index = source.state.messages.length - 1
    while (index >= 0 && source.state.messages[index].role === 'tool') index--
    const assistant = source.state.messages[index]
    const call = assistant?.role === 'assistant' ? assistant.toolCalls?.find(item => item.id === original.callId) : undefined
    if (source.state.phase !== 'idle' || source.snapshotHash !== original.normalization.sourceSnapshotHash
      || source.revision + 1 !== state.frame.revision || parent.operationKey !== `exec:${source.state.nextOperationSequence}`
      || !call || call.name !== parent.action || call.incomplete || call.arguments !== original.normalization.rawArguments
      || runtimeJson(original.args).hash !== original.normalization.normalizedArgsHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '独立模型缺少原工具调用关联。')
    const grant = state.configuration.toolAuthority.find(item => item.name === parent.action)
    if (state.configuration.mode !== 'build' || !grant || grant.permission === 'deny'
      || !state.configuration.tools.some(tool => tool.function.name === parent.action)) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '原任务不允许独立检查或修订。')
    if (grant.permission === 'ask' || grant.alwaysConfirm) await assertToolApproval(tx, lease, source.snapshotHash, original.callId, parent.action, call.arguments, original.normalization.normalizedArgsHash)
    if (contract.previous && !await hasFrozenRepairReport(tx, lease, parent.inputSnapshot, captured.step)) {
      const prerequisite = contract.previous
      const previous = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: `aux:${parent.id}:${prerequisite}` } } })
      if (!previous || previous.parentOperationId !== parent.id || previous.status !== 'succeeded') return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '前一个独立模型步骤尚无确认结果，不能跳过或以新步骤重试。')
      const result = await tx.agentProviderAttempt.findUnique({ where: { operationId_attemptKey: { operationId: previous.id, attemptKey: '1' } } })
      const parsedResult = z.object({ outcome: z.literal('succeeded'), result: durableChatResultSchema }).strict().safeParse(result?.result)
      if (previous.kind !== 'provider' || previous.action !== prerequisite || runtimeJson(previous.inputSnapshot).hash !== previous.inputHash
        || !result || result.status !== 'succeeded' || !result.resultHash || runtimeJson(result.result).hash !== result.resultHash || !parsedResult.success) {
        return runtimeError('RUNTIME_RECEIPT_INVALID', '前一独立模型步骤回执损坏，不能继续收费调用。')
      }
      const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `result:${result.id}:${result.resultHash}` } })
      if (!result.dispatchedAt || !event || event.taskRootId !== lease.taskRootId || event.operationId !== previous.id || event.type !== 'provider.result.recorded'
        || runtimeJson(event.payload).hash !== runtimeJson({ attemptId: result.id, status: 'succeeded', resultHash: result.resultHash }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '前一个独立模型步骤缺少原结果事件，不能继续。')
    }
    return preparePricedProviderOperationInTransaction(tx, lease, captured)
  })
}
