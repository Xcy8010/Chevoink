import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const db = vi.hoisted(() => ({ sessions: vi.fn(), runs: vi.fn(), run: vi.fn(), messages: vi.fn() }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<typeof import('../../api/lib/prisma.js')>(), prisma: {
  agentSession: { findMany: db.sessions }, agentRun: { findMany: db.runs, findUnique: db.run }, agentMessage: { findMany: db.messages },
} }))
import { taskWaitTool } from '../../api/lib/agent/tools/task-orchestration-tools.js'

const ctx = { userId: 'author', novelId: 'novel', sessionId: 'parent', runId: 'run', chapterId: null,
  callId: 'wait', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', emit: vi.fn(), signal: new AbortController().signal } as ToolContext
beforeEach(() => {
  vi.resetAllMocks()
  db.sessions.mockResolvedValue([]); db.runs.mockResolvedValue([])
  db.run.mockResolvedValue({ outputSummary: '真实交付' }); db.messages.mockResolvedValue([])
})
describe('legacy task_wait reports invalid targets as failed observations', () => {
  it.each([['contract-uuid'], ['chapter-id'], ['compiler-id'], ['valid', 'unknown']].map(sessionIds => ({ sessionIds })))('rejects nonexistent targets $sessionIds before polling or reading deliveries', async ({ sessionIds }) => {
    db.sessions.mockResolvedValue(sessionIds.includes('valid') ? [{ id: 'valid', title: '合法窗口' }] : [])
    db.runs.mockResolvedValue([{ id: 'child-run', sessionId: 'valid', status: 'running' }])
    const result = await taskWaitTool.execute(ctx, { sessionIds, mode: 'all', timeoutSeconds: 600 })
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'TASK_WAIT_TARGET_NOT_FOUND' })
    expect(result.output).toContain('本次未开始等待')
    expect(result.output).toContain('task_spawn')
    expect(db.sessions).toHaveBeenCalledOnce()
    expect(db.sessions.mock.calls[0][0].where).toEqual({ id: { in: sessionIds }, userId: ctx.userId })
    expect(db.run).not.toHaveBeenCalled(); expect(db.messages).not.toHaveBeenCalled()
  })
  it.each([['parent'], ['valid', 'parent']].map(sessionIds => ({ sessionIds })))('refuses self-wait $sessionIds without substituting the remaining set', async ({ sessionIds }) => {
    expect(await taskWaitTool.execute(ctx, { sessionIds, mode: 'any', timeoutSeconds: 600 }))
      .toMatchObject({ outcome: 'failed', failureCode: 'TASK_WAIT_TARGET_INVALID' })
    expect(db.sessions).not.toHaveBeenCalled()
  })
  it('does not query a foreign author run even when given its window id', async () => {
    const result = await taskWaitTool.execute(ctx, { sessionIds: ['foreign'], mode: 'any', timeoutSeconds: 10 })
    expect(result.failureCode).toBe('TASK_WAIT_TARGET_NOT_FOUND')
    expect(db.runs).not.toHaveBeenCalled(); expect(result.output).not.toContain('foreign-author')
  })
  it.each(['completed', 'failed', 'cancelled', 'paused', 'awaiting_approval'])('preserves the real %s child status as a valid read, not an invalid target', async status => {
    db.sessions.mockResolvedValue([{ id: 'child', title: '真实窗口' }])
    db.runs.mockResolvedValue([{ id: 'child-run', sessionId: 'child', status }])
    const result = await taskWaitTool.execute(ctx, { sessionIds: ['child'], mode: 'all', timeoutSeconds: 10 })
    expect(result.outcome).toBeUndefined(); expect(result.failureCode).toBeUndefined()
    expect(result.display).toMatchObject({ kind: 'taskOrchestration', windows: [{ sessionId: 'child',
      status: status === 'completed' ? 'succeeded' : ['paused', 'awaiting_approval'].includes(status) ? 'awaiting' : status }] })
    if (status === 'completed') expect(result.output).toContain('真实交付')
  })
  it('a valid live window still supports bounded timeout and another wait', async () => {
    const signal = new AbortController(); signal.abort()
    db.sessions.mockResolvedValue([{ id: 'child', title: '真实窗口' }])
    db.runs.mockResolvedValue([{ id: 'child-run', sessionId: 'child', status: 'running' }])
    const result = await taskWaitTool.execute({ ...ctx, signal: signal.signal }, { sessionIds: ['child'], mode: 'all', timeoutSeconds: 10 })
    expect(result.outcome).toBeUndefined()
    expect(result.display).toMatchObject({ windows: [{ sessionId: 'child', status: 'timeout' }] })
    expect(result.output).toContain('再次调用 task_wait')
  })
})
