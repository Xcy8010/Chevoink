import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { verifyTestDatabase } from '../support/database-preflight.js'

const ready = await verifyTestDatabase(isTestDatabaseRequired())

describe.skipIf(!ready)('private studio conversation search on isolated PostgreSQL', () => {
  it('matches literal full text and titles without indexing hidden history or another author', async () => {
    const { prisma } = await import('../../api/lib/prisma.js')
    const { searchAgentSessionsData } = await import('../../api/lib/agent/run-service.js')
    const ids = { a: randomUUID(), b: randomUUID() }
    const now = Date.now()
    const date = (offset: number) => new Date(now + offset)
    async function createConversation(userId: string, label: string, status: 'active' | 'archived' = 'active') {
      const novel = await prisma.novel.create({ data: {
        authorId: userId, title: label + '原名', displayTitle: label + '展示名', summary: '', slug: randomUUID(),
      } })
      const session = await prisma.agentSession.create({ data: {
        userId, novelId: novel.id, title: label + '会话', status, lastRunAt: date(-3000),
      } })
      const run = await prisma.agentRun.create({ data: {
        userId, novelId: novel.id, sessionId: session.id, mode: 'act', action: 'workspaceAgent',
        agentType: 'writingOrchestrator', status: 'failed', inputSummary: '省略正文', errorMessage: 'HIDDEN_SERVER_NOTICE',
      } })
      return { novel, session, run }
    }
    try {
      await prisma.user.createMany({ data: Object.values(ids).map(id => ({ id, nickname: '合成作者', passwordHash: 'unusable' })) })
      const owned = await createConversation(ids.a, '本人作品')
      const foreign = await createConversation(ids.b, '他人作品')
      const archived = await createConversation(ids.a, '归档作品', 'archived')
      const goal = await prisma.agentGoal.create({ data: {
        userId: ids.a, novelId: owned.novel.id, sessionId: owned.session.id, executionOptions: {},
      } })
      await prisma.agentGoalRevision.create({ data: {
        goalId: goal.id, revision: 1, objective: '合成目标', request: {},
        authorityHash: 'a'.repeat(64), sourceActionId: randomUUID(),
      } })
      await prisma.agentGoalExecution.create({ data: {
        goalId: goal.id, goalRevision: 1, epoch: 1n, runId: owned.run.id,
        trigger: 'goal_auto', continuationIndex: 1, sourceEventId: randomUUID(),
      } })
      const noticeId = randomUUID()
      await prisma.agentMessage.createMany({ data: [
        { runId: owned.run.id, sessionId: owned.session.id, role: 'user', parts: [{ type: 'text', text: 'HIDDEN_AUTOMATIC_PROMPT' }], createdAt: date(-2000) },
        { runId: owned.run.id, sessionId: owned.session.id, role: 'user', parts: [{ type: 'text', text: '前'.repeat(500) + '字面%_关键词' }], createdAt: date(-1000) },
        { runId: owned.run.id, sessionId: owned.session.id, role: 'assistant', parts: [
          { type: 'reasoning', text: 'HIDDEN_REASONING' },
          { type: 'text', text: '这是可以查到的可见回复。\n\n{"arguments":"HIDDEN_PROTOCOL"}' },
          { type: 'text', text: '正在调用 Story Compiler' },
        ], createdAt: date(-500) },
        { id: noticeId, runId: owned.run.id, sessionId: owned.session.id, role: 'assistant', parts: [{ type: 'text', text: 'HIDDEN_SERVER_NOTICE' }] },
        { runId: foreign.run.id, sessionId: foreign.session.id, role: 'user', parts: [{ type: 'text', text: '字面%_关键词 FOREIGN_ONLY' }] },
        { runId: foreign.run.id, sessionId: owned.session.id, role: 'user', parts: [{ type: 'text', text: 'MISMATCHED_RUN_OWNER' }] },
        { runId: archived.run.id, sessionId: archived.session.id, role: 'user', parts: [{ type: 'text', text: 'ARCHIVED_ONLY' }] },
      ] })
      await prisma.agentRunEvent.createMany({ data: [
        { runId: owned.run.id, seq: 1, type: 'message.start', payload: { role: 'assistant', messageId: noticeId } },
        { runId: owned.run.id, seq: 2, type: 'text.final', payload: { messageId: noticeId, asReasoning: false, text: 'HIDDEN_SERVER_NOTICE' } },
        { runId: owned.run.id, seq: 3, type: 'run.finished', payload: { status: 'failed' } },
      ] })

      for (const term of ['字面%_关键词', '可见回复', '剧情编译', '本人作品展示名', '本人作品会话']) {
        const response = await searchAgentSessionsData(ids.a, term)
        expect(response.items.map(item => item.id)).toEqual([owned.session.id])
        expect(response.items[0]).not.toHaveProperty('parts')
      }
      for (const term of ['HIDDEN_AUTOMATIC_PROMPT', 'HIDDEN_REASONING', 'HIDDEN_PROTOCOL', 'HIDDEN_SERVER_NOTICE', 'FOREIGN_ONLY', 'MISMATCHED_RUN_OWNER', 'ARCHIVED_ONLY', '%_缺失']) {
        expect(await searchAgentSessionsData(ids.a, term)).toEqual({ items: [] })
      }
    } finally {
      const userId = { in: Object.values(ids) }
      await prisma.agentGoal.deleteMany({ where: { userId } })
      await prisma.agentRun.deleteMany({ where: { userId } })
      await prisma.agentSession.deleteMany({ where: { userId } })
      await prisma.novel.deleteMany({ where: { authorId: userId } })
      await prisma.user.deleteMany({ where: { id: userId } })
      await prisma.$disconnect()
    }
  })
})
