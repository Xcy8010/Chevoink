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
      { id: 'internal-batch-response', runId: 'run', artifactType: 'continuityReview', title: '批量审阅原响应',
        summary: null, content: 'RAW_PROVIDER_BATCH_RESPONSE', createdAt, updatedAt: createdAt,
        metadata: { version: 1, batchResponseRequestHash: 'verified-original-request' } },
    ]
    db.agentRun.findMany.mockResolvedValue([run])
    db.agentArtifact.findMany.mockResolvedValue(artifacts.map(artifact => ({ ...artifact, run })))
    db.projectMemoryEntry.findMany.mockResolvedValue([{ id: 'memory', runId: 'run', memoryType: 'character', title: '人物', content: '记忆', importance: 50, createdAt }])

    const full = await listAgentSessionHistoryData('user', 'session')
    const workspace = await listAgentSessionWorkspaceHistoryData('user', 'session')
    expect(buildArtifactsFromHistory(workspace.items)).toEqual(buildArtifactsFromHistory(full.items))
    for (const history of [full, workspace]) {
      expect(history.items[0].artifacts.map(artifact => artifact.id)).toEqual(['artifact-first', 'artifact-second'])
      expect(JSON.stringify(history)).not.toContain('RAW_PROVIDER_BATCH_RESPONSE')
    }
    expect(workspace.items[0].handoff).toMatchObject({ sourceRunId: 'run', sourceArtifactId: 'artifact-first' })
    expect(workspace.items[0].activeAgent).toEqual(full.items[0].activeAgent)
    expect(JSON.stringify(workspace).length).toBeLessThan(JSON.stringify(full).length)
  })
  it('lists one scoped main run in stable order and returns only its author-visible preview', async () => {
    db.agentSession.findMany.mockResolvedValue([{
      id: 'session', userId: 'user', novelId: 'novel', title: '有效任务', status: 'active', lastRunAt: null,
      createdAt: record.createdAt, updatedAt: record.createdAt, pinnedAt: null, toolPolicy: null, sandboxMode: 'workspace',
      novel: { title: '书', displayTitle: null },
      runs: [{ novelId: 'novel', status: 'completed', inputSummary: '作者的问题', outputSummary: '可见回复。\n\n{"arguments":"HIDDEN_PROTOCOL"}' }],
    }])
    const result = await listAgentSessionsData('user', 'novel')
    expect(result.items[0]).toMatchObject({ hasAgentHistory: true, latestMessagePreview: '可见回复。' })
    expect(result.items[0]).not.toHaveProperty('runs')
    expect(JSON.stringify(result)).not.toContain('HIDDEN_PROTOCOL')
    expect(db.agentSession.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user', novelId: 'novel', status: 'active' },
      include: expect.objectContaining({ runs: {
        where: { userId: 'user', novelId: 'novel', incomingChildGrant: { isNot: { kind: 'inline' } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1,
        select: { status: true, novelId: true, outputSummary: true, inputSummary: true, goalExecution: { select: { trigger: true } } },
      } }),
    }))
  })
  it('keeps literal author input on one line and omits missing, automatic or other-work previews', async () => {
    const session = { userId: 'user', novelId: 'novel', title: '已命名任务', status: 'active', createdAt: record.createdAt, updatedAt: record.createdAt }
    const input = '  作者原话\t\n{"arguments":"照写"} ' + '⭐'.repeat(200)
    const latest = { novelId: 'novel', status: 'running', inputSummary: input, outputSummary: null }
    db.agentSession.findMany.mockResolvedValue([
      { ...session, id: 'literal', runs: [{ ...latest, status: 'failed', outputSummary: '内部失败原因' }] },
      { ...session, id: 'emoji', runs: [{ ...latest, inputSummary: '甲'.repeat(159) + '🌙尾' }] },
      { ...session, id: 'automatic', runs: [{ ...latest, goalExecution: { trigger: 'goal_auto' } }] },
      { ...session, id: 'other-work', runs: [{ ...latest, novelId: 'other' }] },
      { ...session, id: 'blank', runs: [{ ...latest, inputSummary: ' \n ' }] },
      { ...session, id: 'empty', runs: [] },
    ])
    const { items } = await listAgentSessionsData('user', undefined, { includeArchived: true, ids: ['literal', 'emoji', 'automatic', 'other-work', 'blank', 'empty'] })
    expect(items[0].latestMessagePreview).toMatch(/^作者原话 {"arguments":"照写"} /)
    expect(Array.from(items[0].latestMessagePreview!)).toHaveLength(160)
    expect(items[1].latestMessagePreview).toBe('甲'.repeat(159) + '🌙')
    for (const item of items.slice(2)) expect(item).not.toHaveProperty('latestMessagePreview')
    expect(items.map(item => item.hasAgentHistory)).toEqual([true, true, true, true, true, false])
    expect(JSON.stringify(items)).not.toContain('内部失败原因')
    expect(db.agentSession.findMany).toHaveBeenCalledOnce()
    expect(db.agentSession.findMany.mock.calls[0][0].where).toMatchObject({ userId: 'user', novel: { authorId: 'user' } })
    expect(db.agentRun.findMany).not.toHaveBeenCalled()
  })
})
