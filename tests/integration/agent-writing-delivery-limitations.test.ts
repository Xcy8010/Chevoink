import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { initializeExecutionState, loadExecutionState, saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { prepareStoryCompilation, reserveContinuityCheck, validateStoryContinuity, commitChapterBridge, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { readLimitedWritingDelivery, assertLimitedWritingDelivery, readRunLimitedWritingOutcome, limitedWritingDeliverySchema } from '../../api/lib/agent/writing-delivery-limitations.js'
import { readCompletedWritingDelivery } from '../../api/lib/agent/writing-scope.js'
import { collectDurableCompletionEvidence } from '../../api/lib/agent/runtime-completion-evidence.js'
import { advanceDurableWritingDelivery } from '../../api/lib/agent/runtime-writing-delivery.js'
import { finalizeDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import * as ai from '../../api/lib/ai-service.js'
import { advanceDurableMemory } from '../../api/lib/agent/runtime-memory.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { todoWriteTool } from '../../api/lib/agent/tools/todo-tools.js'
import { advanceDurableCompletionObligations } from '../../api/lib/agent/runtime-continuation.js'
import { chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { readDurableTodoItems } from '../../api/lib/agent/tools/durable-todo.js'
import { buildHumanityQualityContext, qualityReviewContextHash, HUMANITY_CRITIC_VERSION } from '../../api/lib/agent/humanity-quality.js'
import { readQualityUnavailableProof } from '../../api/lib/agent/quality-unavailable-proof.js'

describe.runIf(available)('current saved writing with exhausted continuity review', () => {
  async function capped(f: Parameters<Parameters<typeof fixture>[0]>[0], finishMemory = true) {
    const lease = await claim(f)
    const original = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const prepared = await prepareStoryCompilation({ ...f, mode: 'premium', intentSummary: '修改本章正文' })
    const state = { knowledge: [], body: [], objects: [], relationships: [], emotion: [], openLoops: [] }
    await saveSceneTasks({ ...f, compilationId: prepared.compilation.id, tasks: [1, 2, 3].map(n => ({ purpose: `真实准备场景${n}`, entryState: state,
      goal: '登上山路', obstacle: '夜色渐深', choice: '交出钥匙', cost: '放弃返回', turn: '独自登山', exitState: state, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } })) })
    const compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
    for (let n = 0; n < 3; n++) expect(await reserveContinuityCheck(f.userId, f.novelId, compilation.id)).toBe(true)
    await validateStoryContinuity({ ...f, compilationId: compilation.id, independentCheck: 'complete', expectedChapterRevision: original.revision,
      findings: [], coverage: compilerContinuityCoverage({ chapter: original, bridge: compilation.bridge, sceneTasks: compilation.sceneTasks, source: null }) })
    const tools = [chapterReadTool, chapterWriteTool, todoWriteTool, chapterBridgeCommitTool]
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
      toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [],
        messages: [{ role: 'user', content: '修改本章正文' }, { role: 'assistant', content: null, toolCalls: [
          { id: 'read-current', name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) },
          { id: 'save-body', name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '他把钥匙交给守门人，然后沿着山路向上走去。门已锁好，灯仍亮着。' }) },
        ] }] } })
    await executeDurableToolStep(lease, new AbortController().signal)
    await executeDurableToolStep(lease, new AbortController().signal)
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const report = await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId,
      compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision, status: 'passed',
      deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(chapter.content).digest('hex') } } })
    if (finishMemory) await advanceDurableMemory(lease)
    return { lease, compilationId: compilation.id, chapter, report }
  }
  async function failedQuality(f: Parameters<Parameters<typeof fixture>[0]>[0], c: Awaited<ReturnType<typeof capped>>, completeContinuity = false) {
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, engine: 'loop', startRequest: { prompt: '修改本章' } } })
    if (completeContinuity) {
      const compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: c.compilationId }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
      await validateStoryContinuity({ ...f, compilationId: c.compilationId, expectedChapterRevision: c.chapter.revision, independentCheck: 'complete', findings: [],
        coverage: compilerContinuityCoverage({ chapter: c.chapter, bridge: compilation.bridge, sceneTasks: compilation.sceneTasks, source: null }) })
    }
    const started = new Date(Date.now() + 10), created = new Date(started.getTime() + 10), finished = new Date(started.getTime() + 30)
    const context = await buildHumanityQualityContext(f.userId, f.novelId, f.chapterId, f.runId)
    const report = await prisma.chapterQualityReport.update({ where: { id: c.report.id }, data: { status: 'failed', criticVersion: HUMANITY_CRITIC_VERSION,
      createdAt: created, deterministicMetrics: { independentCheck: 'unavailable', contentHash: createHash('sha256').update(c.chapter.content).digest('hex'),
        qualityContextHash: qualityReviewContextHash(context) } } })
    const callId = randomUUID()
    const call = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 5000, type: 'tool.call', createdAt: started,
      payload: { toolName: 'quality_analyze', callId, args: { compilationId: c.compilationId } } } })
    const result = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 5001, type: 'tool.result', createdAt: finished,
      payload: { toolName: 'quality_analyze', callId, ok: false, failureCode: 'QUALITY_REPORT_INCOMPLETE' } } })
    const paid = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, targetType: 'chapter', targetId: f.chapterId,
      providerType: 'text', providerMode: 'fixture', modelName: 'fixture', action: 'agent3HumanityCritic', requestTokens: 100, responseTokens: 50,
      durationMs: 1, usageSource: 'reported', billingStatus: 'settled', createdAt: new Date(started.getTime() + 5) } })
    return { report, call, result, paid, started, finished, callId }
  }
  // Shape compatibility only. This is not a terminal receipt and cannot grant
  // a fresh delivery; authoritative child verification still requires receipts.
  async function historicalProofShape(f: Parameters<Parameters<typeof fixture>[0]>[0], c: Awaited<ReturnType<typeof capped>>) {
    const compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: c.compilationId }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
    const report = await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: c.report.id }, include: { findings: true } })
    const source = compilation.bridge?.fromChapterId ? await prisma.chapter.findUniqueOrThrow({ where: { id: compilation.bridge.fromChapterId } }) : null
    const summary = '历史已交付正文；原三次限制下当前版本未复核。'
    return limitedWritingDeliverySchema.parse({ version: 1, taskId: f.rootId, targetRunId: f.runId, sourceRunId: f.runId,
      chapters: [{ id: c.chapter.id, title: c.chapter.title, revision: c.chapter.revision, contentHash: runtimeJson({ content: c.chapter.content }).hash,
        compilationId: compilation.id, compilerStateHash: runtimeJson(JSON.parse(JSON.stringify(compilation))).hash,
        sourceChapterId: source?.id ?? null, sourceRevision: source?.revision ?? null, sourceContentHash: source ? runtimeJson({ content: source.content }).hash : null,
        continuityCheckRounds: 3, continuityStatus: 'stale', qualityReportId: report.id, qualityReportHash: runtimeJson(JSON.parse(JSON.stringify(report))).hash,
        retainedQualityIssueCount: 0 }], text: summary, outcome: { kind: 'delivered_with_limitations', summary } })
  }
  async function unavailableProof(f: Parameters<Parameters<typeof fixture>[0]>[0], c: Awaited<ReturnType<typeof capped>>) {
    return prisma.$transaction(async tx => {
      const report = await tx.chapterQualityReport.findUniqueOrThrow({ where: { id: c.report.id }, include: { findings: true } })
      const chapter = await tx.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      return readQualityUnavailableProof(tx, f, [f.runId], report, chapter, null)
    })
  }
  it.each([false, true])('retains known format evidence without completing unfinished writing; continuity=%s', async complete => fixture(async f => {
    const model = vi.spyOn(ai, 'generateTextCompletion').mockRejectedValue(new Error('Paid replay forbidden'))
    const c = await capped(f), evidence = await failedQuality(f, c, complete)
    try {
      const subject = { userId: f.userId, novelId: f.novelId, runId: f.runId }
      expect(await unavailableProof(f, c)).toMatchObject({ source: 'legacy', witnessIds: [evidence.call.id, evidence.result.id, evidence.paid.id] })
      expect(await prisma.$transaction(tx => readLimitedWritingDelivery(tx, subject))).toBeNull()
      expect(await prisma.$transaction(tx => readCompletedWritingDelivery(tx, subject))).toBeNull()
      const old = await historicalProofShape(f, c), qualityFailure = await unavailableProof(f, c)
      const historical = limitedWritingDeliverySchema.parse({ ...old, version: 2, chapters: old.chapters.map(chapter => ({ ...chapter,
        continuityStatus: complete ? 'complete' : 'stale', qualityStatus: 'unavailable', qualityFailure })) })
      expect(readRunLimitedWritingOutcome({ outcome: historical.outcome, deliveryProof: historical })).toEqual(historical)
      await expect(prisma.$transaction(tx => assertLimitedWritingDelivery(tx, subject, historical))).rejects.toMatchObject({ code: 'WRITING_DELIVERY_STALE' })
      expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: c.report.id } })).toMatchObject({ status: 'failed' })
      expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: c.compilationId } })).toMatchObject({ status: 'active' })
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: c.compilationId } })).committedAt).toBeNull()
      expect(model).not.toHaveBeenCalled()
    } finally { await prisma.aiUsageLog.delete({ where: { id: evidence.paid.id } }) }
  }))
  it.each(['missing-call', 'wrong-call', 'missing-result', 'wrong-code', 'usage-unknown', 'usage-pending', 'usage-duplicate', 'report-duplicate',
    'interleaved', 'body-changed', 'context-changed', 'continuity-stale', 'independent-todo', 'evidence-changed', 'recovery-unknown', 'audit-provider', 'audit-foreign'] as const)('known-format %s cannot manufacture delivery', async scenario => fixture(async f => {
    const c = await capped(f), evidence = await failedQuality(f, c, true)
    const subject = { userId: f.userId, novelId: f.novelId, runId: f.runId }
    const proof = await unavailableProof(f, c)
    expect(proof).not.toBeNull()
    let duplicateUsage: string | undefined
    if (scenario === 'missing-call') await prisma.agentRunEvent.delete({ where: { id: evidence.call.id } })
    if (scenario === 'wrong-call') await prisma.agentRunEvent.update({ where: { id: evidence.call.id }, data: { payload: { toolName: 'quality_analyze', callId: evidence.callId, args: { chapterId: 'foreign' } } } })
    if (scenario === 'missing-result') await prisma.agentRunEvent.delete({ where: { id: evidence.result.id } })
    if (scenario === 'wrong-code') await prisma.agentRunEvent.update({ where: { id: evidence.result.id }, data: { payload: { toolName: 'quality_analyze', callId: evidence.callId, ok: false, failureCode: 'AI_PROVIDER_UNKNOWN' } } })
    if (scenario === 'usage-unknown') await prisma.aiUsageLog.update({ where: { id: evidence.paid.id }, data: { usageSource: 'unknown', responseTokens: null } })
    if (scenario === 'usage-pending') await prisma.aiUsageLog.update({ where: { id: evidence.paid.id }, data: { billingStatus: 'pending_usage' } })
    if (scenario === 'usage-duplicate') duplicateUsage = (await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, targetType: 'chapter', targetId: f.chapterId,
      providerType: 'text', providerMode: 'fixture', modelName: 'fixture', action: 'agent3HumanityCritic', requestTokens: 1, responseTokens: 1,
      durationMs: 1, usageSource: 'reported', billingStatus: 'settled', createdAt: evidence.paid.createdAt } })).id
    if (scenario === 'report-duplicate') await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId, compilationId: c.compilationId,
      chapterId: f.chapterId, chapterRevision: c.chapter.revision, status: 'failed', criticVersion: HUMANITY_CRITIC_VERSION, deterministicMetrics: evidence.report.deterministicMetrics!, createdAt: evidence.report.createdAt } })
    if (scenario === 'interleaved') {
      await prisma.agentRunEvent.update({ where: { id: evidence.result.id }, data: { seq: 5002 } })
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 5001, type: 'tool.call', createdAt: evidence.report.createdAt,
        payload: { toolName: 'chapter_edit_range', callId: 'interleaved', args: { chapterId: f.chapterId } } } })
    }
    if (scenario === 'body-changed') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者的新正文', revision: { increment: 1 } } })
    if (scenario === 'context-changed') await prisma.chapter.update({ where: { id: f.chapterId }, data: { title: '作者更新的章节标题' } })
    if (scenario === 'continuity-stale') await prisma.storyCompilation.update({ where: { id: c.compilationId }, data: { validation: { checkRounds: 3, checkedRevision: c.chapter.revision - 1 } } })
    if (scenario === 'independent-todo') await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'chapterPlan', title: '未完成正文', content: JSON.stringify([{ content: '保存封面', status: 'pending' }]), metadata: { todoList: true } } })
    if (scenario === 'evidence-changed') await prisma.aiUsageLog.update({ where: { id: evidence.paid.id }, data: { responseTokens: 51 } })
    if (scenario === 'recovery-unknown') duplicateUsage = (await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, targetType: 'chapter', targetId: f.chapterId,
      providerType: 'text', providerMode: 'fixture', modelName: 'fixture', action: 'agent3HumanityCriticOutputRecovery', durationMs: 1,
      usageSource: 'unknown', billingStatus: 'settled', createdAt: evidence.paid.createdAt } })).id
    if (scenario === 'audit-provider' || scenario === 'audit-foreign') await prisma.chapterQualityReport.update({ where: { id: c.report.id }, data: {
      deterministicMetrics: { ...evidence.report.deterministicMetrics as object, criticResponse: { version: 1, contentHash: 'a'.repeat(64), characterCount: 10,
        classification: scenario === 'audit-provider' ? 'provider_unavailable' : 'json_invalid', callId: 'foreign-call' } } } })
    try {
      expect(await prisma.$transaction(tx => readLimitedWritingDelivery(tx, subject))).toBeNull()
      const currentWitness = await unavailableProof(f, c)
      if (scenario === 'evidence-changed') expect(currentWitness).not.toEqual(proof)
      else if (['continuity-stale', 'independent-todo'].includes(scenario)) expect(currentWitness).toEqual(proof)
      else expect(currentWitness).toBeNull()
    } finally { await prisma.aiUsageLog.deleteMany({ where: { id: { in: [evidence.paid.id, ...(duplicateUsage ? [duplicateUsage] : [])] } } }) }
  }))
  it('keeps historical v1 proof readable but cannot project or complete an unreviewed revision after three checks', async () => fixture(async f => {
    const model = vi.spyOn(ai, 'generateTextCompletion').mockRejectedValue(new Error('No model dispatch permitted'))
    const c = await capped(f)
    const subject = { userId: f.userId, novelId: f.novelId, runId: f.runId }
    expect(await prisma.$transaction(tx => readCompletedWritingDelivery(tx, subject))).toBeNull()
    expect(await prisma.$transaction(tx => readLimitedWritingDelivery(tx, subject))).toBeNull()
    const historical = await historicalProofShape(f, c)
    expect(readRunLimitedWritingOutcome({ outcome: historical.outcome, deliveryProof: historical })).toEqual(historical)
    expect(() => readRunLimitedWritingOutcome({ outcome: { ...historical.outcome, summary: '伪造' }, deliveryProof: historical })).toThrow()
    expect(await reserveContinuityCheck(f.userId, f.novelId, c.compilationId)).toBe(true)
    await expect(commitChapterBridge({ ...f, compilationId: c.compilationId, chapterSummary: '不得提交未复核正文', exitState: { knowledge: [], body: [], objects: [], relationships: [], emotion: [], openLoops: [] },
      lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '', endingStructure: '' })).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
    const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })
    expect(await advanceDurableWritingDelivery(c.lease)).toBeNull()
    let current = await loadExecutionState(f.userId, f.runId)
    await saveExecutionState(c.lease, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash,
      snapshot: { ...current.frame.state, messages: [...current.frame.state.messages, { role: 'assistant', content: '正文已保存，当前版本的连续性检查仍未完成。' }] } })
    current = await loadExecutionState(f.userId, f.runId)
    // A pre-deploy candidate is immutable history, not a committed terminal receipt.
    const projected = runtimeJson({ version: 1, chapters: historical.chapters.map(({ id, revision, contentHash }) => ({ id, revision, contentHash })),
      text: historical.text, limitedWritingDelivery: historical })
    await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: f.rootId, runId: f.runId,
      eventKey: `writing-delivery:${f.rootId}:${current.frame.revision}`, type: 'writing.delivery.projected', payload: {
        sourceRevision: current.frame.revision - 1, sourceHash: 'a'.repeat(64), revision: current.frame.revision,
        snapshotHash: current.frame.snapshotHash, proof: projected.value, proofHash: projected.hash } } })
    const evidence = await collectDurableCompletionEvidence(c.lease, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash })
    expect(evidence.snapshot.blockers.length).toBeGreaterThan(0)
    expect(evidence.snapshot.limitedWritingDelivery).toBeUndefined()
    await expect(finalizeDurableTask(c.lease, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash })).rejects.toMatchObject({ code: 'RUNTIME_COMPLETION_BLOCKED' })
    const finished = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    expect(finished.status).not.toBe('completed')
    expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'writing.delivery.projected' } })).toBe(1)
    const compiler = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: c.compilationId }, include: { bridge: true, sceneTasks: true } })
    expect(compiler.status).toBe('active')
    expect(compiler.bridge!.committedAt).toBeNull()
    expect(compiler.sceneTasks.map(scene => scene.status)).toEqual(['writing', 'writing', 'writing'])
    expect(compiler.validation).toMatchObject({ checkRounds: 4, checkedRevision: c.chapter.revision - 1 })
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })).toEqual(budget)
    expect(model).not.toHaveBeenCalled()
  }))

  it('lets an independent native todo reach continuation and the model before limited projection', async () => fixture(async f => {
    const c = await capped(f)
    const update = async (items: Array<{ id?: string; content: string; status: 'pending' | 'completed' }>) => {
      const current = await loadExecutionState(f.userId, f.runId)
      await saveExecutionState(c.lease, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash,
        snapshot: { ...current.frame.state, messages: [...current.frame.state.messages, { role: 'assistant', content: null,
          toolCalls: [{ id: `todo-${current.frame.revision}`, name: 'todo_write', arguments: JSON.stringify({ items }) }] }] } })
      await executeDurableToolStep(c.lease, new AbortController().signal)
    }
    await update([{ content: '核对本章正文已保存', status: 'pending' }, { content: '完成连续性检查及章节终态提交', status: 'pending' }])
    let current = await loadExecutionState(f.userId, f.runId)
    const todos = await prisma.$transaction(tx => readDurableTodoItems(tx, f.rootId, current.frame.revision))
    expect(todos.map(item => item.status)).toEqual(['pending', 'pending'])
    expect(await advanceDurableWritingDelivery(c.lease)).toBeNull()
    await saveExecutionState(c.lease, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash,
      snapshot: { ...current.frame.state, messages: [...current.frame.state.messages, { role: 'assistant', content: '正文已保存，尚有核对待办。' }] } })
    current = await loadExecutionState(f.userId, f.runId)
    expect(await advanceDurableCompletionObligations(c.lease, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash })).toMatchObject({ kind: 'continued' })
    const continuation = await loadExecutionState(f.userId, f.runId)
    expect(continuation.frame.state.messages.at(-1)?.role).toBe('system')
    expect(await advanceDurableWritingDelivery(c.lease)).toBeNull()
    expect((await loadExecutionState(f.userId, f.runId)).frame.snapshotHash).toBe(continuation.frame.snapshotHash)
    await update(todos.map((item, index) => ({ ...item, status: index === 0 ? 'completed' : 'pending' })))
    expect(await advanceDurableWritingDelivery(c.lease)).toBeNull()
    current = await loadExecutionState(f.userId, f.runId)
    await saveExecutionState(c.lease, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash,
      snapshot: { ...current.frame.state, messages: [...current.frame.state.messages, { role: 'assistant', content: '正文核对已完成，连续性检查和终态提交仍待完成。' }] } })
    current = await loadExecutionState(f.userId, f.runId)
    expect((await collectDurableCompletionEvidence(c.lease, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash })).snapshot.blockers.length).toBeGreaterThan(0)
  }))

  it.each(['active', 'completed'] as const)('does not cover a second %s compilation with the exhausted target proof', async status => fixture(async f => {
    const c = await capped(f)
    const original = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: c.compilationId } })
    const other = await prisma.storyCompilation.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId,
      chapterId: f.chapterId, mode: original.mode, targetOrderIndex: original.targetOrderIndex,
      sourcePromptHash: original.sourcePromptHash, preparedContext: {}, status, stage: 'prepare' } })
    const current = await loadExecutionState(f.userId, f.runId)
    expect(await advanceDurableWritingDelivery(c.lease)).toBeNull()
    expect((await loadExecutionState(f.userId, f.runId)).frame.snapshotHash).toBe(current.frame.snapshotHash)
    await prisma.storyCompilation.update({ where: { id: other.id }, data: { status: 'abandoned' } })
    expect(await advanceDurableWritingDelivery(c.lease)).toBeNull()
  }))

  it('finishing native memory cannot replace a current continuity assessment', async () => fixture(async f => {
    const c = await capped(f, false)
    const before = await loadExecutionState(f.userId, f.runId)
    expect(await advanceDurableWritingDelivery(c.lease)).toBeNull()
    expect((await loadExecutionState(f.userId, f.runId)).frame.snapshotHash).toBe(before.frame.snapshotHash)
    expect(await advanceDurableMemory(c.lease)).not.toBeNull()
    expect(await advanceDurableWritingDelivery(c.lease)).toBeNull()
  }))

  it.each(['quality-stale', 'quality-changed', 'checks-left', 'malformed-receipt', 'unknown-operation', 'unknown-attempt', 'pending-usage', 'settled-unknown', 'author-race', 'source-race', 'wrong-proof', 'foreign-subject', 'paused', 'rollback'] as const)('%s preserves the admission and audit boundaries', async scenario => fixture(async f => {
    const c = await capped(f), subject = { userId: f.userId, novelId: f.novelId, runId: f.runId }
    if (scenario === 'source-race') {
      const original = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const source = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: original.volumeId, title: '来源章', content: '原来源', revision: 1, orderIndex: 2, orderInVolume: 2, wordCount: 3 } })
      await prisma.chapterBridge.update({ where: { compilationId: c.compilationId }, data: { fromChapterId: source.id, sourceRevision: source.revision } })
    }
    expect(await prisma.$transaction(tx => readLimitedWritingDelivery(tx, subject))).toBeNull()
    const proof = await historicalProofShape(f, c)
    let usageId: string | undefined
    if (scenario === 'quality-stale') await prisma.chapterQualityReport.update({ where: { id: c.report.id }, data: { chapterRevision: c.chapter.revision - 1 } })
    if (scenario === 'quality-changed') await prisma.chapterQualityReport.update({ where: { id: c.report.id }, data: { deterministicMetrics: { ...c.report.deterministicMetrics as object, changedAudit: true } } })
    if (scenario === 'checks-left') await prisma.storyCompilation.update({ where: { id: c.compilationId }, data: { validation: { checkRounds: 2 } } })
    if (scenario === 'malformed-receipt') await prisma.storyCompilation.update({ where: { id: c.compilationId }, data: { validation: { checkRounds: 3, newDraftRevision: { version: 999 } } } })
    if (scenario === 'author-race') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 }, content: '作者更新的正文，必须保留。' } })
    if (scenario === 'source-race') await prisma.chapter.update({ where: { id: proof!.chapters[0].sourceChapterId! }, data: { revision: { increment: 1 }, content: '作者更新的来源。' } })
    if (scenario === 'paused') await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused' } })
    if (scenario === 'unknown-operation' || scenario === 'unknown-attempt') {
      const operation = await prisma.agentOperation.create({ data: { id: randomUUID(), taskRootId: f.rootId, originRunId: f.runId, operationKey: 'unknown-review', kind: 'provider', action: 'fixture', inputHash: runtimeJson({}).hash, inputSnapshot: {}, status: scenario === 'unknown-operation' ? 'unknown' : 'failed' } })
      if (scenario === 'unknown-attempt') await prisma.agentProviderAttempt.create({ data: { id: randomUUID(), operationId: operation.id, runId: f.runId, ownerEpoch: c.lease.epoch, attemptKey: 'unknown', provider: 'fixture', model: 'fixture', requestHash: runtimeJson({}).hash, requestSnapshot: {}, status: 'unknown' } })
    }
    if (scenario === 'pending-usage' || scenario === 'settled-unknown') usageId = (await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId,
      targetType: 'agentRun', targetId: f.runId, providerType: 'text', providerMode: 'fixture', modelName: 'fixture', action: 'workspaceAgent', durationMs: 1, usageSource: 'unknown', billingStatus: scenario === 'settled-unknown' ? 'settled' : 'pending_usage' } })).id
    try {
      if (scenario === 'wrong-proof') await expect(prisma.$transaction(tx => assertLimitedWritingDelivery(tx, subject, { ...proof!, targetRunId: 'foreign' }))).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      else if (scenario === 'foreign-subject') expect(await prisma.$transaction(tx => readLimitedWritingDelivery(tx, { ...subject, userId: randomUUID() }))).toBeNull()
      else if (scenario === 'malformed-receipt') expect(await prisma.$transaction(tx => readLimitedWritingDelivery(tx, subject))).toBeNull()
      else if (scenario === 'quality-changed') {
        expect(await prisma.$transaction(tx => readLimitedWritingDelivery(tx, subject))).not.toEqual(proof)
        await expect(prisma.$transaction(tx => assertLimitedWritingDelivery(tx, subject, proof!))).rejects.toMatchObject({ code: 'WRITING_DELIVERY_STALE' })
      }
      else if (scenario === 'rollback') {
        const before = await loadExecutionState(f.userId, f.runId)
        await expect(prisma.$transaction(async tx => { await tx.agentRun.update({ where: { id: f.runId }, data: { outputSummary: 'rollback' } }); await assertLimitedWritingDelivery(tx, subject, proof) })).rejects.toMatchObject({ code: 'WRITING_DELIVERY_STALE' })
        expect((await loadExecutionState(f.userId, f.runId)).frame.snapshotHash).toBe(before.frame.snapshotHash)
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).outputSummary).toBeNull()
      } else if (scenario === 'settled-unknown') {
        expect(await prisma.$transaction(tx => readLimitedWritingDelivery(tx, subject))).toBeNull()
        expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usageId } })).toMatchObject({ usageSource: 'unknown', billingStatus: 'settled' })
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      } else if (scenario === 'paused') await expect(prisma.$transaction(tx => assertLimitedWritingDelivery(tx, subject, proof!))).rejects.toThrow()
      else {
        expect(await prisma.$transaction(tx => readLimitedWritingDelivery(tx, subject))).toBeNull()
        await expect(prisma.$transaction(tx => assertLimitedWritingDelivery(tx, subject, proof!))).rejects.toMatchObject({ code: 'WRITING_DELIVERY_STALE' })
      }
    } finally { if (usageId) await prisma.aiUsageLog.delete({ where: { id: usageId } }) }
  }))
  it.each(['修改第一章正文，检查通过后才能交付', '修改第一章正文，并生成封面', '检查第一章连续性'] as const)('does not waive the original hard or independent requirement: %s', async prompt => fixture(async f => {
    const c = await capped(f)
    expect(await prisma.$transaction(tx => readLimitedWritingDelivery(tx, { userId: f.userId, novelId: f.novelId, runId: f.runId }))).toBeNull()
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: c.compilationId } })).status).toBe('active')
  }, undefined, prompt))

  it.each(['todo', 'dependency', 'malformed-todo', 'active-child', 'active-subtask', 'old-task-todo', 'hard-review', 'postcondition'] as const)('legacy %s remains scoped and cannot hide unfinished independent work', async scenario => fixture(async f => {
    const runId = randomUUID(), prompt = '修改本章'
    const spec = buildTaskSpec({ runId, novelId: f.novelId, chapterId: f.chapterId, prompt })
    if (scenario === 'hard-review') spec.hardConstraints.push({ id: randomUUID(), kind: 'author_directive', text: '必须连续性复核通过才能交付' })
    if (scenario === 'postcondition') spec.postconditions.push({ code: 'AUTHOR_ACCEPTANCE_VERIFIED', description: '必须有真实作者验收', severity: 'error' })
    await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: f.chapterId,
      engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running',
      startRequest: { prompt }, taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const ctx = { userId: f.userId, novelId: f.novelId, runId, sessionId: f.sessionId, chapterId: f.chapterId,
      callId: 'legacy-save', mode: 'build' as const, creativeFreedom: 'balanced' as const, qualityMode: 'premium' as const, emit: () => {}, signal: new AbortController().signal }
    const prepared = await prepareStoryCompilation({ ...ctx, mode: 'premium', intentSummary: prompt })
    const compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id }, include: { bridge: true, sceneTasks: true } })
    const original = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    for (let n = 0; n < 3; n++) expect(await reserveContinuityCheck(f.userId, f.novelId, compilation.id)).toBe(true)
    await validateStoryContinuity({ ...ctx, compilationId: compilation.id, independentCheck: 'complete', expectedChapterRevision: original.revision,
      findings: [], coverage: compilerContinuityCoverage({ chapter: original, bridge: compilation.bridge, sceneTasks: compilation.sceneTasks, source: null }) })
    await chapterReadTool.execute(ctx, { chapterId: f.chapterId })
    await chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: '真实保存的当前正文。钥匙交给守门人，山路仍通向高处。' })
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId, runId, compilationId: compilation.id,
      chapterId: chapter.id, chapterRevision: chapter.revision, status: 'passed', deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(chapter.content).digest('hex') } } })
    const subject = { userId: f.userId, novelId: f.novelId, runId }
    const before = await prisma.$transaction(tx => readLimitedWritingDelivery(tx, subject))
    if (scenario === 'hard-review' || scenario === 'postcondition') {
      expect(before).toBeNull()
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: chapter.content, revision: chapter.revision })
      return
    }
    expect(before).toBeNull()
    if (['todo', 'dependency', 'malformed-todo', 'old-task-todo'].includes(scenario)) {
      await prisma.agentArtifact.create({ data: { runId: scenario === 'old-task-todo' ? f.runId : runId, artifactType: 'chapterPlan', title: '任务待办清单',
        content: scenario === 'malformed-todo' ? 'broken-json' : JSON.stringify([{ id: 'real-task', content: scenario === 'dependency' ? '完成连续性检查及章节终态提交' : '完成原任务的场景正文核对', status: 'pending' }]),
        metadata: { todoList: true, todoRunId: scenario === 'old-task-todo' ? f.runId : runId } } })
    }
    if (scenario === 'active-child') {
      const session = await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '未完成派生任务', spawnedFromRunId: runId, spawnedFromSessionId: f.sessionId } })
      await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: session.id, mode: 'review', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', engine: 'loop' } })
    }
    if (scenario === 'active-subtask') {
      const definition = await prisma.agentSubtask.create({ data: { userId: f.userId, novelId: f.novelId, name: '未完成检查', role: 'research', prompt: '只读核对', triggerCondition: '真实子工作', status: 'ready' } })
      await prisma.agentSubtaskRun.create({ data: { subtaskId: definition.id, parentRunId: runId, userId: f.userId, novelId: f.novelId, task: '尚未完成检查', status: 'running' } })
    }
    if (scenario === 'dependency' || scenario === 'old-task-todo') expect(await prisma.$transaction(tx => readLimitedWritingDelivery(tx, subject))).toEqual(before)
    else if (scenario === 'malformed-todo') expect(await prisma.$transaction(tx => readLimitedWritingDelivery(tx, subject))).toBeNull()
    else {
      expect(await prisma.$transaction(tx => readLimitedWritingDelivery(tx, subject))).toBeNull()
      await expect(prisma.$transaction(tx => assertLimitedWritingDelivery(tx, subject, before!))).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    }
  }))
})
