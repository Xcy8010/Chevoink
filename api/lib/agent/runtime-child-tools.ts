import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { COMPATIBILITY_TOKEN_LIMIT } from './execution-control.js'
import { prisma } from '../prisma.js'
import { setTimeout as delay } from 'node:timers/promises'
import { databaseNow, runtimeError, runtimeJson } from './runtime-common.js'
import { withRunLease, acquireRunLease, releaseRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionStateInTransaction, readExecutionFrame, type executionSnapshotSchema } from './runtime-state.js'
import { readTaskBudgetInTransaction } from './runtime-budget.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { getActiveRun, registerActiveRun, deregisterActiveRun } from './active-runs.js'
import type { AgentTool, ToolContext, ToolResult } from './tools/types.js'
import type { ToolExecutionCursor } from './runtime-tool-cursor.js'
import { admitChildExecutionInTransaction, adoptChildGrants, verifyChildGrant } from './runtime-child.js'

type ChildConfiguration = Awaited<ReturnType<typeof readExecutionStateInTransaction>>['configuration']
type ChildMessages = z.infer<typeof executionSnapshotSchema>['messages']
const live = ['admitted', 'running', 'paused_parent', 'reconciliation']
// Foundation failure matrix passed. Full native matrix and release review are
// still required before this mutable source can be deployed.
export const DURABLE_CHILD_EXECUTION_ENABLED = true
const childWorkerOwner = `child:${randomUUID()}`
const childWorkers = new Map<string, Promise<void>>()

/** A saved child cursor is the only input. No prompt, model, price or inherited
 * authorization is reconstructed by the recovery dispatcher. */
export function dispatchDurableChild(userId: string, childRunId: string): Promise<void> {
  const pending = childWorkers.get(childRunId)
  if (pending) return pending
  const work = driveChild(userId, childRunId).finally(() => { childWorkers.delete(childRunId) })
  childWorkers.set(childRunId, work)
  return work
}

export async function wakeDurableChildren(parent: RunLeaseToken) {
  const grants = await withRunLease(parent, async tx => {
    await adoptChildGrants(tx, parent)
    const state = await readExecutionStateInTransaction(tx, parent.taskRootId)
    const pending = state.frame.state.pendingOperationId ? await tx.agentOperation.findUnique({ where: { id: state.frame.state.pendingOperationId } }) : null
    return tx.agentChildExecutionGrant.findMany({ where: { parentRootId: parent.taskRootId, status: { in: ['admitted', 'running'] },
      // Persist the immediate native window acknowledgement before allowing
      // its workers to contend with parent cursor reduction. A restart uses
      // the same prepared native operation and then wakes these saved grants.
      ...(pending?.status === 'prepared' && ['task_spawn', 'task_send'].includes(pending.action) ? { parentOperationId: { not: pending.id } } : {}) }, select: { childRunId: true } })
  })
  for (const grant of grants) void dispatchDurableChild(parent.userId, grant.childRunId).catch(() => {})
}

async function driveChild(userId: string, childRunId: string) {
  const saved = await prisma.agentChildExecutionGrant.findUnique({ where: { childRunId }, include: { childRun: true } })
  if (!saved || saved.childRun.userId !== userId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '子任务不存在或不属于当前作者。')
  const frozen = verifyChildGrant(saved)
  if (saved.status === 'completed' || !live.includes(saved.status)) return
  if (getActiveRun(childRunId)) return
  const controller = new AbortController()
  registerActiveRun(childRunId, { controller, userId, sessionId: saved.childRun.sessionId, internalChild: saved.kind === 'inline' })
  let lease: RunLeaseToken | undefined
  try {
    lease = await acquireRunLease({ userId, runId: childRunId, ownerId: childWorkerOwner, claimId: randomUUID() })
    await withRunLease(lease, async tx => {
      if (frozen.kind === 'inline') {
        const definition = frozen.definitionId ? await tx.agentSubtask.findFirst({ where: { id: frozen.definitionId, userId, novelId: saved.childRun.novelId, enabled: true } }) : null
        if (!definition) return runtimeError('RUNTIME_CHILD_DEFINITION_REQUIRED', '原子 Agent 定义不存在或已停用，不能派发。')
      }
      await tx.agentRun.update({ where: { id: childRunId }, data: { status: 'running', startedAt: saved.childRun.startedAt ?? await databaseNow(tx) } })
      await tx.agentChildExecutionGrant.update({ where: { id: saved.id }, data: { status: 'running' } })
    })
    const { runReviewedDurableExecution } = await import('./runtime-executor.js')
    const context = await (await import('./goal-fence.js')).readGoalExecution(userId, childRunId)
    const { withGoalExecutionContext } = await import('./goal-context.js')
    const outcome = await withGoalExecutionContext(context, () => runReviewedDurableExecution(lease!, controller.signal))
    if (outcome.kind !== 'completed') {
      await withRunLease(lease, async tx => {
        await tx.agentChildExecutionGrant.update({ where: { id: saved.id }, data: { status: 'reconciliation' } })
      }).catch(() => { /* A pause/lease loss is already persisted; never undo it. */ })
    }
  } catch (error) {
    if (lease && !controller.signal.aborted) {
      try {
        const current = await withRunLease(lease, tx => readExecutionStateInTransaction(tx, lease!.taskRootId))
        await withRunLease(lease, async tx => {
          await tx.agentChildExecutionGrant.update({ where: { id: saved.id }, data: { status: 'reconciliation' } })
          const code = typeof error === 'object' && error && 'code' in error && typeof error.code === 'string' ? error.code : 'CHILD_EXECUTION_INTERRUPTED'
          await tx.agentExecutionOutbox.upsert({ where: { eventKey: `child-interrupted:${saved.id}:${lease!.epoch}` }, update: {}, create: {
            id: randomUUID(), taskRootId: lease!.taskRootId, runId: childRunId, eventKey: `child-interrupted:${saved.id}:${lease!.epoch}`,
            type: 'child.interrupted', payload: { version: 1, grantId: saved.id, code } } })
        })
        await (await import('./runtime-lifecycle.js')).pauseDurableTaskForAttention(lease,
          { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash }, 'needs_input')
      } catch { /* Parent fencing owns the stopped result; do not replace it. */ }
    }
    throw error
  } finally {
    try { if (lease) await releaseRunLease(lease) }
    finally { deregisterActiveRun(childRunId) }
  }
}

/** Persist an await receipt BEFORE yielding. Restarts rediscover the grants and
 * renew the parent while the same saved child cursors finish. Unknown, paused,
 * failed and cancelled children are never converted into success. */
export async function awaitDurableChildren(parent: RunLeaseToken, signal: AbortSignal, options?: { sessionIds?: string[]; operation?: { id: string; grantIds: string[] }; any?: boolean; timeoutMs?: number }) {
  const selectedOperation = options?.operation ? { id: options.operation.id, grantIds: [...options.operation.grantIds] } : undefined
  if (selectedOperation && (options?.sessionIds || selectedOperation.grantIds.length !== 1 || !selectedOperation.id || !selectedOperation.grantIds[0])) {
    return runtimeError('RUNTIME_CHILD_SOURCE_REQUIRED', '内嵌等待必须明确绑定当前调用的唯一子任务授权。')
  }
  if (options?.sessionIds && !options.sessionIds.length) return runtimeError('RUNTIME_CHILD_SOURCE_REQUIRED', '窗口等待必须指定本任务的窗口，不能回退到整个任务历史。')
  const deadline = options?.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs
  for (;;) {
    signal.throwIfAborted()
    const rows = await withRunLease(parent, async tx => {
      const state = await readExecutionStateInTransaction(tx, parent.taskRootId)
      if (selectedOperation) {
        const operation = await tx.agentOperation.findUnique({ where: { id: selectedOperation.id } })
        if (state.frame.state.phase !== 'awaiting_operation' || state.frame.state.pendingOperationId !== selectedOperation.id
          || !operation || operation.taskRootId !== parent.taskRootId || operation.status !== 'prepared' || operation.kind !== 'tool'
          || !['subagent_run', 'subagent_delegate'].includes(operation.action) || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) {
          return runtimeError('RUNTIME_CHILD_SOURCE_REQUIRED', '内嵌等待不属于当前父任务原生调用。')
        }
      }
      const grants = await tx.agentChildExecutionGrant.findMany({ where: { parentRootId: parent.taskRootId,
        ...(selectedOperation ? { parentOperationId: selectedOperation.id, id: { in: selectedOperation.grantIds }, kind: 'inline' } : {}),
        ...(options?.sessionIds ? { childRun: { sessionId: { in: options.sessionIds } } } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { childRun: { include: { taskRoot: true } } } })
      for (const grant of grants) verifyChildGrant(grant)
      if (selectedOperation && (grants.length !== 1 || grants[0].id !== selectedOperation.grantIds[0])) return runtimeError('RUNTIME_CHILD_SOURCE_REQUIRED', '当前原生调用缺少精确子任务授权，不能收取其他历史交付。')
      const selected = options?.sessionIds ? [...new Map(grants.map(grant => [grant.childRun.sessionId, grant])).values()] : grants
      if (!selected.length) return selected
      const eventKey = `child-await:${parent.taskRootId}:${state.frame.revision}:${runtimeJson(selectedOperation ?? options?.sessionIds ?? []).hash}`
      const payload = { version: 1, sourceRevision: state.frame.revision, sourceHash: state.frame.snapshotHash, grantIds: selected.map(grant => grant.id) }
      const receipt = await tx.agentExecutionOutbox.findUnique({ where: { eventKey } })
      if (receipt) {
        if (receipt.taskRootId !== parent.taskRootId || receipt.type !== 'child.awaiting' || runtimeJson(receipt.payload).hash !== runtimeJson(payload).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原子任务等待回执与当前授权不一致。')
      } else await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: parent.taskRootId,
        runId: parent.runId, eventKey, type: 'child.awaiting', payload } })
      return selected
    })
    const completed = rows.filter(row => row.status === 'completed' && row.childRun.status === 'completed' && row.childRun.taskRoot?.status === 'completed')
    if (options?.any ? completed.length > 0 : completed.length === rows.length) return rows
    const blocked = rows.some(row => ['reconciliation', 'failed', 'cancelled', 'paused_parent'].includes(row.status)
      || ['paused', 'failed', 'cancelled'].includes(row.childRun.status))
    if (blocked || deadline !== undefined && Date.now() >= deadline) return rows
    // This is an idempotent in-process wake-up. A remote lease is authoritative;
    // busy/lost owners remain visible in the saved grant instead of duplicate HTTP.
    for (const row of rows.filter(item => item.status !== 'completed')) {
      void dispatchDurableChild(parent.userId, row.childRunId).catch(() => { /* Saved state determines the next wait result. */ })
    }
    await delay(500, undefined, { signal })
  }
}

/** Preserve complete context, omitting only the still-unanswered delegation
 * call from the child's native protocol. Its exact source stays in the grant. */
export function childContext(messages: ChildMessages, prompt: string, rolePrompt: string): ChildMessages {
  const replies = new Set(messages.flatMap(item => item.role === 'tool' ? [item.toolCallId] : []))
  const history: ChildMessages = messages.flatMap(item => {
    if (item.role !== 'assistant' || !item.toolCalls?.length) return [item]
    const calls = item.toolCalls.filter(call => replies.has(call.id))
    if (calls.length) return [{ ...item, toolCalls: calls }]
    return item.content ? [{ role: 'assistant' as const, content: item.content }] : []
  })
  return [...history, { role: 'system', content: rolePrompt }, { role: 'user', content: prompt }]
}

/** Native child tools enter this adapter directly; the legacy inline runner is
 * never called for a durable root. */
export async function executeDurableChildTool(parent: RunLeaseToken, cursor: ToolExecutionCursor, ctx: ToolContext, tool: AgentTool, args: Record<string, unknown>) {
  if (!DURABLE_CHILD_EXECUTION_ENABLED) return runtimeError('RUNTIME_CHILD_ADAPTER_REQUIRED', '持久子任务执行仍待验证，不能回退到旧执行器。')
  const { prepareToolCursorOperation } = await import('./runtime-tool-cursor.js')
  const { commitOperationEffect, assertCurrentToolPolicy, recordToolFailure } = await import('./runtime-operations.js')
  const { reduceExecutionReceipt } = await import('./runtime-reducer.js')
  const { normalizeToolInput } = await import('./tools/input-validation.js')
  const normalize = (raw: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(normalizeToolInput(tool, raw)) as Record<string, unknown>).filter(([, value]) => value !== undefined))
  const source = await withRunLease(parent, tx => readExecutionStateInTransaction(tx, parent.taskRootId))
  const frame = await withRunLease(parent, tx => readExecutionFrame(tx, parent.taskRootId, cursor.expectedRevision))
  const prepared = await prepareToolCursorOperation(parent, cursor, { key: `exec:${frame.state.nextOperationSequence}`,
    action: tool.name, callId: ctx.callId, targetId: parent.taskRootId, effectDomain: 'read', effectiveArgs: args,
    normalize, operationInput: runtimeJson({ callId: ctx.callId, args }).value })
  const existing = await withRunLease(parent, tx => tx.agentChildExecutionGrant.findMany({ where: { parentOperationId: prepared.operation.id }, orderBy: { childIndex: 'asc' }, include: { childRun: true } }))
  let grants = existing
  if (tool.name !== 'task_wait' && !existing.length) {
    const entries = tool.name === 'task_spawn' ? z.array(z.object({ title: z.string(), brief: z.string(), model: z.unknown().optional() })).parse(args.tasks)
      : [{ title: String(args.name ?? '子 Agent'), brief: String(args.task ?? args.prompt), model: args.model }]
    if (entries.length > env.agentSpawnMaxParallel && tool.name === 'task_spawn') return runtimeError('RUNTIME_CHILD_CONCURRENCY_LIMIT', '本次派生数量超过并行上限。')
    const { getModelTierRuntime } = await import('../credits.js')
    const { admitAssignedModel } = await import('./model-assignments.js')
    const { assignedTaskModel } = await import('./model-assignment-context.js')
    const { agentModelSelectionSchema } = await import('../../../shared/contracts/agent-model-assignments.js')
    const { resolveTokenPrice } = await import('../billing/resolve-token-price.js')
    const { modelRouteRevision } = await import('./runtime-model-cursor.js')
    const { getAgentDefinition } = await import('./agents.js')
    const selections = await Promise.all(entries.map(async entry => {
      const selected = entry.model ? await admitAssignedModel(ctx.userId, agentModelSelectionSchema.parse(entry.model))
        : await assignedTaskModel(ctx.userId, ctx.novelId, tool.name.startsWith('subagent_') ? 'subagent' : 'spawned_task', source.configuration.modelAssignments, true)
      const inherited = source.configuration.model
      const runtime = selected?.runtime ?? await getModelTierRuntime(inherited.tier as import('../../../shared/contracts/index.js').CreditModelTier,
        ctx.userId, inherited.customModelId, inherited.reasoningEffort as import('../../../shared/contracts/index.js').ModelReasoningEffort)
      if (runtime.tier !== (selected?.selection.modelTier ?? inherited.tier)) return runtimeError('RUNTIME_MODEL_ADAPTER_REQUIRED', '原子任务模型不可用，不能替换为其他档位。')
      return { entry, runtime, selected, price: await resolveTokenPrice(runtime.tier, runtime.multiplierBps) }
    }))
    grants = await withRunLease(parent, async tx => {
      await assertCurrentToolPolicy(tx, parent, prepared.operation)
      const result = []
      for (const [index, selection] of selections.entries()) {
        let definition: { id: string; name: string; role: string; prompt: string; enabled: boolean } | null = null
        if (tool.name === 'subagent_run') definition = await tx.agentSubtask.findFirst({ where: { id: String(args.subagentId), userId: ctx.userId, novelId: ctx.novelId } })
        if (tool.name === 'subagent_delegate') {
          definition = await tx.agentSubtask.findFirst({ where: { userId: ctx.userId, novelId: ctx.novelId, name: String(args.name) } })
            ?? await tx.agentSubtask.create({ data: { userId: ctx.userId, novelId: ctx.novelId, name: String(args.name), role: String(args.role), prompt: String(args.prompt),
              triggerCondition: String(args.triggerCondition), tokenBudget: 16000, enabled: true, status: 'ready' } })
        }
        if (tool.name.startsWith('subagent_') && (!definition || !definition.enabled)) return runtimeError('RUNTIME_CHILD_DEFINITION_REQUIRED', '子 Agent 不存在或已停用。')
        const role = z.enum(['orchestrator', 'research', 'continuity', 'quality', 'lore']).parse(definition?.role ?? 'orchestrator')
        const parentSpec = taskSpecSchema.parse(source.originalSpec)
        const kind = tool.name.startsWith('subagent_') ? 'inline' as const : 'spawned' as const
        const prompt = kind === 'inline' ? String(args.task) : tool.name === 'task_send' ? String(args.prompt)
          : (await import('./tools/task-orchestration-tools.js')).composeSpawnPrompt(selection.entry.brief, args.inherit === 'transcript' ? 'transcript' : 'brief')
        const mode = kind === 'inline' ? role === 'research' ? 'plan' as const : 'review' as const : z.enum(['plan', 'build', 'review']).parse(args.mode)
        const task = kind === 'inline' ? { ...parentSpec, id: randomUUID(), runId: undefined, intent: 'review' as const,
          goals: [prompt], expectedOutputs: [{ kind: 'validation_report' as const, required: true, description: prompt }], postconditions: [], createdAt: new Date().toISOString() }
          : { ...(await import('./task-spec.js')).buildTaskSpec({ runId: randomUUID(), novelId: ctx.novelId, chapterId: ctx.chapterId, prompt,
            creativeFreedom: source.configuration.creativeFreedom, qualityMode: source.configuration.qualityMode }), scope: parentSpec.scope, hardConstraints: parentSpec.hardConstraints }
        const budget = await readTaskBudgetInTransaction(tx, parent.taskRootId)
        if (budget.unresolvedAttempts > 0n) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原任务存在未知支出，不能分配新子任务。')
        const tokenCeiling = COMPATIBILITY_TOKEN_LIMIT
        const modelName = selection.runtime.modelName ?? env.aiTextModel
        const inheritedConfiguration = Object.fromEntries(Object.entries(source.configuration).filter(([key]) => key !== 'pinnedSubagentId')) as ChildConfiguration
        const configuration: ChildConfiguration = { ...inheritedConfiguration, mode, agentType: role,
          model: selection.selected ? { ...source.configuration.model, tier: selection.runtime.tier, provider: selection.runtime.provider,
            modelName, customModelId: selection.selected.selection.customModelId ?? null, reasoningEffort: selection.runtime.reasoningEffort,
            routeRevision: modelRouteRevision({ provider: selection.runtime.provider, model: modelName,
              endpoint: `${(selection.runtime.baseUrl ?? env.aiTextBaseUrl).replace(/\/$/, '')}/chat/completions`, reasoningEffort: selection.runtime.reasoningEffort }) }
            : source.configuration.model }
        if (parentSpec.scope.selection) {
          const { getToolByName } = await import('./tools/registry.js')
          const readNames = new Set(configuration.tools.filter(item => getToolByName(item.function.name)?.readOnly).map(item => item.function.name))
          configuration.tools = configuration.tools.filter(item => readNames.has(item.function.name))
          configuration.toolAuthority = configuration.toolAuthority.filter(item => readNames.has(item.name))
        }
        const grant = await admitChildExecutionInTransaction(tx, parent, { parentOperationId: prepared.operation.id, childIndex: index, kind, role,
          name: definition?.name ?? selection.entry.title, prompt, spec: task, configuration, price: selection.price, tokenCeiling,
          turnCeiling: 1, roleTools: getAgentDefinition(role).tools,
          ...(tool.name === 'task_send' ? { targetSessionId: String(args.sessionId) } : {}),
          ...(definition ? { definitionId: definition.id } : {}),
          // Rework admission appends this current parent block after the
          // verified target window's full saved transcript inside this TX.
          messages: childContext(source.frame.state.messages, prompt, definition?.prompt ?? '只执行当前分工，交付后等待主控审查；不能新增授权或再次派生。') })
        result.push(await tx.agentChildExecutionGrant.findUniqueOrThrow({ where: { id: grant.id }, include: { childRun: true } }))
      }
      return result
    })
  }
  let result: ToolResult
  if (tool.name === 'task_spawn' || tool.name === 'task_send') {
    // Admission is committed before this immediate acknowledgement. Scheduler
    // failure leaves discoverable saved work and never invents completion.
    const windows = grants.map(grant => ({ sessionId: grant.childRun.sessionId, title: verifyChildGrant(grant).name, status: 'running' as const }))
    result = { output: `已派生 ${grants.length} 个持久任务窗口：\n${windows.map(window => `- ${window.title}｜任务 ID ${window.sessionId}`).join('\n')}\n请使用 task_wait 收取真实交付并逐个审查。`,
      summary: tool.name === 'task_send' ? '返工任务已准入' : `派生 ${grants.length} 个并行窗口`, display: { kind: 'taskOrchestration', mode: tool.name === 'task_send' ? 'send' : 'spawn', detail: '任务已准入', windows } }
  } else {
    const ids = tool.name === 'task_wait' ? z.array(z.string()).parse(args.sessionIds) : undefined
    const waited = await awaitDurableChildren(parent, ctx.signal, ids
      ? { sessionIds: ids, any: args.mode === 'any', timeoutMs: Math.min(Number(args.timeoutSeconds), env.agentTaskWaitMaxSeconds) * 1000 }
      : { operation: { id: prepared.operation.id, grantIds: grants.map(grant => grant.id) } })
    const summaries = await Promise.all(waited.map(async grant => {
      const { state, interruption } = await withRunLease(parent, async tx => ({
        state: await readExecutionStateInTransaction(tx, grant.childRun.taskRootId!),
        interruption: await tx.agentExecutionOutbox.findFirst({ where: { runId: grant.childRunId, type: 'child.interrupted' }, orderBy: { createdAt: 'desc' } }),
      }))
      const last = state.frame.state.messages.at(-1)
      const interrupted = z.object({ version: z.literal(1), grantId: z.literal(grant.id), code: z.string() }).safeParse(interruption?.payload)
      const reason = interrupted.success ? ['RUNTIME_CHILD_BUDGET_EXHAUSTED', 'RUNTIME_CHILD_REQUEST_BUDGET_REQUIRED'].includes(interrupted.data.code)
        ? '完整原始上下文与配置输出空间超过本子任务冻结额度，供应商尚未派发。原上下文、执行位置和已保存内容均保留；主 Agent 可以继续自己已获授权的工作，指定子 Agent 的交付要求仍未完成。'
        : interrupted.data.code === 'RUNTIME_CHILD_DEFINITION_REQUIRED' ? '原子 Agent 已停用或定义身份不匹配，供应商尚未派发。请核对原定义后继续。'
          : '原子任务执行被中断，已保留原始进度和回执；未确认的供应商结果需核对，不能自动重复派发。' : ''
      return { grant, report: [last?.role === 'assistant' ? last.content ?? '' : '', reason].filter(Boolean).join('\n'), completed: grant.status === 'completed' && grant.childRun.status === 'completed' }
    }))
    const completed = summaries.every(item => item.completed) && (!ids || ids.every(id => summaries.some(item => item.grant.childRun.sessionId === id)))
    result = { output: summaries.map(item => `${verifyChildGrant(item.grant).name}：${item.completed ? '已完成，需审查' : '未完成，需处理'}\n${item.report}`).join('\n\n') || '没有本任务授权的子任务交付。',
      summary: completed ? '子任务真实交付已返回' : '子任务尚未完成', ...(completed ? {} : { outcome: 'failed' as const }) }
    if (tool.name.startsWith('subagent_') && summaries[0]) result.display = { kind: 'subagentReport', subagentRunId: summaries[0].grant.id,
      subagentName: verifyChildGrant(summaries[0].grant).name, role: verifyChildGrant(summaries[0].grant).role,
      status: completed ? 'success' : 'failed', report: summaries[0].report, steps: 0 }
  }
  const receipt = result.outcome === 'failed' ? await recordToolFailure(parent, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash,
    code: 'RUNTIME_CHILD_NOT_COMPLETED', output: result.output, summary: result.summary ?? '子任务未完成' })
    : await commitOperationEffect(parent, prepared.operation.id, prepared.operation.inputHash, async () => runtimeJson({ toolResult: result }).value)
  await reduceExecutionReceipt(parent, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  if (tool.name === 'task_spawn' || tool.name === 'task_send') {
    for (const grant of grants) void dispatchDurableChild(ctx.userId, grant.childRunId).catch(() => {})
  }
  return { kind: 'tool' as const, result: z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult }
}
