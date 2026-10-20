import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ scope: vi.fn(), assert: vi.fn(), clarification: vi.fn(), update: vi.fn() }))
vi.mock('../../api/lib/agent/writing-scope.js', () => ({ assertQuestionWritingScope: mocks.assert, readWritingScope: mocks.scope }))
vi.mock('../../api/lib/agent/writing-clarification.js', () => ({ recordWritingClarification: mocks.clarification }))
vi.mock('../../api/lib/agent/goal-runtime.js', () => ({ setGoalRunPhase: vi.fn(async () => {}) }))
vi.mock('../../api/lib/agent/goal-context.js', () => ({ currentGoalExecution: () => null }))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } },
  prisma: { $transaction: async (callback: (tx: object) => unknown) => callback({}), agentRun: { updateMany: mocks.update } },
}))
import { askUserTool } from '../../api/lib/agent/tools/interact-tools.js'
import { cancelAllQuestions, consumeQuestionBudget, resolveQuestionAnswer } from '../../api/lib/agent/permissions.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { env } from '../../api/config/env.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const args = { question: '写入哪一章？', options: [{ label: '第一章' }, { label: '暂不写入' }] }
const ctx: ToolContext = { userId: 'author', novelId: 'novel', sessionId: 'session', runId: 'run', chapterId: null,
  callId: 'original-question', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', emit: () => {}, signal: new AbortController().signal }
function scope(kind: 'bounded' | 'needs_input' = 'needs_input', local = false) {
  const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: null, prompt: '写一小段' })
  spec.scope.writing = { version: 1, kind, targets: kind === 'bounded' ? [{ orderIndex: 1, chapterId: 'chapter' }] : [],
    titleAndBodyOnly: false, repairAuthorized: false }
  if (local) spec.scope.localEditBoundary = { version: 1, kind: 'needs_input', regions: [] }
  mocks.scope.mockResolvedValue({ spec, writing: spec.scope.writing })
  return spec
}
async function start(context = ctx) {
  const pending = askUserTool.execute(context, args)
  for (let index = 0; index < 12; index++) await Promise.resolve()
  return { pending }
}
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); mocks.update.mockResolvedValue({ count: 1 }); mocks.clarification.mockResolvedValue(null); scope() })
afterEach(() => { cancelAllQuestions('run'); vi.useRealTimers() })

describe('required legacy author decisions', () => {
  it.each([false, true])('parks frozen scope on timeout without restarting the run or recording default authority (local=%s)', async local => {
    scope(local ? 'bounded' : 'needs_input', local)
    const { pending } = await start()
    await vi.advanceTimersByTimeAsync(env.agentApprovalTimeoutMs + 1)
    const result = await pending
    expect(result).toMatchObject({ failureCode: 'AUTHOR_INPUT_REQUIRED', display: { kind: 'question', unanswered: true } })
    expect(result.outcome).toBeUndefined()
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(mocks.update.mock.calls[0][0].data.status).toBe('awaiting_approval')
    expect(mocks.clarification).not.toHaveBeenCalled()
    expect(resolveQuestionAnswer('run', 'original-question', '第一章')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps defaultable preferences separate when the frozen target is already known', async () => {
    scope('bounded')
    const { pending } = await start()
    await vi.advanceTimersByTimeAsync(env.agentApprovalTimeoutMs + 1)
    const result = await pending
    expect(result.failureCode).toBeUndefined()
    expect(result.output).toContain('默认方案继续')
    expect(mocks.update).toHaveBeenCalledTimes(2)
  })
  it('cannot replace a required decision when the bounded question budget is exhausted', async () => {
    for (let index = 0; index < 3; index++) consumeQuestionBudget('run')
    expect(await askUserTool.execute(ctx, args)).toMatchObject({ failureCode: 'AUTHOR_INPUT_REQUIRED', display: { unanswered: true } })
    expect(mocks.update).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it('retains a real answer without upgrading an old frozen contract', async () => {
    const original = scope(), before = structuredClone(original)
    const { pending } = await start()
    expect(resolveQuestionAnswer('run', 'original-question', '第一章写入')).toBe(true)
    const result = await pending
    expect(result).toMatchObject({ failureCode: 'AUTHOR_INPUT_REQUIRED', display: { answer: '第一章写入' } })
    expect(result.semanticTransition).toBeUndefined()
    expect(original).toEqual(before)
    expect(mocks.clarification).toHaveBeenCalledOnce()
  })
  it('allows only the already implemented authenticated clarification transition to continue', async () => {
    mocks.clarification.mockResolvedValue({ targetId: 'writing-scope:original', beforeHash: 'old', afterHash: 'new' })
    const { pending } = await start()
    expect(resolveQuestionAnswer('run', 'original-question', '第一章写入')).toBe(true)
    expect(await pending).toMatchObject({ semanticTransition: { targetId: 'writing-scope:original' } })
    expect(mocks.clarification).toHaveBeenCalledWith(expect.anything(), ctx, expect.objectContaining({ source: 'legacy_question', callId: ctx.callId }))
    expect(vi.getTimerCount()).toBe(0)
  })
  it('propagates cancellation without disguising it as a missing author decision', async () => {
    const controller = new AbortController(), { pending } = await start({ ...ctx, signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(mocks.update).toHaveBeenCalledOnce(); expect(mocks.clarification).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
