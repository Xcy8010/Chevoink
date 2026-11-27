import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { previousHistoryTask } from '../../api/lib/agent/task-lineage.js'
import { sessionHistorySearchTool, sessionMessageReadTool } from '../../api/lib/agent/tools/session-history-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('previous author task history', () => {
  it('resolves the preceding request and its continuations even when the current task itself resumed', async () => {
    await fixture(async f => {
      const current = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId }, select: { createdAt: true } })
      const time = (delta: number) => new Date(current.createdAt.getTime() + delta * 1000)
      const sibling = await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '旁支会话' } })
      const addRun = (taskId: string | null, delta: number, sessionId = f.sessionId) => prisma.agentRun.create({
        data: { id: randomUUID(), userId: f.userId, novelId: f.novelId, sessionId,
          mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop',
          ...(taskId ? { taskSpec: { id: taskId } } : {}), createdAt: time(delta) }, select: { id: true },
      })
      const message = (runId: string, role: string, delta: number, text: string | null) => prisma.agentMessage.create({
        data: { sessionId: f.sessionId, runId, role, createdAt: time(delta), parts: text === null
          ? [{ type: 'tool-call', toolName: 'plan_read', title: '读取合成细纲', status: 'success' }]
          : [{ type: 'text', text }] }, select: { id: true },
      })
      const older = await addRun(null, -50)
      const olderReply = await message(older.id, 'assistant', -49, '我先拟订计划。')
      const previousId = randomUUID()
      const previous = await addRun(previousId, -40)
      const request = await message(previous.id, 'user', -39, '核对合成细纲。')
      await message(previous.id, 'assistant', -38, null)
      const previousResume = await addRun(previousId, -30)
      await message(previousResume.id, 'assistant', -29, null)
      await message(previousResume.id, 'assistant', -28, '核对完毕。')
      await addRun(previousId, -20, sibling.id)
      const later = await addRun(randomUUID(), 20)
      const laterReply = await message(later.id, 'assistant', 21, '稍后任务的说明。')
      const currentResume = await addRun(f.rootId, 30)

      const ctx: ToolContext = { ...f, runId: currentResume.id, callId: 'history', mode: 'review', creativeFreedom: 'balanced',
        qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal }
      expect(await previousHistoryTask(f.userId, f.sessionId, currentResume.id)).toEqual({
        runIds: [previous.id, previousResume.id], requestId: request.id,
      })
      expect((await previousHistoryTask('foreign-user', f.sessionId, currentResume.id)).runIds).toEqual([])
      expect((await previousHistoryTask(f.userId, sibling.id, currentResume.id)).runIds).toEqual([])
      expect((await previousHistoryTask(f.userId, f.sessionId, previous.id)).runIds).toEqual([older.id])

      const search = (args: unknown) => sessionHistorySearchTool.execute(ctx, sessionHistorySearchTool.parameters.parse(args))
      const scoped = await search({ mode: 'recent', scope: 'previous_task' })
      expect(scoped.output).toContain('核对合成细纲。')
      expect(scoped.output).toContain('核对完毕。')
      expect(scoped.output.match(/读取合成细纲/g)).toHaveLength(2)
      expect(scoped.output).not.toMatch(/拟订计划|稍后任务/)
      expect((await search({ mode: 'keyword', query: '拟订计划', scope: 'previous_task' })).output).toContain('未找到')
      expect((await search({ mode: 'keyword', query: '拟订计划' })).output).toContain(olderReply.id)
      expect((await search({ mode: 'first_user_prompt', scope: 'previous_task' })).output).toContain(request.id)
      const read = (messageId: string) => sessionMessageReadTool.execute(ctx,
        sessionMessageReadTool.parameters.parse({ messageId, scope: 'previous_task' }))
      expect((await read(request.id)).output).toContain('核对合成细纲。')
      for (const id of [olderReply.id, laterReply.id, f.sourceMessageId]) expect((await read(id)).outcome).toBe('failed')
    })
  })
})
