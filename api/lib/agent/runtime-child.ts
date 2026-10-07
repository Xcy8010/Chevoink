import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentChildExecutionGrant, Prisma } from '@prisma/client'
import { databaseNow, lockRunRoot, runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { withRunLease, withRunLeaseInTransaction, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionStateInTransaction, executionSnapshotSchema } from './runtime-state.js'
import { createTaskBudgetPolicy, readTaskBudgetInTransaction } from './runtime-budget.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { tokenPriceSchema } from '../billing/token-price.js'
import { env } from '../../config/env.js'
import { COMPATIBILITY_TOKEN_LIMIT } from './execution-control.js'

export const MAIN_RUN_FILTER = { incomingChildGrant: { isNot: { kind: 'inline' } } } satisfies Prisma.AgentRunWhereInput
export const CHILD_ACTIONS = ['subagent_run', 'subagent_delegate', 'task_spawn', 'task_send'] as const
const live = ['admitted', 'running', 'paused_parent', 'reconciliation']

/** Business deletion may erase a settled lineage's receipts under the existing
 * policy. It may never remove a live parent's pin/usage proof or unknown cost.
 * Caller uses the SAME transaction for this check and the subsequent deletion. */
export async function prepareChildGrantDeletion(tx: RuntimeTx, userId: string, runIds: string[]) {
  const affected = { OR: [{ admissionRunId: { in: runIds } }, { currentParentRunId: { in: runIds } }, { childRunId: { in: runIds } }] }
  const initial = await tx.agentChildExecutionGrant.findMany({ where: affected })
  if (!initial.length) return
  const parentRootIds = [...new Set(initial.map(grant => grant.parentRootId))].sort()
  // Parent locks precede every child lock, matching admission, execution and
  // late evidence writes. Re-read siblings after locking to include admissions
  // that committed before our parent lock was acquired.
  const parents = await tx.agentRun.findMany({ where: { taskRootId: { in: parentRootIds } }, orderBy: { id: 'asc' } })
  if (parents.some(run => run.userId !== userId)) return runtimeError('RUNTIME_SCOPE_MISMATCH', '删除目标含其他作者的父任务。')
  for (const run of parents) await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${run.id} FOR UPDATE`
  for (const rootId of parentRootIds) await tx.$queryRaw`SELECT id FROM agent_task_roots WHERE id = ${rootId} FOR UPDATE`
  const grants = await tx.agentChildExecutionGrant.findMany({ where: { parentRootId: { in: parentRootIds } }, orderBy: { id: 'asc' }, include: { childRun: true } })
  const childRootIds: string[] = []
  for (const grant of grants) {
    verifyChildGrant(grant)
    if (grant.childRun.userId !== userId || !grant.childRun.taskRootId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '删除目标缺少原子任务归属。')
    await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${grant.childRunId} FOR UPDATE`
    await tx.$queryRaw`SELECT id FROM agent_task_roots WHERE id = ${grant.childRun.taskRootId} FOR UPDATE`
    childRootIds.push(grant.childRun.taskRootId)
  }
  const rootIds = [...parentRootIds, ...childRootIds]
  const runs = await tx.agentRun.findMany({ where: { taskRootId: { in: rootIds } } })
  const roots = await tx.agentTaskRoot.findMany({ where: { id: { in: rootIds } } })
  if (runs.some(run => !['completed', 'failed', 'cancelled'].includes(run.status))
    || roots.some(root => !['completed', 'cancelled'].includes(root.status))) {
    return runtimeError('RUNTIME_CHILD_DELETION_BLOCKED', '父子任务尚未终止，不能删除原授权、交付证据或累计预算。')
  }
  for (const rootId of parentRootIds) {
    if ((await readTaskBudgetInTransaction(tx, rootId)).unresolvedAttempts > 0n) return runtimeError('RUNTIME_CHILD_DELETION_BLOCKED', '父子任务仍有未确认的供应商用量，核对前不能删除。')
  }
  if (await tx.agentProviderUsageReceipt.count({ where: { attempt: { operation: { taskRootId: { in: rootIds } } }, settlementStatus: { not: 'settled' } } })) {
    return runtimeError('RUNTIME_CHILD_DELETION_BLOCKED', '父子任务仍有待结算的已知用量，结算前不能删除。')
  }
  const removing = new Set(runIds)
  const affectedGrants = grants.filter(grant => removing.has(grant.admissionRunId) || removing.has(grant.currentParentRunId) || removing.has(grant.childRunId))
  if (affectedGrants.some(grant => grant.kind === 'spawned' && !removing.has(grant.childRunId))) {
    return runtimeError('RUNTIME_CHILD_DELETION_BLOCKED', '独立子任务窗口仍需保留原授权和范围。请先删除已结清的相关子任务窗口，再删除父任务对话。')
  }
  // Sibling grants are checked above but retained unless this exact business
  // deletion targets their authoritative parent/child run.
  await tx.agentChildExecutionGrant.deleteMany({ where: affected })
  // Same-session inline executions must never outlive the provenance which
  // keeps them private. Clean them atomically even when only the parent turn
  // is selected; separate visible windows are governed by the check above.
  const inline = affectedGrants.filter(grant => grant.kind === 'inline')
  const inlineIds = inline.map(grant => grant.childRunId)
  const inlineRoots = inline.map(grant => grant.childRun.taskRootId!)
  if (inlineIds.length) {
    await tx.projectMemoryEntry.deleteMany({ where: { runId: { in: inlineIds } } })
    await tx.agentArtifact.deleteMany({ where: { runId: { in: inlineIds } } })
    await tx.agentRun.deleteMany({ where: { id: { in: inlineIds }, userId } })
    await tx.agentTaskRoot.deleteMany({ where: { id: { in: inlineRoots }, userId } })
  }
}
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const grantSnapshotSchema = z.object({
  version: z.literal(1), parentRootId: z.string(), parentOperationId: z.string(), childIndex: z.number().int().nonnegative().max(4),
  admissionRunId: z.string(), admissionEpoch: z.string().regex(/^[0-9]+$/), kind: z.enum(['inline', 'spawned']),
  targetSessionId: z.string().optional(), definitionId: z.string().optional(),
  role: z.enum(['orchestrator', 'research', 'continuity', 'quality', 'lore']), name: z.string().min(1), prompt: z.string().min(1),
  taskSpec: taskSpecSchema, configuration: z.unknown(), price: tokenPriceSchema,
  tokenCeiling: z.number().int().min(500).max(2147483647), turnCeiling: z.number().int().positive().max(2147483647),
  parentConfigurationHash: hash, parentFrameRevision: z.number().int().nonnegative(), parentFrameHash: hash,
  reworkSource: z.object({ grantId: z.string(), runId: z.string(), taskRootId: z.string(), frameRevision: z.number().int().nonnegative(), frameHash: hash }).strict().optional(),
}).strict()

export type ChildParentFence = { grantId: string; runId: string; taskRootId: string; ownerId: string; claimId: string; epoch: bigint }

/** The mutable generation never participates in this immutable admission digest. */
export function verifyChildGrant(grant: AgentChildExecutionGrant) {
  const parsed = grantSnapshotSchema.safeParse(grant.snapshot)
  if (!parsed.success || runtimeJson(grant.snapshot).hash !== grant.snapshotHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '子任务授权快照损坏。')
  const frozen = parsed.data
  if (frozen.parentRootId !== grant.parentRootId || frozen.parentOperationId !== grant.parentOperationId
    || frozen.childIndex !== grant.childIndex || frozen.admissionRunId !== grant.admissionRunId
    || frozen.admissionEpoch !== String(grant.admissionEpoch) || frozen.kind !== grant.kind || frozen.tokenCeiling !== grant.tokenCeiling) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '子任务授权与原准入身份不一致。')
  }
  return frozen
}

/** A pinned author choice is a frozen parent requirement, fulfilled only by a
 * real native call and canonical terminal child. Assistant prose is not proof. */
export async function assertPinnedChildCompletion(tx: RuntimeTx, parentRootId: string) {
  const state = await readExecutionStateInTransaction(tx, parentRootId)
  const pin = z.object({ pinnedSubagentId: z.string().optional() }).parse(state.configuration).pinnedSubagentId
  if (!pin) return
  const grants = await tx.agentChildExecutionGrant.findMany({ where: { parentRootId, kind: 'inline', status: 'completed' },
    include: { parentOperation: true, childRun: { include: { taskRoot: true } } } })
  const { verifyRunLimitedWritingOutcome } = await import('./writing-delivery-limitations.js')
  const limited = new Set<string>()
  for (const grant of grants) {
    if (await verifyRunLimitedWritingOutcome(tx, { userId: grant.childRun.userId, novelId: grant.childRun.novelId, runId: grant.childRunId })) limited.add(grant.id)
  }
  const matched = grants.some(grant => {
    const frozen = verifyChildGrant(grant)
    const operation = grant.parentOperation
    if (operation.action !== 'subagent_run' || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash
      || frozen.definitionId !== pin || grant.childRun.status !== 'completed' || grant.childRun.taskRoot?.status !== 'completed') return false
    if (limited.has(grant.id)) return false
    const envelope = z.object({ input: z.object({ args: z.object({ subagentId: z.string() }) }) }).safeParse(operation.inputSnapshot)
    return envelope.success && envelope.data.input.args.subagentId === pin
  })
  if (!matched) return runtimeError('RUNTIME_PINNED_CHILD_REQUIRED', '指定子 Agent 尚未通过原生调用交付真实完成报告。')
}

/** All execution checks run after the common parent-before-child lock acquisition.
 * A generation change invalidates existing child tokens even if their own lease survived. */
export async function assertChildParentFence(tx: RuntimeTx, runId: string, expected?: ChildParentFence) {
  const grant = await tx.agentChildExecutionGrant.findUnique({ where: { childRunId: runId } })
  if (!grant) {
    if (expected) return runtimeError('RUNTIME_LEASE_LOST', '原子任务授权已不存在。')
    return undefined
  }
  const frozen = verifyChildGrant(grant)
  const childRun = await tx.agentRun.findUniqueOrThrow({ where: { id: runId } })
  const { run, root } = await lockRunRoot(tx, childRun.userId, grant.currentParentRunId)
  if (childRun.taskRootId !== frozen.taskSpec.id || childRun.novelId !== root.novelId || childRun.userId !== root.userId
    || childRun.runtimeProtocolVersion !== 1) return runtimeError('RUNTIME_SCOPE_MISMATCH', '子任务原执行身份或作品范围已改变。')
  const childState = await readExecutionStateInTransaction(tx, childRun.taskRootId)
  if (runtimeJson(childState.head.configuration).hash !== runtimeJson(frozen.configuration).hash
    || runtimeJson(childState.originalSpec).hash !== runtimeJson(frozen.taskSpec).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '子任务不能改变原授权模型、配置或任务合同。')
  const parentGoal = await (await import('./goal-fence.js')).readGoalExecution(childRun.userId, run.id, tx)
  const childGoal = await tx.agentGoalExecution.findUnique({ where: { runId: childRun.id } })
  if (parentGoal ? !childGoal || childGoal.goalId !== parentGoal.goalId || childGoal.goalRevision !== parentGoal.revision
    || childGoal.epoch !== parentGoal.epoch || childGoal.trigger !== 'subagent' || childGoal.sourceEventId !== `child-grant:${grant.id}` : Boolean(childGoal)) {
    return runtimeError('RUNTIME_CHILD_GOAL_FENCE_REQUIRED', '子任务必须先由当前父任务采用原目标预算归属。')
  }
  const held = await tx.agentRunLease.findUnique({ where: { runId: run.id } })
  if (!live.includes(grant.status) || grant.status === 'paused_parent' || root.id !== grant.parentRootId
    || root.status !== 'active' || !['queued', 'running'].includes(run.status) || !held?.enabled
    || held.epoch !== grant.generation || !held.ownerId || !held.claimId || !held.expiresAt || held.expiresAt <= await databaseNow(tx)) {
    return runtimeError('RUNTIME_PARENT_LEASE_LOST', '父任务已暂停、终止或失去所有权，子任务不能继续执行。')
  }
  const fence = { grantId: grant.id, runId: run.id, taskRootId: root.id, ownerId: held.ownerId, claimId: held.claimId, epoch: held.epoch }
  if (expected && (expected.grantId !== fence.grantId || expected.runId !== fence.runId || expected.taskRootId !== fence.taskRootId
    || expected.ownerId !== fence.ownerId || expected.claimId !== fence.claimId || expected.epoch !== fence.epoch)) {
    return runtimeError('RUNTIME_PARENT_LEASE_LOST', '父任务执行代次已改变，已阻止旧子任务执行者。')
  }
  return fence
}

/** Called only when the parent's new lease has been acquired. Same grant/run/root,
 * same operations and receipts; adoption never creates or sends a provider request. */
export async function adoptChildGrants(tx: RuntimeTx, parent: RunLeaseToken) {
  const grants = await tx.agentChildExecutionGrant.findMany({ where: { parentRootId: parent.taskRootId, status: { in: live } }, orderBy: { id: 'asc' }, include: { childRun: true } })
  for (const grant of grants) {
    verifyChildGrant(grant)
    const goalChanged = await bindChildGoal(tx, parent, grant)
    if (!goalChanged && grant.currentParentRunId === parent.runId && grant.generation === parent.epoch) continue
    await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${grant.childRunId} FOR UPDATE`
    const child = grant.childRun
    if (!child.taskRootId || child.runtimeProtocolVersion !== 1) return runtimeError('RUNTIME_RECEIPT_INVALID', '子任务缺少原持久执行身份。')
    await tx.$queryRaw`SELECT id FROM agent_task_roots WHERE id = ${child.taskRootId} FOR UPDATE`
    const lease = await tx.agentRunLease.findUniqueOrThrow({ where: { runId: child.id } })
    if (lease.epoch >= 9223372036854775807n) return runtimeError('RUNTIME_EPOCH_EXHAUSTED', '子任务执行代次已达上限。')
    await tx.agentRunLease.update({ where: { runId: child.id }, data: { enabled: true, ownerId: null, claimId: null, expiresAt: null, epoch: { increment: 1 } } })
    if (grant.status === 'paused_parent') {
      await tx.agentTaskRoot.update({ where: { id: child.taskRootId }, data: { status: 'active' } })
      await tx.agentRun.update({ where: { id: child.id }, data: { status: 'queued' } })
    }
    await tx.agentChildExecutionGrant.update({ where: { id: grant.id }, data: { currentParentRunId: parent.runId, generation: parent.epoch,
      ...(grant.status === 'paused_parent' ? { status: 'admitted' } : {}) } })
  }
}

/** Caller already fenced and locked the parent. Goal attachment adds a budget
 * restriction; it grants no tool/target/source authority and sends no request. */
async function bindChildGoal(tx: RuntimeTx, parent: RunLeaseToken, grant: AgentChildExecutionGrant) {
  const parentGoal = await (await import('./goal-fence.js')).readGoalExecution(parent.userId, parent.runId, tx)
  const childGoal = await tx.agentGoalExecution.findUnique({ where: { runId: grant.childRunId } })
  if (!parentGoal) {
    if (childGoal) return runtimeError('RUNTIME_SCOPE_MISMATCH', '原目标子任务不能采用无目标父任务授权。')
    return false
  }
  if (childGoal) {
    if (childGoal.goalId !== parentGoal.goalId || childGoal.trigger !== 'subagent' || childGoal.sourceEventId !== `child-grant:${grant.id}`) return runtimeError('RUNTIME_SCOPE_MISMATCH', '子任务缺少原目标归属。')
    if (childGoal.goalRevision === parentGoal.revision && childGoal.epoch === parentGoal.epoch) return false
    await tx.agentGoalExecution.update({ where: { runId: grant.childRunId }, data: { goalRevision: parentGoal.revision, epoch: parentGoal.epoch } })
    return true
  }
  const goal = await tx.agentGoal.findUniqueOrThrow({ where: { id: parentGoal.goalId } })
  const { withGoalExecutionContext } = await import('./goal-context.js')
  const { admitGoalRun, bindGoalRun } = await import('./goal-run-admission.js')
  const admission = { goalId: parentGoal.goalId, revision: parentGoal.revision, epoch: parentGoal.epoch,
    continuationIndex: goal.continuationIndex, trigger: 'subagent' as const, sourceEventId: `child-grant:${grant.id}` }
  const frozen = verifyChildGrant(grant)
  const child = await tx.agentRun.findUniqueOrThrow({ where: { id: grant.childRunId } })
  const admitted = await withGoalExecutionContext(parentGoal, () => admitGoalRun(tx, parent.userId, child.sessionId, child.novelId, admission, frozen.prompt))
  await bindGoalRun(tx, admitted, admission, child.id)
  await tx.agentGoalExecution.update({ where: { runId: child.id }, data: { taskRootId: child.taskRootId } })
  return true
}

/** Parent stop is authoritative even if the child worker is on another process. */
export async function pauseChildGrants(tx: RuntimeTx, parentRootId: string, cancel = false) {
  const grants = await tx.agentChildExecutionGrant.findMany({ where: { parentRootId, status: { in: live } }, orderBy: { id: 'asc' }, include: { childRun: true } })
  const runIds: string[] = []
  for (const grant of grants) {
    await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${grant.childRunId} FOR UPDATE`
    if (!grant.childRun.taskRootId) return runtimeError('RUNTIME_RECEIPT_INVALID', '子任务根不存在。')
    await tx.$queryRaw`SELECT id FROM agent_task_roots WHERE id = ${grant.childRun.taskRootId} FOR UPDATE`
    await tx.agentRunLease.updateMany({ where: { runId: grant.childRunId, epoch: { lt: 9223372036854775807n } }, data: { epoch: { increment: 1 } } })
    await tx.agentRunLease.update({ where: { runId: grant.childRunId }, data: { enabled: false, ownerId: null, claimId: null, expiresAt: null } })
    await tx.agentTaskRoot.update({ where: { id: grant.childRun.taskRootId }, data: { status: cancel ? 'cancelled' : 'paused' } })
    await tx.agentRun.update({ where: { id: grant.childRunId }, data: { status: cancel ? 'cancelled' : 'paused' } })
    await tx.agentChildExecutionGrant.update({ where: { id: grant.id }, data: { status: cancel ? 'cancelled' : 'paused_parent' } })
    runIds.push(grant.childRunId)
  }
  return runIds
}

type ChildConfiguration = Awaited<ReturnType<typeof readExecutionStateInTransaction>>['configuration']
type ChildMessages = z.infer<typeof executionSnapshotSchema>['messages']

/** Preserve every historical message, changing only native call identities in
 * the copied block. The original frame remains the canonical source evidence. */
function reworkHistory(previous: ChildMessages, current: ChildMessages, sourceHash: string): ChildMessages {
  const occupied = new Set(current.flatMap(message => message.role === 'assistant' ? (message.toolCalls ?? []).map(call => call.id)
    : message.role === 'tool' ? [message.toolCallId] : []))
  const checked = (messages: ChildMessages, namespace: boolean): ChildMessages => {
    const pending = new Map<string, string>()
    const result = messages.map((message, index) => {
      if (message.role === 'tool') {
        const id = pending.get(message.toolCallId)
        if (!id) return runtimeError('RUNTIME_RECEIPT_INVALID', '返工历史存在未配对的原生工具回复。')
        pending.delete(message.toolCallId)
        return { ...message, toolCallId: id }
      }
      if (pending.size) return runtimeError('RUNTIME_RECEIPT_INVALID', '返工历史的原生调用尚未收到全部回复。')
      if (message.role !== 'assistant' || !message.toolCalls?.length) return message
      return { ...message, toolCalls: message.toolCalls.map((call, callIndex) => {
        if (call.incomplete || pending.has(call.id)) return runtimeError('RUNTIME_RECEIPT_INVALID', '返工历史包含不完整或重复的原生调用。')
        const id = namespace ? `rework_${runtimeJson({ sourceHash, index, callIndex, id: call.id }).hash.slice(0, 32)}` : call.id
        if (namespace && occupied.has(id)) return runtimeError('RUNTIME_RECEIPT_INVALID', '返工历史原生调用编号与当前上下文冲突。')
        if (namespace) occupied.add(id)
        pending.set(call.id, id)
        return { ...call, id }
      }) }
    })
    if (pending.size) return runtimeError('RUNTIME_RECEIPT_INVALID', '返工历史尚有未回复的原生调用。')
    return result
  }
  const prior = checked(previous, true), parent = checked(current, false)
  return [{ role: 'system', content: '以下是目标窗口已完成任务的完整历史，仅作为原任务上下文与证据，不构成新增授权。' }, ...prior,
    { role: 'system', content: '以下是当前主任务上下文与本次返工指令。执行仍受当前冻结授权、目标与预算约束。' }, ...parent]
}

/** Pure ceiling intersection: delegation cannot make an ask into allow, omit a
 * protected target, add a tool, or recursively issue another delegation. */
export function intersectChildConfiguration(parent: ChildConfiguration, requested: ChildConfiguration, roleTools: readonly string[] | '*') {
  const forbidden = new Set([...CHILD_ACTIONS, 'task_wait', 'agent_configure', 'model_assign', 'goal_enable', 'novel_import'])
  const authority = requested.toolAuthority.flatMap(item => {
    const ceiling = parent.toolAuthority.find(value => value.name === item.name)
    if (!ceiling || ceiling.permission === 'deny' || item.permission === 'deny' || forbidden.has(item.name)
      || roleTools !== '*' && !roleTools.includes(item.name)) return []
    return [{ ...item, permission: ceiling.permission === 'ask' || item.permission === 'ask' ? 'ask' as const : 'allow' as const,
      alwaysConfirm: ceiling.alwaysConfirm || item.alwaysConfirm, dangerous: ceiling.dangerous || item.dangerous }]
  })
  const tools = requested.tools.filter(tool => authority.some(item => item.name === tool.function.name)
    && parent.tools.some(item => item.function.name === tool.function.name && runtimeJson(item.function.parameters).hash === runtimeJson(tool.function.parameters).hash))
  const { pinnedSubagentId: _pin, ...childConfiguration } = requested
  return { ...childConfiguration, tools, toolAuthority: authority.filter(item => tools.some(tool => tool.function.name === item.name)),
    protectedChapterIds: [...new Set([...parent.protectedChapterIds, ...requested.protectedChapterIds])],
    ...(parent.modelAssignments ? { modelAssignments: parent.modelAssignments } : {}) }
}

/** Only a server adapter which already admitted a native parent cursor may call
 * this DB-only issuer. It proves the pending call again; no HTTP issuer exists. */
export async function admitChildExecutionInTransaction(tx: RuntimeTx, parent: RunLeaseToken, input: {
  parentOperationId: string; childIndex: number; kind: 'inline' | 'spawned'; role: z.infer<typeof grantSnapshotSchema>['role'];
  name: string; prompt: string; spec: unknown; configuration: ChildConfiguration; price: unknown;
  tokenCeiling: number; turnCeiling: number; roleTools: readonly string[] | '*'; messages: ChildMessages;
  targetSessionId?: string; definitionId?: string;
}) {
  await withRunLeaseInTransaction(tx, parent, async () => undefined)
  const { run, root } = await lockRunRoot(tx, parent.userId, parent.runId)
  if (await tx.agentChildExecutionGrant.findUnique({ where: { childRunId: run.id } })) return runtimeError('RUNTIME_CHILD_RECURSION_DENIED', '子任务不能继续派生其他任务。')
  const current = await readExecutionStateInTransaction(tx, root.id)
  const operation = await tx.agentOperation.findUnique({ where: { id: input.parentOperationId } })
  if (current.frame.state.phase !== 'awaiting_operation' || current.frame.state.pendingOperationId !== input.parentOperationId
    || !operation || operation.taskRootId !== root.id || operation.kind !== 'tool' || operation.status !== 'prepared'
    || !CHILD_ACTIONS.some(action => action === operation.action) || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) {
    return runtimeError('RUNTIME_CHILD_SOURCE_REQUIRED', '子任务必须由当前父任务原生工具调用签发。')
  }
  const envelope = operation.inputSnapshot as { input?: { args?: unknown; callId?: unknown; normalization?: { sourceRevision?: unknown } } }
  const callId = envelope.input?.callId
  const sourceRevision = envelope.input?.normalization?.sourceRevision
  if (typeof callId !== 'string' || typeof sourceRevision !== 'number') return runtimeError('RUNTIME_CHILD_SOURCE_REQUIRED', '子任务缺少已验证的原生调用位置。')
  const source = await (await import('./runtime-state.js')).readExecutionFrame(tx, root.id, sourceRevision)
  const call = source.state.messages.flatMap(message => message.role === 'assistant' ? message.toolCalls ?? [] : []).find(item => item.id === callId)
  if (!call || call.name !== operation.action || call.incomplete) return runtimeError('RUNTIME_CHILD_SOURCE_REQUIRED', '子任务来源不是已保存的完整原生调用。')
  const nativeArgs = envelope.input?.args as { sessionId?: unknown } | undefined
  if (operation.action === 'task_send' && (input.childIndex !== 0 || input.targetSessionId !== nativeArgs?.sessionId || !input.targetSessionId)) {
    return runtimeError('RUNTIME_CHILD_SOURCE_REQUIRED', '返工窗口必须精确匹配当前原生调用的目标。')
  }
  const configuration = intersectChildConfiguration(current.configuration, input.configuration, input.roleTools)
  const parentSpec = taskSpecSchema.parse(root.specSnapshot)
  const spec = taskSpecSchema.parse(JSON.parse(JSON.stringify(input.spec)))
  if ((operation.action.startsWith('subagent_') ? input.kind !== 'inline' || input.childIndex !== 0 : input.kind !== 'spawned')) return runtimeError('RUNTIME_CHILD_SOURCE_REQUIRED', '子任务种类与原调用不一致。')
  if (input.kind === 'inline') {
    const definition = input.definitionId ? await tx.agentSubtask.findFirst({ where: { id: input.definitionId, userId: run.userId, novelId: run.novelId, enabled: true } }) : null
    const args = envelope.input?.args as { subagentId?: unknown; name?: unknown } | undefined
    if (!definition || definition.role !== input.role || definition.name !== input.name
      || (operation.action === 'subagent_run' ? args?.subagentId !== definition.id : args?.name !== definition.name)) return runtimeError('RUNTIME_CHILD_DEFINITION_REQUIRED', '子 Agent 准入定义与原调用、作者作品或冻结角色不一致。')
  }
  // Exact scope copies the immutable parent ceiling. Child instructions cannot
  // create a foreign chapter, novel, selection, or phased authorization.
  if (spec.authorization || runtimeJson(spec.scope).hash !== runtimeJson(parentSpec.scope).hash
    || runtimeJson(spec.hardConstraints).hash !== runtimeJson(parentSpec.hardConstraints).hash) return runtimeError('RUNTIME_SCOPE_MISMATCH', '子任务不能扩大原任务范围或硬约束。')
  const existing = await tx.agentChildExecutionGrant.findUnique({ where: { parentOperationId_childIndex: { parentOperationId: operation.id, childIndex: input.childIndex } } })
  const existingSnapshot = existing ? verifyChildGrant(existing) : null
  // Numerical ceilings in old grants were server defaults, not author limits.
  // Replay retains them exactly; new rows use positive storage-only values.
  const compatibilityTokenLimit = existingSnapshot?.tokenCeiling ?? COMPATIBILITY_TOKEN_LIMIT
  const compatibilityTurns = existingSnapshot?.turnCeiling ?? 1
  let frozen = runtimeJson(grantSnapshotSchema.parse({ version: 1, parentRootId: root.id, parentOperationId: operation.id,
    childIndex: input.childIndex, admissionRunId: run.id, admissionEpoch: String(parent.epoch), kind: input.kind,
    role: input.role, name: input.name, prompt: input.prompt, taskSpec: spec, configuration, price: input.price,
    ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
    ...(input.definitionId ? { definitionId: input.definitionId } : {}),
    tokenCeiling: compatibilityTokenLimit, turnCeiling: compatibilityTurns, parentConfigurationHash: current.head.configurationHash,
    parentFrameRevision: source.revision, parentFrameHash: source.snapshotHash }))
  if (existing) {
    const old = verifyChildGrant(existing)
    // Compare the requested task/configuration and ceilings, not the new lease's
    // generation or freshly allocated child spec id.
    const { admissionEpoch: _epoch, admissionRunId: _run, taskSpec: oldSpec, reworkSource: _source, ...oldRequest } = old
    const { admissionEpoch: _newEpoch, admissionRunId: _newRun, taskSpec: newSpec, ...newRequest } = grantSnapshotSchema.parse(frozen.value)
    const withoutIdentity = (value: z.infer<typeof taskSpecSchema>) => { const { id: _id, createdAt: _date, runId: _runId, controlPolicy: _controlPolicy, ...rest } = value; return rest }
    if (runtimeJson({ ...oldRequest, taskSpec: withoutIdentity(oldSpec) }).hash !== runtimeJson({ ...newRequest, taskSpec: withoutIdentity(newSpec) }).hash) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '同一次派生调用已绑定其他子任务输入。')
    await withRunLeaseInTransaction(tx, parent, async () => undefined)
    return existing
  }
  const budget = await readTaskBudgetInTransaction(tx, root.id)
  if (budget.unresolvedAttempts > 0n) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原任务仍有未知支出，不能派生新任务。')
  // A per-user admission lock also prevents unrelated parent roots from racing
  // the same durable child concurrency ceiling.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-child-admission:${run.userId}`}, 0))::text`
  const admittedCount = await tx.agentChildExecutionGrant.count({ where: { childRun: { userId: run.userId }, status: { in: live } } })
  if (admittedCount >= (input.kind === 'inline' ? 8 : env.agentOrchestrationMaxConcurrent - 1)) return runtimeError('RUNTIME_CHILD_CONCURRENCY_LIMIT', '子任务并发已达上限。')
  const childRunId = randomUUID(), childRootId = spec.id
  if (childRootId === root.id || await tx.agentTaskRoot.findUnique({ where: { id: childRootId } })) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '子任务根必须有独立身份。')
  let initialMessages = input.messages
  if (input.targetSessionId) {
    const previous = await tx.agentChildExecutionGrant.findFirst({ where: { parentRootId: root.id, kind: 'spawned',
      childRun: { userId: run.userId, novelId: run.novelId, sessionId: input.targetSessionId } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { childRun: true } })
    if (operation.action !== 'task_send' || !previous || previous.childRun.status !== 'completed' || previous.status !== 'completed') return runtimeError('RUNTIME_CHILD_REWORK_NOT_READY', '只能向原任务已完成的派生窗口投递返工，不能接管其他窗口或重复执行未确认任务。')
    const prior = verifyChildGrant(previous)
    const owned = await lockRunRoot(tx, run.userId, previous.childRunId)
    if (owned.root.id !== prior.taskSpec.id || owned.run.sessionId !== input.targetSessionId || owned.root.status !== 'completed'
      || owned.run.novelId !== run.novelId || runtimeJson(owned.root.specSnapshot).hash !== runtimeJson(prior.taskSpec).hash
      || await tx.agentRun.count({ where: { taskRootId: owned.root.id } }) !== 1) return runtimeError('RUNTIME_CHILD_REWORK_NOT_READY', '返工目标缺少原已完成子任务的精确身份。')
    const saved = await readExecutionStateInTransaction(tx, owned.root.id)
    if (saved.frame.originRunId !== previous.childRunId || saved.frame.state.phase !== 'completed' || saved.frame.state.pendingOperationId !== null
      || runtimeJson(saved.head.configuration).hash !== runtimeJson(prior.configuration).hash
      || (await readTaskBudgetInTransaction(tx, owned.root.id)).unresolvedAttempts > 0n
      || await tx.agentProviderUsageReceipt.count({ where: { attempt: { operation: { taskRootId: owned.root.id } }, settlementStatus: { not: 'settled' } } })) {
      return runtimeError('RUNTIME_CHILD_REWORK_NOT_READY', '返工目标仍有待确认执行、用量或原快照身份不一致。')
    }
    initialMessages = reworkHistory(saved.frame.state.messages, input.messages, saved.frame.snapshotHash)
    frozen = runtimeJson(grantSnapshotSchema.parse({ ...grantSnapshotSchema.parse(frozen.value), reworkSource: {
      grantId: previous.id, runId: previous.childRunId, taskRootId: owned.root.id, frameRevision: saved.frame.revision, frameHash: saved.frame.snapshotHash } }))
  }
  const session = input.kind === 'inline' ? await tx.agentSession.findUniqueOrThrow({ where: { id: run.sessionId } })
    : input.targetSessionId ? await tx.agentSession.findFirstOrThrow({ where: { id: input.targetSessionId, userId: run.userId, novelId: run.novelId } })
    : await tx.agentSession.create({ data: { userId: run.userId, novelId: run.novelId, title: input.name.slice(0, 160),
      spawnedFromSessionId: run.sessionId, spawnedFromRunId: run.id } })
  const request = runtimeJson([{ type: 'text', text: input.prompt }])
  const specSnapshot = runtimeJson(JSON.parse(JSON.stringify(spec)))
  const inputHash = runtimeJson({ spec: specSnapshot.value, request: request.value }).hash
  const policy = createTaskBudgetPolicy()
  await tx.agentTaskRoot.create({ data: { id: childRootId, userId: run.userId, sessionId: session.id, novelId: run.novelId,
    sourceMessageId: root.sourceMessageId, specSnapshot: specSnapshot.value, requestSnapshot: request.value, inputHash,
    budget: { create: { policy: policy.value, policyHash: policy.hash, tokenLimit: compatibilityTokenLimit } } } })
  await tx.agentRun.create({ data: { id: childRunId, userId: run.userId, sessionId: session.id, novelId: run.novelId, chapterId: run.chapterId,
    mode: configuration.mode === 'build' ? 'act' : configuration.mode, agentType: run.agentType, action: run.action,
    engine: 'loop', runtimeProtocolVersion: 1, taskRootId: childRootId, taskSpec: specSnapshot.value,
    manuscriptRevision: run.manuscriptRevision, inputSummary: input.prompt.slice(0, 500), modelTier: configuration.model.tier,
    customModelId: configuration.model.customModelId, reasoningEffort: configuration.model.reasoningEffort, executionLease: { create: {} } } })
  const snapshot = runtimeJson(executionSnapshotSchema.parse({ version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0,
    phase: 'idle', pendingOperationId: null, messages: initialMessages, successfulToolSignatures: [] }))
  const configurationJson = runtimeJson(configuration)
  await tx.agentExecutionState.create({ data: { taskRootId: childRootId, configuration: configurationJson.value,
    configurationHash: runtimeJson({ configuration: configurationJson.value, inputHash }).hash } })
  await tx.agentExecutionFrame.create({ data: { taskRootId: childRootId, revision: 0, originRunId: childRunId,
    snapshot: snapshot.value, snapshotHash: snapshot.hash } })
  await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: childRootId, runId: childRunId,
    eventKey: `state:${childRootId}:0`, type: 'execution.state.saved', payload: { revision: 0, snapshotHash: snapshot.hash, previousHash: null } } })
  const grant = await tx.agentChildExecutionGrant.create({ data: { id: randomUUID(), parentRootId: root.id, parentOperationId: operation.id,
    childIndex: input.childIndex, admissionRunId: run.id, admissionEpoch: parent.epoch, currentParentRunId: run.id,
    generation: parent.epoch, childRunId, kind: input.kind, tokenCeiling: compatibilityTokenLimit, snapshot: frozen.value, snapshotHash: frozen.hash } })
  await bindChildGoal(tx, parent, grant)
  await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: root.id, runId: run.id, operationId: operation.id,
    eventKey: `child-admitted:${grant.id}`, type: 'child.admitted', payload: { version: 1, grantId: grant.id, childRunId, sessionId: session.id,
      kind: input.kind, index: input.childIndex, snapshotHash: frozen.hash, tokenCeiling: compatibilityTokenLimit } } })
  await readExecutionStateInTransaction(tx, childRootId)
  await withRunLeaseInTransaction(tx, parent, async () => undefined)
  return grant
}

/** Internal issuer wrapper: callers cannot provide a parent epoch without
 * proving both the current lease and the saved native operation inside its TX. */
export async function admitChildExecution(parent: RunLeaseToken, input: Parameters<typeof admitChildExecutionInTransaction>[2]) {
  return withRunLease(parent, tx => admitChildExecutionInTransaction(tx, parent, input))
}
