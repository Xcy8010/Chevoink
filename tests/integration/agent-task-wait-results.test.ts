import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { taskWaitTool } from '../../api/lib/agent/tools/task-orchestration-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('legacy wait invalid targets against authoritative owned DB windows', () => {
  const ctx = (f: { userId: string; novelId: string; sessionId: string; runId: string; chapterId: string }): ToolContext => ({ ...f,
    callId: randomUUID(), mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', signal: new AbortController().signal, emit: () => {} })
  it('contract id, owned empty window and self never yield successful waiting or dispatch', async () => fixture(async f => {
    const empty = await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '没有执行记录的窗口' } })
    for (const target of [f.spec.id, empty.id]) {
      expect(await taskWaitTool.execute(ctx(f), { sessionIds: [target], mode: 'all', timeoutSeconds: 600 }))
        .toMatchObject({ outcome: 'failed', failureCode: 'TASK_WAIT_TARGET_NOT_FOUND' })
    }
    expect(await taskWaitTool.execute(ctx(f), { sessionIds: [f.sessionId], mode: 'all', timeoutSeconds: 600 }))
      .toMatchObject({ outcome: 'failed', failureCode: 'TASK_WAIT_TARGET_INVALID' })
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
  }), 15000)
  it('foreign windows are indistinguishable from missing IDs and do not expose their delivery', async () => fixture(async f => {
    const author = await prisma.user.create({ data: { nickname: 'wait-foreign', passwordHash: 'test-only-unusable' } })
    try {
      const novel = await prisma.novel.create({ data: { authorId: author.id, title: 'PRIVATE_NOVEL', slug: randomUUID(), summary: '' } })
      const window = await prisma.agentSession.create({ data: { userId: author.id, novelId: novel.id, title: 'PRIVATE_WINDOW_SENTINEL' } })
      await prisma.agentRun.create({ data: { userId: author.id, novelId: novel.id, sessionId: window.id, status: 'completed', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', outputSummary: 'PRIVATE_DELIVERY_SENTINEL' } })
      const result = await taskWaitTool.execute(ctx(f), { sessionIds: [window.id], mode: 'any', timeoutSeconds: 600 })
      expect(result).toMatchObject({ outcome: 'failed', failureCode: 'TASK_WAIT_TARGET_NOT_FOUND' })
      expect(JSON.stringify(result)).not.toContain('PRIVATE_')
    } finally {
      await prisma.agentRun.deleteMany({ where: { userId: author.id } })
      await prisma.agentSession.deleteMany({ where: { userId: author.id } })
      await prisma.novel.deleteMany({ where: { authorId: author.id } })
      await prisma.user.delete({ where: { id: author.id } })
    }
  }), 15000)
  it('valid failed child remains a truthful read and mixed missing targets never count as successful wait', async () => fixture(async f => {
    const window = await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '本任务窗口', spawnedFromSessionId: f.sessionId, spawnedFromRunId: f.runId } })
    const child = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: window.id, status: 'failed', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', outputSummary: '真实失败，正文未交付' } })
    const result = await taskWaitTool.execute(ctx(f), { sessionIds: [window.id], mode: 'all', timeoutSeconds: 10 })
    expect(result.outcome).toBeUndefined()
    expect(result.display).toMatchObject({ windows: [{ sessionId: window.id, status: 'failed', summary: '真实失败，正文未交付' }] })
    expect(await taskWaitTool.execute(ctx(f), { sessionIds: [window.id, f.spec.id], mode: 'all', timeoutSeconds: 600 }))
      .toMatchObject({ outcome: 'failed', failureCode: 'TASK_WAIT_TARGET_NOT_FOUND' })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: child.id } })).status).toBe('failed')
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
  }), 15000)
})
