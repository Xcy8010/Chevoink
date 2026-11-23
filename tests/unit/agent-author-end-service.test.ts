import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({
  agentRun: { findFirst: vi.fn(), findMany: vi.fn() },
  agentGoalExecution: { findUnique: vi.fn() },
  agentGoal: { findFirst: vi.fn() },
  agentSession: { findUnique: vi.fn(), findMany: vi.fn() },
  agentArtifact: { findMany: vi.fn() }, projectMemoryEntry: { findMany: vi.fn() }, $transaction: vi.fn(),
}))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<typeof import('../../api/lib/prisma.js')>(), prisma: db }))
import { continueLoopRun, listAgentSessionHistoryData, listAgentSessionWorkspaceHistoryData, listAgentSessionsData, listSessionRunStatuses } from '../../api/lib/agent/run-service.js'
import { buildArtifactsFromHistory } from '../../src/features/studio/lib/agent-persistence.js'
const ended = { fulfilled: false, todoItems: [{ id: 'todo-1', content: '剩余工作', status: 'cancelled', reason: '作者要求结束' }] }
const record = { id: 'run', userId: 'user', sessionId: 'session', novelId: 'novel', chapterId: null, agentType: 'writingOrchestrator', mode: 'act', action: 'workspaceAgent', status: 'cancelled', createdAt: new Date('2026-11-23T08:00:00.000Z'), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, authorEnded: ended } }
beforeEach(() => {
  vi.clearAllMocks()
  db.agentRun.findFirst.mockResolvedValue(record)
  db.agentRun.findMany.mockResolvedValue([record])
  db.agentGoalExecution.findUnique.mockResolvedValue(null)
  db.agentGoal.findFirst.mockResolvedValue({ id: 'pending-goal' })
  db.agentSession.findMany.mockResolvedValue([{ id: 'session' }])
  db.agentSession.findUnique.mockResolvedValue({ id: 'session', userId: 'user' })
  db.agentArtifact.findMany.mockResolvedValue([])
  db.projectMemoryEntry.findMany.mockResolvedValue([])
  db.$transaction.mockImplementation(async work => Array.isArray(work) ? Promise.all(work) : Promise.reject(new Error('resume proceeded')))
})
describe('author-ended run API boundary', () => {
  it('rejects resume before mutation or paid execution', async () => {
    await expect(continueLoopRun('user', 'run')).rejects.toMatchObject({ code: 'RUN_AUTHOR_ENDED', status: 409 })
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.agentGoal.findFirst).not.toHaveBeenCalled()
    expect(db.agentGoalExecution.findUnique).not.toHaveBeenCalled()
  })
  it('polls only the newest run disposition and clears ending when a new task starts', async () => {
    expect((await listSessionRunStatuses('user', ['session'])).statuses.session).toMatchObject({ runId: 'run', runGoalId: null, authorEnded: ended })
    db.agentRun.findMany.mockResolvedValue([{ ...record, id: 'new', status: 'running', usage: {} }, record])
    expect((await listSessionRunStatuses('user', ['session'])).statuses.session).toMatchObject({ runId: 'new', status: 'running' })
    expect((await listSessionRunStatuses('user', ['session'])).statuses.session?.authorEnded).toBeUndefined()
    db.agentRun.findMany.mockResolvedValue([{ ...record, id: 'goal-run', status: 'running', usage: {}, goalExecution: { goalId: 'goal-1' } }, record])
    expect((await listSessionRunStatuses('user', ['session'])).statuses.session).toMatchObject({ runId: 'goal-run', runGoalId: 'goal-1' })
  })
  it('restores author-ended disposition and cancelled items on history refresh', async () => {
    const history = await listAgentSessionHistoryData('user', 'session')
    expect(history.items[0].run.authorEnded).toEqual(ended)
    expect(history.items[0].run.status).toBe('cancelled')
  })
  it('returns only workspace artifact fields while retaining all visible artifacts and memory', async () => {
    const createdAt = new Date('2026-11-23T08:00:00.000Z')
    db.agentArtifact.findMany.mockResolvedValue([{
      id: 'artifact', runId: 'run', artifactType: 'chapterPlan', title: '章节计划', content: '完整计划正文', createdAt,
      metadata: { actionPlan: { steps: [] }, savedAsPlan: true, workspaceTask: 'workspace-agent', privateTrace: 'omit this payload' },
      run: { id: 'run', sessionId: 'session', action: 'workspaceAgent', mode: 'act', status: 'cancelled', inputSummary: '继续梳理', createdAt },
    }])
    db.projectMemoryEntry.findMany.mockResolvedValue([{
      id: 'memory', runId: 'run', memoryType: 'character', title: '人物', content: '已确认记忆', importance: 50, createdAt,
    }])

    const history = await listAgentSessionWorkspaceHistoryData('user', 'session')
    expect(history.items).toHaveLength(1)
    expect(history.items[0]).toMatchObject({
      run: { id: 'run', sessionId: 'session', action: 'workspaceAgent', mode: 'act', status: 'cancelled', inputSummary: '继续梳理' },
      prompt: '继续梳理',
      artifacts: [{ id: 'artifact', content: '完整计划正文', metadata: { actionPlan: { steps: [] }, savedAsPlan: true }, availableApplyStrategies: [] }],
      memoryEntries: [{ id: 'memory', memoryType: 'character', content: '已确认记忆', importance: 50 }],
    })
    expect(history.items[0].run).not.toHaveProperty('userId')
    expect(history.items[0].artifacts[0]).not.toHaveProperty('summary')
    expect(JSON.stringify(history)).not.toContain('privateTrace')
    expect(db.agentArtifact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { run: { sessionId: 'session', incomingChildGrant: { isNot: { kind: 'inline' } } } },
      select: expect.objectContaining({ content: true, metadata: true, run: expect.any(Object) }),
    }))
  })
  it('workspace projection restores the same legacy handoff and multi-artifact run metadata as full history', async () => {
    const createdAt = new Date('2026-11-23T08:00:00.000Z')
    const run = { ...record, createdAt }
    const artifacts = [
      { id: 'artifact-first', runId: 'run', artifactType: 'chapterPlan', title: '第一份', summary: null, content: '计划 A', createdAt, updatedAt: createdAt,
        metadata: { handoff: { sourceMode: 'plan', targetMode: 'build', title: '继续', summary: '继续构建', confirmLabel: '确认' }, privateTrace: 'discard large diagnostics' } },
      { id: 'artifact-second', runId: 'run', artifactType: 'chapterDraft', title: '第二份', summary: null, content: '正文 B', createdAt, updatedAt: createdAt,
        metadata: { executionMode: 'build', actionPlan: { steps: [] }, privateTrace: 'discard large diagnostics' } },
    ]
    db.agentRun.findMany.mockResolvedValue([run])
    db.agentArtifact.findMany.mockResolvedValue(artifacts.map(artifact => ({ ...artifact, run })))
    db.projectMemoryEntry.findMany.mockResolvedValue([{ id: 'memory', runId: 'run', memoryType: 'character', title: '人物', content: '记忆', importance: 50, createdAt }])

    const full = await listAgentSessionHistoryData('user', 'session')
    const workspace = await listAgentSessionWorkspaceHistoryData('user', 'session')
    expect(buildArtifactsFromHistory(workspace.items)).toEqual(buildArtifactsFromHistory(full.items))
    expect(workspace.items[0].handoff).toMatchObject({ sourceRunId: 'run', sourceArtifactId: 'artifact-first' })
    expect(workspace.items[0].activeAgent).toEqual(full.items[0].activeAgent)
    expect(JSON.stringify(workspace).length).toBeLessThan(JSON.stringify(full).length)
  })
  it('session listing checks whether one run exists instead of counting a long history', async () => {
    db.agentSession.findMany.mockResolvedValue([{
      id: 'session', userId: 'user', novelId: 'novel', title: '有效任务', status: 'active', lastRunAt: null,
      createdAt: record.createdAt, updatedAt: record.createdAt, pinnedAt: null, toolPolicy: null, sandboxMode: 'workspace',
      novel: { title: '书', displayTitle: null }, runs: [{ id: 'run' }],
    }])
    const result = await listAgentSessionsData('user', 'novel')
    expect(result.items[0].hasAgentHistory).toBe(true)
    expect(db.agentSession.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ runs: { where: { incomingChildGrant: { isNot: { kind: 'inline' } } }, take: 1, select: { id: true } } }),
    }))
  })
})
