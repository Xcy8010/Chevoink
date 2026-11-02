import { beforeEach, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { assertTaskResponseEligible } from '../../api/lib/agent/task-response.js'

const mocks = vi.hoisted(() => ({ original: {} as Record<string, unknown>, todos: [] as Array<{ id: string; content: string; status: string }> }))
vi.mock('../../api/lib/agent/original-request.js', () => ({ readOriginalTaskRequest: vi.fn(async () => mocks.original), originalTaskRunIds: vi.fn(async () => ['r']) }))
vi.mock('../../api/lib/agent/tools/todo-tools.js', () => ({ loadSessionTodoItems: vi.fn(async () => mocks.todos) }))
const subject = { userId: 'u', novelId: 'n', runId: 'r', sessionId: 's' }
let db: { agentRun: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  storyCompilation: { findFirst: ReturnType<typeof vi.fn> }; agentMessage: { findMany: ReturnType<typeof vi.fn> };
  agentOperation: { count: ReturnType<typeof vi.fn> }; agentSubtaskRun: { count: ReturnType<typeof vi.fn> } }
beforeEach(() => {
  const spec = { ...buildTaskSpec({ runId: 'r', novelId: 'n', chapterId: null, prompt: '说明作品规划' }), responseDeliveryProtocol: 1 }
  mocks.original = { prompt: '说明作品规划', spec, taskId: spec.id, sourceRunId: 'r', parentRunId: null }
  mocks.todos = []
  db = { agentRun: { findFirst: vi.fn(async () => ({ id: 'r' })), findMany: vi.fn(async () => []) },
    storyCompilation: { findFirst: vi.fn(async () => null) }, agentMessage: { findMany: vi.fn(async () => []) },
    agentOperation: { count: vi.fn(async () => 0) }, agentSubtaskRun: { count: vi.fn(async () => 0) } }
})
const check = () => assertTaskResponseEligible(db as unknown as Prisma.TransactionClient, subject)
it('names the real unfinished plan todo and directs execution back to the original workflow', async () => {
  mocks.todos = [{ id: 'save-plan', content: '保存完整创作计划', status: 'in_progress' }]
  await expect(check()).rejects.toMatchObject({ code: 'TASK_RESPONSE_WORK_PENDING', message: expect.stringContaining('保存完整创作计划') })
  await expect(check()).rejects.toMatchObject({ message: expect.stringContaining('不反复调用task_respond') })
  expect(mocks.todos[0].status).toBe('in_progress')
})
it('returns the existing compilation lookup instead of asking for a replacement compiler', async () => {
  db.storyCompilation.findFirst.mockResolvedValue({ id: 'real-compilation' })
  await expect(check()).rejects.toMatchObject({ code: 'TASK_RESPONSE_WORK_PENDING', message: expect.stringContaining('real-compilation，用chapter_bridge_get') })
})
it('preserves unknown-operation blocking and directs reconciliation before any retry', async () => {
  db.agentOperation.count.mockResolvedValue(1)
  await expect(check()).rejects.toMatchObject({ code: 'TASK_RESPONSE_WORK_PENDING', message: expect.stringContaining('未知结果先核对，不重复请求') })
})
it('keeps a pre-execution parameter failure eligible for an ordinary response when no work is pending', async () => {
  db.agentMessage.findMany.mockResolvedValue([{ parts: [{ type: 'tool-call', toolName: 'plan_save', status: 'failed', preExecutionFailure: true }] }])
  await expect(check()).resolves.toMatchObject({ taskId: mocks.original.taskId, requestHash: expect.any(String) })
})
it('retains actual started work even when todo items were marked complete', async () => {
  mocks.todos = [{ id: 'save-plan', content: '保存计划', status: 'completed' }]
  db.agentMessage.findMany.mockResolvedValue([{ parts: [{ type: 'tool-call', toolName: 'plan_save', status: 'success' }] }])
  await expect(check()).rejects.toMatchObject({ code: 'TASK_RESPONSE_WORK_PENDING', message: expect.stringContaining('先核对工具回执并完成原目标') })
})
