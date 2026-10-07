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
import { configurationResponseSchema } from './tools/configuration-tools.js'
import { verifyChildGrant } from './runtime-child.js'
import { readParentContentionScope } from './runtime-parent-contention.js'
import { savedChapterPresentationSchema } from './writing-scope.js'
import { limitedWritingDeliverySchema } from './writing-delivery-limitations.js'

/** Only this DB-locked allocator writes UI events for the durable protocol.
 * New source families retain their outbox rows until their projector is added;
 * no global publishedAt cursor skips facts this version doesn't understand. */
export async function publishDurableEvents(userId: string, runId: string, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) runtimeError('RUNTIME_INPUT_INVALID', '事件批次大小无效。')
  const contentionScope = await readParentContentionScope(userId, runId)
  return runtimeTransaction(async tx => {
    const { root } = await lockRunRoot(tx, userId, runId)
    const sources = await tx.agentExecutionOutbox.findMany({ where: { taskRootId: root.id,
      OR: [{ type: { in: ['child.admitted', 'approval.requested', 'approval.resolved', 'execution.state.saved', 'writing.delivery.projected', 'question.requested', 'import.requested', 'import.commit_requested', 'goal.activation_registered', 'configuration.changed'] } },
        { type: 'execution.completion.decided', runId, payload: { path: ['kind'], equals: 'completed' } },
        { type: 'run.paused', payload: { path: ['runIds'], array_contains: [runId] } }],
      projections: { none: { runId } } }, orderBy: { sequence: 'asc' }, take: limit })
    const latest = await tx.agentRunEvent.findFirst({ where: { runId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    let seq = latest?.seq ?? 0
    const events: AgentStreamEvent[] = []
    for (const source of sources) {
      let bodies: import('../../../shared/contracts/index.js').AgentStreamEventBody[]
      if (source.type === 'writing.delivery.projected') {
        const payload = z.object({ sourceRevision: z.number().int().nonnegative(), sourceHash: z.string(), revision: z.number().int().positive(), snapshotHash: z.string(),
          proof: z.object({ version: z.literal(1), chapters: z.array(z.object({ id: z.string(), revision: z.number().int().positive(), contentHash: z.string() })), text: z.string(),
            limitedWritingDelivery: limitedWritingDeliverySchema.optional() }), proofHash: z.string() }).parse(source.payload)
        const before = await readExecutionFrame(tx, root.id, payload.sourceRevision)
        const frame = await readExecutionFrame(tx, root.id, payload.revision)
        const candidate = frame.state.messages.at(-1)
        const incoming = payload.proof.limitedWritingDelivery ? await tx.agentChildExecutionGrant.findUnique({ where: { childRunId: source.runId ?? '' } }) : null
        if (incoming) verifyChildGrant(incoming)
        if (source.eventKey !== `writing-delivery:${root.id}:${payload.revision}` || payload.revision !== payload.sourceRevision + 1
          || before.snapshotHash !== payload.sourceHash || frame.snapshotHash !== payload.snapshotHash
          || runtimeJson(payload.proof).hash !== payload.proofHash || candidate?.role !== 'assistant' || candidate.toolCalls?.length
          || candidate.content !== payload.proof.text || frame.state.messages.length !== before.state.messages.length + 1
          || runtimeJson(frame.state.messages.slice(0, -1)).hash !== runtimeJson(before.state.messages).hash
          || payload.proof.limitedWritingDelivery && (payload.proof.limitedWritingDelivery.taskId !== (incoming?.parentRootId ?? root.id)
            || payload.proof.limitedWritingDelivery.targetRunId !== source.runId || payload.proof.limitedWritingDelivery.text !== payload.proof.text
            || runtimeJson(payload.proof.limitedWritingDelivery.chapters.map(({ id, revision, contentHash }) => ({ id, revision, contentHash }))).hash !== runtimeJson(payload.proof.chapters).hash)) return runtimeError('RUNTIME_RECEIPT_INVALID', '正文交付投影与原章节版本证据不一致。')
        const messageId = `wd-${runtimeJson({ rootId: root.id, revision: payload.revision }).hash.slice(0, 48)}`
        bodies = [{ type: 'message.start', messageId, role: 'assistant' }, { type: 'text.final', messageId, text: payload.proof.text, asReasoning: false }]
      } else if (source.type === 'child.admitted') {
        const payload = z.object({ version: z.literal(1), grantId: z.string(), childRunId: z.string(), sessionId: z.string(), kind: z.enum(['inline', 'spawned']),
          index: z.number().int().nonnegative(), snapshotHash: z.string(), tokenCeiling: z.number().int().positive() }).strict().parse(source.payload)
        const grant = await tx.agentChildExecutionGrant.findUnique({ where: { id: payload.grantId }, include: { childRun: true, parentOperation: true } })
        if (!grant || grant.parentRootId !== root.id || grant.parentOperationId !== source.operationId || source.eventKey !== `child-admitted:${grant.id}`
          || grant.childRunId !== payload.childRunId || grant.childRun.sessionId !== payload.sessionId || grant.kind !== payload.kind
          || grant.childIndex !== payload.index || grant.snapshotHash !== payload.snapshotHash || grant.tokenCeiling !== payload.tokenCeiling
          || runtimeJson(grant.parentOperation.inputSnapshot).hash !== grant.parentOperation.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '子任务准入事件缺少原授权身份。')
        const frozen = verifyChildGrant(grant)
        const invocation = z.object({ input: z.object({ callId: z.string(), normalization: z.object({ sourceRevision: z.number() }) }) }).parse(grant.parentOperation.inputSnapshot)
        const frame = await readExecutionFrame(tx, root.id, invocation.input.normalization.sourceRevision)
        bodies = grant.kind === 'spawned' ? [{ type: 'task.spawned', messageId: durableMessageId(root.id, frame.state.turn), callId: invocation.input.callId,
          sessions: [{ sessionId: grant.childRun.sessionId, runId: grant.childRunId, novelId: root.novelId, title: frozen.name }] }]
          : [{ type: 'subagent.progress', messageId: durableMessageId(root.id, frame.state.turn), callId: invocation.input.callId, step: 0, message: '子 Agent 已准入，等待真实交付。' }]
      } else if (source.type === 'configuration.changed') {
        const payload = z.object({ callId: z.string(), requestHash: z.string(), configuration: configurationResponseSchema }).strict().parse(source.payload)
        const command = await tx.agentConfigurationChange.findUnique({ where: { runId_callId: { runId: source.runId!, callId: payload.callId } } })
        const effect = await tx.agentEffectReceipt.findUnique({ where: { operationId: source.operationId! }, include: { operation: true } })
        const saved = command?.response as { configuration?: unknown } | undefined
        const invocation = z.object({ input: z.object({ callId: z.string() }) }).safeParse(effect?.operation.inputSnapshot)
        const outcome = z.object({ toolResult: z.object({ output: z.string() }) }).safeParse(effect?.result)
        let response: unknown
        try { response = outcome.success ? JSON.parse(outcome.data.toolResult.output) : undefined } catch { response = undefined }
        if (!command || command.requestHash !== payload.requestHash || runtimeJson(saved?.configuration ?? command.response).hash !== runtimeJson(payload.configuration).hash
          || source.eventKey !== `configuration:${source.runId}:${payload.callId}` || !effect || !['agent_configure', 'model_assign'].includes(effect.operation.action)
          || !invocation.success || invocation.data.input.callId !== payload.callId || response === undefined || runtimeJson(response).hash !== runtimeJson(command.response).hash
          || effect.operation.taskRootId !== root.id || effect.operation.status !== 'succeeded' || runtimeJson(effect.result).hash !== effect.resultHash) {
          return runtimeError('RUNTIME_RECEIPT_INVALID', '配置事件缺少原切换回执。')
        }
        bodies = [{ type: 'run.configuration', ...payload.configuration }]
      } else if (source.type === 'goal.activation_registered') {
        const effect = await tx.agentEffectReceipt.findUnique({ where: { operationId: source.operationId ?? '' }, include: { operation: true } })
        const result = z.object({ toolResult: z.object({ goalSnapshot: z.object({ id: z.string(), sessionId: z.literal(root.sessionId), novelId: z.literal(root.novelId), currentRunId: z.string() }).passthrough() }) }).safeParse(effect?.result)
        const event = z.object({ operationId: z.string(), snapshot: z.unknown() }).safeParse(source.payload)
        if (!effect || !result.success || !event.success || effect.operation.action !== 'goal_enable' || effect.operation.taskRootId !== root.id
          || source.runId !== effect.runId || source.eventKey !== `goal-activation:${effect.operationId}` || event.data.operationId !== effect.operationId
          || runtimeJson(effect.result).hash !== effect.resultHash || runtimeJson(event.data.snapshot).hash !== runtimeJson(result.data.toolResult.goalSnapshot).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '目标登记事件缺少原调用回执。')
        bodies = [{ type: 'goal.snapshot', snapshot: result.data.toolResult.goalSnapshot as unknown as import('../../../shared/contracts/agent-goal.js').AgentGoalSnapshot }]
      } else if (source.type === 'import.requested' || source.type === 'import.commit_requested') {
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
          sourceRevision: z.number().int().nonnegative(), sourceHash: z.string(), revision: z.number().int().positive(), snapshotHash: z.string(),
          outcome: limitedWritingDeliverySchema.shape.outcome.optional() }).parse(source.payload)
        const receipt = await tx.agentEffectReceipt.findUnique({ where: { operationId: decision.reviewOperationId }, include: { operation: true } })
        const verdict = z.object({ verdict: z.object({ verdict: z.literal('complete') }) }).safeParse(receipt?.result)
        const proof = z.object({ version: z.literal(1), sourceRevision: z.number(), sourceHash: z.string(),
          candidateHash: z.string(), evidenceHash: z.string(), evidence: z.object({ blockers: z.array(z.never()) }).passthrough(),
          chapterPresentation: savedChapterPresentationSchema.optional(), limitedWritingDelivery: limitedWritingDeliverySchema.optional(),
          outcome: limitedWritingDeliverySchema.shape.outcome.optional() }).safeParse(receipt?.result)
        const frame = await readExecutionFrame(tx, root.id, decision.revision)
        const before = await readExecutionFrame(tx, root.id, decision.sourceRevision)
        const candidate = before.state.messages.at(-1)
        if (candidate?.role !== 'assistant') return runtimeError('RUNTIME_RECEIPT_INVALID', '完成事件缺少原候选答复。')
        const validProof = receipt?.operation.action === 'completion_finalize' && proof.success
          && proof.data.sourceRevision === decision.sourceRevision && proof.data.sourceHash === decision.sourceHash
          && runtimeJson(proof.data.evidence).hash === proof.data.evidenceHash
          && proof.data.candidateHash === runtimeJson({ content: candidate.content, reasoning: candidate.reasoning ?? null }).hash
          && (!proof.data.chapterPresentation || proof.data.chapterPresentation.targetRunId === source.runId)
          && (!proof.data.chapterPresentation || (() => {
            const admitted = z.object({ input: z.object({ chapterPresentation: savedChapterPresentationSchema }) }).safeParse(receipt.operation.inputSnapshot)
            return admitted.success && runtimeJson(receipt.operation.inputSnapshot).hash === receipt.operation.inputHash
              && runtimeJson(admitted.data.input.chapterPresentation).hash === runtimeJson(proof.data.chapterPresentation).hash
          })())
          && (!proof.data.limitedWritingDelivery || (() => {
            const limited = proof.data.limitedWritingDelivery
            const admitted = z.object({ input: z.object({ limitedWritingDelivery: limitedWritingDeliverySchema,
              outcome: limitedWritingDeliverySchema.shape.outcome }) }).safeParse(receipt.operation.inputSnapshot)
            const checked = z.object({ limitedWritingDelivery: limitedWritingDeliverySchema }).safeParse(proof.data.evidence)
            const decisionOutcome = z.object({ outcome: limitedWritingDeliverySchema.shape.outcome }).safeParse(source.payload)
            return admitted.success && checked.success && decisionOutcome.success && limited.targetRunId === source.runId
              && limited.text === candidate.content && runtimeJson(receipt.operation.inputSnapshot).hash === receipt.operation.inputHash
              && runtimeJson(admitted.data.input.limitedWritingDelivery).hash === runtimeJson(limited).hash
              && runtimeJson(checked.data.limitedWritingDelivery).hash === runtimeJson(limited).hash
              && runtimeJson(admitted.data.input.outcome).hash === runtimeJson(limited.outcome).hash
              && runtimeJson(decisionOutcome.data.outcome).hash === runtimeJson(limited.outcome).hash
              && runtimeJson(proof.data.outcome ?? {}).hash === runtimeJson(limited.outcome).hash
          })())
          && (!!proof.data.outcome === !!proof.data.limitedWritingDelivery)
          && (!!decision.outcome === !!proof.data.outcome)
        const legacyReview = receipt?.operation.action === 'completion_review' && verdict.success && !decision.outcome
        if (!receipt || (!validProof && !legacyReview) || receipt.operation.taskRootId !== root.id
          || source.operationId !== receipt.operationId || source.eventKey !== `decision:${receipt.operationId}`
          || receipt.resultHash !== decision.resultHash || runtimeJson(receipt.result).hash !== decision.resultHash
          || decision.revision !== decision.sourceRevision + 1 || before.snapshotHash !== decision.sourceHash
          || frame.snapshotHash !== decision.snapshotHash || frame.state.phase !== 'completed'
          || runtimeJson(frame.state.messages).hash !== runtimeJson(before.state.messages).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '完成事件缺少原审查回执和终态执行帧。')
        const children = await tx.agentChildExecutionGrant.findMany({ where: { parentRootId: root.id }, include: { childRun: { select: { taskRootId: true } } } })
        for (const child of children) verifyChildGrant(child)
        const roots = [root.id, ...children.flatMap(child => child.childRun.taskRootId ? [child.childRun.taskRootId] : [])]
        const usage = await tx.agentProviderUsageReceipt.aggregate({ where: { attempt: { operation: { taskRootId: { in: roots } } } }, _sum: { promptTokens: true, completionTokens: true } })
        const promptTokens = usage._sum.promptTokens ?? 0, completionTokens = usage._sum.completionTokens ?? 0
        const presentation = validProof && proof.success ? proof.data.chapterPresentation : null
        bodies = [...(presentation ? [{ type: 'text.final' as const, messageId: durableMessageId(root.id, before.state.turn), text: presentation.text, asReasoning: false }] : []),
          { type: 'run.finished', status: 'succeeded', usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
            ...(validProof && proof.success && proof.data.limitedWritingDelivery ? { outcome: proof.data.limitedWritingDelivery.outcome } : {}),
            artifacts: [], outputSummary: presentation?.text ?? candidate.content ?? '' }]
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
  }, { contentionScope })
}

/** Paginated replay never invents a terminal state from a disconnected process. */
export async function loadDurableEvents(userId: string, runId: string, sinceSeq: number, limit = 200): Promise<AgentStreamEvent[]> {
  if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) runtimeError('RUNTIME_INPUT_INVALID', '事件游标无效。')
  const contentionScope = await readParentContentionScope(userId, runId)
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
  }, { contentionScope })
}
