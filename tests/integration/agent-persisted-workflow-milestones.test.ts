import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { taskSpecSchema, sceneTaskInputSchema } from '../../shared/contracts/index.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { freezeWritingScope } from '../../api/lib/agent/writing-scope.js'
import { prepareStoryCompilation, readPersistedWritingWorkflowMilestones, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { observeWritingWorkflowMilestone, nextStagnantBatch } from '../../api/lib/agent/semantic-progress.js'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'

const json = (value: unknown) => runtimeJson(JSON.parse(JSON.stringify(value))).value
const tasks = [sceneTaskInputSchema.parse({ purpose: '寻找线索', entryState: {}, goal: '开门', obstacle: '门锁', choice: '绕路', cost: '时间', turn: '发现脚印', exitState: {}, styleBudget: {} })]
async function legacy(work: (f: { userId: string; novelId: string; sessionId: string; runId: string; taskSpec: ReturnType<typeof taskSpecSchema.parse>; compilationId: string }) => Promise<void>) {
  await fixture(async base => {
    const session = await prisma.agentSession.create({ data: { userId: base.userId, novelId: base.novelId, title: '旧版原始任务' } })
    const runId = randomUUID(), prompt = '写下一章'
    const spec = buildTaskSpec({ ...base, runId, prompt })
    await prisma.agentRun.create({ data: { id: runId, userId: base.userId, novelId: base.novelId, sessionId: session.id, chapterId: base.chapterId,
      runtimeProtocolVersion: 0, status: 'running', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop',
      taskSpec: json(spec), startRequest: { prompt }, usage: { totalTokens: 524051, checkpoint: { stagnantBatches: 6, progressSignatures: [] } } } })
    const frozen = await prisma.$transaction(tx => freezeWritingScope(tx, { ...base, runId }, spec, prompt))
    await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: json(frozen) } })
    const prepared = await prepareStoryCompilation({ ...base, runId, chapterId: undefined, mode: 'premium', intentSummary: prompt })
    await work({ userId: base.userId, novelId: base.novelId, sessionId: session.id, runId, taskSpec: taskSpecSchema.parse(frozen), compilationId: prepared.compilation.id })
  })
}

describe.runIf(available)('legacy saved workflow compatibility, never a fresh resume allowance', () => {
  it('recovers old marker-free PREPARE read-only and consumes one stable signature before a later read', async () => legacy(async f => {
    const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilationId } })
    const markers = await readPersistedWritingWorkflowMilestones(f)
    expect(markers).toEqual([{ version: 1, userId: f.userId, novelId: f.novelId, runId: f.runId, targetOrderIndex: 2, phase: 'prepare' }])
    const seen = new Set<string>()
    expect(observeWritingWorkflowMilestone(seen, 'story_compiler_prepare', markers[0], f)).toBe(true)
    expect(nextStagnantBatch(6, true)).toBe(0)
    expect(observeWritingWorkflowMilestone(seen, 'story_compiler_prepare', (await readPersistedWritingWorkflowMilestones(f))[0], f)).toBe(false)
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).toEqual(before)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilationId } })).toEqual(compilation)
  }), 15000)
  it('a validated main-run continuation reuses both saved phases without buying another credit on restart', async () => legacy(async f => {
    await saveSceneTasks({ ...f, compilationId: f.compilationId, tasks })
    const old = await readPersistedWritingWorkflowMilestones(f), seen = new Set<string>()
    for (const marker of old) expect(observeWritingWorkflowMilestone(seen, marker.phase === 'prepare' ? 'story_compiler_prepare' : 'scene_task_build', marker, f)).toBe(true)
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'failed' } })
    const runId = randomUUID(), taskSpec = taskSpecSchema.parse({ ...f.taskSpec, runId })
    await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, runtimeProtocolVersion: 0,
      status: 'running', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: json(taskSpec), startRequest: { prompt: '写下一章' } } })
    const resumed = { ...f, runId, taskSpec }
    const markers = await readPersistedWritingWorkflowMilestones(resumed)
    expect(markers.map(marker => marker.phase)).toEqual(['prepare', 'scenes'])
    expect(markers.every(marker => marker.runId === runId)).toBe(true)
    for (const marker of markers) expect(observeWritingWorkflowMilestone(seen, marker.phase === 'prepare' ? 'story_compiler_prepare' : 'scene_task_build', marker, resumed)).toBe(false)
  }), 15000)
  it.each(['user', 'novel', 'contract', 'target', 'abandoned', 'bridge', 'binding', 'paused', 'spawned', 'native'] as const)('%s mismatch cannot mint legacy workflow credit', async scenario => legacy(async f => {
    const input = { ...f }
    if (scenario === 'user') input.userId = randomUUID()
    if (scenario === 'novel') input.novelId = randomUUID()
    if (scenario === 'contract') input.taskSpec = taskSpecSchema.parse({ ...f.taskSpec, goals: ['修改原章节'] })
    if (scenario === 'target') await prisma.storyCompilation.update({ where: { id: f.compilationId }, data: { targetOrderIndex: 3 } })
    if (scenario === 'abandoned') await prisma.storyCompilation.update({ where: { id: f.compilationId }, data: { status: 'abandoned' } })
    if (scenario === 'bridge') await prisma.chapterBridge.update({ where: { compilationId: f.compilationId }, data: { targetOrderIndex: 3 } })
    if (scenario === 'binding') {
      const chapter = await prisma.chapter.findFirstOrThrow({ where: { novelId: f.novelId } })
      await prisma.storyCompilation.update({ where: { id: f.compilationId }, data: { chapterId: chapter.id } })
      await prisma.chapterBridge.update({ where: { compilationId: f.compilationId }, data: { toChapterId: chapter.id } })
    }
    if (scenario === 'paused') await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused' } })
    if (scenario === 'spawned') await prisma.agentSession.update({ where: { id: f.sessionId }, data: { spawnedFromSessionId: f.sessionId, spawnedFromRunId: f.runId } })
    if (scenario === 'native') await prisma.agentRun.update({ where: { id: f.runId }, data: { runtimeProtocolVersion: 1 } })
    expect(await readPersistedWritingWorkflowMilestones(input)).toEqual([])
  }), 15000)
  it('same session/task-id strings cannot import another full contract or a child compilation', async () => legacy(async f => {
    const childSession = await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '历史子任务',
      spawnedFromSessionId: f.sessionId, spawnedFromRunId: f.runId } })
    const childId = randomUUID()
    await prisma.agentRun.create({ data: { id: childId, userId: f.userId, novelId: f.novelId, sessionId: childSession.id,
      runtimeProtocolVersion: 0, status: 'failed', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop',
      taskSpec: json({ ...f.taskSpec, runId: childId }), startRequest: { prompt: '写下一章' } } })
    await prisma.storyCompilation.update({ where: { id: f.compilationId }, data: { runId: childId } })
    expect(await readPersistedWritingWorkflowMilestones(f)).toEqual([])
    await prisma.storyCompilation.update({ where: { id: f.compilationId }, data: { runId: f.runId } })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskSpec: json({ ...f.taskSpec, goals: ['完全不同的原合同'] }) } })
    expect(await readPersistedWritingWorkflowMilestones(f)).toEqual([])
  }), 15000)
})
