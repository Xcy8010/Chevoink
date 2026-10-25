import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const mocks = vi.hoisted(() => ({ reserve: vi.fn(), reusable: vi.fn(), completion: vi.fn(), cycle: vi.fn(),
  state: { validation: { checkRounds: 1, autoRepairRounds: 0 } as Record<string, unknown>, claim: false, missing: false }, tx: {} as Record<string, unknown> }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: {
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
    const before = structuredClone(mocks.state)
    try { return await work(mocks.tx) } catch (error) { Object.assign(mocks.state, before); throw error }
  },
} }))
vi.mock('../../api/lib/agent/assessment-response-lifecycle.js', async original => ({ ...await original<object>(),
  readReusableLegacyContinuityAssessment: mocks.reusable, reserveLegacyContinuityAssessment: mocks.reserve,
  observeLegacyContinuityFirstNotDispatched: vi.fn(async () => {}),
}))
vi.mock('../../api/lib/agent/review-completion.js', async original => ({ ...await original<object>(), generateReviewCompletion: mocks.completion }))
vi.mock('../../api/lib/agent/review-cycle-store.js', async original => ({ ...await original<object>(), markChapterReviewCycleVerification: mocks.cycle }))

import { DataAccessError } from '../../api/lib/prisma.js'
import { reserveContinuityCheck } from '../../api/lib/agent/story-compiler.js'
import { runLegacyContinuityReview } from '../../api/lib/agent/tools/story-compiler-tools.js'

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(mocks.state, { validation: { checkRounds: 1, autoRepairRounds: 0 }, claim: false, missing: false })
  mocks.tx = { $queryRaw: vi.fn(async () => []), storyCompilation: {
    findFirst: vi.fn(async () => mocks.state.missing ? null : { id: 'compilation', validation: mocks.state.validation }),
    update: vi.fn(async ({ data }) => { mocks.state.validation = data.validation; return {} }),
  } }
  mocks.reusable.mockResolvedValue(null)
  mocks.reserve.mockImplementation(async () => { mocks.state.claim = true; return 'new' })
  mocks.completion.mockImplementation(async () => { throw Error('synthetic provider boundary') })
})
function invoke() {
  const ctx = { userId: 'user', novelId: 'novel', runId: 'run', callId: 'call', signal: new AbortController().signal } as ToolContext
  return runLegacyContinuityReview(ctx, { chapterId: 'chapter', revision: 1, bodies: { current: 'Synthetic saved body.', previous: null },
    system: 'Synthetic frozen reviewer.', content: 'Synthetic request.', options: { userId: 'user', novelId: 'novel', targetType: 'story_compilation', targetId: 'compilation' },
    assertCurrent: async () => {}, onNewRequestReserved: async tx => {
      if (!await reserveContinuityCheck('user', 'novel', 'compilation', tx)) throw new DataAccessError(409, 'COMPILATION_NOT_FOUND', 'Synthetic missing compilation')
    } })
}

describe('continuity check counter shares actual new-request admission', () => {
  it.each(['denied', 'blocked', 'cached'] as const)('%s leaves the counter, claim and provider untouched', async kind => {
    if (kind === 'denied') mocks.reserve.mockRejectedValue(new DataAccessError(409, 'CONTINUITY_PHASE_AUTHORITY_REQUIRED', 'No original phase'))
    if (kind === 'blocked') mocks.reserve.mockResolvedValue('blocked')
    if (kind === 'cached') mocks.reusable.mockResolvedValue({ complete: true })
    const before = structuredClone(mocks.state)
    if (kind === 'cached') await expect(invoke()).resolves.toMatchObject({ complete: true })
    else await expect(invoke()).rejects.toMatchObject({ code: kind === 'denied' ? 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' : 'CONTINUITY_REPORT_INCOMPLETE' })
    expect(mocks.state).toEqual(before)
    expect(mocks.completion).not.toHaveBeenCalled()
    expect(mocks.cycle).not.toHaveBeenCalled()
  })
  it('counts an admitted actual attempt once even when the provider boundary fails', async () => {
    mocks.completion.mockImplementation(async () => {
      expect(mocks.state).toMatchObject({ claim: true, validation: { checkRounds: 2, autoRepairRounds: 0 } })
      throw Error('synthetic provider boundary')
    })
    await expect(invoke()).rejects.toThrow('synthetic provider boundary')
    expect(mocks.state.validation).toEqual({ checkRounds: 2, autoRepairRounds: 0 })
    expect(mocks.completion).toHaveBeenCalledOnce()
  })
  it('rolls back the phase reservation when its compilation counter cannot be reserved', async () => {
    mocks.state.missing = true
    const before = structuredClone(mocks.state)
    await expect(invoke()).rejects.toMatchObject({ code: 'COMPILATION_NOT_FOUND' })
    expect(mocks.state).toEqual(before)
    expect(mocks.completion).not.toHaveBeenCalled()
  })
})
