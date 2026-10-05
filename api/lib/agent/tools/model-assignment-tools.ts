import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { agentModelSelectionSchema, modelAssignmentsSchema, modelAssignmentTaskSchema, type FrozenModelAssignments } from '../../../../shared/contracts/agent-model-assignments.js'
import { assertConfigurationAuthority } from '../configuration-authority.js'
import { applyModelAssignmentsPatch, resolveAssignedModel } from '../model-assignments.js'
import { lockOwnedRun, runtimeJson, runtimeTransaction } from '../runtime-common.js'
import { readExecutionStateInTransaction } from '../runtime-state.js'
import { prepareToolCursorOperation } from '../runtime-tool-cursor.js'
import { commitOperationEffect, recordToolFailure } from '../runtime-operations.js'
import { reduceExecutionReceipt } from '../runtime-reducer.js'
import { defineTool } from './types.js'
import { DataAccessError } from '../../prisma.js'
import { taskSpecSchema } from '../../../../shared/contracts/task-spec-contracts.js'
import { modelRouteRevision } from '../runtime-model-cursor.js'
import { env } from '../../../config/env.js'
import { configurationResponseSchema } from './configuration-tools.js'

type AssignmentResponse = { modelAssignments: FrozenModelAssignments; configuration?: import('zod').infer<typeof configurationResponseSchema>;
  semanticTransition?: { targetId: string; beforeHash: string; afterHash: string } }
function assignmentResult(response: AssignmentResponse) {
  const { semanticTransition, ...publicResponse } = response
  return { output: JSON.stringify(publicResponse), summary: '任务模型分配已保存', ...(semanticTransition ? { semanticTransition } : {}) }
}

const schema = z.object({ task: modelAssignmentTaskSchema, model: agentModelSelectionSchema,
  scope: z.enum(['novel', 'global']).default('novel'), expectedRevision: z.number().int().nonnegative().max(2147483646) }).strict()

export const modelAssignmentTool = defineTool({ name: 'model_assign', title: '分配任务模型',
  description: '仅按作者明确的“某项任务用某模型”要求保存任务模型和思考强度。默认仅当前作品；只有作者明确全局或所有作品时使用 global。先 model_list 读取配置版本，再传 expectedRevision。不会修改已有付费操作或重置任务预算。',
  parameters: schema, permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: false,
  async execute(ctx, args) {
    const capability = ctx.durableConfiguration
    const prepare = () => {
      if (!capability) throw new DataAccessError(409, 'CONFIGURATION_ADAPTER_REQUIRED', '缺少持久配置能力。')
      return prepareToolCursorOperation(capability.lease, capability.cursor, { key: capability.operationKey, action: 'model_assign', callId: ctx.callId,
        effectDomain: 'configuration', targetId: capability.lease.taskRootId, effectiveArgs: args, normalize: raw => schema.parse(raw), operationInput: runtimeJson({ callId: ctx.callId, args }).value })
    }
    try {
      ctx.signal.throwIfAborted()
      if (!capability) {
        const old = await runtimeTransaction(async tx => {
          const run = await lockOwnedRun(tx, ctx.userId, ctx.runId)
          if (run.sessionId !== ctx.sessionId || run.novelId !== ctx.novelId) throw new DataAccessError(404, 'NOT_FOUND', '任务不存在或无权访问。')
          return tx.agentConfigurationChange.findUnique({ where: { runId_callId: { runId: ctx.runId, callId: ctx.callId } } })
        })
        if (old) {
          if (old.requestHash !== runtimeJson(args).hash) throw new DataAccessError(409, 'CONFIGURATION_IDENTITY_CONFLICT', '模型分配请求与原回执不同。')
          return assignmentResult(old.response as unknown as AssignmentResponse)
        }
      }
      const authority = (tx: import('@prisma/client').Prisma.TransactionClient, effectiveReasoningEffort?: string) => assertConfigurationAuthority(tx, ctx, {
        model: args.model, task: args.task, global: args.scope === 'global', effectiveReasoningEffort })
      await runtimeTransaction(authority)
      const selected = await resolveAssignedModel(ctx.userId, args.model, args.task === 'vision')
      const requestHash = runtimeJson(args).hash
      const work = async (tx: import('@prisma/client').Prisma.TransactionClient) => {
        const run = await lockOwnedRun(tx, ctx.userId, ctx.runId)
        ctx.signal.throwIfAborted()
        if (!['running', 'awaiting_approval'].includes(run.status) || run.sessionId !== ctx.sessionId || run.novelId !== ctx.novelId) throw new DataAccessError(409, 'RUN_IN_PROGRESS', '任务状态已变化，未保存模型分配。')
        const old = await tx.agentConfigurationChange.findUnique({ where: { runId_callId: { runId: ctx.runId, callId: ctx.callId } } })
        if (old) {
          if (old.requestHash !== requestHash) throw new DataAccessError(409, 'CONFIGURATION_IDENTITY_CONFLICT', '模型分配请求与原回执不同。')
          return old.response as unknown as AssignmentResponse
        }
        await authority(tx, selected.runtime.reasoningEffort)
        const scopeKey = args.scope === 'novel' ? ctx.novelId : ''
        const stored = await tx.agentModelAssignment.findUnique({ where: { userId_scopeKey: { userId: ctx.userId, scopeKey } } })
        const beforeSelection = modelAssignmentsSchema.parse(stored?.assignments ?? {})[args.task] ?? null
        const assigned = await applyModelAssignmentsPatch(tx, ctx.userId, { scope: args.scope, ...(args.scope === 'novel' ? { novelId: ctx.novelId } : {}),
          expectedRevision: args.expectedRevision, assignments: { [args.task]: selected.selection } }, { [args.task]: selected.selection })
        const preserveNovel = args.scope === 'global' && ctx.modelAssignments?.sources?.[args.task] === 'novel'
        const frozen: FrozenModelAssignments = { version: 1, globalRevision: ctx.modelAssignments?.globalRevision ?? 0,
          novelRevision: ctx.modelAssignments?.novelRevision ?? 0, assignments: { ...ctx.modelAssignments?.assignments,
            ...(!preserveNovel ? { [args.task]: selected.selection } : {}) }, sources: { ...ctx.modelAssignments?.sources,
              ...(!preserveNovel ? { [args.task]: args.scope } : {}) } }
        if (args.scope === 'global') frozen.globalRevision = args.expectedRevision + 1
        else frozen.novelRevision = args.expectedRevision + 1
        const spec = taskSpecSchema.safeParse(run.taskSpec)
        const writing = spec.success && ['write', 'revise'].includes(spec.data.intent) && !['proposal_only', 'conversation_only'].includes(spec.data.writingPacing ?? '')
        const appliesMain = !preserveNovel && (args.task === 'chapter_writing' && writing || args.task === 'main' && !(writing && frozen.assignments.chapter_writing))
        const semanticTransition = { targetId: `model-assignment:${ctx.userId}:${scopeKey}:${args.task}`,
          beforeHash: runtimeJson({ selection: beforeSelection }).hash, afterHash: runtimeJson({ selection: assigned[args.task] ?? null }).hash }
        const response: AssignmentResponse = { modelAssignments: frozen, semanticTransition, ...(appliesMain ? { configuration: configurationResponseSchema.parse({ modelTier: selected.runtime.tier,
          customModelId: selected.selection.customModelId ?? null, reasoningEffort: selected.runtime.reasoningEffort, creativeFreedom: ctx.creativeFreedom, modelSelectionExplicit: true }) } : {}) }
        if (capability && run.taskRootId) {
          const state = await readExecutionStateInTransaction(tx, run.taskRootId)
          const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: run.taskRootId } })
          if (state.frame.state.phase !== 'awaiting_operation' || await tx.agentProviderAttempt.count({ where: { operation: { taskRootId: run.taskRootId }, status: { in: ['prepared', 'dispatched', 'unknown'] } } }))
            throw new DataAccessError(409, 'RUNTIME_RECONCILIATION_REQUIRED', '原模型请求尚待核对，不能切换配置。')
          const runtime = selected.runtime
          const configuration = { ...state.configuration, modelAssignments: frozen, ...(appliesMain ? { model: { ...state.configuration.model,
            tier: runtime.tier, customModelId: selected.selection.customModelId ?? null, provider: runtime.provider, modelName: runtime.modelName ?? env.aiTextModel,
            reasoningEffort: runtime.reasoningEffort, contextWindowTokens: runtime.contextWindowTokens ?? env.agentContextWindowTokens,
            routeRevision: modelRouteRevision({ provider: runtime.provider, model: runtime.modelName ?? env.aiTextModel,
              endpoint: `${(runtime.baseUrl ?? env.aiTextBaseUrl).replace(/\/$/, '')}/chat/completions`, reasoningEffort: runtime.reasoningEffort }) } } : {}) }
          await tx.agentExecutionState.update({ where: { taskRootId: run.taskRootId }, data: { configuration: runtimeJson(configuration).value,
            configurationHash: runtimeJson({ configuration, inputHash: root.inputHash }).hash } })
          if (response.configuration) await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: run.taskRootId, runId: run.id, operationId: state.frame.state.pendingOperationId,
            eventKey: `configuration:${run.id}:${ctx.callId}`, type: 'configuration.changed', payload: { callId: ctx.callId, requestHash, configuration: response.configuration } } })
        }
        if (response.configuration) await tx.agentRun.update({ where: { id: run.id }, data: { modelTier: response.configuration.modelTier,
          customModelId: response.configuration.customModelId, reasoningEffort: response.configuration.reasoningEffort } })
        await tx.agentConfigurationChange.create({ data: { runId: ctx.runId, callId: ctx.callId, requestHash, response: runtimeJson(response).value } })
        ctx.signal.throwIfAborted()
        return response
      }
      let response: Awaited<ReturnType<typeof work>>
      if (capability) {
        const prepared = await prepare()
        const receipt = await commitOperationEffect(capability.lease, prepared.operation.id, prepared.operation.inputHash, async tx => runtimeJson({
          toolResult: assignmentResult(await work(tx)) }).value)
        const result = (receipt.result as unknown as { toolResult: ReturnType<typeof assignmentResult> }).toolResult
        response = { ...JSON.parse(result.output), ...(result.semanticTransition ? { semanticTransition: result.semanticTransition } : {}) }
        await reduceExecutionReceipt(capability.lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
      } else response = await runtimeTransaction(work)
      ctx.applyModelAssignments?.(response.modelAssignments)
      if (response.configuration) ctx.emit({ type: 'run.configuration', ...response.configuration })
      return assignmentResult(response)
    } catch (error) {
      if (!(error instanceof DataAccessError) || !['CONFIGURATION_AUTHOR_REQUIRED', 'MODEL_ASSIGNMENT_CONFLICT', 'MODEL_VISION_REQUIRED'].includes(error.code)) throw error
      if (capability) {
        const prepared = await prepare()
        await recordToolFailure(capability.lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, code: error.code, output: error.message, summary: '模型分配未保存' })
        await reduceExecutionReceipt(capability.lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
      }
      return { outcome: 'failed', failureCode: error.code, output: error.message, summary: '模型分配未保存' }
    }
  },
})
