import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
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
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { z } from 'zod'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

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
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, prompt }), prompt))
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
    const sourceMessageId = randomUUID()
    await prisma.agentMessage.create({ data: { id: sourceMessageId, sessionId: ctx.sessionId, runId: ctx.runId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { status: 'queued' } })
    await initializeDurableTask({ userId: ctx.userId, runId: ctx.runId, sourceMessageId })
    const lease = await acquireRunLease({ userId: ctx.userId, runId: ctx.runId, ownerId: 'scope-durable', claimId: randomUUID() })
    const args = { title: '第一章', position: 1 }
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: [{ type: 'function', function: { name: chapterCreateTool.name, description: chapterCreateTool.description, parameters: z.toJSONSchema(chapterCreateTool.parameters, { io: 'input' }) } }],
      toolAuthority: [{ name: chapterCreateTool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: null, toolCalls: [{ id: 'scope-durable-create', name: chapterCreateTool.name, arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
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
    expect(reused.display).toMatchObject({ kind: 'chapterDiff', before: next.content, after: next.content })
    expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(2)
    await expect(prisma.$transaction(tx => assertWritingTarget(tx, { ...ctx, userId: randomUUID() }, { chapterId: next.id }))).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { status: 'paused' } })
    await expect(prisma.$transaction(tx => assertWritingTarget(tx, ctx, { chapterId: next.id }))).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: next.id } })).content).toBe(next.content)
  }))
})
