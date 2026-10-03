import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ goal: vi.fn(), revision: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } },
  prisma: { agentGoal: { findFirst: mocks.goal }, agentGoalRevision: { findUniqueOrThrow: mocks.revision }, agentGoalEvidence: { findUnique: async () => null } },
}))
import { resolveGoalAuthorAdmission } from '../../api/lib/agent/goal-author-admission.js'

const input = { sessionId: 'session', novelId: 'novel', mode: 'build' as const, prompt: '先完成前三章' }
const goal = { id: 'goal', userId: 'owner', sessionId: 'session', novelId: 'novel', status: 'active', phase: 'awaiting_input',
  reasonCode: 'GOAL_SCOPE_DECISION_REQUIRED', pendingRevision: null, currentRevision: 1, epoch: 1n, continuationIndex: 1, executionOptions: { mode: 'build' } }

beforeEach(() => { vi.resetAllMocks(); mocks.goal.mockResolvedValue(goal); mocks.revision.mockResolvedValue({ objective: '写一本小说' }) })

describe('goal author admission scope', () => {
  it('requires an explicit goal revision instead of repeatedly running an old proposal-only contract', async () => {
    await expect(resolveGoalAuthorAdmission('owner', input, 'source')).rejects.toMatchObject({ code: 'GOAL_SCOPE_UPDATE_REQUIRED' })
    expect(mocks.revision).not.toHaveBeenCalled()
  })
  it('preserves the original full goal when ordinary steering is allowed', async () => {
    mocks.goal.mockResolvedValue({ ...goal, phase: 'queued', reasonCode: null })
    expect(await resolveGoalAuthorAdmission('owner', input, 'source')).toMatchObject({ input: { prompt: '写一本小说' },
      steering: input, admission: { goalId: 'goal', sourceEventId: 'source', trigger: 'steering' } })
  })
  it('leaves an ordinary window unchanged', async () => {
    mocks.goal.mockResolvedValue(null)
    expect(await resolveGoalAuthorAdmission('owner', input, 'source')).toEqual({ input })
  })
})
