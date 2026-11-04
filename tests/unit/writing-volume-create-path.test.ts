import { beforeEach, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { createWritingTailVolume, assertExplicitWritingVolumePlacement } from '../../api/lib/agent/writing-volume.js'
import { DataAccessError } from '../../api/lib/prisma.js'

const mocks = vi.hoisted(() => ({ target: vi.fn(), scope: vi.fn(), create: vi.fn() }))
vi.mock('../../api/lib/agent/writing-scope.js', () => ({ assertWritingTarget: mocks.target, readWritingScope: mocks.scope }))
vi.mock('../../api/lib/data/volume.js', () => ({ createVolumeData: mocks.create }))
const subject = { userId: 'u', novelId: 'n', runId: 'r' }
const proposal = { title: '远行', summary: '进入下一困局', boundary: { previousChapterId: 'previous', previousRevision: 3,
  quote: '守门人终于放下武器，交出了旧城的钥匙。', completedObjective: '获得进入旧城的钥匙', nextConflict: '穿过旧城寻找失踪者' } }
const scope = { sourceRunId: 'r', parentRunId: null, writing: { targets: [{ orderIndex: 2, chapterId: null }],
  tailVolume: { targetOrderIndex: 2, previousChapterId: 'previous', previousRevision: 3 } } }
const fixture = () => ({ chapter: { findFirst: vi.fn().mockResolvedValue({ id: 'previous', revision: 3, orderIndex: 1, content: proposal.boundary.quote }) },
  storyCompilation: { update: vi.fn(), findFirst: vi.fn().mockResolvedValue({ id: 'comp', preparedContext: { previousChapter: { id: 'previous', revision: 3 }, volumeDecision: { kind: 'new_volume', newVolume: proposal } } }) },
  volume: { create: vi.fn(), findFirst: vi.fn() } })
beforeEach(() => { vi.resetAllMocks(); mocks.target.mockResolvedValue(scope); mocks.scope.mockResolvedValue(scope); mocks.create.mockResolvedValue({ id: 'new-volume' }) })
it('uses the directory creation service in the original chapter transaction after the existing boundary proof', async () => {
  const db = fixture()
  expect(await createWritingTailVolume(db as unknown as Prisma.TransactionClient, subject, 2, proposal)).toEqual({ id: 'new-volume' })
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith('u', 'n', { title: proposal.title, summary: proposal.summary }, db)
  expect(db.volume.create).not.toHaveBeenCalled()
})
it('does not create a volume when the frozen predecessor revision or original authority is invalid', async () => {
  const db = fixture()
  db.chapter.findFirst.mockResolvedValue({ id: 'previous', revision: 4, orderIndex: 1, content: proposal.boundary.quote })
  await expect(createWritingTailVolume(db as unknown as Prisma.TransactionClient, subject, 2, proposal)).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
  mocks.target.mockRejectedValue(new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '本任务未授权创建尾卷'))
  await expect(createWritingTailVolume(db as unknown as Prisma.TransactionClient, subject, 2, proposal)).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
  expect(mocks.create).not.toHaveBeenCalled()
  expect(db.volume.create).not.toHaveBeenCalled()
})

it('persists one explicit tail-volume binding and reuses it rather than creating duplicate volumes', async () => {
  const db = fixture(), explicit = { ...scope, writing: { ...scope.writing, tailVolume: { ...scope.writing.tailVolume, creationProtocol: 2 } } }
  mocks.target.mockResolvedValue(explicit); mocks.scope.mockResolvedValue(explicit)
  const prepared = { previousChapter: { id: 'previous', revision: 3 }, volumeDecision: { kind: 'new_volume', newVolume: proposal } }
  const compilation = { id: 'comp', preparedContext: prepared }
  db.storyCompilation.findFirst.mockImplementation(async () => compilation)
  db.storyCompilation.update.mockImplementation(async ({ data }) => { Object.assign(compilation, data); return compilation })
  const volume = { id: 'new-volume', revision: 1, title: proposal.title }
  mocks.create.mockResolvedValue(volume); db.volume.findFirst.mockResolvedValue(volume)
  expect(await createWritingTailVolume(db as unknown as Prisma.TransactionClient, subject, 2, proposal)).toEqual(volume)
  expect(await createWritingTailVolume(db as unknown as Prisma.TransactionClient, subject, 2, proposal)).toEqual(volume)
  expect(mocks.create).toHaveBeenCalledOnce()
  expect(compilation.preparedContext).toMatchObject({ createdTailVolume: { id: volume.id, targetOrderIndex: 2 } })
  await expect(assertExplicitWritingVolumePlacement(db as unknown as Prisma.TransactionClient, subject, 2, 'different-volume')).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
  await expect(assertExplicitWritingVolumePlacement(db as unknown as Prisma.TransactionClient, subject, 2, volume.id)).resolves.toBeUndefined()
  db.volume.findFirst.mockResolvedValue(null)
  await expect(createWritingTailVolume(db as unknown as Prisma.TransactionClient, subject, 2, proposal)).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
  expect(mocks.create).toHaveBeenCalledOnce()
})
it('requires the explicit volume to exist before chapter placement and never treats continue as permission to switch volumes', async () => {
  const db = fixture()
  await expect(assertExplicitWritingVolumePlacement(db as unknown as Prisma.TransactionClient, subject, 2)).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
  db.storyCompilation.findFirst.mockResolvedValue({ id: 'comp', preparedContext: { previousChapter: { id: 'previous', revision: 3 }, volumeDecision: { kind: 'continue', reason: '当前目标尚未收束' } } } as never)
  await expect(assertExplicitWritingVolumePlacement(db as unknown as Prisma.TransactionClient, subject, 2, 'unrelated')).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
  expect(mocks.create).not.toHaveBeenCalled()
})
