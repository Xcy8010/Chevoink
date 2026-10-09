import * as storyMemory from '../../api/lib/agent/story-memory.js'
import * as compiler from '../../api/lib/agent/story-compiler.js'
import { continuityDecisionBinding } from '../../api/lib/agent/chapter-review-guard.js'
import type { Prisma } from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { assertWritingTarget, freezeWritingScope, readWritingScope, readNewDraftRevision, readNewDraftWritingAuthority, readCompletedWritingDelivery } from '../../api/lib/agent/writing-scope.js'
import { chapterCreateTool, chapterWriteTool, chapterEditRangeTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { continuityValidateTool, storyCompilerPrepareTool, sceneTaskBuildTool, chapterBridgeCommitTool, chapterBridgeGetTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { normalizeToolInput } from '../../api/lib/agent/tools/input-validation.js'
import { originalToolParameterSchemas } from '../../api/lib/agent/tool-schema.js'
import { lockNovelActiveScope } from '../../api/lib/data/novel-write-lock.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { acquireRunLease } from '../../api/lib/agent/runtime-lease.js'
import { initializeExecutionState, saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { toOpenAITools } from '../../api/lib/agent/tools/registry.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { z } from 'zod'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { getCreatedChapter } from '../../api/lib/agent/baseline.js'
import * as volumeData from '../../api/lib/data/volume.js'
import { prepareStoryCompilation, validateStoryContinuity, commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { buildHumanityQualityContext, qualityReviewContextHash } from '../../api/lib/agent/humanity-quality.js'
import { observeChapterReviewProgress } from '../../api/lib/agent/semantic-progress.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(() => prisma.$disconnect())
async function fixture(prompt: string, work: (ctx: ToolContext) => Promise<void>) {
  const userId = randomUUID(), novelId = randomUUID(), volumeId = randomUUID(), sessionId = randomUUID(), runId = randomUUID()
  try {
  await prisma.user.create({ data: { id: userId, nickname: 'scope-isolated', passwordHash: 'test-only' } })
  await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '独立范围测试', slug: `scope-${novelId}`, summary: 'test-only' } })
  await prisma.volume.create({ data: { id: volumeId, novelId, title: '第一卷', orderIndex: 1 } })
  await prisma.agentSession.create({ data: { id: sessionId, userId, novelId, title: 'scope-isolated' } })
  await prisma.agentRun.create({ data: { id: runId, sessionId, userId, novelId, engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', startRequest: { prompt } } })
  const ctx: ToolContext = { userId, novelId, sessionId, runId, chapterId: null, callId: 'scope-create', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal }
  await work(ctx)
  } finally {
    await prisma.$transaction(async tx => {
      // Serialize teardown with derived memory writes for this synthetic novel.
      await lockNovelActiveScope(tx, novelId)
      await tx.memoryExtractionJob.deleteMany({ where: { novelId, novel: { authorId: userId } } })
      await tx.projectMemoryEntry.deleteMany({ where: { novelId, novel: { authorId: userId } } })
      await tx.agentRun.deleteMany({ where: { userId } })
      await tx.agentSession.deleteMany({ where: { userId } })
      await tx.chapter.deleteMany({ where: { authorId: userId } })
      await tx.novel.deleteMany({ where: { id: novelId, authorId: userId } })
      await tx.user.deleteMany({ where: { id: userId } })
    })
  }
}
describe.skipIf(!available)('atomic original chapter scope', () => {
  it.each(['legacy', 'durable-current', 'durable-previous-presentation'] as const)('recovers a mistaken source48 ID before preparing and writing frozen chapter49 via %s', mode => fixture('写下一章', async ctx => {
    const firstVolume = await prisma.volume.findFirstOrThrow({ where: { novelId: ctx.novelId, orderIndex: 1 } })
    const second = await prisma.volume.create({ data: { novelId: ctx.novelId, title: '雪压边墙', summary: '守堡主困局未收束，继续当前故事阶段', orderIndex: 2 } })
    const chapters = Array.from({ length: 48 }, (_, index) => ({ id: randomUUID(), authorId: ctx.userId, novelId: ctx.novelId,
      volumeId: index < 16 ? firstVolume.id : second.id, orderIndex: index + 1, orderInVolume: index < 16 ? index + 1 : index - 15,
      title: `原章${index + 1}`, content: index === 47 ? '两面的火头都在等他先动。天亮了。' : `已保存的原文${index + 1}。`, revision: index === 47 ? 6 : 1 }))
    await prisma.chapter.createMany({ data: chapters })
    ctx.chapterId = chapters[0].id // The editor is context; neither it nor source48 is the target.
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { chapterId: ctx.chapterId } })
    const prompt = '写下一章'
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, chapterId: ctx.chapterId, prompt }), prompt))
    expect(spec.scope.writing?.targets).toEqual([{ chapterId: null, orderIndex: 49 }])
    expect(spec.scope.writing?.tailVolume).toMatchObject({ previousChapterId: chapters[47].id, previousRevision: 6, targetOrderIndex: 49 })
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const original = await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' },
      select: { id: true, authorId: true, content: true, title: true, revision: true, volumeId: true, orderIndex: true, orderInVolume: true } })
    const decision = { kind: 'continue' as const, reason: '现有第二卷守堡主困局尚未收束，继续当前故事阶段，不能因章数切卷' }
    const badPrepare = { chapterId: chapters[47].id, targetOrderIndex: 49, intentSummary: '承接前章写新章', volumeDecision: decision }
    const goodPrepare = { targetOrderIndex: 49, intentSummary: '承接前章写新章', volumeDecision: decision }
    const tasks = [{ purpose: '推进守堡困局', entryState: {}, goal: '查明火头', obstacle: '消息未核实', choice: '先查守门人', cost: '等待', turn: '找到线索', exitState: {},
      styleBudget: { description: 'low' as const, dialogue: 'medium' as const, rhetoric: 'low' as const } }]
    const createArgs = { title: '第49章《风眼》', volumeOrder: '2', positionInVolume: '33' }
    let createdRevision = 0
    if (mode === 'legacy') {
      const rejected = await storyCompilerPrepareTool.execute(ctx, badPrepare)
      expect(rejected).toMatchObject({ outcome: 'failed', failureCode: 'INVALID_ARGUMENTS' })
      expect(rejected.output).toContain('本任务允许准备冻结的全书第 49 章')
      expect(rejected.output).toContain('已有第 48 章')
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
      await storyCompilerPrepareTool.execute(ctx, goodPrepare)
      await sceneTaskBuildTool.execute(ctx, { tasks })
      const normalized = chapterCreateTool.parameters.parse(normalizeToolInput(chapterCreateTool, createArgs))
      const created = await chapterCreateTool.execute(ctx, normalized)
      expect(created.observedState?.kind).toBe('chapter')
      createdRevision = created.observedState!.revision
      const chapterId = created.observedState!.id
      await chapterReadTool.execute(ctx, { chapterId })
      await chapterWriteTool.execute(ctx, { chapterId, content: '他沿墙根找到守门人，先核对了北面火头的消息。' })
    } else {
      await prisma.agentRun.update({ where: { id: ctx.runId }, data: { status: 'queued' } })
      const sourceMessageId = randomUUID()
      await prisma.agentMessage.create({ data: { id: sourceMessageId, sessionId: ctx.sessionId, runId: ctx.runId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
      const root = await initializeDurableTask({ userId: ctx.userId, runId: ctx.runId, sourceMessageId })
      const lease = await acquireRunLease({ userId: ctx.userId, runId: ctx.runId, ownerId: 'next-chapter-fixture', claimId: randomUUID() })
      const tools = [storyCompilerPrepareTool, sceneTaskBuildTool, chapterCreateTool, chapterReadTool, chapterWriteTool]
      const definitions = toOpenAITools(tools, spec.scope)
      if (mode === 'durable-previous-presentation') {
        const previous = originalToolParameterSchemas(storyCompilerPrepareTool, spec.scope).find(schema =>
          Object.prototype.hasOwnProperty.call(schema.properties, 'chapterId') && (schema.required as string[]).includes('volumeDecision'))!
        expect(previous).toBeDefined()
        definitions[0].function.parameters = previous
      }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: definitions, toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [], messages: [
          { role: 'user', content: prompt }, { role: 'assistant', content: null, toolCalls: [
            { id: 'mistaken-source', name: storyCompilerPrepareTool.name, arguments: JSON.stringify(badPrepare) },
            { id: 'prepare-new', name: storyCompilerPrepareTool.name, arguments: JSON.stringify(goodPrepare) },
            { id: 'scenes-new', name: sceneTaskBuildTool.name, arguments: JSON.stringify({ tasks }) },
            { id: 'create-new', name: chapterCreateTool.name, arguments: JSON.stringify(createArgs) },
          ] },
        ] } })
      const frozenBefore = (await loadExecutionState(ctx.userId, ctx.runId)).configuration
      const step = () => executeDurableToolStep(lease, new AbortController().signal)
      expect(await step()).toMatchObject({ kind: 'tool', result: { outcome: 'failed', failureCode: 'INVALID_ARGUMENTS' } })
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
      let createdId = ''
      for (let index = 0; index < 3; index++) {
        const result = await step()
        expect(result.kind).toBe('tool')
        if (result.kind === 'tool') {
          expect(result.result.outcome).toBeUndefined()
          if (index === 2) {
            createdRevision = result.result.observedState!.revision
            createdId = result.result.observedState!.id
          }
        }
      }
      expect(createdId).not.toBe('')
      const current = await loadExecutionState(ctx.userId, ctx.runId)
      // Simulate the next model reply using the genuine returned ID; never guess it in the creation batch.
      await saveExecutionState(lease, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash,
        snapshot: { ...current.frame.state, messages: [...current.frame.state.messages, { role: 'assistant', content: null, toolCalls: [
          { id: 'read-new', name: chapterReadTool.name, arguments: JSON.stringify({ chapterId: createdId }) },
          { id: 'write-new', name: chapterWriteTool.name, arguments: JSON.stringify({ chapterId: createdId, content: '他沿墙根找到守门人，先核对了北面火头的消息。' }) },
        ] }] } })
      for (let index = 0; index < 2; index++) {
        const result = await step()
        expect(result.kind).toBe('tool')
        if (result.kind === 'tool') expect(result.result.outcome, result.result.output).toBeUndefined()
      }
      const first = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: root.id, operationKey: 'exec:0' }, include: { effectReceipt: true } })
      expect(first.effectReceipt!.result).toMatchObject({ code: 'INVALID_ARGUMENTS', effectApplied: false })
      expect(runtimeJson(first.inputSnapshot).hash).toBe(first.inputHash)
      expect((await loadExecutionState(ctx.userId, ctx.runId)).configuration).toEqual(frozenBefore)
      expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: root.id } } })).toBe(0)
    }
    const created = await prisma.chapter.findFirstOrThrow({ where: { novelId: ctx.novelId, orderIndex: 49 } })
    expect(createdRevision).toBeGreaterThan(0)
    expect(created).toMatchObject({ authorId: ctx.userId, title: '风眼', content: '他沿墙根找到守门人，先核对了北面火头的消息。', volumeId: second.id, orderInVolume: 33, revision: createdRevision + 1 })
    expect(await prisma.volume.count({ where: { novelId: ctx.novelId } })).toBe(2)
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId, orderIndex: { lt: 49 } }, orderBy: { orderIndex: 'asc' },
      select: { id: true, authorId: true, content: true, title: true, revision: true, volumeId: true, orderIndex: true, orderInVolume: true } })).toEqual(original)
    expect((await readWritingScope(prisma, ctx)).writing?.targets).toEqual([{ chapterId: null, orderIndex: 49 }])
    expect((await readWritingScope(prisma, ctx)).bindings?.targets).toEqual([{ chapterId: created.id, orderIndex: 49 }])
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: ctx.runId } })).toBe(0)
  }))
  async function newDraftReview(ctx: ToolContext, prompt = '写第一章', content = '同一扇门已经锁上。随后他却说这扇门从未锁过。', durable = false) {
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt }), prompt))
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const lease = durable ? await (async () => {
      await prisma.agentRun.update({ where: { id: ctx.runId }, data: { status: 'queued' } })
      const sourceMessageId = randomUUID()
      await prisma.agentMessage.create({ data: { id: sourceMessageId, sessionId: ctx.sessionId, runId: ctx.runId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
      await initializeDurableTask({ userId: ctx.userId, runId: ctx.runId, sourceMessageId })
      return acquireRunLease({ userId: ctx.userId, runId: ctx.runId, ownerId: 'synthetic-repeat-writer', claimId: randomUUID() })
    })() : null
    const result = await chapterCreateTool.execute(ctx, { title: '合成事实检查章', content })
    const chapterId = result.observedState!.id
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })
    const prepared = await prepareStoryCompilation({ ...ctx, chapterId, mode: 'balanced', intentSummary: prompt })
    await prisma.chapterBridge.update({ where: { compilationId: prepared.compilation.id }, data: { targetRevision: chapter.revision } })
    await prisma.sceneTask.create({ data: { userId: ctx.userId, novelId: ctx.novelId, compilationId: prepared.compilation.id, chapterId,
      ordinal: 1, purpose: '确认门锁', entryState: {}, goal: '打开门', obstacle: '门锁', choice: '找钥匙', cost: '等待', turn: '找到钥匙', exitState: {}, styleBudget: {} } })
    const compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
    const validation = { checkRounds: 1, autoRepairRounds: 0, independentCheck: 'complete', checkedChapterId: chapterId, checkedRevision: chapter.revision,
      errorCount: 1, warningCount: 0, findings: [{ signal: 'object', severity: 'error', evidence: '同一门的原文「已经锁上」与「这扇门从未锁过」互斥', suggestion: '保留锁门事实' }],
      coverage: compilerContinuityCoverage({ chapter, bridge: compilation.bridge, sceneTasks: compilation.sceneTasks, source: null }) }
    await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { stage: 'check', validation: runtimeJson(validation).value } })
    const quality = await prisma.chapterQualityReport.create({ data: { userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId,
      compilationId: compilation.id, chapterId, chapterRevision: chapter.revision, status: 'passed',
      deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(chapter.content).digest('hex') } } })
    return { chapter, chapterId, compilation, spec, validation, quality, lease }
  }
  async function finalizationFixture(ctx: ToolContext, count = 2, prompt = '写第一章') {
    const f = await newDraftReview(ctx, prompt, '甲句。乙句。丙句。丁句。戊句。己句。庚句。辛句。壬句。癸句。')
    await prisma.storyCompilation.update({ where: { id: f.compilation.id }, data: { validation: runtimeJson({ ...f.validation, findings: [], errorCount: 0 }).value } })
    const findings = await Promise.all(Array.from({ length: count }, (_, i) => prisma.qualityFinding.create({ data: {
      reportId: f.quality.id, userId: ctx.userId, novelId: ctx.novelId, source: 'critic', signal: 'emotion_grounding', severity: 'advisory',
      startOffset: i * 3, endOffset: i * 3 + 2, evidenceExcerpt: f.chapter.content.slice(i * 3, i * 3 + 2),
      evidenceHash: createHash('sha256').update(f.chapter.content.slice(i * 3, i * 3 + 2)).digest('hex'), explanation: '审美建议', suggestion: '增加动作', confidence: 0.9,
    } })))
    const retainedFindings = findings.map(item => ({ source: 'quality' as const, reportId: f.quality.id, findingId: item.id, reason: '此处保留简短停顿，增加动作会改变人物声口。' }))
    const call = (retained: unknown) => chapterBridgeCommitTool.execute(ctx, chapterBridgeCommitTool.parameters.parse(normalizeToolInput(chapterBridgeCommitTool,
      { compilationId: f.compilation.id, retainedFindings: retained })))
    return { ...f, findings, retainedFindings, call }
  }
  it('accepts exact JSON-string decisions through the real tool schema and commits without manuscript or report mutation', () => fixture('写第一章', async ctx => {
    const f = await finalizationFixture(ctx, 10)
    const readiness = await readChapterReviewReadiness(prisma, ctx, f.compilation.id)
    expect(readiness?.requiredDecisions).toHaveLength(8)
    const get = await chapterBridgeGetTool.execute(ctx, { compilationId: f.compilation.id })
    expect(get.output).toContain(f.quality.id)
    expect(get.output).toContain(f.findings[0].id)
    const report = await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: f.quality.id }, include: { findings: true } })
    const input = f.retainedFindings.filter(item => readiness!.requiredDecisions!.some(required => required.findingId === item.findingId))
    expect((await f.call(JSON.stringify(input))).outcome).not.toBe('failed')
    expect((await f.call(input)).outcome).not.toBe('failed')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(f.chapter)
    expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: f.quality.id }, include: { findings: true } })).toEqual(report)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).toMatchObject({ status: 'completed', validation: { checkRounds: 1, autoRepairRounds: 0 } })
    expect(await prisma.aiUsageLog.count({ where: { novelId: ctx.novelId } })).toBe(0)
  }))
  it('holds finding feedback until the retained decision and terminal transaction have committed', () => fixture('写第一章', async ctx => {
    const f = await finalizationFixture(ctx)
    let release!: () => void, locked!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { locked = resolve })
    const realSave = storyMemory.saveStoryMemory
    const hook = vi.spyOn(storyMemory, 'saveStoryMemory').mockImplementation(async (...args) => { locked(); await held; return realSave(...args) })
    let feedback: Promise<unknown> | undefined
    const commit = f.call(f.retainedFindings)
    try {
      await reached
      let pidReady!: (pid: number) => void
      const pid = new Promise<number>(resolve => { pidReady = resolve })
      feedback = prisma.$transaction(async tx => {
        const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        pidReady(connection.pid)
        await tx.qualityFinding.update({ where: { id: f.findings[0].id }, data: { authorFeedback: 'accepted', feedbackReason: '作者新的明确反馈' } })
      })
      const backendPid = await pid
      let waiting = false
      for (let i = 0; i < 50 && !waiting; i++) {
        const state = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${backendPid}`
        waiting = state[0]?.waiting === true
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(waiting).toBe(true)
      release()
      expect((await commit).outcome).not.toBe('failed')
      await feedback
      expect(await readChapterReviewReadiness(prisma, ctx, f.compilation.id)).toMatchObject({ decisionPending: true })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(f.chapter)
    } finally { release(); await Promise.allSettled([commit, ...(feedback ? [feedback] : [])]); hook.mockRestore() }
  }))
  it('rereads feedback committed ahead of the finding lock and refuses an older retained binding', () => fixture('写第一章', async ctx => {
    const f = await finalizationFixture(ctx)
    await chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: f.chapter.content, retainedFindings: f.retainedFindings })
    let release!: () => void, updated!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { updated = resolve })
    const feedback = prisma.$transaction(async tx => {
      await tx.qualityFinding.update({ where: { id: f.findings[0].id }, data: { authorFeedback: 'accepted' } })
      updated(); await held
    })
    await reached
    const commit = f.call(undefined)
    release()
    await feedback
    expect(await commit).toMatchObject({ outcome: 'failed', failureCode: 'REVIEW_DECISION_REQUIRED' })
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).toMatchObject({ status: 'active' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(f.chapter)
  }))
  it('rejects real decisions from another owner and chapter without altering either compilation', () => fixture('写第一章', async ctx => {
    const f = await finalizationFixture(ctx)
    await fixture('写第一章', async other => {
      const foreign = await finalizationFixture(other)
      const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })
      expect(await f.call(foreign.retainedFindings)).toMatchObject({ outcome: 'failed', failureCode: 'REVIEW_DECISION_REQUIRED' })
      expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).toEqual(before)
      expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: foreign.compilation.id } })).toMatchObject({ status: 'active' })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: foreign.chapterId } })).toEqual(foreign.chapter)
    })
  }))
  it('rolls back exact retention and terminal writes together when story memory persistence fails', () => fixture('写第一章', async ctx => {
    const f = await finalizationFixture(ctx)
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id }, include: { bridge: true, sceneTasks: true } })
    const failure = vi.spyOn(storyMemory, 'saveStoryMemory').mockRejectedValueOnce(new Error('synthetic-memory-failure'))
    try {
      await expect(f.call(f.retainedFindings)).rejects.toThrow('synthetic-memory-failure')
      expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id }, include: { bridge: true, sceneTasks: true } })).toEqual(before)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(f.chapter)
    } finally { failure.mockRestore() }
  }))
  it.each(['partial', 'duplicate', 'swapped', 'stale', 'foreign-ref', 'body', 'hard-pass'] as const)('rejects %s decisions atomically without saving retention or terminal state', kind => fixture('写第一章', async ctx => {
    const prompt = kind === 'hard-pass' ? '写第一章，质量检查必须通过才能交付' : '写第一章'
    const f = await finalizationFixture(ctx, 2, prompt)
    let retained = f.retainedFindings
    if (kind === 'partial') retained = retained.slice(0, 1)
    if (kind === 'duplicate') retained = [retained[0], retained[0]]
    if (kind === 'swapped') retained = retained.map(item => ({ ...item, reportId: item.findingId, findingId: '0' }))
    if (kind === 'foreign-ref') retained = retained.map(item => ({ ...item, reportId: randomUUID() }))
    if (kind === 'hard-pass') await prisma.chapterQualityReport.update({ where: { id: f.quality.id }, data: { status: 'needs_repair' } })
    if (kind === 'stale') await prisma.chapterQualityReport.create({ data: { userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId,
      compilationId: f.compilation.id, chapterId: f.chapterId, chapterRevision: f.chapter.revision, status: 'passed', deterministicMetrics: f.quality.deterministicMetrics as Prisma.InputJsonValue,
      createdAt: new Date(Date.now() + 1000) } })
    if (kind === 'body') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: f.chapter.content + '新正文', revision: { increment: 1 } } })
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id }, include: { bridge: true, sceneTasks: true } })
    const result = await f.call(JSON.stringify(retained))
    expect(result.outcome).toBe('failed')
    expect(result.failureCode).toBe(kind === 'body' ? 'CONTINUITY_CHECK_REQUIRED' : 'REVIEW_DECISION_REQUIRED')
    if (kind !== 'body') expect(result.output).toContain('精确参数模板')
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id }, include: { bridge: true, sceneTasks: true } })).toEqual(before)
  }))
  it('recovers an opaque-ID typo and paragraph-format anchor while refusing stale critic evidence and preserving review counts', () => fixture('写第一章', async ctx => {
    const body = '天未亮。纸条右上一角有缺角。\n\n堡内老卫站着。老段仍被押。'
    const f = await newDraftReview(ctx, '写第一章', body)
    const original = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const missing = await chapterWriteTool.execute(ctx, { chapterId: f.chapterId + '-typo', content: body })
    expect(missing).toMatchObject({ outcome: 'failed', failureCode: 'CHAPTER_NOT_FOUND' })
    expect(missing.output).toContain(f.chapterId)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(original)
    const invalid = await chapterEditRangeTool.execute(ctx, { chapterId: f.chapterId, patches: [
      { oldText: '天未亮', newText: '天大亮后' }, { oldText: '完全不存在的旧话', newText: '猜测' }] })
    expect(invalid).toMatchObject({ outcome: 'failed', failureCode: 'CHAPTER_ANCHOR_CONFLICT' })
    expect(invalid.output).toContain('第 2 处')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(original)
    await chapterEditRangeTool.execute(ctx, { chapterId: f.chapterId, patches: [
      { oldText: '天未亮', newText: '天大亮后' },
      { oldText: '纸条右上一角有缺角。堡内老卫站着。', newText: '纸条右上一角有缺角。\n\n堡内老卫坐下。' }] })
    const revised = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    expect(revised).toMatchObject({ revision: original.revision + 1, content: '天大亮后。纸条右上一角有缺角。\n\n堡内老卫坐下。老段仍被押。' })
    const comp = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id }, include: { bridge: true, sceneTasks: true } })
    const coverage = compilerContinuityCoverage({ chapter: revised, bridge: comp.bridge, sceneTasks: comp.sceneTasks, source: null })
    const badReport = await validateStoryContinuity({ ...ctx, compilationId: comp.id, expectedChapterRevision: revised.revision,
      coverage, independentCheck: 'complete', findings: [{ signal: 'object', severity: 'error', evidence: '当前"纸条右下角有缺角"', suggestion: '改右上',
        sourceEvidence: [{ source: 'current', quote: '纸条右下角有缺角' }] }] })
    expect(badReport).toMatchObject({ independentCheck: 'unavailable', errorCount: 1, checkRounds: 1 })
    // A previously accepted cache cannot mask a stale prose quotation with one
    // valid structured quotation, or announce complete after local revalidation.
    await prisma.storyCompilation.update({ where: { id: comp.id }, data: { validation: {
      ...badReport, coverage, checkedChapterId: revised.id, checkedRevision: revised.revision, independentCheck: 'complete',
      findings: [{ signal: 'object', severity: 'error', evidence: '当前"纸条右下角有缺角"', suggestion: '改右上',
        sourceEvidence: [{ source: 'current', quote: '纸条右上一角有缺角' }] }],
    } } })
    const cached = await continuityValidateTool.execute(ctx, { compilationId: comp.id })
    expect(cached).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_EVIDENCE_UNLOCATED' })
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: comp.id } })).toMatchObject({ validation: {
      independentCheck: 'unavailable', unlocatedEvidenceCount: 1, checkRounds: 1,
    } })
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, ctx, comp.id))).toMatchObject({ ready: false, continuity: 'incomplete' })
    const input = { ...ctx, compilationId: comp.id, chapterSummary: '合成修订已保存', exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
      lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '天大亮后', endingStructure: '老段仍被押' }
    await expect(prisma.$transaction(tx => commitChapterBridge(input, tx))).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
    // Supply a completed synthetic independent check and matching quality report;
    // this fixture proves orchestration, not actual model review reliability.
    await validateStoryContinuity({ ...ctx, compilationId: comp.id, expectedChapterRevision: revised.revision, coverage, independentCheck: 'complete', findings: [] })
    await prisma.chapterQualityReport.create({ data: { userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, compilationId: comp.id,
      chapterId: f.chapterId, chapterRevision: revised.revision, status: 'passed', deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(revised.content).digest('hex') } } })
    await prisma.$transaction(tx => commitChapterBridge(input, tx))
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: comp.id } })).toMatchObject({ status: 'completed', validation: { checkRounds: 1 } })
    expect(await prisma.agentProviderAttempt.count({ where: { runId: ctx.runId } })).toBe(0)
  }))
  it.each(['legacy', 'durable'] as const)('%s permits range → range → write without paid checks per fragment and requires truthful final review', mode => fixture('写第一章', async ctx => {
    const f = await newDraftReview(ctx, '写第一章', '同一扇门已经锁上。随后他却说这扇门从未锁过。钥匙已经交出。随后他却说钥匙一直在手中。', mode === 'durable')
    const budget = f.lease ? await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.lease.taskRootId } }) : null
    const context = async (index: number): Promise<ToolContext> => ({ ...ctx, callId: `synthetic-edit-${index}`,
      toolAuthority: new Map(['chapter_write', 'chapter_edit_range'].map(name => [name, { permission: 'allow', alwaysConfirm: false, dangerous: false }])),
      ...(f.lease ? { durableContent: { lease: f.lease, operationKey: `manuscript-edit:${index}`, chapterId: f.chapterId,
        expectedRevision: (await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).revision } } : {}),
    })
    const finding = await prisma.qualityFinding.create({ data: { reportId: f.quality.id, userId: ctx.userId, novelId: ctx.novelId,
      source: 'critic', signal: 'emotion_grounding', severity: 'advisory', startOffset: 0, endOffset: 3, evidenceExcerpt: '同一扇',
      evidenceHash: createHash('sha256').update('同一扇').digest('hex'), explanation: '合成可留置建议', suggestion: '保留当前动作', confidence: 0.9 } })
    await expect(chapterWriteTool.execute(await context(10), { chapterId: f.chapterId, content: f.chapter.content + '不能写入。',
      retainedFindings: [{ source: 'quality', reportId: f.quality.id, findingId: '0', reason: '编号必须真实。' }] }))
      .rejects.toMatchObject({ code: 'REVIEW_MERGED_REVISION_REQUIRED' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(f.chapter)
    await chapterWriteTool.execute(await context(11), { chapterId: f.chapterId, content: f.chapter.content,
      retainedFindings: [{ source: 'quality', reportId: f.quality.id, findingId: finding.id, reason: '当前动作已清楚，保留作者声口。' }] })
    expect(readNewDraftRevision((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).validation)).toBeNull()
    await chapterEditRangeTool.execute(await context(1), { chapterId: f.chapterId, oldText: '这扇门从未锁过', newText: '这扇门已经锁上' })
    await expect(chapterWriteTool.execute(await context(12), { chapterId: f.chapterId, content: f.chapter.content,
      retainedFindings: [{ source: 'quality', reportId: f.quality.id, findingId: finding.id, reason: '旧报告不能绑定新版。' }] }))
      .rejects.toMatchObject({ code: 'REVIEW_MERGED_REVISION_REQUIRED' })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })
    const receipt = readNewDraftRevision(saved.validation)
    expect(receipt).toBeTruthy()
    await chapterEditRangeTool.execute(await context(2), { chapterId: f.chapterId, oldText: '钥匙一直在手中', newText: '钥匙已经交出' })
    const content = '同一扇门已经锁上。他用备用钥匙打开门，把交出的钥匙留给同伴。'
    await chapterWriteTool.execute(await context(3), { chapterId: f.chapterId, content })
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    expect(chapter).toMatchObject({ content, revision: f.chapter.revision + 3 })
    expect(readNewDraftRevision((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).validation)).toEqual(receipt)
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).validation).toMatchObject({ checkRounds: 1, autoRepairRounds: 0 })
    expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: f.quality.id } })).toEqual(f.quality)
    expect(await prisma.agentProviderAttempt.count({ where: { runId: ctx.runId } })).toBe(0)
    if (f.lease) expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.lease.taskRootId } })).toEqual(budget)
    const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, ctx, f.compilation.id))
    expect(readiness).toMatchObject({ ready: false, continuity: 'stale', quality: 'stale' })
    await expect(prisma.$transaction(tx => commitChapterBridge({ ...ctx, compilationId: f.compilation.id, chapterSummary: '合成摘要',
      exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }, lastUnfinishedAction: '',
      hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '停步' }, tx))).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
    const beforeNoop = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })
    await chapterWriteTool.execute(await context(4), { chapterId: f.chapterId, content })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(chapter)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).toEqual(beforeNoop)
  }))
  it('rejects an invalid batch without effects, then applies both exact patches in one CAS and permits a later write', () => fixture('写第一章', async ctx => {
    const f = await newDraftReview(ctx, '写第一章', '同一扇门已经锁上。随后他却说这扇门从未锁过。钥匙已经交出。随后他却说钥匙一直在手中。')
    f.validation.findings.push({ signal: 'object', severity: 'error', evidence: '钥匙原文「已经交出」与「钥匙一直在手中」互斥', suggestion: '核对同一物件的事实' })
    f.validation.errorCount = 2
    await prisma.storyCompilation.update({ where: { id: f.compilation.id }, data: { validation: runtimeJson(f.validation).value } })
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })
    const novel = await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })
    const jobs = await prisma.memoryExtractionJob.findMany({ where: { novelId: ctx.novelId }, orderBy: { id: 'asc' } })
    const receipts = () => prisma.agentEffectReceipt.findMany({ where: { operation: { taskRoot: { novelId: ctx.novelId } } } })
    expect(await chapterEditRangeTool.execute(ctx, { chapterId: f.chapterId, patches: [
      { oldText: '这扇门从未锁过', newText: '这扇门已经锁上' }, { oldText: '不存在的当前原文', newText: '第二条' },
    ] })).toMatchObject({ outcome: 'failed', failureCode: 'CHAPTER_ANCHOR_CONFLICT' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(f.chapter)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).toEqual(before)
    expect(await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })).toEqual(novel)
    expect(await prisma.memoryExtractionJob.findMany({ where: { novelId: ctx.novelId }, orderBy: { id: 'asc' } })).toEqual(jobs)
    expect(await receipts()).toEqual([])
    const noop = await chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: f.chapter.content })
    expect(noop.display).toMatchObject({ revision: f.chapter.revision })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(f.chapter)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).toEqual(before)
    const content = f.chapter.content.replace('这扇门从未锁过', '这扇门已经锁上').replace('钥匙一直在手中', '钥匙已经交出')
    expect(await chapterEditRangeTool.execute(ctx, { chapterId: f.chapterId, patches: [
      { oldText: '这扇门从未锁过', newText: '这扇门已经锁上' }, { oldText: '钥匙一直在手中', newText: '钥匙已经交出' },
    ] })).not.toMatchObject({ outcome: 'failed' })
    const after = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    expect(after).toMatchObject({ content, revision: f.chapter.revision + 1 })
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).validation).toMatchObject({
      checkRounds: 1, autoRepairRounds: 0, newDraftRevision: { checkedRevision: f.chapter.revision } })
    await expect(chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: content + '第二次修改。' })).resolves.toBeTruthy()
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: content + '第二次修改。', revision: after.revision + 1 })
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).validation).toMatchObject({ checkRounds: 1, autoRepairRounds: 0 })
    expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: f.quality.id } })).toEqual(f.quality)
  }))
  it.each(['写第一章', '写第一章并润色'])('requires an explicit decision for strict writing advice regardless of automatic repair authority: %s', prompt => fixture(prompt, async ctx => {
    const f = await newDraftReview(ctx, prompt, '甲句。乙句。')
    // A frozen write contract may also carry an explicit human repair clause.
    // Preserve that historical intersection instead of changing intent parsing.
    if (prompt.includes('润色')) await prisma.agentRun.update({ where: { id: ctx.runId }, data: {
      taskSpec: runtimeJson(JSON.parse(JSON.stringify({ ...f.spec, intent: 'write' }))).value } })
    expect(await prisma.$transaction(tx => readNewDraftWritingAuthority(tx, ctx, f.chapter))).toBeTruthy()
    const jobs = await prisma.memoryExtractionJob.findMany({ where: { novelId: ctx.novelId }, orderBy: { id: 'asc' } })
    await prisma.storyCompilation.update({ where: { id: f.compilation.id }, data: { validation: runtimeJson({ ...f.validation, findings: [], errorCount: 0 }).value } })
    const finding = await prisma.qualityFinding.create({ data: { reportId: f.quality.id, userId: ctx.userId, novelId: ctx.novelId,
      source: 'critic', signal: 'emotion_grounding', severity: 'advisory', startOffset: 0, endOffset: 2, evidenceExcerpt: '甲句',
      evidenceHash: createHash('sha256').update('甲句').digest('hex'), explanation: '合成审美建议', suggestion: '补一个动作', confidence: 0.9 } })
    const input = { ...ctx, compilationId: f.compilation.id, chapterSummary: '合成摘要', exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
      lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '停步' }
    await expect(prisma.$transaction(tx => commitChapterBridge(input, tx))).rejects.toMatchObject({ code: 'REVIEW_DECISION_REQUIRED' })
    await chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: f.chapter.content, retainedFindings: [
      { source: 'quality', reportId: f.quality.id, findingId: finding.id, reason: '此处刻意简短，无法安全增添动作而改变作者声口。' },
    ] })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })
    expect(saved.validation).toHaveProperty('retainedReviewDecision')
    expect(readNewDraftRevision(saved.validation)).toBeNull()
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(f.chapter)
    expect(await prisma.memoryExtractionJob.findMany({ where: { novelId: ctx.novelId }, orderBy: { id: 'asc' } })).toEqual(jobs)
    expect(await prisma.$transaction(tx => commitChapterBridge(input, tx))).toMatchObject({ chapterRevision: f.chapter.revision, retainedIssueCount: 1 })
    await expect(chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: '甲新句。乙句。' })).resolves.toBeTruthy()
    await expect(chapterEditRangeTool.execute(ctx, { chapterId: f.chapterId, patches: [{ oldText: '甲新句', newText: '甲再次修改' }] })).resolves.toBeTruthy()
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: '甲再次修改。乙句。', revision: f.chapter.revision + 2 })
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).validation).toMatchObject(saved.validation)
    await expect(prisma.$transaction(tx => commitChapterBridge(input, tx))).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
    expect((await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: f.quality.id }, include: { findings: true } })).findings[0])
      .toMatchObject({ disposition: 'pending', severity: 'advisory' })
  }))
  it('observes only current persisted assessments and a real bound no-op decision as progress', () => fixture('写第一章，只要章名和正文', async ctx => {
    const f = await newDraftReview(ctx, '写第一章，只要章名和正文', '甲句。乙句。')
    await prisma.storyCompilation.update({ where: { id: f.compilation.id }, data: { validation: runtimeJson({ ...f.validation, findings: [], errorCount: 0 }).value } })
    const finding = await prisma.qualityFinding.create({ data: { reportId: f.quality.id, userId: ctx.userId, novelId: ctx.novelId,
      source: 'critic', signal: 'emotion_grounding', severity: 'advisory', startOffset: 0, endOffset: 2, evidenceExcerpt: '甲句',
      evidenceHash: createHash('sha256').update('甲句').digest('hex'), explanation: '合成建议', suggestion: '补动作', confidence: 0.9 } })
    const bundle = await buildHumanityQualityContext(ctx.userId, ctx.novelId, f.chapterId, ctx.runId)
    await prisma.chapterQualityReport.update({ where: { id: f.quality.id }, data: { deterministicMetrics: {
      ...f.quality.deterministicMetrics as Prisma.JsonObject, qualityContextHash: qualityReviewContextHash(bundle) } } })
    const read = () => prisma.$transaction(tx => readChapterReviewReadiness(tx, ctx, f.compilation.id))
    const seen = new Set<string>(), subject = { ...ctx, taskSpec: f.spec, expectedOriginalTaskId: f.spec.id }
    const first = await read()
    expect(first).toMatchObject({ decisionPending: true, progressEvidence: { phases: ['continuity', 'quality'] } })
    expect(observeChapterReviewProgress(seen, first!.progressEvidence, subject)).toBe(true)
    expect(observeChapterReviewProgress(seen, (await read())!.progressEvidence, subject)).toBe(false)
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { title: '变更标题' } })
    expect((await read())!.progressEvidence!.phases).not.toContain('quality')
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { title: f.chapter.title } })
    const beforeRetention = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    await chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: f.chapter.content, retainedFindings: [
      { source: 'quality', reportId: f.quality.id, findingId: finding.id, reason: '刻意保留短句节奏，补动作会改变此处作者声口。' } ] })
    const decided = await read()
    expect(decided).toMatchObject({ decisionPending: false, progressEvidence: { phases: ['continuity', 'quality', 'decision'] } })
    expect(observeChapterReviewProgress(seen, decided!.progressEvidence, subject)).toBe(true)
    expect(observeChapterReviewProgress(new Set(seen), (await read())!.progressEvidence, subject)).toBe(false)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(beforeRetention)
    await prisma.chapterQualityReport.update({ where: { id: f.quality.id }, data: { status: 'repaired' } })
    expect((await read())!.progressEvidence!.phases).toEqual(['continuity'])
    await prisma.chapterQualityReport.update({ where: { id: f.quality.id }, data: { status: 'failed' } })
    expect((await read())!.progressEvidence!.phases).toEqual(['continuity'])
  }))
  it.each(['revise', 'retain'] as const)('recovers an already completed chapter with six unprocessed findings after a consumed automatic attempt: %s', action => fixture('写第一章，只要章名和正文', async ctx => {
    const f = await newDraftReview(ctx, '写第一章，只要章名和正文', '甲句。乙句。丙句。丁句。戊句。己句。')
    await prisma.storyCompilation.update({ where: { id: f.compilation.id }, data: { validation: runtimeJson({ ...f.validation, findings: [], errorCount: 0 }).value } })
    const input = { ...ctx, compilationId: f.compilation.id, chapterSummary: '合成摘要', exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
      lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '停步' }
    await commitChapterBridge(input)
    await prisma.chapterQualityReport.update({ where: { id: f.quality.id }, data: { deterministicMetrics: {
      ...f.quality.deterministicMetrics as Prisma.JsonObject, autoRepairAttempted: true } } })
    const findings = await Promise.all(Array.from({ length: 6 }, (_, index) => prisma.qualityFinding.create({ data: {
      reportId: f.quality.id, userId: ctx.userId, novelId: ctx.novelId, source: 'critic', signal: 'emotion_grounding', severity: 'advisory',
      startOffset: index * 3, endOffset: index * 3 + 2, evidenceExcerpt: f.chapter.content.slice(index * 3, index * 3 + 2),
      evidenceHash: createHash('sha256').update(f.chapter.content.slice(index * 3, index * 3 + 2)).digest('hex'),
      explanation: '合成建议', suggestion: '核对动作', confidence: 0.9,
    } })))
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, ctx, f.compilation.id))).toMatchObject({ ready: true, decisionPending: true, qualityCandidateCount: 6 })
    expect(await prisma.$transaction(tx => readCompletedWritingDelivery(tx, ctx))).toBeNull()
    await expect(commitChapterBridge(input)).rejects.toMatchObject({ code: 'REVIEW_DECISION_REQUIRED' })
    const oldReport = await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: f.quality.id } })
    if (action === 'retain') {
      await chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: f.chapter.content, retainedFindings: findings.map((finding, index) =>
        ({ source: 'quality' as const, reportId: f.quality.id, findingId: finding.id, reason: `第${index + 1}处是人物有意停顿，增添动作会改变此处节奏。` })) })
      expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, ctx, f.compilation.id))).toMatchObject({ decisionPending: false })
      await prisma.qualityFinding.update({ where: { id: findings[0].id }, data: { suggestion: '报告意见已改变' } })
      await expect(commitChapterBridge(input)).rejects.toMatchObject({ code: 'REVIEW_DECISION_REQUIRED' })
      await prisma.qualityFinding.update({ where: { id: findings[0].id }, data: { suggestion: findings[0].suggestion } })
      await chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: f.chapter.content, retainedFindings: findings.map(finding =>
        ({ source: 'quality' as const, reportId: f.quality.id, findingId: finding.id, reason: '重新核对当前报告，保留人物原本的短句停顿。' })) })
    } else {
      await chapterEditRangeTool.execute(ctx, { chapterId: f.chapterId, patches: [{ oldText: '甲句', newText: '甲句后他停步' }] })
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const reopened = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id }, include: { bridge: true, sceneTasks: true } })
      expect(reopened).toMatchObject({ status: 'active', stage: 'repair', completedAt: null, bridge: { committedAt: null, targetRevision: chapter.revision },
        validation: { checkRounds: 1, autoRepairRounds: 0 } })
      await expect(commitChapterBridge(input)).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
      const coverage = compilerContinuityCoverage({ chapter, bridge: reopened.bridge, sceneTasks: reopened.sceneTasks, source: null })
      await validateStoryContinuity({ ...ctx, compilationId: f.compilation.id, expectedChapterRevision: chapter.revision, coverage, independentCheck: 'complete', findings: [] })
      await expect(commitChapterBridge(input)).rejects.toMatchObject({ code: 'QUALITY_CHECK_REQUIRED' })
      await prisma.chapterQualityReport.create({ data: { userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, compilationId: f.compilation.id,
        chapterId: f.chapterId, chapterRevision: chapter.revision, status: 'passed', deterministicMetrics: {
          independentCheck: 'complete', contentHash: createHash('sha256').update(chapter.content).digest('hex') } } })
    }
    await commitChapterBridge(input)
    expect(await prisma.$transaction(tx => readCompletedWritingDelivery(tx, ctx))).not.toBeNull()
    expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: f.quality.id } })).toEqual(oldReport)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: ctx.runId } })).toBe(0)
    expect(await prisma.storyCompilation.count({ where: { novelId: ctx.novelId } })).toBe(1)
  }))
  it('rolls back manuscript CAS when the compiler transition fails and rejects stale post-write hooks', () => fixture('写第一章', async ctx => {
    const f = await newDraftReview(ctx)
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id }, include: { bridge: true } })
    const hook = vi.spyOn(compiler, 'recordStoryCompilerWrite').mockRejectedValueOnce(new Error('synthetic compiler transition failed'))
    try {
      await expect(chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: '修改后的正文。' })).rejects.toThrow('synthetic compiler transition failed')
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(f.chapter)
      expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id }, include: { bridge: true } })).toEqual(before)
    } finally { hook.mockRestore() }
    await chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: '真实修改后的正文。' })
    const latest = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id }, include: { bridge: true } })
    await expect(compiler.recordStoryCompilerWrite({ ...ctx, chapterId: f.chapterId, chapterOrderIndex: 1, chapterRevision: f.chapter.revision }))
      .rejects.toMatchObject({ code: 'CHAPTER_REVISION_CONFLICT' })
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id }, include: { bridge: true } })).toEqual(latest)
  }))
  it('does not let a retention decision waive an original mandatory continuity pass', () => fixture('写第一章，必须通过连续性检查才能交付', async ctx => {
    const f = await newDraftReview(ctx, '写第一章，必须通过连续性检查才能交付')
    await chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: f.chapter.content, retainedFindings: [
      { source: 'continuity', reportId: continuityDecisionBinding(f.compilation.id, f.chapter.revision, f.validation), findingId: '0', reason: '保留问题供作者核对。' },
    ] })
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, ctx, f.compilation.id))).toMatchObject({ ready: true, decisionPending: true, continuityErrorCount: 1 })
    await expect(commitChapterBridge({ ...ctx, compilationId: f.compilation.id, chapterSummary: '摘要', exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
      lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '停步' })).rejects.toMatchObject({ code: 'REVIEW_DECISION_REQUIRED' })
  }))
  it.each(['质量', '连续性'] as const)('preserves explicit %s pass without expanding it to other reviews', kind => fixture(`写第一章，${kind}检查必须通过才能交付`, async ctx => {
    const f = await newDraftReview(ctx, `写第一章，${kind}检查必须通过才能交付`)
    await prisma.storyCompilation.update({ where: { id: f.compilation.id }, data: { validation: { ...f.validation, findings: [], errorCount: 0, warningCount: 0 } } })
    await prisma.chapterQualityReport.update({ where: { id: f.quality.id }, data: { status: 'needs_repair' } })
    const finding = await prisma.qualityFinding.create({ data: { reportId: f.quality.id, userId: ctx.userId, novelId: ctx.novelId,
      source: 'critic', signal: 'emotion_grounding', severity: 'warning', startOffset: 0, endOffset: 3, evidenceExcerpt: '同一扇',
      evidenceHash: createHash('sha256').update('同一扇').digest('hex'), explanation: '人物声口建议', suggestion: '核对重复用语', confidence: 0.9 } })
    await chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: f.chapter.content, retainedFindings: [
      { source: 'quality', reportId: f.quality.id, findingId: finding.id, reason: '核对原文后保留人物刻意重复的声口。' },
    ] })
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, ctx, f.compilation.id))).toMatchObject({ ready: true, decisionPending: kind === '质量', continuityErrorCount: 0, qualityErrorCount: 0 })
    const input = { ...ctx, compilationId: f.compilation.id, chapterSummary: '摘要', exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
      lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '停步' }
    if (kind === '质量') await expect(commitChapterBridge(input)).rejects.toMatchObject({ code: 'REVIEW_DECISION_REQUIRED' })
    else await expect(commitChapterBridge(input)).resolves.toBeTruthy()
  }))
  it('allows original manuscript edits with failed reports without certifying final review', () => fixture('写第一章', async ctx => {
    const f = await newDraftReview(ctx)
    await prisma.chapterQualityReport.update({ where: { id: f.quality.id }, data: { status: 'failed' } })
    await expect(chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: '同一扇门已经锁上。他随后用钥匙打开门。' })).resolves.toBeTruthy()
    const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, ctx, f.compilation.id))
    expect(readiness).toMatchObject({ ready: false, continuity: 'stale', quality: 'incomplete' })
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).validation).toMatchObject({ checkRounds: 1, autoRepairRounds: 0 })
  }))
  it('preserves automatic decision consumption through CHECK and reprepare while ordinary writes remain authorized', () => fixture('写第一章', async ctx => {
    const f = await newDraftReview(ctx)
    expect((await chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: '同一扇门已经锁上。他用钥匙打开门。' })).outcome).not.toBe('failed')
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })
    const receipt = readNewDraftRevision(saved.validation)
    expect(receipt).toMatchObject({ beforeHash: runtimeJson({ content: f.chapter.content }).hash,
      afterHash: runtimeJson({ content: chapter.content }).hash, retainedFindings: [] })
    expect(saved.validation).toMatchObject({ checkRounds: 1, autoRepairRounds: 0,
      newDraftRevision: { taskId: f.spec.id, chapterId: f.chapterId, checkedRevision: f.chapter.revision } })
    // A complete report cannot replenish automatic repair, but ordinary writes keep their original authority.
    await prisma.chapterBridge.update({ where: { compilationId: f.compilation.id }, data: { targetRevision: chapter.revision } })
    await validateStoryContinuity({ ...ctx, compilationId: f.compilation.id, expectedChapterRevision: chapter.revision, independentCheck: 'complete', findings: [
      { signal: 'object', severity: 'error', evidence: '合成剩余事实冲突', suggestion: '交作者决定' },
    ] })
    const { chapterAppendTool, chapterEditRangeTool } = await import('../../api/lib/agent/tools/chapter-tools.js')
    for (const execute of [
      () => chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: '不应再整体修改。' }),
      () => chapterAppendTool.execute(ctx, { chapterId: f.chapterId, content: '不应追加。' }),
      () => chapterEditRangeTool.execute(ctx, { chapterId: f.chapterId, oldText: '不应再整体修改', newText: '连续局部修改' }),
    ]) await expect(execute()).resolves.toBeTruthy()
    const reprepared = await prepareStoryCompilation({ ...ctx, chapterId: f.chapterId, mode: 'balanced', intentSummary: '写第一章' })
    expect(readNewDraftRevision(reprepared.compilation.validation)).toEqual(receipt)
    expect(reprepared.compilation.validation).toMatchObject({ checkRounds: 1, newDraftRevision: { chapterId: f.chapterId } })
    await expect(chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: '重新准备后依旧按原授权修改。' })).resolves.toBeTruthy()
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: '重新准备后依旧按原授权修改。', revision: chapter.revision + 4 })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec).toEqual(runtimeJson(JSON.parse(JSON.stringify(f.spec))).value)
  }))
  it.each(['parent', 'child'] as const)('a %s correction shares the original automatic decision receipt but does not remove opposite lineage writing authority', writer => fixture('写第一章', async ctx => {
    const f = await newDraftReview(ctx)
    const session = await prisma.agentSession.create({ data: { userId: ctx.userId, novelId: ctx.novelId, title: 'synthetic-draft-child', spawnedFromRunId: ctx.runId, spawnedFromSessionId: ctx.sessionId } })
    const child = await prisma.agentRun.create({ data: { userId: ctx.userId, novelId: ctx.novelId, sessionId: session.id, status: 'running', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', startRequest: { prompt: 'generated brief is not authority' } } })
    const childCtx = { ...ctx, runId: child.id, sessionId: session.id, chapterId: f.chapterId }
    // Review evidence and the first writer are deliberately opposite.
    if (writer === 'parent') await prisma.storyCompilation.update({ where: { id: f.compilation.id }, data: { runId: child.id } })
    const subject = writer === 'parent' ? ctx : childCtx
    expect((await chapterWriteTool.execute(subject, { chapterId: f.chapterId, content: '同一扇门已经锁上。他随后用钥匙开门。' })).outcome).not.toBe('failed')
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const opposite = writer === 'parent' ? childCtx : ctx
    await chapterReadTool.execute(opposite, { chapterId: f.chapterId })
    await expect(chapterWriteTool.execute(opposite, { chapterId: f.chapterId, content: '另一执行在原权限内继续修改。' })).resolves.toBeTruthy()
    const prepared = await prepareStoryCompilation({ ...ctx, chapterId: f.chapterId, mode: 'balanced', intentSummary: '写第一章' })
    expect(prepared.compilation.validation).toMatchObject({ checkRounds: 1, newDraftRevision: { chapterId: f.chapterId } })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: '另一执行在原权限内继续修改。', revision: chapter.revision + 1 })
  }))
  it('transaction rollback and a legacy CAS count of zero preserve the unconsumed original new-draft allowance', () => fixture('写第一章', async ctx => {
    const f = await newDraftReview(ctx)
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })
    await expect(prisma.$transaction(async tx => {
      await chapterWriteTool.execute({ ...ctx, transaction: tx }, { chapterId: f.chapterId, content: '同一扇门锁着。他用钥匙开门。' })
      throw new Error('synthetic-rollback-after-successful-CAS')
    })).rejects.toThrow('synthetic-rollback-after-successful-CAS')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(f.chapter)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).toEqual(before)
    await prisma.$transaction(async tx => {
      const cas = vi.spyOn(tx.chapter, 'updateMany').mockResolvedValueOnce({ count: 0 })
      try {
        const result = await chapterWriteTool.execute({ ...ctx, transaction: tx }, { chapterId: f.chapterId, content: '不应写入的冲突稿。' })
        expect(result.output).toContain('冲突')
      } finally { cas.mockRestore() }
    })
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).toEqual(before)
    await expect(chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: '同一扇门锁着。他用钥匙开门。' })).resolves.toBeTruthy()
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })).validation).toMatchObject({ newDraftRevision: { chapterId: f.chapterId } })
  }))
  it('repreparing preserves check budgets while explicitly authorized manuscript edits can continue', () => fixture('写第一章并检查修复正文', async ctx => {
    const prompt = '写第一章并检查修复正文'
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt }), prompt))
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const created = await chapterCreateTool.execute(ctx, { title: '合成整体修订章', content: '合成待修正原稿。' })
    const chapterId = created.observedState!.id
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })
    const { prepareStoryCompilation } = await import('../../api/lib/agent/story-compiler.js')
    const initial = await prepareStoryCompilation({ ...ctx, chapterId, mode: 'balanced', intentSummary: prompt })
    const old = await prisma.storyCompilation.update({ where: { id: initial.compilation.id }, data: { stage: 'check', validation: { checkRounds: 1, checkedRevision: before.revision, independentCheck: 'complete', errorCount: 1 } } })
    expect(await chapterWriteTool.execute(ctx, { chapterId, content: '合成已保存的完整修订。' })).not.toMatchObject({ outcome: 'failed' })
    const prepared = await prepareStoryCompilation({ ...ctx, chapterId, mode: 'balanced', intentSummary: prompt })
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('abandoned')
    expect(prepared.compilation.validation).toMatchObject({ checkRounds: 1 })
    const current = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })
    await expect(chapterWriteTool.execute(ctx, { chapterId, content: '原授权修订可以继续。' })).resolves.toBeTruthy()
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })).toMatchObject({ content: '原授权修订可以继续。', revision: current.revision + 1 })
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })).validation).toEqual(prepared.compilation.validation)
  }))
  it.each([
    { writer: 'parent', rounds: 1 }, { writer: 'child', rounds: 1 },
    { writer: 'parent', rounds: 3 }, { writer: 'child', rounds: 3 },
  ] as const)('inherits original continuity state from the opposite lineage when $writer writes after $rounds checks', ({ writer, rounds }) => fixture('写第一章', async ctx => {
    const prompt = '写第一章'
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt }), prompt))
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const created = await chapterCreateTool.execute(ctx, { title: '合成父子范围章', content: '合成完整正文，不应碎改。' })
    const chapterId = created.observedState!.id
    const session = await prisma.agentSession.create({ data: { userId: ctx.userId, novelId: ctx.novelId, title: 'review-child', spawnedFromRunId: ctx.runId, spawnedFromSessionId: ctx.sessionId } })
    const child = await prisma.agentRun.create({ data: { userId: ctx.userId, novelId: ctx.novelId, sessionId: session.id, engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', startRequest: { prompt: '模型生成的修订要求不能授予权限' } } })
    const subject = writer === 'parent' ? ctx : { ...ctx, runId: child.id, sessionId: session.id, chapterId }
    await expect(prisma.$transaction(tx => assertWritingTarget(tx, subject, { chapterId }))).resolves.toBeTruthy()
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })
    const compilation = await prisma.storyCompilation.create({ data: { userId: ctx.userId, novelId: ctx.novelId, runId: writer === 'parent' ? child.id : ctx.runId, chapterId,
      targetOrderIndex: 1, sourcePromptHash: 'b'.repeat(64), preparedContext: {}, stage: 'check', validation: { checkRounds: rounds, checkedRevision: chapter.revision, errorCount: 0, warningCount: 1, independentCheck: 'complete' } } })
    await expect(chapterWriteTool.execute(subject, { chapterId, content: '原任务范围内的另一次写入。' })).resolves.toBeTruthy()
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })).toMatchObject({ content: '原任务范围内的另一次写入。', revision: chapter.revision + 1 })
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(compilation)
    expect(await prisma.chapterQualityReport.count({ where: { novelId: ctx.novelId } })).toBe(0)
  }))
  it.each(['warning', 'stale-error', 'failed-check', 'exhausted'] as const)('allows original ordinary writes with %s reviews while preserving truthful review state and counters', scenario => fixture('写第一章', async ctx => {
    const prompt = '写第一章'
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt }), prompt))
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const result = await chapterCreateTool.execute(ctx, { title: '合成连贯章', content: '合成原文保持连贯。' })
    const id = result.observedState!.id
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id } })
    const prepared = await prepareStoryCompilation({ ...ctx, chapterId: id, mode: 'balanced', intentSummary: prompt })
    const compilation = await prisma.storyCompilation.update({ where: { id: prepared.compilation.id }, data: { stage: 'check', validation: {
        checkRounds: scenario === 'exhausted' ? 3 : 1,
        ...(scenario === 'failed-check' ? { independentCheck: 'unavailable' } : { independentCheck: 'complete', checkedRevision: scenario === 'stale-error' ? chapter.revision - 1 : chapter.revision,
          errorCount: scenario === 'warning' ? 0 : 1, warningCount: scenario === 'warning' ? 6 : 0 }),
      } } })
    const { chapterWriteTool, chapterAppendTool, chapterEditRangeTool } = await import('../../api/lib/agent/tools/chapter-tools.js')
    for (const execute of [
      () => chapterWriteTool.execute(ctx, { chapterId: id, content: '不应整体重写。' }),
      () => chapterAppendTool.execute(ctx, { chapterId: id, content: '不应追加修订。' }),
      () => chapterEditRangeTool.execute(ctx, { chapterId: id, oldText: '不应整体重写', newText: '不应碎片替换' }),
    ]) await expect(execute()).resolves.toBeTruthy()
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id } })).toMatchObject({ content: '不应碎片替换。\n\n不应追加修订。', revision: chapter.revision + 3 })
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation).toMatchObject(compilation.validation as Record<string, unknown>)
  }))
  it.each(['narrowed-title', 'narrowed-position', 'legacy-generic', 'cross-target-schema', 'tampered-schema', 'contradictory-args', 'wrong-global', 'wrong-volume'] as const)(
    'validates %s against the exact original durable target without widening scope', scenario => fixture('写第一章', async ctx => {
      const prompt = '写第一章'
      const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt }), prompt))
      expect(spec.scope.writing?.targets).toEqual([{ orderIndex: 1, chapterId: null }])
      await prisma.agentRun.update({ where: { id: ctx.runId }, data: { status: 'queued', taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
      const sourceMessageId = randomUUID()
      await prisma.agentMessage.create({ data: { id: sourceMessageId, sessionId: ctx.sessionId, runId: ctx.runId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
      const root = await initializeDurableTask({ userId: ctx.userId, runId: ctx.runId, sourceMessageId })
      const lease = await acquireRunLease({ userId: ctx.userId, runId: ctx.runId, ownerId: 'synthetic-schema-worker', claimId: randomUUID() })
      const scope = scenario === 'cross-target-schema' ? { ...spec.scope, writing: { ...spec.scope.writing!, targets: [{ orderIndex: 2, chapterId: null }] } } : spec.scope
      const definitions = toOpenAITools([chapterCreateTool], scenario === 'legacy-generic' ? undefined : scope)
      if (scenario === 'tampered-schema') {
        const properties = definitions[0].function.parameters.properties as Record<string, unknown>
        properties.position = { type: 'integer', minimum: 1, enum: [1, 2] }
      }
      const args = { title: '合成待创建章',
        ...(scenario === 'narrowed-position' ? { position: 1 } : {}),
        ...(scenario === 'contradictory-args' ? { position: 1, volumeOrder: 1, positionInVolume: 1 } : {}),
        ...(scenario === 'wrong-global' ? { position: 2 } : {}),
        ...(scenario === 'wrong-volume' ? { volumeOrder: 1, positionInVolume: 2 } : {}) }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: definitions, toolAuthority: [{ name: chapterCreateTool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: null, toolCalls: [
            { id: 'synthetic-create', name: chapterCreateTool.name, arguments: JSON.stringify(args) },
          ] }], successfulToolSignatures: [] } })
      const before = await loadExecutionState(ctx.userId, ctx.runId)
      const novel = await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })
      const invoke = () => executeDurableToolStep(lease, new AbortController().signal)
      const rejectedSchema = scenario === 'cross-target-schema' || scenario === 'tampered-schema'
      const rejectedArgs = ['contradictory-args', 'wrong-global', 'wrong-volume'].includes(scenario)
      if (rejectedSchema) {
        await expect(invoke()).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
        expect(await loadExecutionState(ctx.userId, ctx.runId)).toEqual(before)
        expect(await prisma.agentOperation.count({ where: { taskRootId: root.id } })).toBe(0)
      } else {
        const result = await invoke()
        expect(result.kind).toBe('tool')
        if (result.kind !== 'tool') throw new Error('Expected chapter observation')
        expect(result.result.outcome).toBe(rejectedArgs ? 'failed' : undefined)
        if (scenario === 'wrong-global' || scenario === 'wrong-volume') {
          expect(result.result.summary).toBe('章节目标或位置与原请求不符')
          expect(result.result.output).toContain('不表示任务已结束')
          expect(result.result.output).toContain('现有授权范围内')
        }
        if (scenario === 'contradictory-args') {
          const operation = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: root.id }, include: { effectReceipt: true } })
          expect(operation.inputSnapshot).toMatchObject({ input: { rejection: { code: 'TOOL_SCHEMA_INVALID',
            validation: { schemaHash: runtimeJson(definitions[0].function.parameters).hash } } } })
          expect(operation.effectReceipt?.result).toMatchObject({ code: 'TOOL_SCHEMA_INVALID', effectApplied: false })
          expect((await loadExecutionState(ctx.userId, ctx.runId)).frame.state).toMatchObject({ phase: 'idle', pendingOperationId: null })
        }
      }
      expect((await loadExecutionState(ctx.userId, ctx.runId)).configuration).toEqual(before.configuration)
      const unchangedRoot = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: root.id } })
      expect(unchangedRoot.inputHash).toBe(root.inputHash)
      expect(unchangedRoot.specSnapshot).toEqual(root.specSnapshot)
      if (rejectedSchema || rejectedArgs) {
        expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(0)
        expect(await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })).toEqual(novel)
        expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).writingBindings).toBeNull()
        expect(getCreatedChapter(ctx.runId, args.title)).toBeNull()
      } else {
        expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId } })).toEqual([expect.objectContaining({ title: args.title, orderIndex: 1 })])
      }
    }))
  it.each(['写下一章', '参考当前章节，写下一章', '不要在当前章之后写下一章。请写下一章', '在当前这章之后写下一章', '在正在编辑的章节后写下一章'])(
    'freezes only positive original authority for an early editor anchor: %s', prompt => fixture(prompt, async ctx => {
      const volume = await prisma.volume.findFirstOrThrow({ where: { novelId: ctx.novelId } })
      const chapters = await Promise.all([1, 2, 3].map(order => prisma.chapter.create({ data: { novelId: ctx.novelId, authorId: ctx.userId,
        volumeId: volume.id, orderIndex: order, orderInVolume: order, title: `合成第${order}章`, content: `合成正文${order}` } })))
      await prisma.agentRun.update({ where: { id: ctx.runId }, data: { chapterId: chapters[0].id } })
      const initial = buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, chapterId: chapters[0].id, prompt })
      const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, initial, '模型摘要：在当前章之后写下一章'))
      const editorAfter = prompt.startsWith('在')
      expect(spec.scope.writing?.targets).toEqual([{ orderIndex: editorAfter ? 2 : 4, chapterId: editorAfter ? chapters[1].id : null }])
      // Already-frozen contracts keep their identities when editor/directory changes.
      await prisma.agentRun.update({ where: { id: ctx.runId }, data: { chapterId: chapters[2].id } })
      expect(await prisma.$transaction(tx => freezeWritingScope(tx, ctx, spec, '写下一章'))).toEqual(spec)
      if (!editorAfter) {
        await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
        await prepareStoryCompilation({ ...ctx, targetOrderIndex: 4, mode: 'balanced', intentSummary: prompt, volumeDecision: { kind: 'continue', reason: '当前主困局仍待推进，本章继续原卷' } })
        await chapterCreateTool.execute(ctx, { title: '合成第四章' })
        const after = await prisma.chapter.findMany({ where: { id: { in: chapters.map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })
        expect(after.map(({ id, title, content, revision, orderIndex, orderInVolume }) => ({ id, title, content, revision, orderIndex, orderInVolume })))
          .toEqual(chapters.map(({ id, title, content, revision, orderIndex, orderInVolume }) => ({ id, title, content, revision, orderIndex, orderInVolume })))
        expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(4)
      }
    }))
  it('requires input when the original request explicitly anchors after an unavailable editor chapter', () => fixture('在当前章之后写下一章', async ctx => {
    const prompt = '在当前章之后写下一章'
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt }), prompt))
    expect(spec.scope.writing).toMatchObject({ kind: 'needs_input', targets: [] })
  }))

  it.each(['写下一章', '写第一卷第三十九章'])('rejects a volume clamp from global39 to global17 before any persisted or cache effect: %s', prompt => fixture(prompt, async ctx => {
    const first = await prisma.volume.findFirstOrThrow({ where: { novelId: ctx.novelId } })
    const second = await prisma.volume.create({ data: { novelId: ctx.novelId, title: '合成第二卷', orderIndex: 2 } })
    await prisma.chapter.createMany({ data: Array.from({ length: 38 }, (_, index) => ({ novelId: ctx.novelId, authorId: ctx.userId,
      volumeId: index < 16 ? first.id : second.id, orderIndex: index + 1, orderInVolume: index < 16 ? index + 1 : index - 15,
      title: `合成第${index + 1}章`, content: `合成正文${index + 1}` })) })
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt }), prompt))
    expect(spec.scope.writing?.targets[0].orderIndex).toBe(39)
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    await prepareStoryCompilation({ ...ctx, targetOrderIndex: 39, mode: 'balanced', intentSummary: prompt, volumeDecision: { kind: 'continue', reason: '当前困局仍未收束，继续第二卷' } })
    const chapters = await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })
    const novel = await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })
    await expect(chapterCreateTool.execute(ctx, { title: '不得错绑', content: '不得保存',
      ...(prompt === '写下一章' ? { volumeOrder: 1, positionInVolume: 39 } : {}) })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    if (prompt === '写下一章') {
      const place = volumeData.placeCreatedChapter
      const wrongHydration = vi.spyOn(volumeData, 'placeCreatedChapter').mockImplementationOnce((tx, novelId, created) => place(tx, novelId, created, first.id, 16))
      try {
        await expect(chapterCreateTool.execute(ctx, { title: '错位事务应回滚', volumeOrder: 2, positionInVolume: 23 }))
          .rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
      } finally { wrongHydration.mockRestore() }
      expect(getCreatedChapter(ctx.runId, '错位事务应回滚')).toBeNull()
    }
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(chapters)
    expect(await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })).toEqual(novel)
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).toEqual(run)
    expect(getCreatedChapter(ctx.runId, '不得错绑')).toBeNull()
    if (prompt === '写下一章') {
      const valid = await chapterCreateTool.execute(ctx, { title: '合法第三十九章', volumeOrder: 2, positionInVolume: 23 })
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: valid.observedState!.id } })
      expect(chapter).toMatchObject({ orderIndex: 39, volumeId: second.id, orderInVolume: 23 })
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).writingBindings).toMatchObject({ targets: [{ orderIndex: 39, chapterId: chapter.id }] })
    }
  }))

  it('rejects explicit wrong volumes/positions without chapter, binding, stats or created-cache changes, then truthfully reuses the bound historical chapter', () => fixture('写第二卷第一章', async ctx => {
    const firstVolume = await prisma.volume.findFirstOrThrow({ where: { novelId: ctx.novelId } })
    const secondVolume = await prisma.volume.create({ data: { novelId: ctx.novelId, title: '合成第二卷', orderIndex: 2 } })
    const chapters = await Promise.all([firstVolume, secondVolume].map((volume, index) => prisma.chapter.create({ data: { novelId: ctx.novelId,
      authorId: ctx.userId, volumeId: volume.id, orderIndex: index + 1, orderInVolume: 1, title: `合成${index + 1}`, content: `原合成正文${index + 1}` } })))
    const prompt = '写第二卷第一章'
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt }), prompt))
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const beforeNovel = await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })
    const beforeRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })
    for (const args of [{ position: 1 }, { volumeOrder: 1, positionInVolume: 1 }, { volumeId: firstVolume.id, positionInVolume: 1 },
      { volumeOrder: 2, positionInVolume: 2 }, { volumeOrder: 3, positionInVolume: 1 }]) {
      await expect(chapterCreateTool.execute(ctx, { title: '未授权合成标题', content: '不得写入', ...args })).rejects.toMatchObject({ code: args.volumeOrder === 3 ? 'VOLUME_NOT_FOUND' : 'AUTHOR_CHAPTER_SCOPE' })
    }
    const reused = await chapterCreateTool.execute(ctx, { title: '不应改名', content: '不应覆盖', volumeOrder: 2, positionInVolume: 1 })
    expect(reused.summary).toContain('复用')
    expect(reused.output).toContain('本次未创建、改名或写入章节')
    expect(reused.display).toMatchObject({ kind: 'chapterRef', chapterId: chapters[1].id })
    expect(reused.snapshot).toBeUndefined()
    expect(reused.semanticTransition).toBeUndefined()
    expect(getCreatedChapter(ctx.runId, chapters[1].title)).toBeNull()
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(chapters)
    expect(await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })).toEqual(beforeNovel)
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).toEqual(beforeRun)
  }))

  it('does not reauthorize explicit placement after the same bound chapter was moved by its author', () => fixture('写第二卷第一章', async ctx => {
    const first = await prisma.volume.findFirstOrThrow({ where: { novelId: ctx.novelId } })
    const second = await prisma.volume.create({ data: { novelId: ctx.novelId, title: '合成第二卷', orderIndex: 2 } })
    const chapter = await prisma.chapter.create({ data: { novelId: ctx.novelId, authorId: ctx.userId, volumeId: second.id,
      orderIndex: 1, orderInVolume: 1, title: '原绑定章', content: '合成原正文' } })
    const prompt = '写第二卷第一章'
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt }), prompt))
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const moved = await prisma.chapter.update({ where: { id: chapter.id }, data: { volumeId: first.id, revision: { increment: 1 } } })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })
    const novel = await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })
    await expect(chapterCreateTool.execute(ctx, { title: '不得重授权', content: '不得覆盖', volumeOrder: 1, positionInVolume: 1 }))
      .rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    const omitted = await chapterCreateTool.execute(ctx, { title: '只复用身份' })
    expect(omitted.display).toMatchObject({ kind: 'chapterRef', chapterId: chapter.id })
    expect(omitted.summary).toContain('复用')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(moved)
    expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(1)
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).toEqual(run)
    expect(await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })).toEqual(novel)
    expect(getCreatedChapter(ctx.runId, '不得重授权')).toBeNull()
    expect(getCreatedChapter(ctx.runId, '只复用身份')).toBeNull()
  }))
  it('freezes one chapter before admission and concurrent creates share the same binding across a continuation', () => fixture('写第一章，只要标题和正文', async ctx => {
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt: '写第一章，只要标题和正文' }), '写第一章，只要标题和正文'))
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const secondRun = await prisma.agentRun.create({ data: { sessionId: ctx.sessionId, userId: ctx.userId, novelId: ctx.novelId, engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running',
      startRequest: { prompt: '继续' }, taskSpec: runtimeJson(JSON.parse(JSON.stringify({ ...spec, runId: 'continuation' }))).value } })
    const results = await Promise.all([chapterCreateTool.execute(ctx, { title: '第一章 门前', position: 1 }),
      chapterCreateTool.execute({ ...ctx, runId: secondRun.id, callId: 'scope-other' }, { title: '第一章 不同模型标题', position: 1 })])
    expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(1)
    const chapter = await prisma.chapter.findFirstOrThrow({ where: { novelId: ctx.novelId } })
    expect(results.every(result => result.observedState?.id === chapter.id)).toBe(true)
    const binding = (await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).writingBindings
    expect(binding).toMatchObject({ taskId: spec.id, targets: [{ orderIndex: 1, chapterId: chapter.id }] })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: secondRun.id } })).writingBindings).toBeNull()
    await expect(chapterCreateTool.execute({ ...ctx, callId: 'scope-second' }, { title: '第二章 越权', position: 2 })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(1)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec).toEqual(runtimeJson(JSON.parse(JSON.stringify(spec))).value)
  }))
  it('legacy and durable creates serialize the same admitted first slot without a second chapter', () => fixture('写第一章，只要标题和正文', async ctx => {
    const prompt = '写第一章，只要标题和正文'
    await prisma.volume.create({ data: { novelId: ctx.novelId, title: '合成第二卷', orderIndex: 2 } })
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt }), prompt))
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const sourceMessageId = randomUUID()
    await prisma.agentMessage.create({ data: { id: sourceMessageId, sessionId: ctx.sessionId, runId: ctx.runId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { status: 'queued' } })
    await initializeDurableTask({ userId: ctx.userId, runId: ctx.runId, sourceMessageId })
    const lease = await acquireRunLease({ userId: ctx.userId, runId: ctx.runId, ownerId: 'scope-durable', claimId: randomUUID() })
    const args = { title: '第一章 门前', volumeOrder: 1, positionInVolume: 1 }
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: [{ type: 'function', function: { name: chapterCreateTool.name, description: chapterCreateTool.description, parameters: z.toJSONSchema(chapterCreateTool.parameters, { io: 'input' }) } }],
      toolAuthority: [{ name: chapterCreateTool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: null, toolCalls: [
          { id: 'scope-durable-create', name: chapterCreateTool.name, arguments: JSON.stringify(args) },
          ...[{ position: 2 }, { volumeOrder: 2, positionInVolume: 1 }, { volumeOrder: 1, positionInVolume: 2 },
            { volumeOrder: 1, positionInVolume: 1 }, {}].map((placement, index) => ({ id: `scope-retry-${index}`, name: chapterCreateTool.name,
              arguments: JSON.stringify({ title: args.title, ...placement }) })),
        ] }], successfulToolSignatures: [] } })
    const continuation = await prisma.agentRun.create({ data: { userId: ctx.userId, novelId: ctx.novelId, sessionId: ctx.sessionId, engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running',
      taskSpec: runtimeJson(JSON.parse(JSON.stringify({ ...spec, runId: 'scope-continuation' }))).value, startRequest: { prompt: '继续原任务' } } })
    const started = performance.now()
    const elapsed: number[] = []
    const results = await Promise.allSettled([executeDurableToolStep(lease, new AbortController().signal), chapterCreateTool.execute({ ...ctx, runId: continuation.id }, args)]
      .map((work, index) => work.finally(() => { elapsed[index] = performance.now() - started })))
    for (const [index, result] of results.entries()) if (result.status === 'rejected') {
      const current = await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: lease.runId } })
      console.error('[scope concurrent create rejected]', { branch: index === 0 ? 'durable' : 'legacy', reason: result.reason,
        elapsedMs: elapsed[index], lease: { ...lease, current } })
    }
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    const chapter = await prisma.chapter.findFirstOrThrow({ where: { novelId: ctx.novelId } })
    expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(1)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).writingBindings).toMatchObject({ targets: [{ chapterId: chapter.id, orderIndex: 1 }] })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: continuation.id } })).writingBindings).toBeNull()
    expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: lease.taskRootId, action: chapterCreateTool.name } } })).toBe(1)
    const originalReceipt = await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: lease.taskRootId, action: chapterCreateTool.name } } })
    const root = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    const unchangedChapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })
    const unchangedNovel = await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })
    for (let index = 0; index < 5; index++) {
      const retry = await executeDurableToolStep(lease, new AbortController().signal)
      expect(retry.kind).toBe('tool')
      if (retry.kind !== 'tool') throw new Error('Expected replay tool result')
      if (index < 3) {
        expect(retry.result.outcome).toBe('failed')
        expect(retry.result.output).toMatch(/位置|目标/)
      } else {
        expect(retry.result.outcome).toBeUndefined()
        expect(retry.result.summary).toContain('复用')
        expect(retry.result.output).toContain('本次未创建、改名或写入章节')
        expect(retry.result.display).toMatchObject({ kind: 'chapterRef', chapterId: chapter.id })
        expect(retry.result.snapshot).toBeUndefined()
        expect(retry.result.semanticTransition).toBeUndefined()
      }
    }
    expect(await prisma.agentEffectReceipt.findUniqueOrThrow({ where: { operationId: originalReceipt.operationId } })).toEqual(originalReceipt)
    expect(await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: root.id } })).toEqual(root)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(unchangedChapter)
    expect(await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })).toEqual(unchangedNovel)
    expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(1)
  }))
  it('a child waiting behind parent cancellation cannot modify the claimed chapter', () => fixture('写第一章，只要标题和正文', async ctx => {
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt: '写第一章，只要标题和正文' }), '写第一章，只要标题和正文'))
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const created = await chapterCreateTool.execute(ctx, { title: '第一章 门前', position: 1 })
    const chapterId = created.observedState!.id
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })
    const session = await prisma.agentSession.create({ data: { userId: ctx.userId, novelId: ctx.novelId, title: 'scope-child', spawnedFromRunId: ctx.runId, spawnedFromSessionId: ctx.sessionId } })
    const child = await prisma.agentRun.create({ data: { userId: ctx.userId, novelId: ctx.novelId, sessionId: session.id, engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', startRequest: { prompt: '模型生成的续章要求' } } })
    let release!: () => void, locked!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), acquired = new Promise<void>(resolve => { locked = resolve })
    const cancellation = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM novels WHERE id = ${ctx.novelId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${ctx.runId} FOR UPDATE`
      await tx.agentRun.update({ where: { id: ctx.runId }, data: { status: 'paused' } })
      locked()
      await gate
    })
    await acquired
    const write = chapterWriteTool.execute({ ...ctx, runId: child.id, sessionId: session.id, chapterId, callId: 'scope-child-write' }, { chapterId, content: '不应写入' })
    release()
    await cancellation
    await expect(write).rejects.toMatchObject({ code: 'RUNTIME_PARENT_LEASE_LOST' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })).toMatchObject({ content: before.content, revision: before.revision })
    expect(await prisma.agentArtifact.count({ where: { runId: child.id } })).toBe(0)
  }))
  it('does not infer an old next-chapter admission slot from the current directory', () => fixture('写下一章', async ctx => {
    const spec = buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt: '写下一章' })
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const before = await prisma.chapter.count({ where: { novelId: ctx.novelId } })
    expect((await prisma.$transaction(tx => readWritingScope(tx, ctx))).writing?.kind).toBe('needs_input')
    await expect(chapterCreateTool.execute(ctx, { title: '下一章' })).rejects.toMatchObject({ code: 'SCOPE_NEEDS_INPUT' })
    expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(before)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).writingBindings).toBeNull()
  }))
  it('an old first request with two historical creates only recovers the proven first target', () => fixture('写第一章', async ctx => {
    const volume = await prisma.volume.findFirstOrThrow({ where: { novelId: ctx.novelId } })
    const first = await prisma.chapter.create({ data: { novelId: ctx.novelId, authorId: ctx.userId, volumeId: volume.id, orderIndex: 1, orderInVolume: 1, title: '第一章', content: '原授权正文' } })
    const extra = await prisma.chapter.create({ data: { novelId: ctx.novelId, authorId: ctx.userId, volumeId: volume.id, orderIndex: 2, orderInVolume: 2, title: '第二章', content: '旧轨迹越权正文' } })
    const spec = buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt: '写第一章' })
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    await prisma.storyCompilation.create({ data: { runId: ctx.runId, userId: ctx.userId, novelId: ctx.novelId, chapterId: first.id, targetOrderIndex: 1, mode: 'balanced', sourcePromptHash: 'original-first', preparedContext: {} } })
    await prisma.agentMessage.create({ data: { runId: ctx.runId, sessionId: ctx.sessionId, role: 'assistant', parts: [first, extra].map(chapter => ({ type: 'tool-call', toolName: 'chapter_create', status: 'success', display: { kind: 'chapterRef', chapterId: chapter.id } })) } })
    await expect(prisma.$transaction(tx => assertWritingTarget(tx, ctx, { chapterId: first.id }))).resolves.toBeTruthy()
    await expect(prisma.$transaction(tx => assertWritingTarget(tx, ctx, { chapterId: extra.id }))).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: extra.id } })).content).toBe('旧轨迹越权正文')
  }))
  it('reuses a proven old next target and rejects cross-owner or cancelled effects', () => fixture('写下一章', async ctx => {
    const volume = await prisma.volume.findFirstOrThrow({ where: { novelId: ctx.novelId } })
    const anchor = await prisma.chapter.create({ data: { novelId: ctx.novelId, authorId: ctx.userId, volumeId: volume.id, orderIndex: 1, orderInVolume: 1, title: '第一章', content: '原始锚定正文' } })
    const next = await prisma.chapter.create({ data: { novelId: ctx.novelId, authorId: ctx.userId, volumeId: volume.id, orderIndex: 2, orderInVolume: 2, title: '第二章', content: '已合法创建正文' } })
    const spec = buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, chapterId: anchor.id, prompt: '写下一章' })
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { chapterId: anchor.id, taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    await prisma.storyCompilation.create({ data: { runId: ctx.runId, userId: ctx.userId, novelId: ctx.novelId, chapterId: next.id, targetOrderIndex: 2, mode: 'balanced', sourcePromptHash: 'original-next', preparedContext: {},
      bridge: { create: { userId: ctx.userId, novelId: ctx.novelId, fromChapterId: anchor.id, sourceRevision: anchor.revision, toChapterId: next.id, targetOrderIndex: 2, knowledgeState: [], bodyState: [], objectState: [], relationshipState: [], emotionAftermath: [], recentOpenings: [], recentEndings: [], openLoops: [] } } } })
    await prisma.agentMessage.create({ data: { runId: ctx.runId, sessionId: ctx.sessionId, role: 'assistant', parts: [{ type: 'tool-call', toolName: 'chapter_create', status: 'success', display: { kind: 'chapterRef', chapterId: next.id } }] } })
    const recovered = await prisma.$transaction(tx => readWritingScope(tx, ctx))
    expect(recovered.writing?.targets).toEqual([{ orderIndex: 2, chapterId: next.id }])
    const reused = await chapterCreateTool.execute(ctx, { title: '第二章 新标题' })
    expect(reused.observedState?.id).toBe(next.id)
    expect(reused.display).toMatchObject({ kind: 'chapterRef', chapterId: next.id })
    expect(reused.summary).toContain('（未创建）')
    expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(2)
    await expect(prisma.$transaction(tx => assertWritingTarget(tx, { ...ctx, userId: randomUUID() }, { chapterId: next.id }))).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { status: 'paused' } })
    await expect(prisma.$transaction(tx => assertWritingTarget(tx, ctx, { chapterId: next.id }))).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: next.id } })).content).toBe(next.content)
  }))
  it('parses spaced chapter ranges exactly like compact ones instead of freezing the editor chapter', () => fixture('前 20 章优化', async ctx => {
    const volume = await prisma.volume.findFirstOrThrow({ where: { novelId: ctx.novelId } })
    const first = await prisma.chapter.create({ data: { novelId: ctx.novelId, authorId: ctx.userId, volumeId: volume.id, orderIndex: 1, orderInVolume: 1, title: '流放', content: '第一章合成正文' } })
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { chapterId: first.id } })
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt: '前 20 章优化' }), '前 20 章优化'))
    expect(spec.scope.writing?.kind).toBe('bounded')
    expect(spec.scope.writing?.targets).toHaveLength(20)
    expect(spec.scope.writing?.targets[0]).toEqual({ orderIndex: 1, chapterId: first.id })
  }))
  it('turns an unparsed numbered chapter request into needs_input instead of freezing the editor chapter', () => fixture('优化第 3 卷', async ctx => {
    const volume = await prisma.volume.findFirstOrThrow({ where: { novelId: ctx.novelId } })
    const chapter = await prisma.chapter.create({ data: { novelId: ctx.novelId, authorId: ctx.userId, volumeId: volume.id, orderIndex: 1, orderInVolume: 1, title: '当前编辑章', content: '当前正文' } })
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { chapterId: chapter.id } })
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt: '优化第 3 卷' }), '优化第 3 卷'))
    expect(spec.scope.writing).toMatchObject({ kind: 'needs_input', targets: [] })
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    await expect(prisma.$transaction(tx => assertWritingTarget(tx, ctx, { chapterId: chapter.id }))).rejects.toMatchObject({ code: 'SCOPE_NEEDS_INPUT' })
  }))
})
