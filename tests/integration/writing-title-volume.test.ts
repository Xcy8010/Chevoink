import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as featureFlags from '../../api/lib/agent2-feature-flags.js'
import { prisma } from '../../api/lib/prisma.js'
import { available, fixture, claim } from '../support/agent-durable-runtime-fixture.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { freezeWritingScope } from '../../api/lib/agent/writing-scope.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { chapterCreateTool, chapterRenameTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { volumeCreateTool } from '../../api/lib/agent/tools/structure-tools.js'
import { prepareStoryCompilation, buildStoryCompilerDigest } from '../../api/lib/agent/story-compiler.js'
import { readWritingVolumeContext } from '../../api/lib/agent/writing-volume.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import type { WritingNewVolume } from '../../shared/contracts/writing-volume-contracts.js'
import { createChapterData, updateChapterData } from '../../api/lib/data/chapter.js'
import { splitChapterData } from '../../api/lib/data/volume.js'
import { previewBulkReplaceData, applyChangeSetData, rollbackChangeSetData } from '../../api/lib/data/changeset.js'
import { bulkReplacePreviewRequestSchema } from '../../shared/contracts/index.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { initializeExecutionState, loadExecutionState, saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { toOpenAITools } from '../../api/lib/agent/tools/registry.js'

const json = (value: unknown) => runtimeJson(JSON.parse(JSON.stringify(value))).value
const closing = '陈砚收起血印，案犯已交巡按；这场追查终于结案，黑石堡旧困局至此收束。'
type Base = Parameters<Parameters<typeof fixture>[0]>[0]
async function admission(f: Base, prompt = '写下一章', specTransform: (spec: ReturnType<typeof buildTaskSpec>) => ReturnType<typeof buildTaskSpec> = value => value) {
  const runId = randomUUID()
  const initial = specTransform(buildTaskSpec({ runId, novelId: f.novelId, chapterId: f.chapterId, prompt }))
  await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
    chapterId: f.chapterId, runtimeProtocolVersion: 0, status: 'running', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop',
    startRequest: { prompt }, taskSpec: json(initial) } })
  const ctx: ToolContext = { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, runId, chapterId: f.chapterId,
    callId: 'create', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
  const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, initial, prompt))
  await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: json(spec) } })
  return { ctx, spec }
}
async function newVolume(f: Base): Promise<WritingNewVolume> {
  const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: closing, wordCount: closing.length } })
  return { title: '第二卷 乱世聚沙', summary: '旧案收束后，在溃败边镇聚集流民建立立足点', boundary: {
    previousChapterId: chapter.id, previousRevision: chapter.revision, quote: closing, completedObjective: '追查通敌案并保住黑石堡', nextConflict: '边镇崩溃后安置流民并建立第一块立足点' } }
}
async function prepare(ctx: ToolContext, proposed?: WritingNewVolume) {
  return prepareStoryCompilation({ ...ctx, chapterId: undefined, targetOrderIndex: 2, mode: 'balanced', intentSummary: '先审视当前卷困局，再推进本章',
    volumeDecision: proposed ? { kind: 'new_volume', reason: '原卷旧案已结，下一章进入流民立足的新主困局', newVolume: proposed }
      : { kind: 'continue', reason: '旧困局尚未真实收束，本章继续推进' } })
}

describe.runIf(available)('plain title storage and frozen automatic tail-volume placement', () => {
  beforeEach(() => {
    const actual = featureFlags.isAgent2FeatureEnabled
    // Memory extraction has separate tests. Do not launch an unrelated paid
    // background worker while verifying title/placement transaction boundaries.
    vi.spyOn(featureFlags, 'isAgent2FeatureEnabled').mockImplementation((feature, userId) => feature !== 'memory2' && actual(feature, userId))
  })
  it('requires an explicit volume review in prepare and create, before any chapter or compilation effect', async () => fixture(async f => {
    const { ctx } = await admission(f)
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    await expect(prepareStoryCompilation({ ...ctx, chapterId: undefined, targetOrderIndex: 2, mode: 'balanced', intentSummary: '写下一章' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    await expect(chapterCreateTool.execute(ctx, { title: '继续原卷' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(1)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
    await prepare(ctx)
    const result = await chapterCreateTool.execute(ctx, { title: '第二章《继续》' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: result.observedState!.id } })).toMatchObject({ title: '继续', volumeId: before.volumeId })
  }))
  it.each(['foreign-run', 'changed-previous', 'new-decision-without-proposal'] as const)('a %s cannot authorize a default-volume create', async scenario => fixture(async f => {
    const proposed = await newVolume(f), { ctx } = await admission(f)
    if (scenario === 'foreign-run') {
      const other = await admission(f)
      await prepare(other.ctx)
    } else await prepare(ctx, scenario === 'new-decision-without-proposal' ? proposed : undefined)
    if (scenario === 'changed-previous') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 } } })
    await expect(chapterCreateTool.execute(ctx, { title: '不得悄然延续' })).rejects.toMatchObject({ code: scenario === 'changed-previous' ? 'AUTHOR_CHAPTER_SCOPE' : 'INVALID_ARGUMENTS' })
    expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(1)
    expect(await prisma.volume.count({ where: { novelId: f.novelId } })).toBe(1)
  }))
  it('manual create/update/publish and split save plain title without editing body or reader snapshot', async () => fixture(async f => {
    const body = '正文提到《史记》与第45章，逐字保留。'
    const created = await createChapterData(f.userId, f.novelId, { title: '第45章《火墙》', content: body, status: 'published', visibility: 'private' })
    expect(created).toMatchObject({ title: '火墙', content: body })
    const updated = await updateChapterData(f.userId, f.novelId, created.id, { title: '第46节〈读《史记》〉', expectedRevision: created.revision })
    expect(updated?.title).toBe('读《史记》')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ publishedTitle: '火墙', publishedContent: body, content: body })
    await expect(updateChapterData(f.userId, f.novelId, created.id, { title: '第47章《》', expectedRevision: updated!.revision })).rejects.toThrow()
    const split = await splitChapterData(f.userId, f.novelId, created.id, { expectedRevision: updated!.revision, splitOffset: 6, newChapterTitle: '第48章《定南》' })
    expect(split?.second.title).toBe('定南')
    expect(split!.first.content + split!.second.content).toBe(body)
    await expect(updateChapterData(f.userId, f.novelId, created.id, { title: '第99章 过期覆盖', expectedRevision: updated!.revision })).rejects.toMatchObject({ code: 'CHAPTER_REVISION_CONFLICT' })
  }))
  it('changeset title preview/apply agree and rollback restores the exact historical title', async () => fixture(async f => {
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { title: '第47章《火墙》' } })
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const preview = await previewBulkReplaceData(f.userId, f.novelId, bulkReplacePreviewRequestSchema.parse({ query: '火墙', replacement: '定南', fields: ['title'], reason: '明确标题格式修正' }))
    expect(preview.patches[0]).toMatchObject({ before: before.title, after: '定南', expectedRevision: before.revision })
    await applyChangeSetData(f.userId, preview.id, {})
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ title: '定南', content: before.content })
    await rollbackChangeSetData(f.userId, preview.id)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ title: before.title, content: before.content })
  }))
  it('Agent rename uses plain titles and refuses an empty result without changing the chapter', async () => fixture(async f => {
    const { ctx } = await admission(f, '修改本章标题')
    const renamed = await chapterRenameTool.execute(ctx, { chapterId: f.chapterId, title: '第47章《火墙》' })
    expect(renamed.summary).toContain('火墙')
    const saved = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    expect(saved).toMatchObject({ title: '火墙', content: '原文' })
    await expect(chapterRenameTool.execute(ctx, { chapterId: f.chapterId, title: '第47章〈〉' })).rejects.toMatchObject({ code: 'CHAPTER_RENAME_INVALID' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(saved)
  }))
  it('every prepare reads the volume goal and exposes saved-plan mismatch instead of a chapter-count threshold', async () => fixture(async f => {
    await prisma.volume.update({ where: { id: (await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).volumeId }, data: { title: '第二卷 雪压边墙', summary: '守住边堡并解除粮药困局' } })
    await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'chapterPlan', title: '原规划', content: '第二卷 乱世聚沙：收流民，建第一块立足点。', metadata: { savedAsPlan: true } } })
    const { ctx } = await admission(f)
    const result = await prepare(ctx)
    expect(result.compilation.preparedContext).toMatchObject({ volumeDecision: { kind: 'continue' }, volumeContext: { volumeTitle: '第二卷 雪压边墙', chapterCount: 1, summary: '守住边堡并解除粮药困局', planStatus: expect.stringContaining('尚无可执行') } })
    expect(await buildStoryCompilerDigest(f.userId, f.novelId, f.chapterId, ctx.runId)).toContain('绝非切卷阈值')
    const created = await chapterCreateTool.execute(ctx, { title: '第48章《定南》' })
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: created.observedState!.id } })).volumeId).toBe((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).volumeId)
    expect(await prisma.volume.count({ where: { novelId: f.novelId } })).toBe(1)
  }))
  it('real closure creates a new tail volume and chapter atomically; a changed proposal only reuses a bound identity', async () => fixture(async f => {
    const proposed = await newVolume(f)
    const { ctx, spec } = await admission(f)
    expect(spec.scope.writing?.tailVolume).toMatchObject({ targetOrderIndex: 2, previousChapterId: f.chapterId, previousRevision: 1 })
    const old = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    await prepare(ctx, proposed)
    const result = await chapterCreateTool.execute(ctx, { title: '第二章《聚沙》', content: '流民已到城下。', newVolume: proposed })
    const created = await prisma.chapter.findUniqueOrThrow({ where: { id: result.observedState!.id } })
    expect(created).toMatchObject({ title: '聚沙', orderIndex: 2, orderInVolume: 1 })
    expect(created.volumeId).not.toBe(old.volumeId)
    expect({ ...await prisma.chapter.findUniqueOrThrow({ where: { id: old.id } }), updatedAt: undefined }).toEqual({ ...old, updatedAt: undefined })
    const replay = await chapterCreateTool.execute({ ...ctx, callId: 'again' }, { title: '不同标题', newVolume: { ...proposed, title: '第三卷 不得新增' } })
    expect(replay.observedState!.id).toBe(created.id)
    expect(await prisma.volume.count({ where: { novelId: f.novelId } })).toBe(2)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: created.id } })).toEqual(created)
    await expect(volumeCreateTool.execute(ctx, { title: '独立越权新卷' })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
  }))
  it.each(['stale', 'quote', 'previous-id', 'same-conflict', 'old-freeze', 'fixed-volume', 'selection', 'title-only', 'readonly', 'protected', 'inline-child', 'missing-prepare'] as const)(
    '%s cannot widen chapter creation or change an existing chapter', async scenario => fixture(async f => {
      const proposed = await newVolume(f)
      const { ctx, spec } = await admission(f, scenario === 'fixed-volume' ? '写第一卷第二章' : scenario === 'title-only' ? '写下一章，只要标题和正文' : scenario === 'readonly' ? '写下一章，不得新建卷' : '写下一章',
        initial => scenario === 'selection' ? { ...initial, scope: { ...initial.scope, selection: { chapterId: f.chapterId, start: 0, end: 2 } } }
          : scenario === 'protected' ? { ...initial, scope: { ...initial.scope, chapterIds: [f.chapterId] }, postconditions: [{ code: 'EARLIER_CONTENT_UNCHANGED', description: '原文及结构保持不变', severity: 'error' }] } : initial)
      if (scenario === 'old-freeze') {
        const old = { ...spec, scope: { ...spec.scope, writing: { ...spec.scope.writing!, tailVolume: undefined } } }
        await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: json(old) } })
        expect((await prisma.$transaction(tx => freezeWritingScope(tx, ctx, old, '写下一章'))).scope.writing?.tailVolume).toBeUndefined()
      }
      if (scenario === 'inline-child') ctx.inlineChild = true
      if (['stale', 'quote', 'previous-id', 'same-conflict', 'selection', 'fixed-volume', 'title-only', 'readonly', 'protected', 'old-freeze'].includes(scenario)) {
        if (scenario === 'stale') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 } } })
        if (scenario === 'quote') proposed.boundary.quote = '不存在的收束原文，请勿臆造旧目标胜利'
        if (scenario === 'previous-id') proposed.boundary.previousChapterId = randomUUID()
        if (scenario === 'same-conflict') proposed.boundary.nextConflict = proposed.boundary.completedObjective
        await expect(prepare(ctx, proposed)).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
      } else {
        if (scenario !== 'missing-prepare') await prepare(ctx)
        const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
        await expect(chapterCreateTool.execute(ctx, { title: '新章', newVolume: proposed })).rejects.toMatchObject({ code: scenario === 'missing-prepare' ? 'INVALID_ARGUMENTS' : 'AUTHOR_CHAPTER_SCOPE' })
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
      }
      expect(await prisma.volume.count({ where: { novelId: f.novelId } })).toBe(1)
      expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(1)
    }))
  it('parallel creates share the frozen slot and leave all earlier positions unchanged', async () => fixture(async f => {
    const proposed = await newVolume(f), { ctx } = await admission(f)
    await prepare(ctx, proposed)
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const results = await Promise.all([chapterCreateTool.execute(ctx, { title: '第二章 聚沙', newVolume: proposed }),
      chapterCreateTool.execute({ ...ctx, callId: 'concurrent' }, { title: '第二章 聚沙别名', newVolume: proposed })])
    expect(results[0].observedState!.id).toBe(results[1].observedState!.id)
    expect(await prisma.volume.count({ where: { novelId: f.novelId } })).toBe(2)
    // Existing layout rewrite touches updatedAt while preserving every business field.
    expect({ ...await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } }), updatedAt: undefined }).toEqual({ ...before, updatedAt: undefined })
  }))
  it('an effect interruption rolls back the new volume, chapter and binding together', async () => fixture(async f => {
    const proposed = await newVolume(f), { ctx } = await admission(f)
    await prepare(ctx, proposed)
    await expect(prisma.$transaction(async tx => {
      await chapterCreateTool.execute({ ...ctx, transaction: tx }, { title: '第二章 聚沙', newVolume: proposed })
      throw new Error('synthetic rollback after create')
    })).rejects.toThrow('synthetic rollback after create')
    expect(await prisma.volume.count({ where: { novelId: f.novelId } })).toBe(1)
    expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(1)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).writingBindings).toBeNull()
  }))
  it('native durable create and rename preserve original frozen inputs and authentic receipts', async () => fixture(async f => {
    const proposed = await newVolume(f), { ctx, spec } = await admission(f)
    await prepare(ctx, proposed)
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { status: 'queued' } })
    const messageId = randomUUID()
    await prisma.agentMessage.create({ data: { id: messageId, runId: ctx.runId, sessionId: ctx.sessionId, role: 'user', parts: [{ type: 'text', text: '写下一章' }] } })
    await initializeDurableTask({ userId: f.userId, runId: ctx.runId, sourceMessageId: messageId })
    const lease = await claim(ctx)
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'f'.repeat(64) },
      tools: toOpenAITools([chapterCreateTool, chapterReadTool, chapterRenameTool], spec.scope), toolAuthority: [chapterCreateTool, chapterReadTool, chapterRenameTool].map(tool => ({ name: tool.name, permission: 'allow' as const, alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: '写下一章' }, { role: 'assistant', content: null, toolCalls: [
        { id: 'new', name: 'chapter_create', arguments: JSON.stringify({ title: '第二章《聚沙》', newVolume: proposed }) }] }], successfulToolSignatures: [] } })
    const result = await executeDurableToolStep(lease, ctx.signal)
    expect(result.kind).toBe('tool')
    if (result.kind !== 'tool') throw new Error('Expected durable create')
    expect(result.result.outcome).toBeUndefined()
    const receipt = await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: lease.taskRootId, action: 'chapter_create' } }, include: { operation: true } })
    expect(receipt.operation.inputSnapshot).toMatchObject({ input: { args: { title: '第二章《聚沙》' } } })
    const chapter = await prisma.chapter.findFirstOrThrow({ where: { novelId: f.novelId, orderIndex: 2 } })
    expect(chapter).toMatchObject({ title: '聚沙', orderInVolume: 1 })
    const state = await loadExecutionState(ctx.userId, ctx.runId)
    await saveExecutionState(lease, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash,
      snapshot: { ...state.frame.state, messages: [...state.frame.state.messages, { role: 'assistant', content: null, toolCalls: [
        { id: 'read-created', name: chapterReadTool.name, arguments: JSON.stringify({ chapterId: chapter.id }) },
        { id: 'rename-created', name: chapterRenameTool.name, arguments: JSON.stringify({ chapterId: chapter.id, title: '第3章《新困局》' }) }] }] } })
    expect((await executeDurableToolStep(lease, ctx.signal)).kind).toBe('tool')
    expect((await executeDurableToolStep(lease, ctx.signal)).kind).toBe('tool')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ title: '新困局', content: chapter.content })
    const rename = await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: lease.taskRootId, action: 'chapter_rename' } }, include: { operation: true } })
    expect(rename.operation.inputSnapshot).toMatchObject({ input: { args: { title: '第3章《新困局》' } } })
    expect(runtimeJson(rename.result).hash).toBe(rename.resultHash)
    expect(await prisma.volume.count({ where: { novelId: f.novelId } })).toBe(2)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: lease.taskRootId } } })).toBe(0)
    expect((await prisma.$transaction(tx => readWritingVolumeContext(tx, ctx, 2)))?.previousChapter.id).toBe(f.chapterId)
  }))
})
