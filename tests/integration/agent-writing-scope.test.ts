import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { assertWritingTarget, freezeWritingScope, readWritingScope } from '../../api/lib/agent/writing-scope.js'
import { chapterCreateTool, chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { acquireRunLease } from '../../api/lib/agent/runtime-lease.js'
import { initializeExecutionState } from '../../api/lib/agent/runtime-state.js'
import { loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { toOpenAITools } from '../../api/lib/agent/tools/registry.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { z } from 'zod'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { getCreatedChapter } from '../../api/lib/agent/baseline.js'
import * as volumeData from '../../api/lib/data/volume.js'
import { prepareStoryCompilation, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
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
    await prisma.agentRun.deleteMany({ where: { userId } })
    await prisma.agentSession.deleteMany({ where: { userId } })
    await prisma.chapter.deleteMany({ where: { authorId: userId } })
    await prisma.novel.deleteMany({ where: { id: novelId, authorId: userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
  }
}
describe.skipIf(!available)('atomic original chapter scope', () => {
  async function newDraftReview(ctx: ToolContext, prompt = '写第一章') {
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt }), prompt))
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const result = await chapterCreateTool.execute(ctx, { title: '合成事实检查章', content: '同一扇门已经锁上。随后他却说这扇门从未锁过。' })
    const chapterId = result.observedState!.id
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })
    const prepared = await prepareStoryCompilation({ ...ctx, chapterId, mode: 'balanced', intentSummary: prompt })
    await prisma.chapterBridge.update({ where: { compilationId: prepared.compilation.id }, data: { targetRevision: chapter.revision } })
    await prisma.sceneTask.create({ data: { userId: ctx.userId, novelId: ctx.novelId, compilationId: prepared.compilation.id, chapterId,
      ordinal: 1, purpose: '确认门锁', entryState: {}, goal: '打开门', obstacle: '门锁', choice: '找钥匙', cost: '等待', turn: '找到钥匙', exitState: {}, styleBudget: {} } })
    const compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
    const validation = { checkRounds: 1, autoRepairRounds: 0, independentCheck: 'complete', checkedChapterId: chapterId, checkedRevision: chapter.revision,
      errorCount: 1, warningCount: 0, findings: [{ signal: 'object', severity: 'error', evidence: '同一门锁着却从未锁门', suggestion: '保留锁门事实' }],
      coverage: compilerContinuityCoverage({ chapter, bridge: compilation.bridge, sceneTasks: compilation.sceneTasks, source: null }) }
    await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { stage: 'check', validation: runtimeJson(validation).value } })
    return { chapter, chapterId, compilation, spec, validation }
  }
  it('allows one original new-draft factual correction, preserves consumption through current CHECK and reprepare, and blocks other write tools', () => fixture('写第一章', async ctx => {
    const f = await newDraftReview(ctx)
    expect((await chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: '同一扇门已经锁上。他用钥匙打开门。' })).outcome).not.toBe('failed')
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilation.id } })
    expect(saved.validation).toMatchObject({ checkRounds: 1, autoRepairRounds: 0,
      newDraftRevision: { taskId: f.spec.id, chapterId: f.chapterId, checkedRevision: f.chapter.revision } })
    // A complete report for the revised body still cannot mint another patch.
    await prisma.chapterBridge.update({ where: { compilationId: f.compilation.id }, data: { targetRevision: chapter.revision } })
    await validateStoryContinuity({ ...ctx, compilationId: f.compilation.id, expectedChapterRevision: chapter.revision, independentCheck: 'complete', findings: [
      { signal: 'object', severity: 'error', evidence: '合成剩余事实冲突', suggestion: '交作者决定' },
    ] })
    const { chapterAppendTool, chapterEditRangeTool } = await import('../../api/lib/agent/tools/chapter-tools.js')
    for (const execute of [
      () => chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: '不应再整体修改。' }),
      () => chapterAppendTool.execute(ctx, { chapterId: f.chapterId, content: '不应追加。' }),
      () => chapterEditRangeTool.execute(ctx, { chapterId: f.chapterId, oldText: '打开门', newText: '不应再次局部修改' }),
    ]) await expect(execute()).rejects.toMatchObject({ code: 'REVIEW_AUTOMATION_STOPPED' })
    const reprepared = await prepareStoryCompilation({ ...ctx, chapterId: f.chapterId, mode: 'balanced', intentSummary: '写第一章' })
    expect(reprepared.compilation.validation).toMatchObject({ checkRounds: 1, newDraftRevision: { chapterId: f.chapterId } })
    await expect(chapterWriteTool.execute(ctx, { chapterId: f.chapterId, content: '重新准备也不能改。' })).rejects.toMatchObject({ code: 'REVIEW_AUTOMATION_STOPPED' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(chapter)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec).toEqual(runtimeJson(JSON.parse(JSON.stringify(f.spec))).value)
  }))
  it.each(['parent', 'child'] as const)('a %s correction consumes one shared canonical creation allowance across opposite execution lineage', writer => fixture('写第一章', async ctx => {
    const f = await newDraftReview(ctx)
    const session = await prisma.agentSession.create({ data: { userId: ctx.userId, novelId: ctx.novelId, title: 'synthetic-draft-child', spawnedFromRunId: ctx.runId, spawnedFromSessionId: ctx.sessionId } })
    const child = await prisma.agentRun.create({ data: { userId: ctx.userId, novelId: ctx.novelId, sessionId: session.id, status: 'running', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', startRequest: { prompt: 'generated brief is not authority' } } })
    const childCtx = { ...ctx, runId: child.id, sessionId: session.id, chapterId: f.chapterId }
    // Review evidence and the first writer are deliberately opposite.
    if (writer === 'parent') await prisma.storyCompilation.update({ where: { id: f.compilation.id }, data: { runId: child.id } })
    const subject = writer === 'parent' ? ctx : childCtx
    await chapterWriteTool.execute(subject, { chapterId: f.chapterId, content: '同一扇门已经锁上。他随后用钥匙开门。' })
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    await expect(chapterWriteTool.execute(writer === 'parent' ? childCtx : ctx, { chapterId: f.chapterId, content: '另一执行也不能再改。' })).rejects.toMatchObject({ code: 'REVIEW_AUTOMATION_STOPPED' })
    const prepared = await prepareStoryCompilation({ ...ctx, chapterId: f.chapterId, mode: 'balanced', intentSummary: '写第一章' })
    expect(prepared.compilation.validation).toMatchObject({ checkRounds: 1, newDraftRevision: { chapterId: f.chapterId } })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(chapter)
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
  it('repreparing a compiler after an authorized revision cannot permit another patch from abandoned evidence', () => fixture('写第一章并检查修复正文', async ctx => {
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
    await expect(chapterWriteTool.execute(ctx, { chapterId, content: '不应继续碎改。' })).rejects.toMatchObject({ code: 'REVIEW_REPAIR_RECHECK_REQUIRED' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })).toEqual(current)
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
    await expect(chapterWriteTool.execute(subject, { chapterId, content: '不应被另一条执行链覆盖。' })).rejects.toMatchObject({ code: rounds === 3 ? 'REVIEW_AUTOMATION_STOPPED' : 'REPAIR_NOT_AUTHORIZED' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })).toEqual(chapter)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(compilation)
    expect(await prisma.chapterQualityReport.count({ where: { novelId: ctx.novelId } })).toBe(0)
  }))
  it.each(['warning', 'stale-error', 'failed-check', 'exhausted'] as const)('blocks generic writes driven by %s without changing saved manuscript or review state', scenario => fixture('写第一章', async ctx => {
    const prompt = '写第一章'
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt }), prompt))
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const result = await chapterCreateTool.execute(ctx, { title: '合成连贯章', content: '合成原文保持连贯。' })
    const id = result.observedState!.id
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id } })
    const compilation = await prisma.storyCompilation.create({ data: { userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, chapterId: id,
      targetOrderIndex: 1, sourcePromptHash: 'a'.repeat(64), preparedContext: {}, stage: 'check', validation: {
        checkRounds: scenario === 'exhausted' ? 3 : 1,
        ...(scenario === 'failed-check' ? { independentCheck: 'unavailable' } : { independentCheck: 'complete', checkedRevision: scenario === 'stale-error' ? chapter.revision - 1 : chapter.revision,
          errorCount: scenario === 'warning' ? 0 : 1, warningCount: scenario === 'warning' ? 6 : 0 }),
      } } })
    const { chapterWriteTool, chapterAppendTool, chapterEditRangeTool } = await import('../../api/lib/agent/tools/chapter-tools.js')
    for (const execute of [
      () => chapterWriteTool.execute(ctx, { chapterId: id, content: '不应整体重写。' }),
      () => chapterAppendTool.execute(ctx, { chapterId: id, content: '不应追加修订。' }),
      () => chapterEditRangeTool.execute(ctx, { chapterId: id, oldText: '合成原文', newText: '不应碎片替换' }),
    ]) await expect(execute()).rejects.toMatchObject({ code: scenario === 'exhausted' ? 'REVIEW_AUTOMATION_STOPPED' : 'REPAIR_NOT_AUTHORIZED' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id } })).toEqual(chapter)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(compilation)
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
    const args = { title: '第一章', volumeOrder: 1, positionInVolume: 1 }
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
    const created = await chapterCreateTool.execute(ctx, { title: '第一章', position: 1 })
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
})
