import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
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
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { persistCurrentContinuityReport } from '../support/current-continuity-report.js'
import { chapterBridgeCommitTool, continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'

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
  // Frozen parser output remains readable history, not a current delivery gate.
  await prisma.agentArtifact.create({ data: { id: randomUUID(), runId: a.runId, artifactType: 'continuityReview',
    title: '合成历史终态回执', content: JSON.stringify(inspected.audit), metadata: json({ candidate, audit: inspected.audit }) } })
  await persistCurrentContinuityReport({ ...a, compilationId: a.compilationId, expectedChapterRevision: chapter.revision })
}

const facts = (a: Awaited<ReturnType<typeof admit>>) => prisma.$transaction(tx => readChapterReviewReadiness(tx, a, a.compilationId))

// Reports remain available through their real read projection. They no longer
// turn an optional compiler record into an executor-owned paid workflow.
describe.runIf(available)('ordinary completion keeps current reports advisory', () => {
  it.each([true, false])('marker=%s preserves current facts without a compilation completion gate', marker => fixture(async f => {
    const a = await admit(f, marker)
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId } })
    const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: a.rootId } })
    expect(await facts(a)).toMatchObject({ ready: false, continuity: 'missing', quality: 'complete' })
    expect((await collectDurableCompletionEvidence(a.lease, cursor(a.initial))).snapshot).toMatchObject({ blockers: [] })
    expect(await advanceDurableCompletionObligations(a.lease, cursor(a.initial))).toBeNull()
    expect((await loadExecutionState(a.userId, a.runId)).frame.snapshotHash).toBe(a.initial.snapshotHash)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId } })).toEqual(before)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: a.rootId } })).toEqual(budget)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: a.rootId } } })).toBe(0)
    expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: a.rootId, type: 'execution.continuation' } })).toBe(0)
  }))

  it.each(['changed-body', 'incomplete'] as const)('%s report stays truthful without requesting another check', scenario => fixture(async f => {
    const a = await admit(f)
    if (scenario === 'changed-body') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者后来保存的正文。', revision: 2 } })
    else await prisma.chapterQualityReport.update({ where: { id: a.reportId }, data: { status: 'failed', deterministicMetrics: { independentCheck: 'unavailable' } } })
    expect(await facts(a)).toMatchObject({ ready: false, continuity: 'missing', quality: scenario === 'changed-body' ? 'stale' : 'incomplete' })
    expect((await collectDurableCompletionEvidence(a.lease, cursor(a.initial))).snapshot).toMatchObject({ blockers: [] })
    expect(await advanceDurableCompletionObligations(a.lease, cursor(a.initial))).toBeNull()
    expect((await loadExecutionState(a.userId, a.runId)).frame.snapshotHash).toBe(a.initial.snapshotHash)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: a.rootId } } })).toBe(0)
  }))

  it.each(['unknown', 'denied', 'existing-event', 'stale'] as const)('%s preserves actual reconciliation and cursor boundaries', scenario => fixture(async f => {
    const a = await admit(f, true, scenario === 'denied')
    if (scenario === 'unknown') await prisma.agentOperation.create({ data: { id: randomUUID(), taskRootId: a.rootId, originRunId: a.runId,
      operationKey: 'sidecar-unknown', kind: 'provider', action: 'fixture', inputHash: runtimeJson({}).hash, inputSnapshot: {}, status: 'unknown' } })
    if (scenario === 'existing-event') await prisma.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: a.rootId, runId: a.runId,
      eventKey: 'existing-fixture-event:' + a.rootId, type: 'fixture.conflict', payload: {} } })
    const invoke = () => advanceDurableCompletionObligations(a.lease, { expectedRevision: a.initial.revision,
      expectedHash: scenario === 'stale' ? 'f'.repeat(64) : a.initial.snapshotHash })
    if (scenario === 'unknown') expect(await invoke()).toMatchObject({ kind: 'reconciliation_required', blockers: [expect.objectContaining({ code: 'unresolved_operation' })] })
    else if (scenario === 'stale') await expect(invoke()).rejects.toMatchObject({ code: 'RUNTIME_STATE_CONFLICT' })
    else expect(await invoke()).toBeNull()
    expect((await loadExecutionState(a.userId, a.runId)).frame.snapshotHash).toBe(a.initial.snapshotHash)
    expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: a.rootId, type: { in: ['execution.review_observation', 'execution.continuation'] } } })).toBe(0)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: a.rootId } } })).toBe(0)
  }))

  it('reads five changed opinions without treating them as mandatory model work', () => fixture(async f => {
    const a = await admit(f)
    let frame = a.initial
    const fingerprints: string[] = []
    for (let index = 1; index <= 5; index++) {
      await prisma.qualityFinding.updateMany({ where: { reportId: a.reportId }, data: { explanation: '当前合成证据变化' + index } })
      if (index > 1) frame = await saveExecutionState(a.lease, { ...cursor(frame), snapshot: { ...frame.state,
        messages: [...frame.state.messages, { role: 'assistant', content: '正文已保存。' }] } })
      const current = await facts(a)
      expect(current!.decisionDetails!.some(item => item.explanation === '当前合成证据变化' + index)).toBe(true)
      fingerprints.push(runtimeJson(current!.decisionDetails).hash)
      expect(await advanceDurableCompletionObligations(a.lease, cursor(frame))).toBeNull()
    }
    expect(new Set(fingerprints).size).toBe(5)
    expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: a.rootId, type: 'execution.continuation' } })).toBe(0)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: a.rootId } } })).toBe(0)
  }))

  it('preserves current completed reports and historical unknown verdicts independently', () => fixture(async f => {
    const a = await admit(f, true, false, { terminal: true })
    await saveTerminalReview(a, 'unknown')
    await prisma.qualityFinding.deleteMany({ where: { reportId: a.reportId } })
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId } })
    const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: a.rootId } })
    expect(await facts(a)).toMatchObject({ ready: true, quality: 'complete', continuity: 'complete', terminalCommitted: false })
    expect(await advanceDurableCompletionObligations(a.lease, cursor(a.initial))).toBeNull()
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId } })).toEqual(before)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: a.rootId } })).toEqual(budget)
    expect(await prisma.agentOperation.count({ where: { taskRootId: a.rootId } })).toBe(0)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: a.runId } })).toBe(0)
  }))

  it.each([
    { toolName: 'continuity_validate', access: 'missing' }, { toolName: 'continuity_validate', access: 'denied' },
    { toolName: 'quality_analyze', access: 'missing' }, { toolName: 'quality_analyze', access: 'denied' },
  ] as const)('$toolName $access never launches a report request during completion', ({ toolName, access }) => fixture(async f => {
    const a = await admit(f, true, false, { terminal: true,
      ...(access === 'missing' ? { missingTools: [toolName] } : { deniedTools: [toolName] }) })
    await saveTerminalReview(a, 'unknown')
    await prisma.chapterQualityReport.delete({ where: { id: a.reportId } })
    await prisma.storyCompilation.update({ where: { id: a.compilationId }, data: { validation: {} } })
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId } })
    expect(await facts(a)).toMatchObject({ ready: false, quality: 'missing', continuity: 'missing' })
    expect(await advanceDurableCompletionObligations(a.lease, cursor(a.initial))).toBeNull()
    expect((await loadExecutionState(a.userId, a.runId)).configuration.toolAuthority.find(grant => grant.name === toolName)?.permission).toBe(access === 'denied' ? 'deny' : undefined)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(chapter)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: a.compilationId } })).toEqual(compilation)
    expect(await prisma.agentOperation.count({ where: { taskRootId: a.rootId } })).toBe(0)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: a.runId } })).toBe(0)
  }))
})
