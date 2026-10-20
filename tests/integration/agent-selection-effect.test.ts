import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { freezeWritingScope, assertWritingTarget, readWritingScope } from '../../api/lib/agent/writing-scope.js'
import { probeChapterReviewRevision } from '../../api/lib/agent/chapter-review-guard.js'
import { chapterEditRangeTool, chapterWriteTool, chapterAppendTool, chapterRenameTool, chapterCreateTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { acquireRunLease } from '../../api/lib/agent/runtime-lease.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { volumeListTool, volumeCreateTool, volumeUpdateTool } from '../../api/lib/agent/tools/structure-tools.js'
import { storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { changeSetApplyTool, changeSetRollbackTool } from '../../api/lib/agent/tools/changeset-tools.js'
import { previewBulkReplaceData, applyChangeSetData } from '../../api/lib/data/changeset.js'
import { bulkReplacePreviewRequestSchema } from '../../shared/contracts/index.js'
import { z } from 'zod'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { buildHumanityQualityContext, persistHumanityQualityReport, qualityReviewContextHash } from '../../api/lib/agent/humanity-quality.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(() => prisma.$disconnect())
const body = '前😀段。\n选段甲。重复。\n尾段。重复。'
const start = body.indexOf('选段甲'), end = body.indexOf('\n尾段')
const prompt = '修改第一章选区，优化所选文字'

async function fixture(mode: 'legacy' | 'durable', work: (ctx: ToolContext, spec: Awaited<ReturnType<typeof freezeWritingScope>>,
  invoke: (tool: typeof chapterEditRangeTool, args: Record<string, unknown>) => Promise<unknown>,
  lease?: Awaited<ReturnType<typeof acquireRunLease>>) => Promise<void>, legacy = false, naturalPrompt?: string) {
  const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID(), runId = randomUUID(), chapterId = randomUUID(), volumeId = randomUUID()
  try {
    await prisma.user.create({ data: { id: userId, nickname: 'selection-synthetic', passwordHash: 'test-only' } })
    await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '选区测试', slug: `selection-${novelId}`, summary: 'test-only' } })
    await prisma.volume.create({ data: { id: volumeId, novelId, title: '第一卷', orderIndex: 1 } })
    await prisma.chapter.create({ data: { id: chapterId, novelId, authorId: userId, volumeId, title: '原名', content: body, wordCount: body.length, orderIndex: 1, orderInVolume: 1 } })
    await prisma.agentSession.create({ data: { id: sessionId, userId, novelId, title: 'selection-synthetic' } })
    await prisma.agentRun.create({ data: { id: runId, sessionId, userId, novelId, chapterId, status: mode === 'durable' ? 'queued' : 'running', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator',
      startRequest: naturalPrompt ? { prompt: naturalPrompt } : { prompt, selection: { start, end, text: body.slice(start, end) } } } })
    const ctx: ToolContext = { userId, novelId, sessionId, runId, chapterId, callId: 'selection-call', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', emit: () => {}, signal: new AbortController().signal,
      toolAuthority: new Map(['chapter_edit_range', 'chapter_write', 'chapter_append', 'chapter_rename'].map(name => [name, { permission: 'allow', alwaysConfirm: false, dangerous: false }])) }
    const initial = buildTaskSpec({ runId, novelId, chapterId, prompt: naturalPrompt ?? prompt,
      ...(naturalPrompt ? { localEditProtocol: 1 as const, reviewProtocol: 1 as const } : { selection: { start, end }, manuscriptProtocol: 1 as const }) })
    if (legacy) delete initial.scope.manuscriptProtocol
    if (legacy) delete initial.scope.localEditProtocol
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, initial, naturalPrompt ?? prompt))
    await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    let lease: Awaited<ReturnType<typeof acquireRunLease>> | undefined
    if (mode === 'durable') {
      const sourceMessageId = randomUUID()
      await prisma.agentMessage.create({ data: { id: sourceMessageId, sessionId, runId, role: 'user', parts: [{ type: 'text', text: naturalPrompt ?? prompt }] } })
      await initializeDurableTask({ userId, runId, sourceMessageId })
      lease = await acquireRunLease({ userId, runId, ownerId: 'selection-synthetic', claimId: randomUUID() })
    }
    const invoke = async (tool: typeof chapterEditRangeTool, args: Record<string, unknown>) => {
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })
      const effectCtx = lease ? { ...ctx, durableContent: { lease, operationKey: randomUUID(), chapterId, expectedRevision: chapter.revision } } : ctx
      return tool.execute(effectCtx, tool.parameters.parse(args))
    }
    await work(ctx, spec, invoke, lease)
    expect(await prisma.agentProviderAttempt.count({ where: { runId } })).toBe(0)
  } finally {
    await prisma.$transaction(async tx => {
      await tx.memoryExtractionJob.deleteMany({ where: { novelId, novel: { authorId: userId } } })
      await tx.projectMemoryEntry.deleteMany({ where: { novelId, novel: { authorId: userId } } })
      await tx.agentRun.deleteMany({ where: { userId } })
      await tx.agentSession.deleteMany({ where: { userId } })
      await tx.chapter.deleteMany({ where: { novelId, authorId: userId } })
      await tx.novel.deleteMany({ where: { id: novelId, authorId: userId } })
      await tx.user.deleteMany({ where: { id: userId } })
    })
  }
}

describe.skipIf(!available)('versioned original author selection effect', () => {
  it.each((['legacy', 'durable'] as const).flatMap(mode => (['selection', 'local'] as const).map(scope => ({ mode, scope }))))(
    'coalesces same-address net changes for $scope via $mode', ({ mode, scope }) => fixture(mode, async (ctx, _spec, invoke) => {
      await invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, patches: [{ oldText: '选', newText: '选新' }, { oldText: '段甲', newText: '增段甲' }] })
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).content).toBe(body.replace('选段甲', '选新增段甲'))
      await invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, patches: [{ oldText: '新', newText: '新添' }, { oldText: '增', newText: '换' }] })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toMatchObject({ content: body.replace('选段甲', '选新添换段甲'), revision: 2 })
    }, false, scope === 'local' ? '只润色第一章第二段' : undefined))
  it.each(['legacy', 'durable'] as const)('uses actual effects for copied context and boundary insertions via %s', mode => fixture(mode, async (ctx, _spec, invoke) => {
    await invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, oldText: body, newText: body.replace('选段甲', '选段乙') })
    const first = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
    expect(first.content).toBe(body.replace('选段甲', '选段乙'))
    await invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, oldText: '选段乙。重复。', newText: '新选段乙。重复。' })
    const current = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
    expect(current).toMatchObject({ content: body.replace('选段甲', '新选段乙'), revision: 2 })
    await expect(invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, oldText: current.content,
      newText: current.content.replace('前😀段', '改动前段').replace('选段乙', '选段丙') })).rejects.toMatchObject({ code: 'AUTHOR_SELECTION_SCOPE' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(current)
  }))
  it.each(['legacy', 'durable'] as const)('freezes prose locality and permits ten ordinary edits/atomic batches/no-op via %s', mode => fixture(mode, async (ctx, spec, invoke) => {
    expect(spec.scope.selection).toBeUndefined()
    expect(spec.scope.localEditBoundary).toMatchObject({ kind: 'bounded', regions: [{ chapterId: ctx.chapterId, start, end }] })
    const compiler = await import('../../api/lib/agent/story-compiler.js')
    // This is binding/prepare authority, not a body or metadata effect.
    await expect(compiler.prepareStoryCompilation({ ...ctx, chapterId: ctx.chapterId!, mode: 'balanced', intentSummary: '原作者局部修改' })).resolves.toBeTruthy()
    let oldText = '选段甲'
    for (let index = 0; index < 10; index++) {
      const newText = `片段第${index}轮😀`
      await invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, oldText, newText })
      oldText = newText
    }
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
    await invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, oldText, newText: oldText })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(before)
    await invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, patches: [
      { oldText, newText: '片段更新' }, { oldText: '。重复。\n尾段', newText: '跨出冻结范围' },
    ] }).then(() => { throw new Error('mixed batch must fail') }, error => expect(error).toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' }))
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(before)
    await invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, patches: [{ oldText: '片段第', newText: '新' }, { oldText: '9轮😀', newText: '片段' }] })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toMatchObject({ revision: 12,
      content: `${body.slice(0, start)}新片段。重复。${body.slice(end)}` })
    expect(await prisma.$transaction(tx => probeChapterReviewRevision(tx, ctx, before))).toMatchObject({ open: false, code: 'AUTHOR_LOCAL_SCOPE' })
  }, false, '只润色第一章第二段'))

  it.each(['legacy', 'durable'] as const)('denies local wholebody/metadata/append/outside/coordinates/ambiguous/formatting bypass via %s', mode => fixture(mode, async (ctx, _spec, invoke) => {
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
    const novel = await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })
    for (const tool of [chapterWriteTool, chapterAppendTool]) await expect(invoke(tool, { chapterId: ctx.chapterId, content: body })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    for (const args of [{ oldText: '前😀段', newText: '前😀段' }, { oldText: body, newText: '覆盖' }]) {
      await expect(invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, ...args })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    }
    for (const [args, code] of [
      [{ start, end, newText: '猜定位' }, 'AUTHOR_LOCAL_SCOPE'],
      [{ oldText: '重复。', newText: '猜出现' }, 'CHAPTER_ANCHOR_CONFLICT'],
      [{ oldText: '选段甲。重复。尾段', newText: '去换行匹配' }, 'CHAPTER_ANCHOR_CONFLICT'],
    ] as const) {
      if (mode === 'legacy') expect(await invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, ...args })).toMatchObject({ outcome: 'failed', failureCode: code })
      else await expect(invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, ...args })).rejects.toMatchObject({ code })
    }
    await expect(chapterRenameTool.execute(ctx, { chapterId: ctx.chapterId!, title: '越权' })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    await expect(chapterCreateTool.execute(ctx, { title: '越权' })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    const preview = await previewBulkReplaceData(ctx.userId, ctx.novelId, bulkReplacePreviewRequestSchema.parse({ query: '重复', replacement: '越权', fields: ['content'], reason: '合成预览' }))
    const change = await prisma.changeSet.findUniqueOrThrow({ where: { id: preview.id } })
    await expect(changeSetApplyTool.execute(ctx, { changeSetId: preview.id })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    expect(await prisma.changeSet.findUniqueOrThrow({ where: { id: preview.id } })).toEqual(change)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(before)
    expect(await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })).toEqual(novel)
    expect(await prisma.memoryExtractionJob.count({ where: { novelId: ctx.novelId } })).toBe(0)
    await applyChangeSetData(ctx.userId, preview.id, {}) // independent direct author action
    const applied = await prisma.changeSet.findUniqueOrThrow({ where: { id: preview.id } })
    const appliedChapter = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
    await expect(changeSetRollbackTool.execute(ctx, { changeSetId: preview.id })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    expect(await prisma.changeSet.findUniqueOrThrow({ where: { id: preview.id } })).toEqual(applied)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(appliedChapter)
  }, false, '只润色第一章第二段'))

  it('retains prose-local scope through a continuation/child and intersects an actual editor selection', () => fixture('legacy', async (ctx, spec, invoke) => {
    const childSession = await prisma.agentSession.create({ data: { userId: ctx.userId, novelId: ctx.novelId, title: 'local child', spawnedFromRunId: ctx.runId, spawnedFromSessionId: ctx.sessionId } })
    const continuation = await prisma.agentRun.create({ data: { sessionId: ctx.sessionId, userId: ctx.userId, novelId: ctx.novelId, chapterId: ctx.chapterId,
      status: 'running', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value, startRequest: { prompt: '继续，重写整章' } } })
    const child = await prisma.agentRun.create({ data: { sessionId: childSession.id, userId: ctx.userId, novelId: ctx.novelId, chapterId: ctx.chapterId,
      status: 'running', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', startRequest: { prompt: '模型总结授权全章' } } })
    for (const run of [continuation, child]) {
      const next = { ...ctx, runId: run.id, sessionId: run.sessionId }
      expect((await readWritingScope(prisma, next)).spec).toMatchObject({ scope: { localEditBoundary: spec.scope.localEditBoundary } })
      await expect(chapterWriteTool.execute(next, { chapterId: ctx.chapterId!, content: '扩大范围' })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    }
    const fresh = buildTaskSpec({ ...ctx, prompt: '只润色第二段', localEditProtocol: 1, manuscriptProtocol: 1, reviewProtocol: 1,
      selection: { start, end: start + 3 } })
    const intersection = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, fresh, '模型计划扩大范围'))
    expect(intersection.scope.localEditBoundary).toEqual(spec.scope.localEditBoundary)
    expect(intersection.scope.selectionBoundary).toMatchObject({ start, end: start + 3 })
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(intersection))).value } })
    await expect(invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, oldText: '选段甲。重复。', newText: '本段内但选区外' })).rejects.toMatchObject({ code: 'AUTHOR_SELECTION_SCOPE' })
    await invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, oldText: '选段甲', newText: '合法交集' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toMatchObject({ content: body.replace('选段甲', '合法交集'), revision: 2 })
  }, false, '只润色第二段，其余不要改'))

  it('preserves exact local receipts before reauthorization; a new operation cannot inherit them', () => fixture('durable', async (ctx, _spec, _invoke, lease) => {
    const capability = { lease: lease!, operationKey: 'exact-local-receipt', chapterId: ctx.chapterId!, expectedRevision: 1 }
    const args = { chapterId: ctx.chapterId!, oldText: '选段甲', newText: '合法新片段' }
    const saved = await chapterEditRangeTool.execute({ ...ctx, durableContent: capability }, args)
    await prisma.chapter.update({ where: { id: ctx.chapterId! }, data: { content: body.replace('前😀段', '作者另改前段'), revision: { increment: 1 } } })
    const current = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
    expect(await chapterEditRangeTool.execute({ ...ctx, durableContent: capability }, args)).toEqual(saved)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(current)
    await expect(chapterEditRangeTool.execute({ ...ctx, durableContent: { ...capability, operationKey: 'new-local-effect', expectedRevision: current.revision } }, args)).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_STALE' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(current)
    expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: lease!.taskRootId } } })).toBe(1)
  }, false, '修改第一章第二段'))

  it.each(['chapter_write', 'chapter_append', 'chapter_rename', 'chapter_create', 'volume_create'])(
    'receipts local cursor denial of %s and reaches the next allowed read without budget effects', action => fixture('durable', async (ctx, _spec, _invoke, lease) => {
      const tools = [chapterReadTool, volumeListTool, chapterWriteTool, chapterAppendTool, chapterRenameTool, chapterCreateTool, volumeCreateTool]
      const before = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
      const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: lease!.taskRootId } })
      const args = ['chapter_create', 'volume_create'].includes(action) ? { title: '不允许新建' }
        : action === 'chapter_rename' ? { chapterId: ctx.chapterId, title: '不允许改名' } : { chapterId: ctx.chapterId, content: '不允许覆盖追加' }
      await initializeExecutionState(lease!, {
        configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
          model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
          tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
          toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          successfulToolSignatures: [], messages: [{ role: 'user', content: '只修改第二段' }, { role: 'assistant', content: null, toolCalls: [
            { id: 'read-before', name: chapterReadTool.name, arguments: JSON.stringify({ chapterId: ctx.chapterId }) }, { id: 'volumes-before', name: volumeListTool.name, arguments: '{}' },
            { id: 'denied', name: action, arguments: JSON.stringify(args) }, { id: 'read-after', name: chapterReadTool.name, arguments: JSON.stringify({ chapterId: ctx.chapterId }) },
          ] }] },
      })
      await executeDurableToolStep(lease!, ctx.signal)
      await executeDurableToolStep(lease!, ctx.signal)
      expect(await executeDurableToolStep(lease!, ctx.signal)).toMatchObject({ kind: 'tool', result: { outcome: 'failed', output: expect.stringContaining('局部') } })
      expect(await executeDurableToolStep(lease!, ctx.signal)).toMatchObject({ kind: 'tool' })
      expect(await executeDurableToolStep(lease!, ctx.signal)).toEqual({ kind: 'idle' })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(before)
      expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(1)
      expect(await prisma.volume.count({ where: { novelId: ctx.novelId } })).toBe(1)
      expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: lease!.taskRootId } })).toEqual(budget)
      const receipt = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: lease!.taskRootId, action }, include: { effectReceipt: true } })
      expect(receipt).toMatchObject({ status: 'failed', effectReceipt: { result: { code: 'AUTHOR_LOCAL_SCOPE' } } })
      expect((await loadExecutionState(ctx.userId, ctx.runId)).frame.state.messages.filter(message => message.role === 'tool' && message.toolCallId === 'denied')).toHaveLength(1)
    }, false, '只润色第二段'))

  it.each(['修改第一章结尾', '只修改这段，其余保持不变', '修改第一章“重复。”', '先局部润色第一章，然后重写整章',
    '只修改第二段里的“选段甲”', '只修改第二段的前三个字'])(
    'freezes unprovable locality with zero body effects: %s', request => fixture('legacy', async (ctx, spec, invoke) => {
      expect(spec.scope.localEditBoundary).toMatchObject({ kind: 'needs_input', regions: [] })
      const before = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
      await expect(invoke(chapterWriteTool, { chapterId: ctx.chapterId, content: '模型摘要授权全章' })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
      await expect(invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, oldText: '选段甲', newText: '模型猜范围' })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(before)
    }, false, request))

  it.each(['legacy', 'durable'] as const)('never opts old frozen prose requests into a new interpretation via %s', mode => fixture(mode, async (ctx, spec, invoke) => {
    expect(spec.scope.localEditProtocol).toBeUndefined()
    expect(spec.scope.localEditBoundary).toBeUndefined()
    await invoke(chapterWriteTool, { chapterId: ctx.chapterId, content: '旧合同仍走原普通作者编辑协议' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toMatchObject({ revision: 2 })
  }, true, '修改第一章第二段'))

  it('allows an original quoted author edit after a critic report without spending automatic allowance', () => fixture('legacy', async (ctx, spec, invoke) => {
    expect(spec.scope.localEditBoundary).toMatchObject({ kind: 'bounded', regions: [{ start, end: start + 3 }] })
    const report = await persistHumanityQualityReport({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, chapterId: ctx.chapterId!, chapterRevision: 1,
      mode: 'balanced', deterministicMetrics: {}, deterministicFindings: [], criticComplete: true, criticFindings: [] })
    await invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, oldText: '选段甲', newText: '准确的新片段' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toMatchObject({ content: body.replace('选段甲', '准确的新片段'), revision: 2 })
    expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: report.id }, include: { findings: true } })).toEqual(report)
    expect(await prisma.agentProviderAttempt.count({ where: { runId: ctx.runId } })).toBe(0)
  }, false, '将“选段甲”改为“准确的新片段”'))

  it.each(['legacy', 'durable'] as const)('retains readonly quality findings for another owned chapter via %s without acquiring write scope', mode => fixture(mode, async (ctx, _spec, _invoke, lease) => {
    const first = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
    const other = await prisma.chapter.create({ data: { authorId: ctx.userId, novelId: ctx.novelId, volumeId: first.volumeId,
      orderIndex: 2, orderInVolume: 2, title: '只读检查对象', content: '他把钥匙交给守门人，然后沿着山路上去。', revision: 1 } })
    const report = await persistHumanityQualityReport({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, chapterId: other.id, chapterRevision: 1,
      mode: 'balanced', deterministicMetrics: {}, deterministicFindings: [], criticComplete: true,
      criticFindings: [{ signal: 'emotion_grounding', severity: 'advisory', quote: '他把钥匙交给守门人', explanation: '缺少动作细节', suggestion: '可补充动作', confidence: 0.9 }] })
    const bundle = await buildHumanityQualityContext(ctx.userId, ctx.novelId, other.id, ctx.runId)
    await prisma.chapterQualityReport.update({ where: { id: report.id }, data: { deterministicMetrics: { ...(report.deterministicMetrics as object), qualityContextHash: qualityReviewContextHash(bundle) } } })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected provider call'))
    try {
      if (mode === 'legacy') {
        const result = await qualityAnalyzeTool.execute({ ...ctx, creativeFreedom: 'bold' }, { chapterId: other.id })
        expect(result.output).toContain('原选区只授权精确片段工具')
        expect(result.output).toContain(report.id)
      } else {
        const tools = [chapterReadTool, qualityAnalyzeTool]
        await initializeExecutionState(lease!, {
          configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'bold', qualityMode: 'balanced',
            model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
            tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
            toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
          snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
            successfulToolSignatures: [], messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: null, toolCalls: [
              { id: 'read-other', name: chapterReadTool.name, arguments: JSON.stringify({ chapterId: other.id }) },
              { id: 'quality-other', name: qualityAnalyzeTool.name, arguments: JSON.stringify({ chapterId: other.id }) },
            ] }] },
        })
        await executeDurableToolStep(lease!, ctx.signal)
        const result = await executeDurableToolStep(lease!, ctx.signal)
        expect(result).toMatchObject({ kind: 'tool', result: { output: expect.stringContaining('原选区只授权精确片段工具') } })
        expect((await loadExecutionState(ctx.userId, ctx.runId)).frame.state.phase).toBe('idle')
        const operation = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: lease!.taskRootId, action: 'quality_analyze' }, include: { effectReceipt: true } })
        expect(operation).toMatchObject({ status: 'succeeded', effectReceipt: { result: { toolResult: { output: expect.stringContaining(report.id) } } } })
      }
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally { fetchSpy.mockRestore() }
    expect(await prisma.chapterQualityReport.count({ where: { runId: ctx.runId } })).toBe(1)
    expect(await prisma.qualityFinding.count({ where: { reportId: report.id } })).toBe(1)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: other.id } })).toEqual(other)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(first)
  }))

  it.each(['chapter_create', 'volume_create', 'volume_update', 'story_compiler_prepare', 'chapter_rename', 'chapter_write', 'chapter_append', 'chapter_edit_range'] as const)(
    'receipts a real cursor denial of %s once and reaches the next permitted read', action => fixture('durable', async (ctx, _spec, _invoke, lease) => {
      const volume = await prisma.volume.findFirstOrThrow({ where: { novelId: ctx.novelId } })
      const before = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
      const tools = [chapterReadTool, volumeListTool, chapterCreateTool, volumeCreateTool, volumeUpdateTool, storyCompilerPrepareTool,
        chapterRenameTool, chapterWriteTool, chapterAppendTool, chapterEditRangeTool]
      const args = action === 'chapter_create' || action === 'volume_create' ? { title: '不允许创建' }
        : action === 'volume_update' ? { volumeId: volume.id, title: '不允许改卷' }
        : action === 'story_compiler_prepare' ? { targetOrderIndex: 2, intentSummary: '模型打算写下一章' }
        : action === 'chapter_rename' ? { chapterId: ctx.chapterId, title: '不允许改名' }
        : action === 'chapter_edit_range' ? { chapterId: ctx.chapterId, oldText: '尾段', newText: '不允许改尾段' }
        : { chapterId: ctx.chapterId, content: '不允许整章或追加' }
      const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: lease!.taskRootId } })
      await initializeExecutionState(lease!, {
        configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
          model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
          tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
          toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          successfulToolSignatures: [], messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: null, toolCalls: [
            { id: 'read', name: chapterReadTool.name, arguments: JSON.stringify({ chapterId: ctx.chapterId }) },
            { id: 'volumes', name: volumeListTool.name, arguments: '{}' },
            { id: 'denied', name: action, arguments: JSON.stringify(args) },
            { id: 'read-after', name: chapterReadTool.name, arguments: JSON.stringify({ chapterId: ctx.chapterId }) },
          ] }] },
      })
      for (let step = 0; step < 4; step++) await executeDurableToolStep(lease!, ctx.signal)
      expect(await executeDurableToolStep(lease!, ctx.signal)).toEqual({ kind: 'idle' })
      const operations = await prisma.agentOperation.findMany({ where: { taskRootId: lease!.taskRootId, action }, include: { effectReceipt: true } })
      expect(operations).toHaveLength(1)
      expect(operations[0]).toMatchObject({ status: 'failed', effectReceipt: { result: { code: 'AUTHOR_SELECTION_SCOPE' } } })
      const state = (await loadExecutionState(ctx.userId, ctx.runId)).frame.state
      expect(state.phase).toBe('idle')
      expect(state.messages.filter(message => message.role === 'tool' && message.toolCallId === 'denied')).toHaveLength(1)
      expect(state.messages.filter(message => message.role === 'tool' && message.toolCallId === 'read-after')).toHaveLength(1)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(before)
      expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(1)
      expect(await prisma.volume.findMany({ where: { novelId: ctx.novelId } })).toEqual([volume])
      expect(await prisma.storyCompilation.count({ where: { novelId: ctx.novelId } })).toBe(0)
      expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: lease!.taskRootId } })).toEqual(budget)
    }))

  it('rejects actual changeset apply and rollback without changing saved validation or rebase metadata', () => fixture('legacy', async ctx => {
    const preview = await previewBulkReplaceData(ctx.userId, ctx.novelId, bulkReplacePreviewRequestSchema.parse({ query: '重复', replacement: '改过', fields: ['content'], reason: '独立作者预览' }))
    const query = { where: { id: preview.id }, include: { patches: { orderBy: { id: 'asc' as const } } } }
    const before = await prisma.changeSet.findUniqueOrThrow(query)
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
    await expect(changeSetApplyTool.execute(ctx, { changeSetId: preview.id })).rejects.toMatchObject({ code: 'AUTHOR_SELECTION_SCOPE' })
    expect(await prisma.changeSet.findUniqueOrThrow(query)).toEqual(before)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(chapter)
    // Apply as a separate direct human action, then verify this selected agent
    // still cannot roll it back or overwrite its existing validation metadata.
    await applyChangeSetData(ctx.userId, preview.id, {})
    const applied = await prisma.changeSet.findUniqueOrThrow(query)
    const appliedChapter = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
    await expect(changeSetRollbackTool.execute(ctx, { changeSetId: preview.id })).rejects.toMatchObject({ code: 'AUTHOR_SELECTION_SCOPE' })
    expect(await prisma.changeSet.findUniqueOrThrow(query)).toEqual(applied)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(appliedChapter)
  }))

  it.each(['legacy', 'durable'] as const)('preserves outside UTF-16 text across ten legal edits and an inert no-op via %s', mode => fixture(mode, async (ctx, spec, invoke) => {
    expect(spec.scope.selectionBoundary).toMatchObject({ version: 1, chapterId: ctx.chapterId, revision: 1, start, end, prefix: body.slice(0, start), suffix: body.slice(end) })
    let oldText = '选段甲'
    for (let i = 0; i < 10; i++) {
      const newText = `选段第${i}次修订`
      await invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, oldText, newText })
      oldText = newText
    }
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
    expect(before).toMatchObject({ revision: 11, content: `${body.slice(0, start)}${oldText}。重复。${body.slice(end)}` })
    await invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, oldText, newText: oldText })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(before)
    expect((await readWritingScope(prisma, ctx)).spec).toMatchObject({ scope: { selectionBoundary: spec.scope.selectionBoundary } })
    const probe = await prisma.$transaction(tx => probeChapterReviewRevision(tx, ctx, before))
    expect(probe).toMatchObject({ open: false, code: 'AUTHOR_SELECTION_SCOPE' })
  }))

  it.each(['legacy', 'durable'] as const)('rejects whole/append, outside/no-op, crossing, mixed and ambiguous batches atomically via %s', mode => fixture(mode, async (ctx, _spec, invoke) => {
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
    for (const [tool, args, code] of [
      [chapterWriteTool, { content: body }, 'AUTHOR_SELECTION_SCOPE'],
      [chapterAppendTool, { content: '追加' }, 'AUTHOR_SELECTION_SCOPE'],
      [chapterEditRangeTool, { oldText: '前😀段', newText: '前😀段' }, 'AUTHOR_SELECTION_SCOPE'],
      [chapterEditRangeTool, { start: start - 1, end: start + 2, newText: '越界' }, 'AUTHOR_SELECTION_SCOPE'],
      [chapterEditRangeTool, { patches: [{ oldText: '选段甲', newText: '合法' }, { oldText: '尾段', newText: '越界' }] }, 'AUTHOR_SELECTION_SCOPE'],
      [chapterEditRangeTool, { oldText: '重复。', newText: '不得猜选中出现' }, 'CHAPTER_ANCHOR_CONFLICT'],
    ] as const) {
      const attempt = invoke(tool, { chapterId: ctx.chapterId, ...args })
      // Legacy anchor conflicts are projected as failures; other rejected
      // effects throw before CAS. Durable adapters without a cursor throw.
      if (mode === 'legacy' && code === 'CHAPTER_ANCHOR_CONFLICT') expect(await attempt).toMatchObject({ outcome: 'failed', failureCode: code })
      else await expect(attempt).rejects.toMatchObject({ code })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(before)
    }
    await expect(chapterRenameTool.execute(ctx, { chapterId: ctx.chapterId!, title: '改名' })).rejects.toMatchObject({ code: 'AUTHOR_SELECTION_SCOPE' })
    await expect(chapterCreateTool.execute(ctx, { title: '额外章节' })).rejects.toMatchObject({ code: 'AUTHOR_SELECTION_SCOPE' })
    await expect(prisma.$transaction(tx => assertWritingTarget(tx, ctx, { chapterId: ctx.chapterId!, effect: 'changeset' }))).rejects.toMatchObject({ code: 'AUTHOR_SELECTION_SCOPE' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(before)
    expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(1)
  }))

  it.each(['legacy', 'durable'] as const)('rejects rebinding after an outside edit even when current revision was reread via %s', mode => fixture(mode, async (ctx, _spec, invoke) => {
    await prisma.chapter.update({ where: { id: ctx.chapterId! }, data: { content: body.replace('前😀段', '作者改过前段'), revision: { increment: 1 } } })
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })
    await expect(invoke(chapterEditRangeTool, { chapterId: ctx.chapterId, oldText: '选段甲', newText: '不能沿用' })).rejects.toMatchObject({ code: 'AUTHOR_SELECTION_STALE' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toEqual(before)
  }))

  it('retains original scope through continuation and a child whose generated brief widens it', () => fixture('legacy', async (ctx, spec) => {
    const childSession = await prisma.agentSession.create({ data: { userId: ctx.userId, novelId: ctx.novelId, title: 'child', spawnedFromRunId: ctx.runId, spawnedFromSessionId: ctx.sessionId } })
    const continuation = await prisma.agentRun.create({ data: { sessionId: ctx.sessionId, userId: ctx.userId, novelId: ctx.novelId, chapterId: ctx.chapterId,
      status: 'running', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value, startRequest: { prompt: '继续，重写全章' } } })
    const child = await prisma.agentRun.create({ data: { sessionId: childSession.id, userId: ctx.userId, novelId: ctx.novelId, chapterId: ctx.chapterId,
      status: 'running', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', startRequest: { prompt: '重写全章' } } })
    for (const run of [continuation, child]) {
      const next = { ...ctx, runId: run.id, sessionId: run.sessionId }
      expect((await readWritingScope(prisma, next)).spec).toMatchObject({ scope: { selectionBoundary: spec.scope.selectionBoundary } })
      await expect(chapterWriteTool.execute(next, { chapterId: ctx.chapterId!, content: '扩大范围' })).rejects.toMatchObject({ code: 'AUTHOR_SELECTION_SCOPE' })
    }
    const inherited = await prisma.$transaction(tx => freezeWritingScope(tx, { ...ctx, runId: child.id }, buildTaskSpec({ runId: child.id, novelId: ctx.novelId, chapterId: ctx.chapterId, prompt: '重写全章' }), '重写全章'))
    expect(inherited.scope).toEqual(spec.scope)
  }))

  it.each(['legacy', 'durable'] as const)('keeps old frozen selected protocol behavior through %s', mode => fixture(mode, async (ctx, spec, invoke) => {
    expect(spec.scope.manuscriptProtocol).toBeUndefined()
    expect(spec.scope.selectionBoundary).toBeUndefined()
    await invoke(chapterWriteTool, { chapterId: ctx.chapterId, content: '旧合同整章修改仍用原协议' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: ctx.chapterId! } })).toMatchObject({ revision: 2, content: '旧合同整章修改仍用原协议' })
  }, true))

  it('fails stale supplied selection text and out-of-bounds admission without saving a grant', () => fixture('legacy', async (ctx) => {
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: undefined, startRequest: { prompt, selection: { start, end, text: '旧文本' } } } })
    const fresh = buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, chapterId: ctx.chapterId, prompt, selection: { start, end }, manuscriptProtocol: 1 })
    await expect(prisma.$transaction(tx => freezeWritingScope(tx, ctx, fresh, prompt))).rejects.toMatchObject({ code: 'AUTHOR_SELECTION_STALE' })
    fresh.scope.selection!.end = body.length + 1
    await expect(prisma.$transaction(tx => freezeWritingScope(tx, ctx, fresh, prompt))).rejects.toMatchObject({ code: 'AUTHOR_SELECTION_STALE' })
    expect(() => buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, chapterId: ctx.chapterId, prompt, selection: { start }, manuscriptProtocol: 1 })).toThrow(expect.objectContaining({ code: 'AUTHOR_SELECTION_STALE' }))
  }))
})
