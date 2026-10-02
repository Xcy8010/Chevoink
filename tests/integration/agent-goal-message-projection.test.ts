import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { listLoopSessionMessages } from '../../api/lib/agent/session-messages.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const users: string[] = []

afterEach(async () => {
  for (const userId of users.splice(0)) {
    await prisma.agentSession.deleteMany({ where: { userId } })
    await prisma.novel.deleteMany({ where: { authorId: userId } })
    await prisma.user.delete({ where: { id: userId } })
  }
})
afterAll(() => prisma.$disconnect())

describe.skipIf(!dbAvailable)('goal history ownership (isolated test DB)', () => {
  it.each([undefined, 30])('projects persisted goal identity and only system continuation prompts (runLimit=%s)', async runLimit => {
    const user = await prisma.user.create({ data: { nickname: `goal-history-${randomUUID()}`, passwordHash: 'fixture-only' } })
    users.push(user.id)
    const novel = await prisma.novel.create({ data: { authorId: user.id, title: 'goal-history', slug: randomUUID(), summary: '' } })
    const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: 'goal-history' } })
    const goal = await prisma.agentGoal.create({ data: { userId: user.id, novelId: novel.id, sessionId: session.id, status: 'completed', executionOptions: {} } })
    const runIds: string[] = []
    const messageIds: string[] = []
    const start = Date.parse('2026-10-01T00:00:00Z')
    for (const [index, trigger] of ['author', 'goal_auto', 'goal_auto', null].entries()) {
      const run = await prisma.agentRun.create({ data: {
        userId: user.id, novelId: novel.id, sessionId: session.id, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator',
        engine: 'loop', status: index === 0 ? 'paused' : 'completed', createdAt: new Date(start + index * 10000),
      } })
      runIds.push(run.id)
      if (trigger) await prisma.agentGoalExecution.create({ data: { goalId: goal.id, goalRevision: 1, epoch: 1n,
        runId: run.id, continuationIndex: index + 1, trigger, sourceEventId: randomUUID() } })
      // Index 1 is legacy auto input; index 2 is explicit system input followed
      // by a real author message. Neither may swallow that natural boundary.
      const prompt = await prisma.agentMessage.create({ data: { runId: run.id, sessionId: session.id,
        role: index === 2 ? 'system' : 'user', parts: [{ type: 'text', text: `prompt ${index}` }], createdAt: new Date(start + index * 10000 + 1) } })
      messageIds.push(prompt.id)
      if (index === 2) {
        const natural = await prisma.agentMessage.create({ data: { runId: run.id, sessionId: session.id, role: 'user',
          parts: [{ type: 'text', text: 'real author steering' }], createdAt: new Date(start + index * 10000 + 2) } })
        messageIds.push(natural.id)
      }
      await prisma.agentMessage.create({ data: { runId: run.id, sessionId: session.id, role: 'assistant',
        parts: [{ type: 'text', text: `answer ${index}` }], createdAt: new Date(start + index * 10000 + 3) } })
    }
    const history = await listLoopSessionMessages(user.id, session.id, { runLimit })
    const byId = new Map(history.messages.map(item => [item.id, item]))
    expect(messageIds.map(id => byId.get(id)?.goalContinuation)).toEqual([false, true, true, false, false])
    expect(history.messages.filter(item => item.runId !== runIds[3]).every(item => item.goalId === goal.id)).toBe(true)
    expect(history.messages.filter(item => item.runId === runIds[3]).every(item => item.goalId === null)).toBe(true)
    expect(byId.get(messageIds[2])?.role).toBe('user')
    expect(history.messages.filter(item => item.role === 'assistant').every(item => item.goalContinuation === false)).toBe(true)
  })
})
