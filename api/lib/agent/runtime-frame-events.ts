import { z } from 'zod'
import type { AgentExecutionOutbox } from '@prisma/client'
import type { AgentStreamEventBody, AgentToolDisplayPayload, AgentMessagePart, AgentRollbackSnapshot } from '../../../shared/contracts/index.js'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { readExecutionFrame, readExecutionStateInTransaction } from './runtime-state.js'

export const durableMessageId = (rootId: string, turn: number) => `dm-${runtimeJson({ rootId, turn }).hash.slice(0, 48)}`
const sourceSchema = z.object({ revision: z.number().int().nonnegative(), snapshotHash: z.string(), previousHash: z.string().nullable() }).strict()
const operationInput = z.object({ input: z.object({ callId: z.string(), args: z.unknown() }) })
const historyRollback = z.object({ toolResult: z.object({ snapshot: z.object({ target: z.enum(['chapter', 'novel']),
  targetId: z.string(), field: z.string(), previousValue: z.string().nullable() }).optional() }) })

/** The existing history table is the UI projection, not execution authority.
 * Caller holds the root lock and commits this with the source projection marker. */
export async function persistProjectedMessages(tx: RuntimeTx, source: AgentExecutionOutbox, sessionId: string, bodies: AgentStreamEventBody[]) {
  for (const body of bodies) {
    if (!['message.start', 'reasoning.delta', 'text.final', 'tool.call', 'tool.result'].includes(body.type) || !('messageId' in body)) continue
    const old = await tx.agentMessage.findUnique({ where: { id: body.messageId }, include: { run: { select: { taskRootId: true } } } })
    if (old && (old.sessionId !== sessionId || old.role !== 'assistant' || old.run.taskRootId !== source.taskRootId)) {
      return runtimeError('RUNTIME_SCOPE_MISMATCH', '历史消息不属于原持久任务，不能覆盖。')
    }
    let parts = (old?.parts ?? []) as unknown as AgentMessagePart[]
    if (body.type === 'reasoning.delta') {
      const existing = parts.find(part => part.type === 'reasoning')
      parts = existing ? parts.map(part => part === existing ? { ...existing, text: existing.text + body.delta } : part)
        : [...parts, { type: 'reasoning', text: body.delta }]
    } else if (body.type === 'text.final') {
      parts = parts.filter(part => part.type !== 'text')
      if (body.text) parts = [...parts, { type: body.asReasoning ? 'reasoning' : 'text', text: body.text }]
    } else if (body.type === 'tool.call') {
      const index = parts.findIndex(part => part.type === 'tool-call' && part.callId === body.callId)
      if (index < 0) parts = [...parts, { type: 'tool-call', callId: body.callId, toolName: body.toolName, title: body.title, args: body.args ?? null, status: 'running', ...(body.importWaiting ? { importWaiting: body.importWaiting } : {}) }]
      else parts = parts.map((part, at) => at === index && part.type === 'tool-call'
        ? { ...part, title: body.title, toolName: body.toolName, args: body.args ?? part.args, ...(body.importWaiting ? { importWaiting: body.importWaiting } : {}) } : part)
    } else if (body.type === 'tool.result') {
      const index = parts.findIndex(part => part.type === 'tool-call' && part.callId === body.callId)
      let snapshot: AgentRollbackSnapshot | undefined
      if (body.ok && source.type === 'execution.state.saved') {
        const position = sourceSchema.parse(source.payload)
        const previous = await readExecutionFrame(tx, source.taskRootId, position.revision - 1)
        const receipt = await tx.agentEffectReceipt.findUniqueOrThrow({ where: { operationId: previous.state.pendingOperationId! } })
        snapshot = historyRollback.parse(receipt.result).toolResult.snapshot
      }
      const result = { status: body.ok ? 'success' as const : 'failed' as const, summary: body.summary,
        ...(body.durationMs !== undefined ? { durationMs: body.durationMs } : {}), ...(body.display ? { display: body.display } : {}),
        ...(snapshot ? { snapshot } : {}) }
      if (index < 0) parts = [...parts, { type: 'tool-call', callId: body.callId, toolName: body.toolName, title: body.toolName, args: null, ...result }]
      else parts = parts.map((part, at) => at === index && part.type === 'tool-call' ? { ...part, ...result } : part)
    }
    await tx.agentMessage.upsert({ where: { id: body.messageId },
      create: { id: body.messageId, runId: source.runId, sessionId, role: 'assistant', parts: runtimeJson(parts).value, createdAt: source.createdAt },
      update: { parts: runtimeJson(parts).value } })
  }
}

/** Only committed execution frames drive final UI content, not partial provider
 * receipts or a model's declaration of task completion. */
export async function projectExecutionFrame(tx: RuntimeTx, source: AgentExecutionOutbox): Promise<AgentStreamEventBody[]> {
  const parsed = sourceSchema.safeParse(source.payload)
  if (!parsed.success || source.type !== 'execution.state.saved' || source.eventKey !== `state:${source.taskRootId}:${parsed.data.revision}`) return runtimeError('RUNTIME_RECEIPT_INVALID', '执行帧事件源无效。')
  const frame = await readExecutionFrame(tx, source.taskRootId, parsed.data.revision)
  if (frame.snapshotHash !== parsed.data.snapshotHash) runtimeError('RUNTIME_RECEIPT_INVALID', '执行帧事件摘要不一致。')
  const current = await readExecutionStateInTransaction(tx, source.taskRootId)
  if (frame.revision === 0) return [{ type: 'run.started', agent: { type: current.configuration.agentType, title: 'Chevoink Agent',
    model: current.configuration.model.modelName ?? current.configuration.model.tier }, mode: current.configuration.mode, title: '创作任务' }]
  const previous = await readExecutionFrame(tx, source.taskRootId, frame.revision - 1)
  const messageId = durableMessageId(source.taskRootId, frame.state.turn)
  if (frame.state.phase === 'awaiting_operation' && previous.state.pendingOperationId !== frame.state.pendingOperationId) {
    const operation = await tx.agentOperation.findFirst({ where: { id: frame.state.pendingOperationId!, taskRootId: source.taskRootId } })
    if (!operation || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '待执行操作事件缺少原输入。')
    if (operation.kind === 'provider') return [{ type: 'message.start', messageId, role: 'assistant' }, { type: 'execution.progress', revision: frame.revision, stage: 'model' }]
    if (operation.kind === 'tool') {
      if (operation.action === 'ask_user') return [{ type: 'execution.progress', revision: frame.revision, stage: 'tool' }]
      const input = operationInput.safeParse(operation.inputSnapshot)
      if (!input.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '工具事件缺少原调用身份。')
      const { humanizeAgentVisibleText } = await import('./visible-text.js')
      const grant = current.configuration.toolAuthority.find(item => item.name === operation.action)
      return [{ type: 'tool.call', messageId, callId: input.data.input.callId, toolName: operation.action,
        title: humanizeAgentVisibleText(operation.action), args: input.data.input.args, autoApproved: grant?.permission === 'allow' && !grant.alwaysConfirm }]
    }
  }
  if (previous.state.phase === 'awaiting_operation' && frame.state.phase === 'idle') {
    const appended = frame.state.messages.at(-1)
    if (frame.state.messages.length !== previous.state.messages.length + 1 || !appended) return runtimeError('RUNTIME_RECEIPT_INVALID', '执行归约事件不符合消息追加合同。')
    const { humanizeAgentVisibleText } = await import('./visible-text.js')
    if (appended.role === 'assistant') {
      const events: AgentStreamEventBody[] = []
      if (appended.reasoning) events.push({ type: 'reasoning.delta', messageId, delta: humanizeAgentVisibleText(appended.reasoning) })
      events.push({ type: 'text.final', messageId, text: humanizeAgentVisibleText(appended.content ?? ''), asReasoning: false })
      return events
    }
    if (appended.role === 'tool') {
      const operation = await tx.agentOperation.findFirst({ where: { id: previous.state.pendingOperationId!, taskRootId: source.taskRootId }, include: { effectReceipt: true } })
      const receipt = operation?.effectReceipt
      const parsedResult = z.object({ toolResult: z.object({ summary: z.string(), display: z.unknown().optional(), outcome: z.literal('failed').optional() }) }).safeParse(receipt?.result)
      if (!operation || !receipt || !parsedResult.success || !['succeeded', 'failed'].includes(operation.status)
        || runtimeJson(receipt.result).hash !== receipt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '工具结果事件缺少完整回执。')
      return [{ type: 'tool.result', messageId, callId: appended.toolCallId, toolName: operation.action, ok: operation.status === 'succeeded' && parsedResult.data.toolResult.outcome !== 'failed',
        summary: humanizeAgentVisibleText(parsedResult.data.toolResult.summary), durationMs: Math.max(0, receipt.createdAt.getTime() - operation.createdAt.getTime()),
        ...(operation.status === 'succeeded' && parsedResult.data.toolResult.display ? { display: parsedResult.data.toolResult.display as AgentToolDisplayPayload } : {}) }]
    }
  }
  return [{ type: 'execution.progress', revision: frame.revision, stage: frame.state.phase === 'completed' ? 'finalizing' : 'checkpoint' }]
}
