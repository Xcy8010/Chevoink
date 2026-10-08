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
import { qualityEvidenceSourcesSchema, validateQualityEvidenceSources, inspectCriticResponse } from './quality-evidence.js'
import { qualityFormatRecoverySchema, hasQualityFormatRecoveryClaim } from './quality-format-recovery.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { readQualityUnavailableProof } from './quality-unavailable-proof.js'

const steps = {
  continuity_critic: { parent: 'continuity_validate', previous: null },
  continuity_repair: { parent: 'continuity_validate', previous: 'continuity_critic' },
  continuity_repair_retry: { parent: 'continuity_validate', previous: 'continuity_repair' },
  quality_critic: { parent: 'quality_analyze', previous: null },
  quality_format_recovery: { parent: 'quality_analyze', previous: 'quality_critic' },
  quality_evidence_correction: { parent: 'quality_analyze', previous: 'quality_critic' },
  quality_repair: { parent: 'quality_analyze', previous: 'quality_critic' },
  quality_repair_retry: { parent: 'quality_analyze', previous: 'quality_repair' },
} as const
export type AuxiliaryModelStep = keyof typeof steps
const stepSchema = z.enum(['continuity_critic', 'continuity_repair', 'continuity_repair_retry', 'quality_critic', 'quality_format_recovery', 'quality_evidence_correction', 'quality_repair', 'quality_repair_retry'])
const parentInput = z.object({ input: z.object({ callId: z.string(), args: z.record(z.string(), z.unknown()), normalization: argumentNormalizationSchema }) })
const isolatedRequest = z.object({ body: z.object({
  messages: z.array(z.object({ role: z.enum(['system', 'user']), content: z.string() })).min(1),
  tools: z.array(z.never()).optional(),
}) })

/** 缓存报告只能替代首个修订步骤的 Critic 前置；仍核验原任务、报告哈希和正文版本。 */
export async function hasFrozenRepairReport(tx: Prisma.TransactionClient, lease: RunLeaseToken, snapshot: unknown, step: AuxiliaryModelStep) {
  if (step !== 'quality_repair' && step !== 'continuity_repair') return false
  const parsed = z.object({ input: z.object({ work: z.object({ kind: z.literal('check'), version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)]), repair: z.literal(true),
    compiler: compilerObservationSchema.nullable(), chapter: z.object({ id: z.string(), revision: z.number(), content: z.string() }),
    cached: z.unknown(), coverage: z.unknown().optional(), sources: qualityEvidenceSourcesSchema.optional() }) }) }).safeParse(snapshot)
  if (!parsed.success) return false
  const work = parsed.data.input.work
  const run = await tx.agentRun.findFirst({ where: { id: lease.runId, userId: lease.userId, taskRootId: lease.taskRootId }, select: { novelId: true } })
  if (!run) return false
  const novelId = run.novelId
  if (work.version >= 4 && (step !== 'quality_repair' || !validateQualityEvidenceSources(work.sources,
    { userId: lease.userId, novelId, chapterId: work.chapter.id, chapterRevision: work.chapter.revision }, work.chapter.content))) return false
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
    || captured.action !== captured.step) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '独立模型必须使用原工具的固定步骤身份和冻结价目。')
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
    let frozenFormatClaim = false
    if (captured.step === 'quality_format_recovery') {
      const work = z.object({ input: z.object({ work: z.object({ kind: z.literal('check'), version: z.union([z.literal(5), z.literal(6), z.literal(7)]), parserVersion: z.union([z.literal(1), z.literal(2)]),
        deadlineAt: z.number().int().positive(), formatRecovery: qualityFormatRecoverySchema.nullable(), sources: qualityEvidenceSourcesSchema,
        chapter: z.object({ id: z.string(), revision: z.number(), content: z.string() }) }) }) }).safeParse(parent.inputSnapshot)
      if (!work.success || work.data.input.work.parserVersion !== (work.data.input.work.version >= 6 ? 2 : 1) || Date.now() >= work.data.input.work.deadlineAt) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '原冻结质量协议不允许追加格式恢复或已达原等待上限。')
      const frozen = work.data.input.work
      const owner = await tx.agentRun.findUniqueOrThrow({ where: { id: lease.runId } })
      const ownerSubject = { userId: lease.userId, novelId: owner.novelId, runId: lease.runId }
      await lockNovelActiveScope(tx, owner.novelId)
      if (await hasQualityFormatRecoveryClaim(tx, ownerSubject, frozen.chapter.id, frozen.chapter.revision, parent.id)) {
        return runtimeError('QUALITY_REPORT_INCOMPLETE', '本次请求已有格式恢复记录，或此前请求的结果尚未确认，不能重复发起。作者明确继续且此前结果已确认后可重新检查。')
      }
      if (frozen.formatRecovery) {
        const expected = frozen.formatRecovery
        const run = await tx.agentRun.findUniqueOrThrow({ where: { id: lease.runId } })
        const subject = { userId: lease.userId, novelId: run.novelId, runId: lease.runId }
        const originalTask = await readOriginalTaskRequest(tx, subject)
        const report = await tx.chapterQualityReport.findFirst({ where: { id: expected.reportId, userId: lease.userId, novelId: run.novelId }, include: { findings: true } })
        const marker = z.object({ formatRecovery: z.object({ key: z.string(), operationId: z.literal(parent.id), evidenceHash: z.string() }) }).safeParse(report?.deterministicMetrics)
        const proof = report && await readQualityUnavailableProof(tx, subject, await originalTaskRunIds(tx, subject, originalTask), report,
          frozen.chapter, run.taskRootId, { allowFormatRecovery: frozen.version >= 6 })
        frozenFormatClaim = originalTask.taskId === expected.taskId && !!proof && marker.success && marker.data.formatRecovery.key === expected.key
          && marker.data.formatRecovery.evidenceHash === expected.evidenceHash && proof.evidenceHash === expected.evidenceHash
        if (!frozenFormatClaim) return runtimeError('RUNTIME_RECEIPT_INVALID', '格式恢复缺少原失败报告的持久一次预约和已结算响应证明。')
      }
    }
    if (contract.previous && !frozenFormatClaim && !await hasFrozenRepairReport(tx, lease, parent.inputSnapshot, captured.step)) {
      const restored = z.object({ input: z.object({ work: z.object({ kind: z.literal('check'), version: z.union([z.literal(5), z.literal(6), z.literal(7)]),
        parserVersion: z.union([z.literal(1), z.literal(2)]), formatRecovery: qualityFormatRecoverySchema }) }) }).safeParse(parent.inputSnapshot)
      // A restored old failed report has no new quality_critic child. Its
      // subsequent evidence/repair stages bind this same parent's confirmed
      // format recovery, never another operation or an unverified report.
      const prerequisite = contract.previous === 'quality_critic' && captured.step !== 'quality_format_recovery' && restored.success
        ? 'quality_format_recovery' : contract.previous
      const previous = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: `aux:${parent.id}:${prerequisite}` } } })
      if (!previous || previous.parentOperationId !== parent.id || previous.status !== 'succeeded') return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '前一个独立模型步骤尚无确认结果，不能跳过或以新步骤重试。')
      const result = await tx.agentProviderAttempt.findUnique({ where: { operationId_attemptKey: { operationId: previous.id, attemptKey: '1' } }, include: { usageReceipt: true } })
      const parsedResult = z.object({ outcome: z.literal('succeeded'), result: durableChatResultSchema }).strict().safeParse(result?.result)
      if (previous.kind !== 'provider' || previous.action !== prerequisite || runtimeJson(previous.inputSnapshot).hash !== previous.inputHash
        || !result || result.status !== 'succeeded' || !result.resultHash || runtimeJson(result.result).hash !== result.resultHash || !parsedResult.success) {
        return runtimeError('RUNTIME_RECEIPT_INVALID', '前一独立模型步骤回执损坏，不能继续收费调用。')
      }
      const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `result:${result.id}:${result.resultHash}` } })
      if (!result.dispatchedAt || !event || event.taskRootId !== lease.taskRootId || event.operationId !== previous.id || event.type !== 'provider.result.recorded'
        || runtimeJson(event.payload).hash !== runtimeJson({ attemptId: result.id, status: 'succeeded', resultHash: result.resultHash }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '前一个独立模型步骤缺少原结果事件，不能继续。')
      if (prerequisite === 'quality_format_recovery' && (result.usageReceipt?.source !== 'reported' || result.usageReceipt.settlementStatus !== 'settled')) {
        return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原格式恢复尚未确认结算，不能派发后续质量步骤。')
      }
      if (captured.step === 'quality_format_recovery') {
        const response = parsedResult.data.result
        const inspected = inspectCriticResponse(response.content, undefined, response.finishReason === 'stop' && !response.toolCalls.length,
          z.object({ input: z.object({ work: z.object({ parserVersion: z.union([z.literal(1), z.literal(2)]).optional() }) }) }).parse(parent.inputSnapshot).input.work.parserVersion)
        if (result.usageReceipt?.source !== 'reported' || result.usageReceipt.settlementStatus !== 'settled'
          || !['json_invalid', 'incomplete_json', 'envelope_invalid', 'ambiguous_envelope', 'duplicate_keys', 'findings_invalid'].includes(inspected.diagnostic.classification)) {
          return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '首个质量回复不是已确认结算的格式失败，不允许新计费恢复。')
        }
      }
    }
    return preparePricedProviderOperationInTransaction(tx, lease, captured)
  })
}
