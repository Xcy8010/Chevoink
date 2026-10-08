import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { assembleContext } from '../../api/lib/agent/context.js'
import { getAgentDefinition } from '../../api/lib/agent/agents.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { freezeWritingScope } from '../../api/lib/agent/writing-scope.js'
import * as volumeContext from '../../api/lib/agent/writing-volume.js'
import * as featureFlags from '../../api/lib/agent2-feature-flags.js'

describe.runIf(available)('real context assembly with and without a writing volume target', () => {
  beforeEach(() => {
    const actual = featureFlags.isAgent2FeatureEnabled
    vi.spyOn(featureFlags, 'isAgent2FeatureEnabled').mockImplementation((feature, userId) => feature === 'storyCompiler' || actual(feature, userId))
  })

  async function contextFixture(userId: string, withChapter: boolean, prompt: string) {
    const novel = await prisma.novel.create({ data: { authorId: userId, title: '普通对话真实上下文', slug: randomUUID(), summary: '' } })
    const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '围城', summary: '守住城门并查清粮道', orderIndex: 1 } })
    if (withChapter) await prisma.chapter.create({ data: { authorId: userId, novelId: novel.id, volumeId: volume.id,
      title: '夜守', content: '城门尚未打开，粮道依然被封。', wordCount: 15, orderIndex: 1, orderInVolume: 1 } })
    const session = await prisma.agentSession.create({ data: { userId, novelId: novel.id, title: '问候' } })
    const runId = randomUUID()
    const initial = buildTaskSpec({ runId, novelId: novel.id, chapterId: null, prompt })
    await prisma.agentRun.create({ data: { id: runId, userId, novelId: novel.id, sessionId: session.id, chapterId: null,
      runtimeProtocolVersion: 0, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: 'running',
      startRequest: { prompt }, taskSpec: JSON.parse(JSON.stringify(initial)) } })
    const subject = { userId, novelId: novel.id, runId }
    const taskSpec = await prisma.$transaction(tx => freezeWritingScope(tx, subject, initial, prompt))
    await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: JSON.parse(JSON.stringify(taskSpec)) } })
    return { ...subject, sessionId: session.id, taskSpec, prompt }
  }

  it.each([
    ['empty-standard', false, 'standard'], ['empty-custom', false, 'custom'],
    ['existing-standard', true, 'standard'], ['existing-custom', true, 'custom'],
  ] as const)('%s greeting assembles without a fabricated chapter target or provider request', async (_label, withChapter, modelTier) => fixture(async f => {
    const input = await contextFixture(f.userId, withChapter, '你好')
    expect(input.taskSpec.writingPacing).toBe('conversation_only')
    expect(input.taskSpec.scope.writing).toBeUndefined()
    const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: input.runId } })
    const chapters = await prisma.chapter.findMany({ where: { novelId: input.novelId }, orderBy: { orderIndex: 'asc' } })
    const volumeReader = vi.spyOn(volumeContext, 'readWritingVolumeContext')
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Context assembly must not call a provider'))
    const assembled = await assembleContext({ ...input, agent: getAgentDefinition('orchestrator'), mode: 'build', chapterId: null,
      modelTier, modelName: modelTier === 'custom' ? 'custom-chat-fixture' : undefined })
    expect(assembled.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('你好') })
    const text = assembled.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n')
    expect(text).toContain('作者当前未打开具体章节')
    expect(text).not.toContain('本章必须审视卷目标')
    expect(volumeReader).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: input.runId } })).toEqual(before)
    expect(await prisma.chapter.findMany({ where: { novelId: input.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(chapters)
    expect(await prisma.storyCompilation.count({ where: { runId: input.runId } })).toBe(0)
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
  }))

  it('advice about an existing book does not manufacture a writing target', async () => fixture(async f => {
    const input = await contextFixture(f.userId, true, '如何让人物对白更自然？')
    expect(input.taskSpec.writingPacing).toBe('conversation_only')
    const reader = vi.spyOn(volumeContext, 'readWritingVolumeContext')
    await expect(assembleContext({ ...input, agent: getAgentDefinition('orchestrator'), mode: 'build', chapterId: null,
      modelTier: 'standard' })).resolves.toHaveProperty('messages')
    expect(reader).not.toHaveBeenCalled()
  }))

  it('planning an empty novel assembles without a chapter target', async () => fixture(async f => {
    const input = await contextFixture(f.userId, false, '规划小说')
    expect(input.taskSpec.scope.writing).toBeUndefined()
    const reader = vi.spyOn(volumeContext, 'readWritingVolumeContext')
    const assembled = await assembleContext({ ...input, agent: getAgentDefinition('orchestrator'), mode: 'plan', chapterId: null,
      modelTier: 'custom', modelName: 'custom-chat-fixture' })
    expect(assembled.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('规划小说') })
    expect(reader).not.toHaveBeenCalled()
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
  }))

  it('a real frozen next-chapter target retains volume review context', async () => fixture(async f => {
    const input = await contextFixture(f.userId, true, '写下一章')
    expect(input.taskSpec.scope.writing).toMatchObject({ kind: 'bounded', targets: [{ orderIndex: 2, chapterId: null }] })
    const reader = vi.spyOn(volumeContext, 'readWritingVolumeContext')
    const assembled = await assembleContext({ ...input, agent: getAgentDefinition('orchestrator'), mode: 'build', chapterId: null,
      modelTier: 'standard' })
    expect(reader).toHaveBeenCalledOnce()
    const [database, subject, target] = reader.mock.calls[0]
    expect(database).toBe(prisma)
    expect(subject).toEqual({ userId: f.userId, novelId: input.novelId, runId: input.runId })
    expect(target).toBe(2)
    const text = assembled.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n')
    expect(text).toContain('本章必须审视卷目标')
    expect(text).toContain('守住城门并查清粮道')
    expect(text).toContain('PREPARE明确 volumeDecision')
    expect(await prisma.storyCompilation.count({ where: { runId: input.runId } })).toBe(0)
  }))

  it('invalid direct volume targets fail with typed arguments before any INT4 query', async () => fixture(async f => {
    const query = vi.spyOn(prisma.chapter, 'findFirst')
    for (const target of [Number.MAX_SAFE_INTEGER, 2_147_483_648, 0, -1, 1.5, Number.NaN]) {
      await expect(volumeContext.readWritingVolumeContext(prisma, f, target)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS', status: 400 })
    }
    expect(query).not.toHaveBeenCalled()
  }))
})
