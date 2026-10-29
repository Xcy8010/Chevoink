import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DataAccessError } from '../../api/lib/prisma.js'
import { readCommitReviewApproval } from '../../api/lib/agent/runtime-approval.js'
import type { RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import type { RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'

const mocks = vi.hoisted(() => ({ missing: [] as Array<{ name: string }>, policies: new Map<string, string | Error>(),
  manifest: { version: 1 as const, chapterId: 'chapter', writingHash: 'a'.repeat(64), steps: [
    { step: 'quality' as const, actions: ['quality_analyze'] }, { step: 'continuity' as const, actions: ['continuity_validate'] },
    { step: 'commit' as const, actions: ['chapter_bridge_commit'] },
  ] }, probe: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-writing-service.js', () => ({
  requiredCommitReviewManifest: vi.fn(async () => mocks.manifest),
  readWritingServiceConfirmations: mocks.probe,
}))
vi.mock('../../api/lib/agent/chapter-review-guard.js', () => ({ readChapterReviewReadiness: vi.fn(async () => ({ requiredTools: mocks.missing })) }))
const token = { taskRootId: 'root', runId: 'run', userId: 'user' } as RunLeaseToken
const subject = { userId: 'user', novelId: 'novel', runId: 'run' }
const tx = {} as RuntimeTx
beforeEach(() => {
  mocks.missing = []; mocks.policies.clear(); mocks.probe.mockReset()
  mocks.probe.mockImplementation(async (_tx: RuntimeTx, _token: RunLeaseToken, actions: string[]) => {
    const policy = mocks.policies.get(actions[0]); if (policy instanceof Error) throw policy
    return policy === 'ask' ? actions : []
  })
})
describe('actual commit dependency approval', () => {
  it('does not request new review permission when both current reports already exist', async () => {
    mocks.policies.set('quality_analyze', 'ask'); mocks.policies.set('continuity_validate', 'ask')
    const result = await readCommitReviewApproval(tx, token, subject, 'comp')
    expect(result.confirmations).toEqual([])
    expect(mocks.probe.mock.calls.map(call => call[2])).toEqual([['chapter_bridge_commit']])
    expect(result.manifest).toEqual(mocks.manifest)
  })
  it('keeps actual ask visible while missing or denied dependencies remain for real adapter rejection', async () => {
    mocks.missing = [{ name: 'quality_analyze' }, { name: 'continuity_validate' }]
    mocks.policies.set('quality_analyze', new DataAccessError(403, 'RUNTIME_EFFECT_NOT_AUTHORIZED', 'missing quality grant'))
    mocks.policies.set('continuity_validate', 'ask')
    const result = await readCommitReviewApproval(tx, token, subject, 'comp')
    expect(result.confirmations).toEqual(['continuity_validate'])
    expect(mocks.probe.mock.calls.map(call => call[2])).toEqual([['quality_analyze'], ['continuity_validate'], ['chapter_bridge_commit']])
    expect(result.manifest.steps).toEqual(mocks.manifest.steps)
  })
  it('includes the real parent ask when reports are current', async () => {
    mocks.policies.set('chapter_bridge_commit', 'ask')
    expect((await readCommitReviewApproval(tx, token, subject, 'comp')).confirmations).toEqual(['chapter_bridge_commit'])
  })
  it.each(['RUNTIME_SCOPE_MISMATCH', 'RUNTIME_RECEIPT_INVALID', 'RUNTIME_RECONCILIATION_REQUIRED'])('never hides %s behind dependency permission probing', async code => {
    mocks.missing = [{ name: 'quality_analyze' }]
    mocks.policies.set('quality_analyze', new DataAccessError(409, code, 'original authority or unknown receipt'))
    await expect(readCommitReviewApproval(tx, token, subject, 'comp')).rejects.toMatchObject({ code })
    expect(mocks.probe).toHaveBeenCalledOnce()
  })
})
