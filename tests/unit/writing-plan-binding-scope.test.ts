import { beforeEach, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../../api/lib/prisma.js'
import { bindCreatedChapterWritingPlan } from '../../api/lib/agent/writing-plan-context.js'

const identity = vi.hoisted(() => vi.fn())
vi.mock('../../api/lib/agent/story-compiler.js', () => ({ compilationRunScope: identity }))
const subject = { userId: 'author', novelId: 'novel', runId: 'continuation' }
const chapter = { id: 'new-chapter', orderIndex: 1 }
const fixture = () => ({ storyCompilation: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  agentArtifact: { update: vi.fn() } })
beforeEach(() => vi.resetAllMocks())

it.each([{ rows: [] }, { rows: [{ preparedContext: {} }] }, { rows: [{ preparedContext: null }, { preparedContext: { charterRevision: 1 } }] }])(
  'leaves an admitted create without frozen plans on its existing authority path: %j', async ({ rows }) => {
    const db = fixture()
    db.storyCompilation.findMany.mockResolvedValue(rows)
    identity.mockRejectedValue(new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', 'This create did not request compiler adoption'))
    await expect(bindCreatedChapterWritingPlan(db as unknown as Prisma.TransactionClient, subject, chapter)).resolves.toBeUndefined()
    expect(identity).not.toHaveBeenCalled()
    expect(db.storyCompilation.findFirst).not.toHaveBeenCalled()
    expect(db.storyCompilation.update).not.toHaveBeenCalled()
    expect(db.agentArtifact.update).not.toHaveBeenCalled()
  })

it('does not let an untyped candidate hide another frozen plan or swallow a real compiler identity refusal', async () => {
  const db = fixture()
  db.storyCompilation.findMany.mockResolvedValue([{ id: 'untyped', preparedContext: {} }, { id: 'typed', preparedContext: { planContext: { version: 1 } } }])
  identity.mockRejectedValue(new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', 'Frozen compiler is not owned by this task'))
  await expect(bindCreatedChapterWritingPlan(db as unknown as Prisma.TransactionClient, subject, chapter)).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
  expect(identity).toHaveBeenCalledExactlyOnceWith(db, subject)
  expect(db.storyCompilation.findFirst).not.toHaveBeenCalled()
  expect(db.storyCompilation.update).not.toHaveBeenCalled()
  expect(db.agentArtifact.update).not.toHaveBeenCalled()
})

it('uses the strict task scope after presence detection and never binds another task’s matching chapter plan', async () => {
  const db = fixture()
  db.storyCompilation.findMany.mockResolvedValue([{ id: 'foreign', preparedContext: { planContext: { version: 1 } } }])
  identity.mockResolvedValue({ run: { taskRootId: 'owned-root', userId: subject.userId, novelId: subject.novelId } })
  db.storyCompilation.findFirst.mockResolvedValue(null)
  await bindCreatedChapterWritingPlan(db as unknown as Prisma.TransactionClient, subject, chapter)
  expect(db.storyCompilation.findFirst).toHaveBeenCalledWith({ where: {
    userId: subject.userId, novelId: subject.novelId, status: 'active', id: { in: ['foreign'] },
    OR: [{ chapterId: chapter.id }, { chapterId: null, targetOrderIndex: chapter.orderIndex }],
    run: { taskRootId: 'owned-root', userId: subject.userId, novelId: subject.novelId },
  }, orderBy: { createdAt: 'desc' } })
  expect(db.storyCompilation.update).not.toHaveBeenCalled()
  expect(db.agentArtifact.update).not.toHaveBeenCalled()
})
