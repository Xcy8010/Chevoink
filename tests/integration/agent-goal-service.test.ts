import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { env } from '../../api/config/env.js'
import { actOnAgentGoal, createAgentGoal, readAgentGoal, readAgentGoalDetail, updateAgentGoal } from '../../api/lib/agent/goal-service.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const previousGoalEnabled = env.agentGoalEnabled

type Fixture = { userId: string; novelId: string; sessionId: string }
const fixtures: Fixture[] = []

async function createFixture(): Promise<Fixture> {
  const user = await prisma.user.create({ data: { nickname: `goal-test-${randomUUID()}`, passwordHash: 'not-a-real-password' } })
  const novel = await prisma.novel.create({ data: { authorId: user.id, title: '目标模式测试作品', slug: randomUUID(), summary: '' } })
  const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '目标模式测试会话' } })
  const fixture = { userId: user.id, novelId: novel.id, sessionId: session.id }
  fixtures.push(fixture)
  return fixture
}

async function cleanupFixture(fixture: Fixture) {
  await prisma.agentGoalCommand.deleteMany({ where: { userId: fixture.userId } })
  await prisma.agentSession.deleteMany({ where: { id: fixture.sessionId } })
  await prisma.novel.deleteMany({ where: { id: fixture.novelId } })
  await prisma.user.delete({ where: { id: fixture.userId } }).catch(() => undefined)
}

function createInput(requestId = randomUUID(), objective = '完成目标模式验收') {
  return { requestId, objective, options: { mode: 'build' as const } }
}

describe.skipIf(!dbAvailable)('agent goal service (isolated test DB)', () => {
  beforeAll(() => { env.agentGoalEnabled = true })
  afterEach(async () => {
    while (fixtures.length) await cleanupFixture(fixtures.pop()!)
  })
  afterAll(async () => {
    env.agentGoalEnabled = previousGoalEnabled
    await prisma.$disconnect()
  })

  it('serializes concurrent creation and replays the same request exactly once', async () => {
    const fixture = await createFixture()
    const requestId = randomUUID()
    const [first, second] = await Promise.all([
      createAgentGoal(fixture.userId, { sessionId: fixture.sessionId }, createInput(requestId)),
      createAgentGoal(fixture.userId, { sessionId: fixture.sessionId }, createInput(requestId)),
    ])

    expect(first.id).toBe(second.id)
    expect(await prisma.agentGoal.count({ where: { sessionId: fixture.sessionId } })).toBe(1)
    expect(await prisma.agentGoalCommand.count({ where: { userId: fixture.userId, requestId } })).toBe(1)
    await expect(createAgentGoal(fixture.userId, { sessionId: fixture.sessionId }, createInput(requestId, '重复请求的另一目标')))
      .rejects.toMatchObject({ code: 'GOAL_CONFLICT' })
  })

  it('rejects another user at both session and novel scope', async () => {
    const owner = await createFixture()
    const other = await createFixture()

    await expect(createAgentGoal(other.userId, { sessionId: owner.sessionId }, createInput()))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(createAgentGoal(other.userId, { novelId: owner.novelId }, createInput()))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(readAgentGoal(other.userId, owner.sessionId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('pauses and cancels, while a late pause preserves committed completion', async () => {
    const fixture = await createFixture()
    const created = await createAgentGoal(fixture.userId, { sessionId: fixture.sessionId }, createInput())
    const paused = await actOnAgentGoal(fixture.userId, fixture.sessionId, created.id, {
      requestId: randomUUID(), expectedStateVersion: created.stateVersion, action: 'pause',
    })
    expect(paused).toMatchObject({ id: created.id, status: 'paused', phase: 'idle', reasonCode: 'AUTHOR_PAUSED' })

    const cancelled = await actOnAgentGoal(fixture.userId, fixture.sessionId, created.id, {
      requestId: randomUUID(), expectedStateVersion: paused.stateVersion, action: 'cancel',
    })
    expect(cancelled).toMatchObject({ id: created.id, status: 'cancelled', reasonCode: 'AUTHOR_CANCELLED' })
    expect(cancelled.finishedAt).toBeTruthy()

    const completed = await createAgentGoal(fixture.userId, { sessionId: fixture.sessionId }, createInput())
    const committed = await prisma.agentGoal.update({
      where: { id: completed.id },
      data: { status: 'completed', phase: 'reviewing', finishedAt: new Date(), stateVersion: { increment: 1 } },
    })
    const latePause = await actOnAgentGoal(fixture.userId, fixture.sessionId, completed.id, {
      requestId: randomUUID(), expectedStateVersion: committed.stateVersion, action: 'pause',
    })
    expect(latePause).toMatchObject({ id: completed.id, status: 'completed', stateVersion: committed.stateVersion })
    expect((await prisma.agentGoal.findUniqueOrThrow({ where: { id: completed.id } })).status).toBe('completed')
  })

  it('requires a current progress hash and a real deliverable before author confirmation', async () => {
    const fixture = await createFixture()
    const created = await createAgentGoal(fixture.userId, { sessionId: fixture.sessionId }, createInput())
    const detail = await readAgentGoalDetail(fixture.userId, fixture.sessionId, created.id)

    expect(detail.completion.canConfirm).toBe(false)
    await expect(actOnAgentGoal(fixture.userId, fixture.sessionId, created.id, {
      requestId: randomUUID(), expectedStateVersion: created.stateVersion, action: 'confirm_completion',
      completion: { progressHash: '0'.repeat(64) },
    })).rejects.toMatchObject({ code: 'GOAL_VERSION_CONFLICT' })
    await expect(actOnAgentGoal(fixture.userId, fixture.sessionId, created.id, {
      requestId: randomUUID(), expectedStateVersion: created.stateVersion, action: 'confirm_completion',
      completion: { progressHash: detail.completion.progressHash },
    })).rejects.toMatchObject({ code: 'GOAL_EVIDENCE_INCOMPLETE' })
    expect((await readAgentGoal(fixture.userId, fixture.sessionId))?.status).toBe('active')
  })

  it('accepts one update into the reconciling second phase and rejects a stale concurrent version', async () => {
    const fixture = await createFixture()
    const created = await createAgentGoal(fixture.userId, { sessionId: fixture.sessionId }, createInput())
    const results = await Promise.allSettled([
      updateAgentGoal(fixture.userId, fixture.sessionId, created.id, {
        requestId: randomUUID(), expectedStateVersion: created.stateVersion, expectedRevision: created.revision, objective: '第一阶段修订',
      }),
      updateAgentGoal(fixture.userId, fixture.sessionId, created.id, {
        requestId: randomUUID(), expectedStateVersion: created.stateVersion, expectedRevision: created.revision, objective: '并发冲突修订',
      }),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'GOAL_VERSION_CONFLICT' } })
    const snapshot = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<typeof created>).value
    expect(snapshot).toMatchObject({ status: 'updating', phase: 'reconciling', revision: 1, pendingRevision: 2 })
    expect(['第一阶段修订', '并发冲突修订']).toContain(snapshot.objective)
    expect(await prisma.agentGoalRevision.count({ where: { goalId: created.id } })).toBe(2)
  })

  it('renews an exhausted goal in one author action and replays without granting twice', async () => {
    const fixture = await createFixture()
    const created = await createAgentGoal(fixture.userId, { sessionId: fixture.sessionId }, createInput())
    await prisma.agentGoalBudget.update({ where: { goalId: created.id }, data: {
      tokensUsed: BigInt(created.tokenLimit), activeTimeMs: BigInt(created.activeTimeLimitMs), creditsUsedMicros: 5000n,
    } })
    await prisma.agentGoal.update({ where: { id: created.id }, data: { status: 'budget_limited', phase: 'idle', blockCount: 3, blockFingerprint: 'old-blocker' } })
    const request = { requestId: randomUUID(), expectedStateVersion: created.stateVersion, action: 'resume' as const,
      model: { modelTier: 'custom' as const, customModelId: 'authors-custom-model', reasoningEffort: 'high' as const } }
    const resumed = await actOnAgentGoal(fixture.userId, fixture.sessionId, created.id, request)
    expect(resumed).toMatchObject({ status: 'active', phase: 'queued', tokensUsed: created.tokenLimit,
      activeTimeMs: created.activeTimeLimitMs, creditsUsedMicros: '5000' })
    expect(BigInt(resumed.tokenLimit)).toBe(BigInt(created.tokenLimit) * 2n)
    expect(BigInt(resumed.activeTimeLimitMs)).toBe(BigInt(created.activeTimeLimitMs) * 2n)
    expect(await actOnAgentGoal(fixture.userId, fixture.sessionId, created.id, request)).toEqual(resumed)
    const stored = await prisma.agentGoal.findUniqueOrThrow({ where: { id: created.id } })
    expect(stored.executionOptions).toMatchObject(request.model)
    expect(stored).toMatchObject({ blockCount: 0, blockFingerprint: null })
  })

  it('retains cumulative usage while resuming with increased budget', async () => {
    const fixture = await createFixture()
    const created = await createAgentGoal(fixture.userId, { sessionId: fixture.sessionId }, {
      ...createInput(), limits: { tokenLimit: 1000, activeTimeLimitMs: 60_000 },
    })
    await prisma.agentGoalBudget.update({ where: { goalId: created.id }, data: {
      tokensUsed: 123n, tokensReserved: 7n, creditsUsedMicros: 5000n, activeTimeMs: 2000n,
    } })
    const paused = await actOnAgentGoal(fixture.userId, fixture.sessionId, created.id, {
      requestId: randomUUID(), expectedStateVersion: created.stateVersion, action: 'pause',
    })
    const resumed = await actOnAgentGoal(fixture.userId, fixture.sessionId, created.id, {
      requestId: randomUUID(), expectedStateVersion: paused.stateVersion, action: 'resume',
      budgetChange: { tokenLimit: 2000, activeTimeLimitMs: 120_000 },
    })

    expect(resumed).toMatchObject({ status: 'active', phase: 'queued', tokensUsed: '123', tokensReserved: '7', creditsUsedMicros: '5000', activeTimeMs: '2000', tokenLimit: '2000', activeTimeLimitMs: '120000' })
  })
})
