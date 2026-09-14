import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { lockRunRoot, runtimeError, runtimeJson, runtimeTransaction, type RuntimeTx } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readTaskBudgetInTransaction, taskTurnLimit } from './runtime-budget.js'
import { withObjectType } from './tool-schema.js'

const id = z.string().min(1).max(64)
const count = z.number().int().nonnegative().max(2147483647)
const toolCall = z.object({ id: z.string().min(1), name: z.string().min(1), arguments: z.string(), incomplete: z.boolean().optional() }).strict()
const message = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }).strict(),
  z.object({ role: z.literal('user'), content: z.union([z.string(), z.array(z.union([
    z.object({ type: z.literal('text'), text: z.string() }).strict(),
    z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string(), detail: z.enum(['low', 'high', 'auto']).optional() }).strict() }).strict(),
  ]))]) }).strict(),
  z.object({ role: z.literal('assistant'), content: z.string().nullable(), reasoning: z.string().optional(), toolCalls: z.array(toolCall).optional() }).strict(),
  z.object({ role: z.literal('tool'), toolCallId: z.string().min(1), content: z.string() }).strict(),
])

/** Server configuration only; credentials are resolved separately and never serialized here. */
const configurationSchema = z.object({ version: z.literal(1), mode: z.enum(['plan', 'build', 'review']), agentType: z.string().min(1),
  creativeFreedom: z.enum(['stable', 'balanced', 'bold']), qualityMode: z.enum(['balanced', 'premium']),
  model: z.object({ tier: z.string().min(1), provider: z.string().min(1), modelName: z.string().nullable(), customModelId: id.nullable(),
    reasoningEffort: z.string().min(1), routeRevision: z.string().regex(/^[a-f0-9]{64}$/),
    maxOutputTokens: z.number().int().positive().max(4000000).optional(),
    contextWindowTokens: z.number().int().positive().max(4000000).optional() }).strict(),
  tools: z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1), description: z.string(), parameters: z.record(z.string(), z.unknown()) }).strict() }).strict()),
  toolAuthority: z.array(z.object({ name: z.string().min(1), permission: z.enum(['allow', 'ask', 'deny']), alwaysConfirm: z.boolean(), dangerous: z.boolean() }).strict()),
  protectedChapterIds: z.array(id), pinnedSkillVersions: z.array(z.object({ id, version: z.string().min(1) }).strict()),
}).strict().refine(value => new Set(value.tools.map(tool => tool.function.name)).size === value.tools.length
  && new Set(value.toolAuthority.map(tool => tool.name)).size === value.toolAuthority.length
  && value.tools.every(tool => value.toolAuthority.some(grant => grant.name === tool.function.name)))

export const executionSnapshotSchema = z.object({ version: z.literal(1), turn: count, nextOperationSequence: count,
  checkpointIndex: count, phase: z.enum(['idle', 'awaiting_operation', 'completed']), pendingOperationId: id.nullable(),
  messages: z.array(message).min(1), successfulToolSignatures: z.array(z.string()),
}).strict().refine(value => (value.phase === 'awaiting_operation') === (value.pendingOperationId !== null) && value.turn <= value.nextOperationSequence)

function parseSnapshot(input: unknown) {
  const parsed = executionSnapshotSchema.safeParse(input)
  if (!parsed.success) return runtimeError('RUNTIME_STATE_INVALID', '执行快照不完整或计数无效。')
  return { ...runtimeJson(parsed.data), state: parsed.data }
}

export async function readExecutionFrame(tx: RuntimeTx, taskRootId: string, revision: number) {
  const frame = await tx.agentExecutionFrame.findUnique({ where: { taskRootId_revision: { taskRootId, revision } } })
  if (!frame) return runtimeError('RUNTIME_STATE_REQUIRED', '执行快照缺失，不能用历史摘要代替。')
  const parsed = parseSnapshot(frame.snapshot)
  const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `state:${taskRootId}:${revision}` } })
  if (parsed.hash !== frame.snapshotHash || !event || event.taskRootId !== taskRootId || event.type !== 'execution.state.saved'
    || runtimeJson(event.payload).hash !== runtimeJson({ revision, snapshotHash: frame.snapshotHash, previousHash: frame.previousHash }).hash) runtimeError('RUNTIME_RECEIPT_INVALID', '执行快照或事件损坏。')
  if (revision > 0) {
    const previous = await tx.agentExecutionFrame.findUnique({ where: { taskRootId_revision: { taskRootId, revision: revision - 1 } }, select: { snapshotHash: true } })
    if (!previous || previous.snapshotHash !== frame.previousHash) runtimeError('RUNTIME_RECEIPT_INVALID', '执行快照链不连续。')
  } else if (frame.previousHash !== null) runtimeError('RUNTIME_RECEIPT_INVALID', '初始快照链无效。')
  return { ...frame, state: parsed.state }
}
const readFrame = readExecutionFrame

export async function readExecutionStateInTransaction(tx: RuntimeTx, taskRootId: string) {
  const head = await tx.agentExecutionState.findUnique({ where: { taskRootId } })
  const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: taskRootId } })
  if (!head) return runtimeError('RUNTIME_STATE_REQUIRED', '缺少原执行状态，不能重新初始化继续。')
  const configuration = configurationSchema.safeParse(head.configuration)
  if (!configuration.success || runtimeJson({ configuration: head.configuration, inputHash: root.inputHash }).hash !== head.configurationHash
    || runtimeJson({ spec: root.specSnapshot, request: root.requestSnapshot }).hash !== root.inputHash) runtimeError('RUNTIME_RECEIPT_INVALID', '原始输入或配置快照损坏。')
  const latest = await tx.agentExecutionFrame.findFirst({ where: { taskRootId }, orderBy: { revision: 'desc' }, select: { revision: true } })
  if (!latest || latest.revision !== head.revision) runtimeError('RUNTIME_RECEIPT_INVALID', '执行头指针与最新快照不一致。')
  // 旧快照的工具参数可能缺顶层 type（被供应商拒绝、任务无法继续）；读取时统一修复，与新转换哈希口径一致。
  const storedConfiguration = { ...configuration.data, tools: configuration.data.tools.map(tool => ({ ...tool, function: { ...tool.function, parameters: withObjectType(tool.function.parameters) } })) }
  return { head, configuration: storedConfiguration, originalRequest: root.requestSnapshot, originalSpec: root.specSnapshot,
    frame: await readFrame(tx, taskRootId, head.revision) }
}

const readState = readExecutionStateInTransaction

/** Dispatch must correspond to the saved pending operation or its internal child attempt.
 * The relationship is not an authorization grant; tool/phase admission remains separate. */
export async function assertPendingProviderState(tx: RuntimeTx, taskRootId: string, operationId: string) {
  if (!(await tx.agentExecutionState.findUnique({ where: { taskRootId }, select: { taskRootId: true } }))) return
  const current = await readState(tx, taskRootId), budget = await readTaskBudgetInTransaction(tx, taskRootId)
  if (current.frame.state.phase !== 'awaiting_operation' || current.frame.state.turn > taskTurnLimit(budget.policy, budget.budget.checkpointCount)
    || current.frame.state.checkpointIndex !== budget.budget.checkpointCount) runtimeError('RUNTIME_STATE_CONFLICT', '模型派发不符合已保存的执行位置或轮次合同。')
  let cursor: string | null = operationId
  for (let depth = 0; cursor && depth < 64; depth++) {
    if (cursor === current.frame.state.pendingOperationId) return
    const operation: { taskRootId: string; parentOperationId: string | null } | null = await tx.agentOperation.findUnique({ where: { id: cursor }, select: { taskRootId: true, parentOperationId: true } })
    if (!operation || operation.taskRootId !== taskRootId) break
    cursor = operation.parentOperationId
  }
  runtimeError('RUNTIME_STATE_CONFLICT', '模型请求与原待执行操作无关，不能跳过恢复位置派发。')
}

async function insertFrame(tx: RuntimeTx, token: RunLeaseToken, revision: number, previousHash: string | null, snapshot: ReturnType<typeof parseSnapshot>) {
  await tx.agentExecutionFrame.create({ data: { taskRootId: token.taskRootId, revision, originRunId: token.runId, previousHash,
    snapshot: snapshot.value, snapshotHash: snapshot.hash } })
  await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: token.taskRootId, runId: token.runId,
    eventKey: `state:${token.taskRootId}:${revision}`, type: 'execution.state.saved', payload: { revision, snapshotHash: snapshot.hash, previousHash } } })
}

/** One-time initialization; an existing root never gets fresh messages/config on resume. */
export async function initializeExecutionState(token: RunLeaseToken, input: { configuration: unknown; snapshot: unknown }) {
  const lease = { ...token }, parsed = configurationSchema.safeParse(input.configuration), snapshot = parseSnapshot(input.snapshot)
  if (!parsed.success) return runtimeError('RUNTIME_STATE_INVALID', '执行配置无效或含未允许字段。')
  const configuration = runtimeJson(parsed.data)
  if (snapshot.state.phase !== 'idle' || snapshot.state.turn !== 0 || snapshot.state.nextOperationSequence !== 0 || snapshot.state.checkpointIndex !== 0) runtimeError('RUNTIME_STATE_INVALID', '初始执行位置必须为零。')
  return withRunLease(lease, async tx => {
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (runtimeJson({ spec: root.specSnapshot, request: root.requestSnapshot }).hash !== root.inputHash) runtimeError('RUNTIME_RECEIPT_INVALID', '原始任务输入损坏。')
    const configurationHash = runtimeJson({ configuration: configuration.value, inputHash: root.inputHash }).hash
    const existing = await tx.agentExecutionState.findUnique({ where: { taskRootId: root.id } })
    if (existing) {
      const current = await readState(tx, root.id), initial = await readFrame(tx, root.id, 0)
      if (existing.configurationHash !== configurationHash || initial.snapshotHash !== snapshot.hash) runtimeError('RUNTIME_IDENTITY_CONFLICT', '恢复不能替换原始模型配置或初始上下文。')
      return current
    }
    const budget = await readTaskBudgetInTransaction(tx, root.id)
    taskTurnLimit(budget.policy, budget.budget.checkpointCount)
    if (budget.budget.checkpointCount !== 0 || await tx.agentOperation.count({ where: { taskRootId: root.id } })) runtimeError('RUNTIME_STATE_REQUIRED', '已有执行事实，不能事后补造初始状态。')
    await tx.agentExecutionState.create({ data: { taskRootId: root.id, configuration: configuration.value, configurationHash } })
    await insertFrame(tx, lease, 0, null, snapshot)
    return readState(tx, root.id)
  })
}

/** State persistence CAS. The executor still owns receipt-to-context reduction and authorization. */
export async function saveExecutionState(token: RunLeaseToken, input: { expectedRevision: number; expectedHash: string; snapshot: unknown }) {
  return withRunLease({ ...token }, executionStateWrite(token, input))
}

/** Caller must already hold withRunLease in this same transaction. */
export async function saveExecutionStateInTransaction(tx: RuntimeTx, token: RunLeaseToken, input: { expectedRevision: number; expectedHash: string; snapshot: unknown }) {
  return executionStateWrite(token, input)(tx)
}

function executionStateWrite(token: RunLeaseToken, input: { expectedRevision: number; expectedHash: string; snapshot: unknown }) {
  const lease = { ...token }, snapshot = parseSnapshot(input.snapshot)
  const revision = input.expectedRevision, expectedHash = input.expectedHash
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= 2147483647 || !/^[a-f0-9]{64}$/.test(expectedHash)) runtimeError('RUNTIME_STATE_INVALID', '执行版本或摘要无效。')
  return async (tx: RuntimeTx) => {
    const current = await readState(tx, lease.taskRootId)
    const replay = await tx.agentExecutionFrame.findUnique({ where: { taskRootId_revision: { taskRootId: lease.taskRootId, revision: revision + 1 } } })
    if (replay) {
      if (replay.previousHash !== expectedHash || replay.snapshotHash !== snapshot.hash) runtimeError('RUNTIME_IDENTITY_CONFLICT', '同一状态转换已绑定不同内容。')
      return readFrame(tx, lease.taskRootId, revision + 1)
    }
    if (current.head.revision !== revision || current.frame.snapshotHash !== expectedHash) runtimeError('RUNTIME_STATE_CONFLICT', '执行状态已推进，请读取已保存位置。')
    const before = current.frame.state, after = snapshot.state
    if (before.phase === 'completed' || after.turn < before.turn || after.turn > before.turn + 1
      || after.nextOperationSequence < before.nextOperationSequence || after.nextOperationSequence > before.nextOperationSequence + 1
      || after.checkpointIndex < before.checkpointIndex || after.checkpointIndex > before.checkpointIndex + 1) runtimeError('RUNTIME_STATE_CONFLICT', '执行位置不能倒退、跳号或从已完成状态继续。')
    if (before.successfulToolSignatures.some(value => !after.successfulToolSignatures.includes(value))) runtimeError('RUNTIME_STATE_CONFLICT', '恢复不能清空已成功操作的重复保护。')
    const budget = await readTaskBudgetInTransaction(tx, lease.taskRootId)
    if (after.checkpointIndex !== budget.budget.checkpointCount) runtimeError('RUNTIME_STATE_CONFLICT', '快照检查点必须对应已提交预算回执。')
    if (after.turn > taskTurnLimit(budget.policy, budget.budget.checkpointCount)) runtimeError('RUNTIME_TURN_CHECKPOINT_REQUIRED', '原轮次片已用尽，需要真实进展检查点后再继续。')
    if (after.pendingOperationId) {
      const operation = await tx.agentOperation.findUnique({ where: { id: after.pendingOperationId } })
      if (!operation || operation.taskRootId !== lease.taskRootId) runtimeError('RUNTIME_SCOPE_MISMATCH', '待执行操作不属于原任务。')
      const samePending = before.pendingOperationId === after.pendingOperationId
      if (after.nextOperationSequence !== before.nextOperationSequence + (samePending ? 0 : 1)
        || (!samePending && operation.operationKey !== `exec:${before.nextOperationSequence}`)) runtimeError('RUNTIME_STATE_CONFLICT', '操作身份必须由原执行序号确定。')
      if (after.turn !== before.turn + (!samePending && operation.kind === 'provider' ? 1 : 0)) runtimeError('RUNTIME_STATE_CONFLICT', '模型轮次必须对应新模型操作。')
    } else if (after.nextOperationSequence !== before.nextOperationSequence || after.turn !== before.turn) runtimeError('RUNTIME_STATE_CONFLICT', '不能没有操作就推进序号或轮次。')
    if (before.pendingOperationId && before.pendingOperationId !== after.pendingOperationId) {
      const operation = await tx.agentOperation.findUnique({ where: { id: before.pendingOperationId }, include: { effectReceipt: true } })
      if (!operation || !['succeeded', 'failed', 'cancelled'].includes(operation.status)) runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原操作尚未确认，不能跳过后继续。')
      if (!operation.inputSnapshot || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) runtimeError('RUNTIME_RECEIPT_INVALID', '原操作输入回执损坏。')
      if (operation.kind === 'provider') {
        const attempt = await tx.agentProviderAttempt.findFirst({ where: { operationId: operation.id, status: operation.status, dispatchedAt: { not: null } }, orderBy: { createdAt: 'desc' } })
        if (!attempt?.result || !attempt.resultHash || runtimeJson(attempt.result).hash !== attempt.resultHash) runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '缺少原模型结果回执，不能跳过。')
      } else if (!operation.effectReceipt || runtimeJson(operation.effectReceipt.result).hash !== operation.effectReceipt.resultHash) runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '缺少原工具效果回执，不能跳过。')
    }
    await insertFrame(tx, lease, revision + 1, expectedHash, snapshot)
    const updated = await tx.agentExecutionState.updateMany({ where: { taskRootId: lease.taskRootId, revision }, data: { revision: revision + 1 } })
    if (updated.count !== 1) runtimeError('RUNTIME_STATE_CONFLICT', '执行位置并发更新冲突。')
    return readFrame(tx, lease.taskRootId, revision + 1)
  }
}

/** Read-only recovery works while paused; it does not grant a lease or re-enable the task. */
export async function loadExecutionState(userId: string, runId: string) {
  return runtimeTransaction(async tx => { const { root } = await lockRunRoot(tx, userId, runId); return readState(tx, root.id) })
}
