import { beforeEach, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { readCurrentSavedTaskChapters } from '../../api/lib/agent/saved-chapter-work.js'

vi.mock('../../api/lib/agent/original-request.js', () => ({
  readOriginalTaskRequest: vi.fn(async () => ({ sourceRunId: 'run' })),
  originalTaskRunIds: vi.fn(async () => ['run']),
}))
const subject = { userId: 'author', novelId: 'book', runId: 'run' }
const chapter = { id: 'chapter', title: '第1章', orderIndex: 1, content: '修改后的正文', revision: 3 }
let parts: unknown[], current: typeof chapter
const tx = { agentRun: { findFirst: vi.fn(async () => ({ taskRootId: null })) },
  agentMessage: { findMany: vi.fn(async () => [{ id: 'message', parts }]) },
  chapter: { findMany: vi.fn(async () => [current]) } } as unknown as Prisma.TransactionClient
const effect = (toolName = 'chapter_write', overrides = {}) => ({ type: 'tool-call', toolName, callId: 'call', status: 'success',
  display: { kind: 'chapterDiff', chapterId: chapter.id, before: '原正文', after: chapter.content, revision: 3 }, ...overrides })
beforeEach(() => { current = { ...chapter }; parts = [effect()] })

it('proves saved body without a compiler or a quality certificate', async () => {
  expect(await readCurrentSavedTaskChapters(tx, subject)).toMatchObject([{ id: 'chapter', content: chapter.content, revision: 3 }])
  expect(tx.agentMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
    runId: { in: ['run'] }, role: 'assistant', run: { userId: 'author', novelId: 'book' },
  } }))
})
it.each(['chapter_read', 'chapter_rename', 'volume_create'])('does not certify body from %s', async name => {
  parts = [effect(name)]
  expect(await readCurrentSavedTaskChapters(tx, subject)).toEqual([])
})
it.each(['failed', 'running'])('does not use %s effects', async status => {
  parts = [effect('chapter_write', { status })]
  expect(await readCurrentSavedTaskChapters(tx, subject)).toEqual([])
})
it('rejects a body changed outside the successful effect and permits metadata-only revision changes', async () => {
  current.content = '另一次修改'
  expect(await readCurrentSavedTaskChapters(tx, subject)).toEqual([])
  current = { ...chapter, revision: 4 }
  expect(await readCurrentSavedTaskChapters(tx, subject)).toHaveLength(1)
})
it('does not treat an empty create, no-op or future revision as a completed body', async () => {
  parts = [effect('chapter_create', { display: { kind: 'chapterDiff', chapterId: 'chapter', before: '', after: '', revision: 1 } })]
  expect(await readCurrentSavedTaskChapters(tx, subject)).toEqual([])
  parts = [effect('chapter_write', { display: { kind: 'chapterDiff', chapterId: 'chapter', before: chapter.content, after: chapter.content, revision: 3 } })]
  expect(await readCurrentSavedTaskChapters(tx, subject)).toEqual([])
  parts = [effect()]; current.revision = 2
  expect(await readCurrentSavedTaskChapters(tx, subject)).toEqual([])
})

it('returns no native body proof before the first execution frame, without using legacy messages', async () => {
  const pending = { ...tx, agentRun: { findFirst: vi.fn(async () => ({ taskRootId: 'root' })) },
    agentExecutionState: { findUnique: vi.fn(async () => null) } } as unknown as Prisma.TransactionClient
  vi.mocked(tx.agentMessage.findMany).mockClear()
  expect(await readCurrentSavedTaskChapters(pending, subject)).toEqual([])
  expect(tx.agentMessage.findMany).not.toHaveBeenCalled()
})
