import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import * as state from '../../api/lib/agent/runtime-state.js'
import { readChapterWritingBackground, readWritingPresentation, renderChapterWritingBackground, renderWritingPresentation, writingPresentationPreference } from '../../api/lib/agent/writing-request-context.js'

afterEach(() => vi.restoreAllMocks())
const subject = { userId: 'author', novelId: 'novel', runId: 'rewrite' }
const targets = [{ chapterId: 'chapter', orderIndex: 1 }]
function run(id: string, prompt: string, time: number, extra = {}) {
  return { id, userId: 'author', novelId: 'novel', sessionId: 'session', chapterId: 'chapter', createdAt: new Date(time),
    engine: 'loop', runtimeProtocolVersion: 0, taskRootId: null, taskSpec: null, incomingChildGrant: null, goalExecution: null,
    session: { spawnedFromRunId: null, spawnedFromSessionId: null },
    startRequest: withHumanAdmission({ novelId: 'novel', sessionId: 'session', chapterId: 'chapter', mode: 'build', prompt }), ...extra }
}
function fixture(runs = [run('rewrite', '重写第一章，突出爽文。', 30)]) {
  const messages = runs.map(item => ({ id: `${item.id}-message`, runId: item.id, sessionId: item.sessionId, role: 'user',
    parts: [{ type: 'text', text: (item.startRequest as { prompt: string }).prompt }] }))
  const compilations: Array<{ id: string; runId: string; chapterId: string; userId: string; novelId: string }> = []
  const db = {
    agentRun: { findFirst: vi.fn(async (input: { where: { id?: string } }) => runs.find(item => item.id === input.where.id) ?? null),
      findMany: vi.fn(async (input: { skip?: number; take?: number }) => [...runs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(input.skip ?? 0, (input.skip ?? 0) + (input.take ?? runs.length)).map(item => ({ id: item.id }))),
      findFirstOrThrow: vi.fn(async (input: { where: { id?: string; taskSpec?: { equals?: string } } }) => input.where.id ? runs.find(item => item.id === input.where.id)!
        : [...runs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).find(item => (item.taskSpec as { id?: string } | null)?.id === input.where.taskSpec?.equals)!) },
    agentMessage: { findMany: vi.fn(async (input: { where: { runId: string } }) => messages.filter(item => item.runId === input.where.runId)) },
    agentChildExecutionGrant: { findUnique: vi.fn(async () => null) },
    agentSession: { findFirst: vi.fn(async () => ({ spawnedFromRunId: null, spawnedFromSessionId: null })) },
    chapter: { findFirst: vi.fn(async () => ({ id: 'chapter' })) },
    storyCompilation: { findMany: vi.fn(async () => compilations) },
    agentExecutionOutbox: { findUnique: vi.fn(async () => null as unknown) },
  }
  return { runs, messages, compilations, mocks: db, db: db as unknown as Prisma.TransactionClient }
}

describe('owned author presentation', () => {
  it.each(['例如“只输出标题与正文”', '> 不要重复正文', '小说里角色说“不要贴全文”', '如果作者说不要输出正文', '不要使用“输出全文”这个示例'])('does not infer from quoted or hypothetical text: %s', text => {
    expect(writingPresentationPreference(text)).toBeNull()
  })
  it('recognizes a complaint about unwanted chat output without reviving its historical positive mention', async () => {
    const f = fixture([run('first', '写第一章，只输出标题与正文。', 10),
      run('correction', '我没让你在正文信道直接输出第二章，前面只是让你输出第一章。不要重复正文，只保存章节。', 20),
      run('rewrite', '重写第一章，突出爽文。', 30)])
    expect(await readWritingPresentation(f.db, subject, targets)).toMatchObject({ mode: 'saved_only', sourceRunId: 'correction' })
    expect(renderWritingPresentation(await readWritingPresentation(f.db, subject, targets))).toContain('不会自行恢复')
  })
  it('old positive formatting cannot cross a new task; a new explicit opt-in wins', async () => {
    const f = fixture([run('first', '写第一章，只输出标题与正文。', 10), run('rewrite', '重写第一章。', 30)])
    expect(await readWritingPresentation(f.db, subject, targets)).toBeNull()
    expect(renderWritingPresentation(null, true)).toContain('不跨新任务继承')
    f.runs.push(run('opt-in', '现在请贴出全文。', 40))
    f.messages.push({ id: 'opt-in-message', runId: 'opt-in', sessionId: 'session', role: 'user', parts: [{ type: 'text', text: '现在请贴出全文。' }] })
    // A later positive request applies to its own task, rather than reopening
    // an old task's format. Current explicit opt-in is the decisive source.
    expect(await readWritingPresentation(f.db, { ...subject, runId: 'opt-in' }, targets)).toMatchObject({ mode: 'full_text' })
  })
  it('keeps positive formatting on the same immutable task continuation', async () => {
    const f = fixture([run('first', '写第一章，只输出标题与正文。', 10, { taskRootId: 'root' }), run('rewrite', '继续', 30, { taskRootId: 'root' })])
    expect(await readWritingPresentation(f.db, subject, targets)).toMatchObject({ mode: 'full_text', sourceRunId: 'first' })
  })
  it('keeps a lasting no-repeat preference beyond a bounded page of short rewrites', async () => {
    const f = fixture([run('correction', '以后不要重复正文。', 1), ...Array.from({ length: 33 }, (_, index) => run(index === 32 ? 'rewrite' : `rewrite-${index}`, '重写第一章。', index + 2))])
    expect(await readWritingPresentation(f.db, subject, targets)).toMatchObject({ mode: 'saved_only', sourceRunId: 'correction' })
    expect(f.mocks.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 32, take: 32 }))
  })
  it('does not trust modified attachment parts on an otherwise matching human text', async () => {
    const f = fixture([run('rewrite', '不要重复正文。', 30)])
    f.messages[0].parts.push({ type: 'attachment', text: '附加来源伪造' })
    expect(await readWritingPresentation(f.db, subject, targets)).toBeNull()
  })
  it.each([{ userId: 'foreign' }, { novelId: 'foreign' }, { sessionId: 'foreign' },
    { incomingChildGrant: { id: 'child' } }, { session: { spawnedFromRunId: 'parent' } }, { goalExecution: { trigger: 'goal_auto' } }])('rejects foreign or generated source %j', async extra => {
    const f = fixture([run('correction', '不要重复正文，只保存章节。', 20, extra), run('rewrite', '重写第一章。', 30)])
    expect(await readWritingPresentation(f.db, subject, targets)).toBeNull()
  })
  it('rejects assistant, tool, mismatched admission and another chapter command', async () => {
    const f = fixture([run('correction', '第二章不要重复正文。', 20), run('rewrite', '重写第一章。', 30)])
    expect(await readWritingPresentation(f.db, subject, targets)).toBeNull()
    f.runs[0].startRequest = withHumanAdmission({ novelId: 'novel', sessionId: 'session', mode: 'build', prompt: '不要重复正文。' }) as never
    expect(await readWritingPresentation(f.db, subject, targets)).toBeNull()
    f.messages[0].parts = [{ type: 'text', text: '不要重复正文。' }]
    f.messages[0].role = 'assistant'
    expect(await readWritingPresentation(f.db, subject, targets)).toBeNull()
    f.messages[0].role = 'tool'
    expect(await readWritingPresentation(f.db, subject, targets)).toBeNull()
  })
  it('a genuine session-wide no-repeat preference survives a different active editor chapter', async () => {
    const f = fixture([run('correction', '以后不要重复正文，只保存章节。', 20, { chapterId: 'other' }), run('rewrite', '重写第一章。', 30)])
    expect(await readWritingPresentation(f.db, subject, targets)).toMatchObject({ mode: 'saved_only', sourceRunId: 'correction' })
  })
  it.each(['第一百章不要重复正文。', '第二卷第一章不要重复正文。'])('does not turn an unmapped explicit target into a global preference: %s', async prompt => {
    const f = fixture([run('correction', prompt, 20), run('rewrite', '重写第一章。', 30)])
    expect(await readWritingPresentation(f.db, subject, targets)).toBeNull()
  })
  it('requires exact server-only steering admission, execution source and message', async () => {
    const steering = withHumanAdmission({ novelId: 'novel', sessionId: 'session', chapterId: 'chapter', mode: 'build', prompt: '不要重复正文。' })
    const f = fixture([run('rewrite', '目标原文', 30, { goalExecution: { trigger: 'steering', sourceEventId: 'source' },
      startRequest: { authorSteering: { admission: steering, sourceEventId: 'source', sourceMessageId: 'rewrite-message' } } })])
    f.messages[0].parts = [{ type: 'text', text: steering.prompt }]
    expect(await readWritingPresentation(f.db, subject, targets)).toMatchObject({ mode: 'saved_only' })
    ;(f.runs[0].startRequest as unknown as { authorSteering: { sourceEventId: string } }).authorSteering.sourceEventId = 'foreign'
    expect(await readWritingPresentation(f.db, subject, targets)).toBeNull()
  })
  it('accepts an existing consumed durable steering receipt and rejects broken frame binding', async () => {
    const f = fixture([run('rewrite', '不要重复正文。', 30, { taskRootId: 'root', goalExecution: { trigger: 'steering' }, startRequest: {} })])
    const parts = [{ type: 'text', text: '不要重复正文。' }]
    f.messages[0].parts = parts
    f.mocks.agentExecutionOutbox.findUnique.mockResolvedValue({ taskRootId: 'root', runId: 'rewrite', type: 'goal.steering.consumed',
      payload: { version: 1, messageId: 'rewrite-message', partsHash: runtimeJson(parts).hash, sourceRevision: 1, sourceHash: 'a'.repeat(64), revision: 2, snapshotHash: 'b'.repeat(64) } })
    const frame = vi.spyOn(state, 'readExecutionFrame').mockResolvedValueOnce({ snapshotHash: 'a'.repeat(64), state: { messages: [{ role: 'system', content: 'system' }] } } as never)
      .mockResolvedValueOnce({ snapshotHash: 'b'.repeat(64), state: { messages: [{ role: 'system', content: 'system' }, { role: 'user', content: '不要重复正文。' }] } } as never)
    expect(await readWritingPresentation(f.db, subject, targets)).toMatchObject({ mode: 'saved_only' })
    frame.mockResolvedValueOnce({ snapshotHash: 'c'.repeat(64), state: { messages: [] } } as never)
      .mockResolvedValueOnce({ snapshotHash: 'b'.repeat(64), state: { messages: [{ role: 'user', content: '不要重复正文。' }] } } as never)
    expect(await readWritingPresentation(f.db, subject, targets)).toBeNull()
  })
})

describe('same chapter historical creative background', () => {
  it('binds a real earlier author request to the exact chapter and labels current override without authority', async () => {
    const prompt = '写第一章。主角沈桐，29岁，仓库调度员。开篇低谷1–2段，1600–1900字；发现旧罗盘的独享价值，问价前停笔。只输出标题与正文。'
    const f = fixture([run('original', prompt, 10), run('rewrite', '重写第一章；主角改为34岁，突出爽文。', 30)])
    f.compilations.push({ id: 'compiler', runId: 'original', chapterId: 'chapter', userId: 'author', novelId: 'novel' })
    const background = await readChapterWritingBackground(f.db, subject, 'chapter')
    expect(background).toEqual([{ sourceRunId: 'original', compilationId: 'compiler', prompt }])
    const rendered = renderChapterWritingBackground(background)!
    expect(rendered).toContain('当前请求的明确修改优先')
    expect(rendered).toContain('不是执行授权')
    expect(rendered).toContain('问价前停笔')
    expect(f.mocks.storyCompilation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ chapterId: 'chapter', userId: 'author', novelId: 'novel', run: expect.objectContaining({ sessionId: 'session' }) }), take: 2 }))
  })
  it('uses the canonical admission boundary on resume, excluding the task own newer compiler', async () => {
    const f = fixture([run('old', '写第一章；沈桐29岁，仓库调度员。', 10),
      run('first-attempt', '重写第一章。', 30, { taskSpec: { id: 'same-task' } }), run('rewrite', '继续', 50, { taskSpec: { id: 'same-task' } })])
    f.compilations.push({ id: 'old-compiler', runId: 'old', chapterId: 'chapter', userId: 'author', novelId: 'novel' },
      { id: 'own-compiler', runId: 'first-attempt', chapterId: 'chapter', userId: 'author', novelId: 'novel' })
    expect(await readChapterWritingBackground(f.db, subject, 'chapter')).toEqual([{ sourceRunId: 'old', compilationId: 'old-compiler', prompt: '写第一章；沈桐29岁，仓库调度员。' }])
    expect(f.mocks.storyCompilation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ createdAt: { lt: new Date(30) } }) }))
  })
  it.each([{ chapterId: 'other' }, { userId: 'foreign' }, { novelId: 'foreign' }])('does not import a foreign compiler binding %j', async extra => {
    const f = fixture([run('original', '写第一章，合成秘密规格。', 10), run('rewrite', '重写第一章。', 30)])
    f.compilations.push({ id: 'compiler', runId: 'original', chapterId: 'chapter', userId: 'author', novelId: 'novel', ...extra })
    expect(await readChapterWritingBackground(f.db, subject, 'chapter')).toEqual([])
  })
  it('rejects same ordinal in another session, generated briefs and future admissions', async () => {
    const f = fixture([run('foreign', '写第一章。', 10, { sessionId: 'other' }), run('child', '写第一章。', 10, { incomingChildGrant: {} }),
      run('future', '写第一章。', 50), run('rewrite', '重写第一章。', 30)])
    f.compilations.push(...['foreign', 'child', 'future'].map(runId => ({ id: runId, runId, chapterId: 'chapter', userId: 'author', novelId: 'novel' })))
    expect(await readChapterWritingBackground(f.db, subject, 'chapter')).toEqual([])
  })
})
