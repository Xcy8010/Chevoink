import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { freezeWritingScope } from '../../api/lib/agent/writing-scope.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { initializeExecutionState, loadExecutionState, saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { collectDurableCompletionEvidence } from '../../api/lib/agent/runtime-completion-evidence.js'
import { advanceDurableCompletionObligations } from '../../api/lib/agent/runtime-continuation.js'
import { prepareStoryCompilation, saveSceneTasks, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { chapterBridgeCommitTool, continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0]
const json = (value: unknown) => runtimeJson(JSON.parse(JSON.stringify(value))).value

// Create the protocol marker before root admission; never mutate a frozen root.
async function admit(f: Fixture, marker = true, denied = false, options: { terminal?: boolean; missingTools?: string[]; deniedTools?: string[] } = {}) {
  const runId = randomUUID(), sourceMessageId = randomUUID(), prompt = '修改本章，完成连续性检查和人类感检查。'
  const subject = { ...f, runId }
  const initialSpec = buildTaskSpec({ runId, novelId: f.novelId, chapterId: f.chapterId, prompt, ...(marker ? { reviewProtocol: 1 } : {}),
    ...(options.terminal ? { terminalEvidenceProtocol: 1 } : {}) })
  await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: f.chapterId,
    status: 'queued', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: json(initialSpec) } })
  await prisma.agentMessage.create({ data: { id: sourceMessageId, runId, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
  const spec = await prisma.$transaction(tx => freezeWritingScope(tx, subject, initialSpec, prompt))
  await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: json(spec) } })
  const root = await initializeDurableTask({ userId: f.userId, runId, sourceMessageId })
  const lease = await claim(subject)
  const tool = chapterBridgeCommitTool
  const tools = [tool, continuityValidateTool, qualityAnalyzeTool].filter(item => !options.missingTools?.includes(item.name))
  const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator',
    creativeFreedom: 'balanced', qualityMode: 'premium',
    model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
    tools: tools.map(item => ({ type: 'function', function: { name: item.name, description: item.description, parameters: z.toJSONSchema(item.parameters, { io: 'input' }) } })),
    toolAuthority: tools.map(item => ({ name: item.name, permission: denied || options.deniedTools?.includes(item.name) ? 'deny' : 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
    snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
      messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: '正文已保存。' }], successfulToolSignatures: [] } })
  const prepared = await prepareStoryCompilation({ ...subject, chapterId: f.chapterId, mode: 'balanced', intentSummary: '合成当前检查对象' })
  const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
  const report = await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId, runId,
    chapterId: chapter.id, chapterRevision: chapter.revision, compilationId: prepared.compilation.id, status: 'passed',
    deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(chapter.content).digest('hex') } } })
  await prisma.qualityFinding.createMany({ data: Array.from({ length: 10 }, (_, index) => ({ id: randomUUID(), reportId: report.id,
    userId: f.userId, novelId: f.novelId, source: 'critic', signal: 'emotion_grounding', severity: 'advisory',
    // Synthetic persisted overlapping/unlocated spans are facts, never an edit grant.
    startOffset: index, endOffset: index + chapter.content.length,
    evidenceExcerpt: chapter.content, evidenceHash: createHash('sha256').update(chapter.content).digest('hex'),
    explanation: `合成意见${index}`, suggestion: '保留作者动作并说明理由', confidence: 0.9 })) })
  return { ...subject, rootId: root.id, lease, initial: initial.frame, compilationId: prepared.compilation.id, reportId: report.id }
}

const cursor = (frame: { revision: number; snapshotHash: string }) => ({ expectedRevision: frame.revision, expectedHash: frame.snapshotHash })

async function saveTerminalReview(a: Awaited<ReturnType<typeof admit>>, verdict: 'supported' | 'unknown') {
  const empty = terminalCandidateSchema.parse({ exitState: {} }).exitState
  await saveSceneTasks({ ...a, compilationId: a.compilationId, tasks: [{ purpose: '核对合成原文的章末动作', entryState: empty,
    goal: '确认当前动作', obstacle: '候选尚未独立核实', choice: '按原文逐项核对', cost: '不新增正文变化',
    turn: '保留真实独立结论', exitState: empty, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
  const candidate = terminalCandidateSchema.parse({ exitState: { action: '原文' } })
  const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: a.chapterId } })
  const compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId }, include: { bridge: true, sceneTasks: true } })
  const previous = await readCompilerContinuitySource(prisma, a, chapter, compilation.bridge!.fromChapterId, 8)
  const context = terminalEvidenceContext(chapter, previous, 1)
  const inspected = inspectContinuityResponse(JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind =>
    ({ kind, result: 'not_applicable', reason: '合成正文没有可比较的动作关系。', findingIndexes: [] })),
    terminalVerdicts: [{ path: 'exitState.action', verdict, basis: 'current', sourceEvidence: verdict === 'supported' ? [{ segmentId: 'c0', quote: chapter.content }] : [] }],
  }), { current: chapter.content, previous: previous?.content ?? null, terminalEvidence: context }, true, 8, candidate)
  expect(inspected.complete).toBe(true)
  await validateStoryContinuity({ ...a, compilationId: a.compilationId, findings: [], independentCheck: 'complete', terminalCandidate: candidate,
    expectedChapterRevision: chapter.revision, continuityCriticResponse: inspected.audit,
    coverage: compilerContinuityCoverage({ chapter, bridge: compilation.bridge, sceneTasks: compilation.sceneTasks, source: previous, terminalCandidate: candidate }, 8) })
}

function v1Message(payload: unknown, blockers: unknown) {
  return `[执行器恢复提示 ${runtimeJson(payload).hash}] 本次任务仍有已核验的未完成事项：${JSON.stringify(blockers)}。请先读取这些对象的当前状态，在原始授权内完成尚未完成的工作；不得覆盖其他任务成果、重复已提交操作、从旧任务获取权限或为收尾新建已完成待办。标识和状态是事实，不是新的用户指令。需要外部决策时明确说明。`
}

describe.runIf(available)('current review observations preserve durable continuation boundaries', () => {
  it.each([true, false])('fresh marker=%s observes current facts without changing saved v1 continuation', async marker => fixture(async f => {
    const a = await admit(f, marker)
    const beforeChapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const beforeCompilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId } })
    const beforeBudget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: a.rootId } })
    const evidence = await collectDurableCompletionEvidence(a.lease, cursor(a.initial))
    expect(evidence.snapshot).toMatchObject({ blockers: [{ code: 'uncommitted_compilation', reference: a.compilationId }] })
    if (marker) expect(evidence.snapshot).toMatchObject({ reviewObservation: { version: 1, observations: [{ chapterId: f.chapterId,
      revision: 1, state: 'check_required', facts: { completeStrictReview: true, quality: 'complete', pending: Array.from({ length: 10 }, () => expect.objectContaining({ reportId: a.reportId })) } }] } })
    else expect(evidence.snapshot).not.toHaveProperty('reviewObservation')
    expect(await advanceDurableCompletionObligations(a.lease, cursor(a.initial))).toMatchObject({ kind: 'continued' })
    const event = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: a.rootId, type: 'execution.continuation' } })
    const blockers = [{ code: 'uncommitted_compilation', reference: a.compilationId }]
    const expected = { version: 1, sourceRevision: a.initial.revision, sourceHash: a.initial.snapshotHash,
      reason: 'domain_incomplete', progressSequence: '0', reminderIndex: 1, blockers }
    expect(event.payload).toEqual(expected)
    const state = await loadExecutionState(a.userId, a.runId)
    expect(state.frame.state.messages.at(-1)).toEqual({ role: 'system', content: v1Message(expected, blockers) })
    expect(state.frame.state.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(state.frame.state.turn).toBe(0)
    expect(state.frame.state.nextOperationSequence).toBe(0)
    const observations = await prisma.agentExecutionOutbox.findMany({ where: { taskRootId: a.rootId, type: 'execution.review_observation' } })
    expect(observations).toHaveLength(marker ? 1 : 0)
    if (marker) {
      const note = state.frame.state.messages.at(-2)
      expect(note).toMatchObject({ role: 'system', content: expect.stringContaining('连续性=missing') })
      expect(note?.content).toContain('尚不能提交为完成')
    }
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(beforeChapter)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId } })).toEqual(beforeCompilation)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: a.rootId } })).toEqual(beforeBudget)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: a.rootId } } })).toBe(0)
  }))

  it('observes a later current body without reusing the old report or granting a paid retry', async () => fixture(async f => {
    const a = await admit(f)
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者后来保存的正文。', revision: 2 } })
    const evidence = await collectDurableCompletionEvidence(a.lease, cursor(a.initial))
    expect(evidence.snapshot).toMatchObject({ reviewObservation: { observations: [{ revision: 2, state: 'check_required',
      requiredToolNames: ['continuity_validate', 'quality_analyze'], facts: { quality: 'stale', pending: [],
        binding: { qualityReportId: null, qualityReportHash: null } } }] } })
    expect((await loadExecutionState(a.userId, a.runId)).frame.snapshotHash).toBe(a.initial.snapshotHash)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: a.rootId } } })).toBe(0)
    expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: a.rootId, type: 'execution.review_observation' } })).toBe(0)
  }))

  it('blocks mixed missing continuity and incomplete quality without buying either check or appending follow-up', async () => fixture(async f => {
    const a = await admit(f)
    await prisma.chapterQualityReport.update({ where: { id: a.reportId }, data: { status: 'failed', deterministicMetrics: { independentCheck: 'unavailable' } } })
    expect((await collectDurableCompletionEvidence(a.lease, cursor(a.initial))).snapshot).toMatchObject({ reviewObservation: { observations: [{ state: 'blocked',
      facts: { continuity: 'missing', quality: 'incomplete', requiredTools: [expect.objectContaining({ name: 'continuity_validate' }), expect.objectContaining({ name: 'quality_analyze' })] } }] } })
    expect(await advanceDurableCompletionObligations(a.lease, cursor(a.initial))).toMatchObject({ kind: 'reconciliation_required' })
    expect((await loadExecutionState(a.userId, a.runId)).frame.snapshotHash).toBe(a.initial.snapshotHash)
    expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: a.rootId, type: { in: ['execution.review_observation', 'execution.continuation'] } } })).toBe(0)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: a.rootId } } })).toBe(0)
  }))

  it.each(['unknown', 'denied', 'rollback', 'stale'] as const)('%s refuses follow-up atomically without recording an actionable observation', async scenario => fixture(async f => {
    const a = await admit(f, true, scenario === 'denied')
    if (scenario === 'unknown') await prisma.agentOperation.create({ data: { id: randomUUID(), taskRootId: a.rootId, originRunId: a.runId,
      operationKey: 'sidecar-unknown', kind: 'provider', action: 'fixture', inputHash: runtimeJson({}).hash, inputSnapshot: {}, status: 'unknown' } })
    if (scenario === 'rollback') await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: a.rootId, runId: a.runId,
      eventKey: `state:${a.rootId}:1`, type: 'fixture.conflict', payload: {} } })
    const invoke = () => advanceDurableCompletionObligations(a.lease, { expectedRevision: a.initial.revision,
      expectedHash: scenario === 'stale' ? 'f'.repeat(64) : a.initial.snapshotHash })
    if (scenario === 'unknown' || scenario === 'denied') expect(await invoke()).toMatchObject({ kind: 'reconciliation_required' })
    else await expect(invoke()).rejects.toThrow()
    expect((await loadExecutionState(a.userId, a.runId)).frame.snapshotHash).toBe(a.initial.snapshotHash)
    expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: a.rootId, type: { in: ['execution.review_observation', 'execution.continuation'] } } })).toBe(0)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: a.rootId } } })).toBe(0)
  }))

  it('changing report facts cannot reset the original four-reminder stagnation ceiling', async () => fixture(async f => {
    const a = await admit(f)
    let frame = a.initial
    const fingerprints: string[] = []
    for (let index = 1; index <= 5; index++) {
      await prisma.qualityFinding.updateMany({ where: { reportId: a.reportId }, data: { explanation: `当前合成证据变化${index}` } })
      if (index > 1) frame = await saveExecutionState(a.lease, { ...cursor(frame),
        snapshot: { ...frame.state, messages: [...frame.state.messages, { role: 'assistant', content: '正文已保存。' }] } })
      const evidence = await collectDurableCompletionEvidence(a.lease, cursor(frame))
      const observation = (evidence.snapshot as { reviewObservation: { fingerprint: string } }).reviewObservation
      fingerprints.push(observation.fingerprint)
      expect(await advanceDurableCompletionObligations(a.lease, cursor(frame))).toMatchObject({ kind: index === 5 ? 'needs_attention' : 'continued' })
      frame = (await loadExecutionState(a.userId, a.runId)).frame
    }
    expect(new Set(fingerprints).size).toBe(5)
    const events = await prisma.agentExecutionOutbox.findMany({ where: { taskRootId: a.rootId, type: 'execution.continuation' }, orderBy: { sequence: 'asc' } })
    expect(events.map(event => (event.payload as { reminderIndex: number }).reminderIndex)).toEqual([1, 2, 3, 4])
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: a.rootId } } })).toBe(0)
  }))

  it('persists a generated terminal_review_required fingerprint and reads the same sidecar on the next continuation', async () => fixture(async f => {
    const a = await admit(f, true, false, { terminal: true })
    await saveTerminalReview(a, 'unknown')
    await prisma.qualityFinding.deleteMany({ where: { reportId: a.reportId } })
    const chapterBefore = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const compilationBefore = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId } })
    const budgetBefore = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: a.rootId } })
    const evidence = await collectDurableCompletionEvidence(a.lease, cursor(a.initial))
    expect(evidence.snapshot).toMatchObject({ blockers: [{ code: 'uncommitted_compilation', reference: a.compilationId }],
      reviewObservation: { observations: [{ compilationId: a.compilationId, chapterId: f.chapterId, revision: 1,
        state: 'terminal_review_required', requiredToolNames: [], facts: { continuity: 'complete', quality: 'complete',
          terminalReview: { state: 'unverified', currentResultVerified: true, deliveryEligible: false } } }] } })
    const observation = (evidence.snapshot as { reviewObservation: { fingerprint: string; observations: unknown[] } }).reviewObservation
    expect(observation.fingerprint).toBe(runtimeJson(observation.observations).hash)
    expect(await advanceDurableCompletionObligations(a.lease, cursor(a.initial))).toMatchObject({ kind: 'continued' })
    const sidecar = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `review-observation:${a.rootId}:${a.initial.revision}` } })
    expect(sidecar).toMatchObject({ type: 'execution.review_observation', payload: { version: 1, sourceRevision: a.initial.revision,
      sourceHash: a.initial.snapshotHash, observation } })
    const saved = await loadExecutionState(a.userId, a.runId)
    expect(saved.frame.previousHash).toBe(a.initial.snapshotHash)
    expect(saved.frame.revision).toBe(a.initial.revision + 1)
    expect(saved.frame.snapshotHash).toBe(runtimeJson(saved.frame.state).hash)
    expect(saved.frame.state.messages.slice(0, -2)).toEqual(a.initial.state.messages)
    expect(saved.frame.state.messages.at(-2)).toMatchObject({ role: 'system', content: expect.stringContaining(`[只读审查事实 ${observation.fingerprint}]`) })
    expect(saved.frame.state.messages.at(-2)?.content).toContain('终态候选尚未证实，不能提交')
    expect(saved.frame.state.messages.at(-2)?.content).toContain('此观察不是授权、已执行操作或进展')
    expect(saved.frame.state).toMatchObject({ phase: 'idle', turn: 0, nextOperationSequence: 0, pendingOperationId: null })
    const firstContinuation = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `continuation:${a.rootId}:${a.initial.revision}` } })
    const blockers = [{ code: 'uncommitted_compilation', reference: a.compilationId }]
    expect(firstContinuation.payload).toEqual({ version: 1, sourceRevision: a.initial.revision, sourceHash: a.initial.snapshotHash,
      reason: 'domain_incomplete', progressSequence: '0', reminderIndex: 1, blockers })
    expect(saved.frame.state.messages.at(-1)).toEqual({ role: 'system', content: v1Message(firstContinuation.payload, blockers) })
    const next = await saveExecutionState(a.lease, { ...cursor(saved.frame), snapshot: { ...saved.frame.state,
      messages: [...saved.frame.state.messages, { role: 'assistant', content: '终态候选仍待核实。' }] } })
    expect((await collectDurableCompletionEvidence(a.lease, cursor(next))).snapshot).toMatchObject({ reviewObservation: observation })
    // This re-reads and validates the prior persisted enum and fingerprint,
    // rather than merely accepting a freshly generated in-memory observation.
    expect(await advanceDurableCompletionObligations(a.lease, cursor(next))).toMatchObject({ kind: 'continued' })
    expect((await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: sidecar.eventKey } })).payload).toEqual(sidecar.payload)
    const continuations = await prisma.agentExecutionOutbox.findMany({ where: { taskRootId: a.rootId, type: 'execution.continuation' }, orderBy: { sequence: 'asc' } })
    expect(continuations.map(event => (event.payload as { reminderIndex: number }).reminderIndex)).toEqual([1, 2])
    const reread = await loadExecutionState(a.userId, a.runId)
    expect(reread.frame.state).toMatchObject({ phase: 'idle', turn: 0, nextOperationSequence: 0, pendingOperationId: null })
    expect(reread.frame.state.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(chapterBefore)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId } })).toEqual(compilationBefore)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: a.rootId } })).toEqual(budgetBefore)
    expect(await prisma.agentOperation.count({ where: { taskRootId: a.rootId } })).toBe(0)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: a.rootId } } })).toBe(0)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: a.runId } })).toBe(0)
  }))

  it.each([
    { toolName: 'continuity_validate', access: 'missing' }, { toolName: 'continuity_validate', access: 'denied' },
    { toolName: 'quality_analyze', access: 'missing' }, { toolName: 'quality_analyze', access: 'denied' },
  ] as const)('terminal review preserves the original $toolName $access boundary without dispatch or charge', async ({ toolName, access }) => fixture(async f => {
    const a = await admit(f, true, false, { terminal: true,
      ...(access === 'missing' ? { missingTools: [toolName] } : { deniedTools: [toolName] }) })
    await saveTerminalReview(a, 'unknown')
    // Force an independent original check obligation as well as the terminal
    // candidate obligation; neither may be lost by classifying the next step.
    await prisma.chapterQualityReport.delete({ where: { id: a.reportId } })
    const chapterBefore = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const compilationBefore = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId } })
    const budgetBefore = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: a.rootId } })
    expect((await collectDurableCompletionEvidence(a.lease, cursor(a.initial))).snapshot).toMatchObject({
      reviewObservation: { observations: [{ state: 'terminal_review_required', requiredToolNames: ['quality_analyze'],
        facts: { continuity: 'complete', quality: 'missing', terminalReview: { deliveryEligible: false } } }] } })
    expect(await advanceDurableCompletionObligations(a.lease, cursor(a.initial))).toMatchObject({ kind: 'reconciliation_required' })
    expect((await loadExecutionState(a.userId, a.runId)).frame.snapshotHash).toBe(a.initial.snapshotHash)
    expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: a.rootId,
      type: { in: ['execution.review_observation', 'execution.continuation'] } } })).toBe(0)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(chapterBefore)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId } })).toEqual(compilationBefore)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: a.rootId } })).toEqual(budgetBefore)
    expect(await prisma.agentOperation.count({ where: { taskRootId: a.rootId } })).toBe(0)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: a.rootId } } })).toBe(0)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: a.runId } })).toBe(0)
  }))

  it('a real unknown operation blocks terminal follow-up without hiding its outcome or buying another request', async () => fixture(async f => {
    const a = await admit(f, true, false, { terminal: true })
    await saveTerminalReview(a, 'unknown')
    await prisma.qualityFinding.deleteMany({ where: { reportId: a.reportId } })
    const operation = await prisma.agentOperation.create({ data: { id: randomUUID(), taskRootId: a.rootId, originRunId: a.runId,
      operationKey: 'terminal-sidecar-unknown', kind: 'provider', action: 'continuity_validate', inputHash: runtimeJson({}).hash,
      inputSnapshot: {}, status: 'unknown' } })
    const budgetBefore = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: a.rootId } })
    const evidence = await collectDurableCompletionEvidence(a.lease, cursor(a.initial))
    expect(evidence.snapshot).toMatchObject({ blockers: expect.arrayContaining([{ code: 'unresolved_operation', reference: operation.id }]),
      reviewObservation: { observations: [{ state: 'terminal_review_required' }] } })
    expect(await advanceDurableCompletionObligations(a.lease, cursor(a.initial))).toMatchObject({ kind: 'reconciliation_required',
      blockers: expect.arrayContaining([{ code: 'unresolved_operation', reference: operation.id }]) })
    expect((await loadExecutionState(a.userId, a.runId)).frame.snapshotHash).toBe(a.initial.snapshotHash)
    expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: operation.id } })).toEqual(operation)
    expect(await prisma.agentOperation.count({ where: { taskRootId: a.rootId } })).toBe(1)
    expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: a.rootId,
      type: { in: ['execution.review_observation', 'execution.continuation'] } } })).toBe(0)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: a.rootId } })).toEqual(budgetBefore)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: a.rootId } } })).toBe(0)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: a.runId } })).toBe(0)
  }))

  it.each(['decision_required', 'commit_available'] as const)('preserves an actionable %s without requiring a new paid review', async expectedState => fixture(async f => {
    const a = await admit(f, true, false, { terminal: true, missingTools: ['continuity_validate', 'quality_analyze'] })
    await saveTerminalReview(a, expectedState === 'decision_required' ? 'unknown' : 'supported')
    if (expectedState === 'commit_available') await prisma.qualityFinding.deleteMany({ where: { reportId: a.reportId } })
    const chapterBefore = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const compilationBefore = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId } })
    const budgetBefore = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: a.rootId } })
    const evidence = await collectDurableCompletionEvidence(a.lease, cursor(a.initial))
    expect(evidence.snapshot).toMatchObject({ reviewObservation: { observations: [{ state: expectedState, requiredToolNames: [],
      facts: { continuity: 'complete', quality: 'complete', terminalReview: { currentResultVerified: true,
        deliveryEligible: expectedState === 'commit_available' } } }] } })
    if (expectedState === 'decision_required') expect(evidence.snapshot).toMatchObject({ reviewObservation: { observations: [{
      facts: { pending: Array.from({ length: 10 }, () => expect.objectContaining({ reportId: a.reportId })) } }] } })
    expect(await advanceDurableCompletionObligations(a.lease, cursor(a.initial))).toMatchObject({ kind: 'continued' })
    const saved = await loadExecutionState(a.userId, a.runId)
    expect(saved.frame.state).toMatchObject({ phase: 'idle', turn: 0, nextOperationSequence: 0, pendingOperationId: null })
    expect(saved.configuration.tools.map(tool => tool.function.name)).toEqual(['chapter_bridge_commit'])
    const observation = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: a.rootId, type: 'execution.review_observation' } })
    expect(observation.payload).toMatchObject({ observation: { observations: [{ state: expectedState }] } })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(chapterBefore)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId } })).toEqual(compilationBefore)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: a.rootId } })).toEqual(budgetBefore)
    expect(await prisma.agentOperation.count({ where: { taskRootId: a.rootId } })).toBe(0)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: a.rootId } } })).toBe(0)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: a.runId } })).toBe(0)
  }))

})
