import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentStreamEvent } from '../../../shared/contracts/index.js'
import { lockRunRoot, runtimeError, runtimeJson, runtimeTransaction } from './runtime-common.js'
import { projectApprovalEvent } from './runtime-approval.js'
import { projectExecutionFrame, persistProjectedMessages } from './runtime-frame-events.js'
import { durablePauseSchema } from './runtime-common.js'
import { readExecutionFrame } from './runtime-state.js'
import { durableQuestionSchema } from './runtime-question.js'
import { durableMessageId } from './runtime-frame-events.js'
import { novelImportWaitingSchema } from '../novel-import-origin.js'
import { importCommitWaitingSchema, importWaitingUrl } from './runtime-import.js'

/** Only this DB-locked allocator writes UI events for the durable protocol.
 * New source families retain their outbox rows until their projector is added;
 * no global publishedAt cursor skips facts this version doesn't understand. */
export async function publishDurableEvents(userId: string, runId: string, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) runtimeError('RUNTIME_INPUT_INVALID', '事件批次大小无效。')
  return runtimeTransaction(async tx => {
    const { root } = await lockRunRoot(tx, userId, runId)
    const sources = await tx.agentExecutionOutbox.findMany({ where: { taskRootId: root.id,
      OR: [{ type: { in: ['approval.requested', 'approval.resolved', 'execution.state.saved', 'question.requested', 'import.requested', 'import.commit_requested'] } },
        { type: 'execution.completion.decided', runId, payload: { path: ['kind'], equals: 'completed' } },
        { type: 'run.paused', payload: { path: ['runIds'], array_contains: [runId] } }],
      projections: { none: { runId } } }, orderBy: { sequence: 'asc' }, take: limit })
    const latest = await tx.agentRunEvent.findFirst({ where: { runId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    let seq = latest?.seq ?? 0
    const events: AgentStreamEvent[] = []
    for (const source of sources) {
      let bodies: import('../../../shared/contracts/index.js').AgentStreamEventBody[]
      if (source.type === 'import.requested' || source.type === 'import.commit_requested') {
        const waiting = source.type === 'import.requested' ? novelImportWaitingSchema.parse(source.payload) : importCommitWaitingSchema.parse(source.payload)
        const operation = await tx.agentOperation.findFirst({ where: { id: waiting.operationId, taskRootId: root.id, kind: 'tool', action: 'novel_import' } })
        const input = z.object({ input: z.object({ callId: z.string(), novelId: z.string(), args: z.unknown(), normalization: z.object({ sourceRevision: z.number().int().nonnegative() }) }) }).safeParse(operation?.inputSnapshot)
        const expectedArgs = 'attachmentUrl' in waiting ? { action: 'prepare', attachmentUrl: waiting.attachmentUrl } : { action: 'commit', jobId: waiting.jobId }
        if (!operation || !input.success || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash || source.operationId !== operation.id
          || source.eventKey !== `import:${operation.id}` || source.runId !== operation.originRunId || input.data.input.novelId !== root.novelId
          || input.data.input.callId !== waiting.callId || runtimeJson(input.data.input.args).hash !== runtimeJson(expectedArgs).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '导入等待事件缺少原始调用。')
        const frame = await readExecutionFrame(tx, root.id, input.data.input.normalization.sourceRevision)
        bodies = [{ type: 'tool.call', messageId: durableMessageId(root.id, frame.state.turn), callId: waiting.callId,
          toolName: 'novel_import', title: '等待作者确认导入', args: expectedArgs, autoApproved: false,
          importWaiting: { url: importWaitingUrl(root.novelId, source.runId, waiting), expiresAt: waiting.expiresAt } }]
      } else if (source.type === 'question.requested') {
        const question = durableQuestionSchema.parse(source.payload)
        const operation = await tx.agentOperation.findFirst({ where: { id: question.operationId, taskRootId: root.id, action: 'ask_user' } })
        const input = z.object({ input: z.object({ callId: z.string(), args: z.unknown(), normalization: z.object({ sourceRevision: z.number().int().nonnegative() }) }) }).safeParse(operation?.inputSnapshot)
        if (!operation || !input.success || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash || source.operationId !== operation.id
          || source.eventKey !== `question:${operation.id}` || input.data.input.callId !== question.callId
          || runtimeJson(input.data.input.args).hash !== runtimeJson({ question: question.question, options: question.options }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '提问事件缺少原工具参数。')
        const frame = await readExecutionFrame(tx, root.id, input.data.input.normalization.sourceRevision)
        bodies = [{ type: 'tool.call', messageId: durableMessageId(root.id, frame.state.turn), callId: question.callId, toolName: 'ask_user', title: '向作者提问',
          args: { question: question.question, options: question.options, requestId: source.id }, autoApproved: true }]
      } else if (source.type === 'execution.completion.decided') {
        const decision = z.object({ version: z.literal(1), kind: z.literal('completed'), reviewOperationId: z.string(), resultHash: z.string(),
          sourceRevision: z.number().int().nonnegative(), sourceHash: z.string(), revision: z.number().int().positive(), snapshotHash: z.string() }).parse(source.payload)
        const receipt = await tx.agentEffectReceipt.findUnique({ where: { operationId: decision.reviewOperationId }, include: { operation: true } })
        const verdict = z.object({ verdict: z.object({ verdict: z.literal('complete') }) }).safeParse(receipt?.result)
        const proof = z.object({ version: z.literal(1), sourceRevision: z.number(), sourceHash: z.string(),
          candidateHash: z.string(), evidenceHash: z.string(), evidence: z.object({ blockers: z.array(z.never()) }).passthrough() }).safeParse(receipt?.result)
        const frame = await readExecutionFrame(tx, root.id, decision.revision)
        const before = await readExecutionFrame(tx, root.id, decision.sourceRevision)
        const candidate = before.state.messages.at(-1)
        if (candidate?.role !== 'assistant') return runtimeError('RUNTIME_RECEIPT_INVALID', '完成事件缺少原候选答复。')
        const validProof = receipt?.operation.action === 'completion_finalize' && proof.success
          && proof.data.sourceRevision === decision.sourceRevision && proof.data.sourceHash === decision.sourceHash
          && runtimeJson(proof.data.evidence).hash === proof.data.evidenceHash
          && proof.data.candidateHash === runtimeJson({ content: candidate.content, reasoning: candidate.reasoning ?? null }).hash
        const legacyReview = receipt?.operation.action === 'completion_review' && verdict.success
        if (!receipt || (!validProof && !legacyReview) || receipt.operation.taskRootId !== root.id
          || source.operationId !== receipt.operationId || source.eventKey !== `decision:${receipt.operationId}`
          || receipt.resultHash !== decision.resultHash || runtimeJson(receipt.result).hash !== decision.resultHash
          || decision.revision !== decision.sourceRevision + 1 || before.snapshotHash !== decision.sourceHash
          || frame.snapshotHash !== decision.snapshotHash || frame.state.phase !== 'completed'
          || runtimeJson(frame.state.messages).hash !== runtimeJson(before.state.messages).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '完成事件缺少原审查回执和终态执行帧。')
        const usage = await tx.agentProviderUsageReceipt.aggregate({ where: { attempt: { operation: { taskRootId: root.id } } }, _sum: { promptTokens: true, completionTokens: true } })
        const promptTokens = usage._sum.promptTokens ?? 0, completionTokens = usage._sum.completionTokens ?? 0
        bodies = [{ type: 'run.finished', status: 'succeeded', usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
          artifacts: [], outputSummary: candidate.content ?? '' }]
      } else if (source.type === 'run.paused') {
        const paused = durablePauseSchema.safeParse(source.payload)
        if (!paused.success || !paused.data.runIds.includes(runId) || source.eventKey !== `pause:${source.id}`) return runtimeError('RUNTIME_RECEIPT_INVALID', '暂停事件源损坏。')
        if (paused.data.reason !== 'user_stop') {
          const frame = await readExecutionFrame(tx, root.id, paused.data.sourceRevision)
          if (frame.snapshotHash !== paused.data.sourceHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '暂停判定与原执行帧不一致。')
        }
        bodies = [{ type: 'run.paused', reason: paused.data.reason }]
      } else if (source.type === 'execution.state.saved') bodies = await projectExecutionFrame(tx, source)
      else bodies = [await projectApprovalEvent(tx, source, userId)]
      if (seq + bodies.length > 2_147_483_647) runtimeError('RUNTIME_EVENT_SEQUENCE_EXHAUSTED', '事件序号需要迁移，不能回绕。')
      // Different runs can replay the same root's events. Apply each source to
      // shared chat history only once, in the same transaction as its marker.
      if (bodies.some(body => 'messageId' in body) && !await tx.agentEventProjection.findFirst({ where: { sourceId: source.id }, select: { eventId: true } })) {
        await persistProjectedMessages(tx, source, root.sessionId, bodies)
      }
      for (const [partIndex, body] of bodies.entries()) {
      const event: AgentStreamEvent = { ...body, runId, seq: ++seq, ts: source.createdAt.toISOString() }
      const snapshot = runtimeJson(event)
      const stored = await tx.agentRunEvent.create({ data: { id: randomUUID(), runId, seq, type: body.type, payload: snapshot.value } })
      await tx.agentEventProjection.create({ data: { runId, sourceId: source.id, partIndex, eventId: stored.id,
        sourceHash: runtimeJson({ id: source.id, taskRootId: source.taskRootId, type: source.type, payload: source.payload }).hash, eventHash: snapshot.hash } })
      events.push(event)
      }
    }
    return events
  })
}

/** Paginated replay never invents a terminal state from a disconnected process. */
export async function loadDurableEvents(userId: string, runId: string, sinceSeq: number, limit = 200): Promise<AgentStreamEvent[]> {
  if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) runtimeError('RUNTIME_INPUT_INVALID', '事件游标无效。')
  return runtimeTransaction(async tx => {
    const { root } = await lockRunRoot(tx, userId, runId)
    const latest = await tx.agentRunEvent.findFirst({ where: { runId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    if (sinceSeq > (latest?.seq ?? 0)) runtimeError('RUNTIME_EVENT_CURSOR_AHEAD', '事件游标超过已保存位置，请重新同步当前任务。')
    const records = await tx.agentRunEvent.findMany({ where: { runId, seq: { gt: sinceSeq } }, orderBy: { seq: 'asc' }, take: limit,
      include: { projection: { include: { source: true } } } })
    return records.map((record, index) => {
      if (record.seq !== sinceSeq + index + 1) runtimeError('RUNTIME_RECEIPT_INVALID', '事件日志不连续，不能跳过缺失事件。')
      const projection = record.projection, source = projection?.source
      if (!projection || !source || projection.version !== 1 || projection.runId !== runId || source.taskRootId !== root.id
        || runtimeJson({ id: source.id, taskRootId: source.taskRootId, type: source.type, payload: source.payload }).hash !== projection.sourceHash
        || runtimeJson(record.payload).hash !== projection.eventHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '事件回放与持久来源不一致。')
      const event = record.payload as unknown as AgentStreamEvent
      if (event.seq !== record.seq || event.runId !== runId || event.type !== record.type) runtimeError('RUNTIME_RECEIPT_INVALID', '事件回放身份不一致。')
      return event
    })
  })
}
