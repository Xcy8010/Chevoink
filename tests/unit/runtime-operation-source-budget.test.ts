import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ operation: vi.fn(), manuscript: vi.fn(), ordinary: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({
  prisma: { agentOperation: { findFirst: mocks.operation } },
  DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } },
}))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withManuscriptRunLease: mocks.manuscript, withRunLease: mocks.ordinary }))
import { commitOperationEffect } from '../../api/lib/agent/runtime-operations.js'
const lease = { userId: 'owner', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
beforeEach(() => { vi.resetAllMocks(); mocks.manuscript.mockResolvedValue('manuscript-fence'); mocks.ordinary.mockResolvedValue('ordinary-fence') })
describe('real effect routing retains bounded source authentication budgets', () => {
  it.each(['chapter_write', 'chapter_append', 'chapter_edit_range', 'quality_analyze', 'continuity_validate', 'chapter_bridge_get', 'chapter_bridge_commit'])(
    '%s selects the existing manuscript/lease fence with the local 20s budget', async action => {
      mocks.operation.mockResolvedValue({ action })
      const effect = vi.fn()
      expect(await commitOperationEffect(lease, 'operation', 'original-hash', effect)).toBe('manuscript-fence')
      expect(mocks.operation).toHaveBeenCalledExactlyOnceWith({ where: { id: 'operation', taskRootId: 'root' }, select: { action: true } })
      expect(mocks.manuscript).toHaveBeenCalledExactlyOnceWith(lease, expect.any(Function), { timeoutMs: 20_000 })
      expect(mocks.ordinary).not.toHaveBeenCalled()
      // Selection does not execute outside the unchanged owner/policy/receipt fence.
      expect(effect).not.toHaveBeenCalled()
    })
  it.each(['chapter_rename', 'chapter_create', 'creative_critique', 'research_dossier_build'])(
    '%s retains the ordinary manuscript transaction allowance', async action => {
      mocks.operation.mockResolvedValue({ action })
      await commitOperationEffect(lease, 'operation', 'original-hash', vi.fn())
      expect(mocks.manuscript).toHaveBeenCalledExactlyOnceWith(lease, expect.any(Function))
      expect(mocks.ordinary).not.toHaveBeenCalled()
    })
  it('keeps a non-manuscript effect on its existing root lease route', async () => {
    mocks.operation.mockResolvedValue({ action: 'todo_write' })
    expect(await commitOperationEffect(lease, 'operation', 'original-hash', vi.fn())).toBe('ordinary-fence')
    expect(mocks.ordinary).toHaveBeenCalledExactlyOnceWith(lease, expect.any(Function))
    expect(mocks.manuscript).not.toHaveBeenCalled()
  })
})
