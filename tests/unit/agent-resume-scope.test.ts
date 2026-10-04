import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ run: vi.fn(), runs: vi.fn(), children: vi.fn(), messages: vi.fn(), message: vi.fn(), artifact: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: {
  agentRun: { findFirst: db.run, findMany: db.runs }, agentSession: { findMany: db.children },
  agentMessage: { findMany: db.messages, findFirst: db.message }, agentArtifact: { findFirst: db.artifact },
} }))
import { getTaskRunIds } from '../../api/lib/agent/task-lineage.js'
import { assertOrchestrationResumeGuard, buildOrchestrationResumeNote } from '../../api/lib/agent/tools/task-orchestration-tools.js'
import { loadSessionTodoItems } from '../../api/lib/agent/tools/todo-tools.js'

beforeEach(() => {
  vi.resetAllMocks()
  db.run.mockResolvedValue({ taskSpec: { id: 'task19' }, status: 'failed' })
  db.runs.mockResolvedValue([{ id: 'run19' }, { id: 'continue19' }])
  db.children.mockImplementation(async ({ where }) => where.spawnedFromRunId?.in?.includes('run13') ? [{ id: 'child13', title: '第13章' }] : [])
  db.messages.mockResolvedValue([])
  db.artifact.mockResolvedValue(null)
  db.message.mockResolvedValue({ parts: [{ type: 'text', text: '写第19章' }] })
})
describe('P0 continuation task identity', () => {
  it('queries only identical persisted TaskSpec ids, not the entire conversation', async () => {
    expect(await getTaskRunIds('s', 'continue19')).toEqual(['continue19', 'run19'])
    expect(db.runs).toHaveBeenCalledWith({ where: { sessionId: 's', engine: 'loop', taskSpec: { path: ['id'], equals: 'task19' },
      incomingChildGrant: { isNot: { kind: 'inline' } } }, select: { id: true } })
  })
  it('legacy tasks without identity cannot inherit arbitrary historical windows', async () => {
    db.run.mockResolvedValue({ taskSpec: null })
    expect(await getTaskRunIds('s', 'run19')).toEqual(['run19'])
    expect(db.runs).not.toHaveBeenCalled()
  })
  it('resuming chapter19 does not inject failed chapter13 windows or block writing', async () => {
    expect(await buildOrchestrationResumeNote('s', 'run19', true)).toBe('')
    expect(await assertOrchestrationResumeGuard('run19', 's', 'chapter_write', { chapterId: 'c19' })).toBeNull()
  })
  it('a new task after a failure never gets an orchestration resume note', async () => {
    expect(await buildOrchestrationResumeNote('s', 'new', false)).toBe('')
    expect(db.children).not.toHaveBeenCalled()
  })
  it('actually related child windows remain discoverable after a typed continuation', async () => {
    db.children.mockResolvedValue([{ id: 'child19', title: '第19章' }])
    expect(await buildOrchestrationResumeNote('s', 'continue19', true)).toContain('child19')
    expect(db.children.mock.calls[0][0].where.spawnedFromRunId.in).toContain('run19')
    expect(await assertOrchestrationResumeGuard('continue19', 's', 'task_send', { sessionId: 'child19' })).toBeNull()
  })
  it('blocks restarting old windows on every attempt, without third-attempt bypass', async () => {
    for (let n = 0; n < 4; n++) expect(await assertOrchestrationResumeGuard('run19', 's', 'task_send', { sessionId: 'child13' })).toContain('不属于当前任务')
  })
  it('does not create windows for chapter19 just because old conversation requested them', async () => {
    expect(await assertOrchestrationResumeGuard('run19', 's', 'task_spawn')).toContain('没有作者明确')
    db.message.mockResolvedValue({ parts: [{ type: 'text', text: '打开不同窗口分别写第13、14、15章' }] })
    expect(await assertOrchestrationResumeGuard('run13', 's', 'task_spawn')).toBeNull()
    db.message.mockResolvedValue({ parts: [{ type: 'text', text: '不要打开不同窗口，自己写第19章' }] })
    expect(await assertOrchestrationResumeGuard('run19', 's', 'task_spawn')).not.toBeNull()
  })
  it('filters both message and artifact todo sources to this task, with no session fallback', async () => {
    expect(await loadSessionTodoItems('s', ['run19'])).toEqual([])
    expect(db.messages.mock.calls[0][0].where).toMatchObject({ sessionId: 's', runId: { in: ['run19'] } })
    expect(db.artifact.mock.calls[0][0].where).toMatchObject({ runId: { in: ['run19'] } })
  })
})
