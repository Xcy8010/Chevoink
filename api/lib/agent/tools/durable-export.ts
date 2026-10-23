import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { env } from '../../../config/env.js'
import { DataAccessError } from '../../prisma.js'
import { buildPublishAdviceRequest, parsePublishAdviceResponse } from '../../ai-service.js'
import { resolveAuxiliaryModelSelection } from '../../credits.js'
import { resolveDurableTokenPrice } from '../../billing/resolve-token-price.js'
import { readNovelExportSource, prepareNovelExportSnapshot, renderNovelExportZip, rememberExportAdvice, type ExportAdviceOutcome } from '../../export-service.js'
import { prepareExportStorage, readExportFile, storeExportFile } from '../../export-private-storage.js'
import { assignedTaskModel } from '../model-assignment-context.js'
import { auxiliaryRouteForRuntime, callDurableAuxiliary } from '../runtime-auxiliary-call.js'
import { exportWorkSchema, parseExportSource, assertExportCapacity, readExportSource, EXPORT_TTL_MS, type ExportWork } from '../runtime-export-contract.js'
import { databaseNow, runtimeError, runtimeJson, type RuntimeTx } from '../runtime-common.js'
import { withManuscriptRunLease, withRunLease } from '../runtime-lease.js'
import { prepareToolCursorOperation, readAdmittedToolOperation } from '../runtime-tool-cursor.js'
import { assertCurrentToolPolicy, commitOperationEffect } from '../runtime-operations.js'
import { reduceExecutionReceipt } from '../runtime-reducer.js'
import { normalizeToolInput } from './input-validation.js'
import { readExecutionStateInTransaction } from '../runtime-state.js'
import { parseToolArgsTolerant } from '../tool-argument-parser.js'
import { assertToolApproval } from '../runtime-approval.js'
import { originalToolParameterSchemas } from '../tool-schema.js'
import { taskSpecSchema } from '../../../../shared/contracts/task-spec-contracts.js'
import { novelExportSchema } from '../../../../shared/contracts/novel-export.js'
import { applySessionToolPolicy } from '../agents.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'

/** Read-only admission before capturing any private manuscript bytes. Final
 * parent preparation and effect still recheck the original cursor and policy. */
async function assertCapture(tx: RuntimeTx, ctx: ToolContext, tool: AgentTool, args: Record<string, unknown>) {
  const capability = ctx.durableExport!, lease = capability.lease
  const current = await readExecutionStateInTransaction(tx, lease.taskRootId), frame = current.frame
  if (taskSpecSchema.parse(current.originalSpec).scope.novelId !== ctx.novelId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '导出目标与原任务不一致。')
  if (frame.state.phase !== 'idle' || frame.revision !== capability.cursor.expectedRevision || frame.snapshotHash !== capability.cursor.expectedHash
    || capability.operationKey !== `exec:${frame.state.nextOperationSequence}`) return runtimeError('RUNTIME_STATE_CONFLICT', '导出快照必须来自原待执行位置。')
  const grant = current.configuration.toolAuthority.find(item => item.name === tool.name)
  const definition = current.configuration.tools.find(item => item.function.name === tool.name)
  if (!grant || grant.permission === 'deny' || !definition || !originalToolParameterSchemas(tool, taskSpecSchema.parse(current.originalSpec).scope).some(schema => runtimeJson(schema).hash === runtimeJson(definition.function.parameters).hash)) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '原任务未允许此次导出。')
  const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
  const session = await tx.agentSession.findUnique({ where: { id: root.sessionId } })
  const effective = session && session.userId === ctx.userId && session.novelId === ctx.novelId && applySessionToolPolicy([{ ...tool,
    permission: { ...tool.permission, [current.configuration.mode]: grant.permission } }], current.configuration.mode, session.toolPolicy, session.sandboxMode === 'read_only' ? 'read_only' : 'workspace')[0]
  if (!effective || effective.permission[current.configuration.mode] === 'deny') return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '当前会话不再允许原导出。')
  let index = frame.state.messages.length - 1
  while (index >= 0 && frame.state.messages[index].role === 'tool') index--
  const assistant = frame.state.messages[index]
  const call = assistant?.role === 'assistant' ? assistant.toolCalls?.find(item => !frame.state.messages.slice(index + 1).some(message => message.role === 'tool' && message.toolCallId === item.id)) : undefined
  if (!call || call.id !== ctx.callId || call.name !== tool.name || call.incomplete) return runtimeError('RUNTIME_STATE_CONFLICT', '导出缺少真实完整调用。')
  const parsed = tool.parameters.parse(normalizeToolInput(tool, call.arguments ? parseToolArgsTolerant(call.arguments, false) : {})) as Record<string, unknown>
  if (runtimeJson(Object.fromEntries(Object.entries(parsed).filter(([, item]) => item !== undefined))).hash !== runtimeJson(args).hash) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '导出参数与原调用不一致。')
  if (effective.permission[current.configuration.mode] === 'ask' || grant.alwaysConfirm) await assertToolApproval(tx, lease, frame.snapshotHash, call.id, tool.name, call.arguments, runtimeJson(args).hash)
  if (!await tx.novel.findFirst({ where: { id: ctx.novelId, authorId: ctx.userId } })) return runtimeError('RUNTIME_SCOPE_MISMATCH', '导出作品不属于当前作者。')
  ctx.signal.throwIfAborted()
}

async function freezeExport(ctx: ToolContext, tool: AgentTool, args: Record<string, unknown>): Promise<ExportWork> {
  const capability = ctx.durableExport!, lease = capability.lease
  const identity = { userId: ctx.userId, taskRootId: lease.taskRootId, operationKey: capability.operationKey,
    sourceHash: capability.cursor.expectedHash, argsHash: runtimeJson(args).hash }
  await withManuscriptRunLease(lease, tx => assertCapture(tx, ctx, tool, args))
  let saved = await readExportFile(identity, 'source')
  if (!saved) {
    const source = await withManuscriptRunLease(lease, async tx => {
      await assertCapture(tx, ctx, tool, args)
      return readNovelExportSource(ctx.userId, ctx.novelId, novelExportSchema.parse(args), tx)
    })
    ctx.signal.throwIfAborted()
    const snapshot = await prepareNovelExportSnapshot(source)
    assertExportCapacity(snapshot)
    saved = await storeExportFile(identity, 'source', Buffer.from(JSON.stringify({ version: 1, novelId: ctx.novelId, capturedAt: new Date().toISOString(), snapshot })))
  }
  const source = parseExportSource(saved.body)
  if (source.novelId !== ctx.novelId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '原导出快照不属于当前作品。')
  assertExportCapacity(source.snapshot)
  ctx.signal.throwIfAborted()
  await prepareExportStorage(identity)
  let advice: ExportWork['advice'] = { kind: 'omitted' }
  if (source.snapshot.advice) {
    if (source.snapshot.advice.cached) advice = { kind: 'cached', advice: source.snapshot.advice.cached }
    else {
      try {
        const assigned = await assignedTaskModel(ctx.userId, ctx.novelId, 'publish_advice', ctx.modelAssignments, true)
        const selected = assigned ? { runtime: assigned.runtime, selection: { tier: assigned.runtime.tier, customModelId: assigned.selection.customModelId ?? null,
          reasoningEffort: assigned.runtime.reasoningEffort } } : await resolveAuxiliaryModelSelection(ctx.userId)
        const effort = assigned ? selected.runtime.reasoningEffort : selected.runtime.reasoningEfforts?.includes('low') ? 'low' : selected.runtime.reasoningEffort
        const route = auxiliaryRouteForRuntime({ ...selected.runtime, reasoningEffort: effort, honorAssignedReasoning: true }, { ...selected.selection, reasoningEffort: effort }, env.aiTextMaxOutputTokens)
        delete route.responseFormat
        const { systemPrompt, userPrompt } = buildPublishAdviceRequest(source.snapshot.advice.input)
        advice = { kind: 'generate', input: source.snapshot.advice.input, system: systemPrompt, content: userPrompt, route,
          price: await resolveDurableTokenPrice(lease, `${capability.operationKey}:export-price`, selected.runtime.tier, selected.runtime.multiplierBps) }
      } catch (error) {
        // This branch resolves local configuration/price only: no provider child
        // or HTTP has been created, unlike a failed/unknown generation call.
        if (!(error instanceof DataAccessError) || !['CREDITS_EXHAUSTED', 'CREDITS_RESERVED', 'MODEL_TIER_UNAVAILABLE', 'CUSTOM_MODEL_NOT_FOUND', 'AI_PROVIDER_NOT_CONFIGURED'].includes(error.code)) throw error
        advice = { kind: 'unavailable', reason: error.code }
      }
    }
  }
  return exportWorkSchema.parse({ version: 1, novelId: ctx.novelId, exportId: randomUUID(), identity, source: saved.pointer,
    advice, fileName: source.snapshot.fileName, summary: source.snapshot.summary })
}

/** Only authenticated terminal provider evidence can choose the optional
 * advice fallback. A transport exception or timeout is never that evidence. */
async function knownAdviceFailure(tx: RuntimeTx, parentId: string, work: ExportWork) {
  if (work.advice.kind !== 'generate') return null
  const child = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: work.identity.taskRootId, operationKey: `aux:${parentId}:publish_advice` } }, include: { attempts: { include: { usageReceipt: true } } } })
  if (!child || child.parentOperationId !== parentId || child.kind !== 'provider' || child.action !== 'publish_advice'
    || runtimeJson(child.inputSnapshot).hash !== child.inputHash || child.attempts.length !== 1) return null
  const attempt = child.attempts[0]
  const childInput = z.object({ input: z.object({ request: z.unknown(), billing: z.unknown() }) }).safeParse(child.inputSnapshot)
  if (!childInput.success || runtimeJson(childInput.data.input.billing).hash !== runtimeJson(work.advice.price).hash
    || !attempt.requestSnapshot || runtimeJson(childInput.data.input.request).hash !== runtimeJson(attempt.requestSnapshot).hash) return null
  if (!attempt.resultHash || !attempt.result || child.status !== attempt.status || !attempt.requestSnapshot
    || runtimeJson(attempt.requestSnapshot).hash !== attempt.requestHash || runtimeJson(attempt.result).hash !== attempt.resultHash) return null
  if (attempt.status === 'cancelled' && !attempt.dispatchedAt) {
    const result = z.object({ outcome: z.literal('cancelled'), result: z.object({ code: z.string(), dispatched: z.literal(false) }).strict() }).strict().safeParse(attempt.result)
    const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `provider.not_dispatched:${attempt.id}` } })
    if (result.success && event?.taskRootId === work.identity.taskRootId && event.operationId === child.id && event.type === 'provider.not_dispatched'
      && runtimeJson(event.payload).hash === runtimeJson({ attemptId: attempt.id, requestHash: attempt.requestHash, code: result.data.result.code, resultHash: attempt.resultHash }).hash) {
      // Cancellation itself is handled by the outer current-authority/signal
      // fence; this does not permit a paused worker to publish a package.
      return result.data.result.code === 'CREDITS_EXHAUSTED' ? { kind: 'credits_exhausted' as const } : { kind: 'unavailable' as const }
    }
  }
  if (attempt.status === 'failed' && attempt.dispatchedAt) {
    const result = z.object({ outcome: z.literal('failed'), result: z.object({ httpStatus: z.number().int().min(100).max(599), code: z.literal('AI_PROVIDER_QUOTA_EXCEEDED').optional() }).strict() }).strict().safeParse(attempt.result)
    const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `result:${attempt.id}:${attempt.resultHash}` } })
    // Match the existing durable provider's definite-rejection classification.
    // Quota, 5xx and any reported-but-unsettled usage remain unresolved; a
    // failed HTTP status alone never proves zero charge.
    if (result.success && !result.data.result.code && !attempt.usageReceipt && [400, 401, 403, 404, 422, 429].includes(result.data.result.httpStatus)
      && event?.taskRootId === work.identity.taskRootId && event.operationId === child.id && event.type === 'provider.result.recorded'
      && runtimeJson(event.payload).hash === runtimeJson({ attemptId: attempt.id, status: 'failed', resultHash: attempt.resultHash }).hash) return { kind: 'unavailable' as const }
  }
  return null
}

export async function executeDurableExport(ctx: ToolContext, tool: AgentTool, raw: unknown): Promise<ToolResult> {
  const capability = ctx.durableExport
  if (!capability || tool.name !== 'novel_export' || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '导出缺少原任务执行能力。')
  const lease = { ...capability.lease }
  const normalize = (value: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(normalizeToolInput(tool, value)) as Record<string, unknown>).filter(([, item]) => item !== undefined))
  const args = normalize(raw)
  let work = await withRunLease(lease, async tx => {
    const old = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: capability.operationKey } } })
    if (!old) return null
    if (runtimeJson(old.inputSnapshot).hash !== old.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出工作损坏。')
    return z.object({ input: z.object({ work: exportWorkSchema }) }).parse(old.inputSnapshot).input.work
  })
  work ??= await freezeExport(ctx, tool, args)
  const prepared = await prepareToolCursorOperation(lease, capability.cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId, effectDomain: 'read', targetId: ctx.novelId,
    effectiveArgs: args, normalize, operationInput: runtimeJson({ novelId: ctx.novelId, callId: ctx.callId, args, work }).value })
  const admitted = await readAdmittedToolOperation(lease, { operationId: prepared.operation.id, action: tool.name, novelId: ctx.novelId, callId: ctx.callId })
  const frozen = exportWorkSchema.parse(admitted.input.work), normalization = z.object({ normalizedArgsHash: z.string(), sourceSnapshotHash: z.string() }).parse(admitted.input.normalization)
  if (frozen.novelId !== ctx.novelId || frozen.identity.userId !== ctx.userId || frozen.identity.taskRootId !== lease.taskRootId || frozen.identity.operationKey !== capability.operationKey
    || frozen.identity.argsHash !== normalization.normalizedArgsHash || frozen.identity.sourceHash !== normalization.sourceSnapshotHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出文件身份与真实调用不一致。')
  if ((args.includeInfo === false) !== (frozen.advice.kind === 'omitted')) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出信息范围与冻结分支不同。')
  const assertCurrent = async (tx: RuntimeTx) => {
    const current = await readAdmittedToolOperation(lease, { operationId: prepared.operation.id, action: tool.name, novelId: ctx.novelId, callId: ctx.callId }, tx)
    if (current.operation.status !== 'prepared' || current.operation.inputHash !== prepared.operation.inputHash) return runtimeError('RUNTIME_STATE_CONFLICT', '原导出不再等待执行。')
    await assertCurrentToolPolicy(tx, lease, current.operation)
    if (!await tx.novel.findFirst({ where: { id: ctx.novelId, authorId: ctx.userId } })) return runtimeError('RUNTIME_SCOPE_MISMATCH', '原导出作品已不可用。')
    ctx.signal.throwIfAborted()
  }
  let receipt = await withRunLease(lease, tx => tx.agentEffectReceipt.findUnique({ where: { operationId: prepared.operation.id } }))
  if (!receipt) {
    const source = await readExportSource(frozen)
    let outcome: ExportAdviceOutcome = { kind: 'unavailable' }
    if (frozen.advice.kind === 'cached') outcome = { kind: 'ready', advice: frozen.advice.advice }
    else if (frozen.advice.kind === 'unavailable') outcome = { kind: frozen.advice.reason === 'CREDITS_EXHAUSTED' ? 'credits_exhausted' : 'unavailable' }
    else if (frozen.advice.kind === 'generate') {
      const advice = frozen.advice
      try {
        const response = await callDurableAuxiliary({ lease, parentOperationId: prepared.operation.id, step: 'publish_advice', route: advice.route, price: advice.price,
          system: advice.system, content: advice.content, temperature: 0.3, signal: ctx.signal, assertCurrent })
        if (response.billing?.status !== 'settled') return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原建议用量或结算尚未核实，未重新请求或发布下载。')
        if (response.finishReason === 'stop' && !response.toolCalls.length && response.content.trim()) {
          try { outcome = { kind: 'ready', advice: parsePublishAdviceResponse(response.content) } }
          catch { /* A complete known output is not valid advice; no new request. */ }
        }
      } catch (error) {
        const known = await withRunLease(lease, tx => knownAdviceFailure(tx, prepared.operation.id, frozen))
        if (!known) throw error
        outcome = known
      }
    }
    ctx.signal.throwIfAborted()
    const result = renderNovelExportZip(source.snapshot, outcome)
    const savedZip = await storeExportFile(frozen.identity, 'zip', result.buffer)
    receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
      await assertCurrent(tx)
      const at = await databaseNow(tx)
      const publication = { version: 1 as const, userId: ctx.userId, taskRootId: lease.taskRootId, parentOperationId: prepared.operation.id, parentInputHash: prepared.operation.inputHash,
        exportId: frozen.exportId, zip: savedZip.pointer, fileName: frozen.fileName, summary: frozen.summary, advice: outcome,
        publishedAt: at.toISOString(), expiresAt: new Date(at.getTime() + EXPORT_TTL_MS).toISOString() }
      await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: lease.taskRootId, operationId: prepared.operation.id, runId: admitted.operation.originRunId,
        eventKey: `export:${frozen.exportId}`, type: 'export.published', payload: runtimeJson(publication).value } })
      const missing = frozen.advice.kind !== 'omitted' && outcome.kind !== 'ready'
      const toolResult: ToolResult = { output: `已打包：${result.fileName}（含${result.summary}）。下载链接15分钟内有效，已生成下载卡片。${missing ? '发布建议未生成，其它原文完整保留；不要重复导出来重试建议。' : ''}`,
        summary: `一键导出 · ${result.summary}${missing ? ' · 建议未生成' : ''}`, ...(missing ? { outcome: 'failed' as const, failureCode: 'EXPORT_ADVICE_UNAVAILABLE' } : {}),
        display: { kind: 'exportReady', downloadUrl: `/api/agent/exports/${frozen.exportId}`, fileName: result.fileName, detail: result.summary } }
      return runtimeJson({ toolResult, publication }).value
    })
    if (outcome.kind === 'ready' && source.snapshot.advice) rememberExportAdvice(ctx.novelId, source.snapshot.advice.fingerprint, outcome.advice)
  }
  if (runtimeJson(receipt.result).hash !== receipt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出交付回执损坏。')
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  return z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
}
