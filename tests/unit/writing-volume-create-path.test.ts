import { beforeEach, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { createWritingTailVolume, assertExplicitWritingVolumePlacement } from '../../api/lib/agent/writing-volume.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
const mocks = vi.hoisted(() => ({ target: vi.fn(), scope: vi.fn(), create: vi.fn() }))
vi.mock('../../api/lib/agent/writing-scope.js', () => ({ assertWritingTarget: mocks.target, readWritingScope: mocks.scope }))
vi.mock('../../api/lib/agent/original-request.js', () => ({ originalTaskRunIds: async () => ['r'] }))
vi.mock('../../api/lib/data/novel-write-lock.js', () => ({ lockNovelActiveScope: async () => {} }))
vi.mock('../../api/lib/data/volume.js', () => ({ createVolumeData: mocks.create }))
const subject = { userId: 'u', novelId: 'n', runId: 'r' }
const proposal = { title: '远行', summary: '进入下一困局', boundary: { previousChapterId: 'previous', previousRevision: 3,
  quote: '守门人终于放下武器，交出了旧城的钥匙。', completedObjective: '获得进入旧城的钥匙', nextConflict: '穿过旧城寻找失踪者' } }
function fixture() {
  const scope = { sourceRunId: 'r', taskId: 'task', parentRunId: null, bindings: null as Record<string, unknown> | null,
    writing: { targets: [{ orderIndex: 2, chapterId: null }], tailVolume: { targetOrderIndex: 2, previousChapterId: 'previous', previousRevision: 3 } } }
  const volume = { id: 'new-volume', revision: 1, title: proposal.title }
  const db = { agentRun: { update: vi.fn(async ({ data }) => { scope.bindings = data.writingBindings }) },
    chapter: { findFirst: vi.fn().mockResolvedValue({ id: 'previous', revision: 3, orderIndex: 1, content: proposal.boundary.quote }) },
    storyCompilation: { update: vi.fn(), findMany: vi.fn().mockResolvedValue([]) }, volume: { findFirst: vi.fn().mockResolvedValue(volume) } }
  mocks.scope.mockImplementation(async () => scope); mocks.target.mockImplementation(async () => scope); mocks.create.mockResolvedValue(volume)
  return { db, tx: db as unknown as Prisma.TransactionClient, scope, volume }
}
beforeEach(() => vi.resetAllMocks())
it('creates without PREPARE and durably reuses the real tail volume across calls and restart', async () => {
  const f = fixture()
  expect(await createWritingTailVolume(f.tx, subject, 2, proposal)).toEqual(f.volume)
  expect(f.scope.bindings).toMatchObject({ version: 1, taskId: 'task', targets: [], tailVolumes: [{ targetOrderIndex: 2, proposalHash: runtimeJson(proposal).hash, volumeId: f.volume.id }] })
  mocks.scope.mockResolvedValue(structuredClone(f.scope))
  expect(await createWritingTailVolume(f.tx, subject, 2, proposal)).toEqual(f.volume)
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith('u', 'n', { title: proposal.title, summary: proposal.summary }, f.db)
  await expect(assertExplicitWritingVolumePlacement(f.tx, subject, 2, f.volume.id)).resolves.toBeUndefined()
  await expect(assertExplicitWritingVolumePlacement(f.tx, subject, 2, 'different-volume')).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
})
it.each(['revision', 'quote', 'parent', 'bound-chapter'])('retains the real fresh-creation boundary: %s', async scenario => {
  const f = fixture()
  if (scenario === 'revision') f.db.chapter.findFirst.mockResolvedValue({ id: 'previous', revision: 4, orderIndex: 1, content: proposal.boundary.quote })
  if (scenario === 'quote') f.db.chapter.findFirst.mockResolvedValue({ id: 'previous', revision: 3, orderIndex: 1, content: 'different body' })
  if (scenario === 'parent') f.scope.parentRunId = 'parent' as never
  if (scenario === 'bound-chapter') f.scope.writing.targets[0].chapterId = 'created' as never
  await expect(createWritingTailVolume(f.tx, subject, 2, proposal)).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
  expect(mocks.create).not.toHaveBeenCalled(); expect(f.db.agentRun.update).not.toHaveBeenCalled()
})
it.each(['proposal', 'archived', 'old-cache-conflict'])('does not create a replacement identity after %s', async scenario => {
  const f = fixture(); await createWritingTailVolume(f.tx, subject, 2, proposal)
  if (scenario === 'archived') f.db.volume.findFirst.mockResolvedValue(null)
  if (scenario === 'old-cache-conflict') f.db.storyCompilation.findMany.mockResolvedValue([{ id: 'old', preparedContext: { createdTailVolume: { id: 'different', targetOrderIndex: 2, proposalHash: runtimeJson(proposal).hash } } }] as never)
  await expect(createWritingTailVolume(f.tx, subject, 2, scenario === 'proposal' ? { ...proposal, title: '另一个提案' } : proposal))
    .rejects.toMatchObject({ code: scenario === 'old-cache-conflict' ? 'RUNTIME_RECEIPT_INVALID' : 'AUTHOR_CHAPTER_SCOPE' })
  expect(mocks.create).toHaveBeenCalledOnce()
})
it('migrates the existing authenticated compiler cache without creating another volume', async () => {
  const f = fixture()
  f.db.storyCompilation.findMany.mockResolvedValue([{ id: 'old', preparedContext: { createdTailVolume: { id: f.volume.id, targetOrderIndex: 2, proposalHash: runtimeJson(proposal).hash } } }] as never)
  expect(await createWritingTailVolume(f.tx, subject, 2, proposal)).toEqual(f.volume)
  expect(mocks.create).not.toHaveBeenCalled()
  expect(f.scope.bindings).toMatchObject({ tailVolumes: [{ volumeId: f.volume.id }] })
})
