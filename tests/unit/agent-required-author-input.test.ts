import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ scope: vi.fn(), assert: vi.fn(), clarification: vi.fn(), update: vi.fn(), covers: vi.fn() }))
vi.mock('../../api/lib/agent/writing-scope.js', () => ({ assertQuestionWritingScope: mocks.assert, readWritingScope: mocks.scope }))
vi.mock('../../api/lib/agent/writing-clarification.js', () => ({ recordWritingClarification: mocks.clarification }))
vi.mock('../../api/lib/agent/goal-runtime.js', () => ({ setGoalRunPhase: vi.fn(async () => {}) }))
vi.mock('../../api/lib/agent/goal-context.js', () => ({ currentGoalExecution: () => null }))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } },
  prisma: { $transaction: async (callback: (tx: object) => unknown) => callback({}), agentRun: { updateMany: mocks.update }, coverAsset: { findMany: mocks.covers } },
}))
import { askUserTool } from '../../api/lib/agent/tools/interact-tools.js'
import { normalizeToolInput } from '../../api/lib/agent/tools/input-validation.js'
import { cancelAllQuestions, consumeQuestionBudget, resolveQuestionAnswer } from '../../api/lib/agent/permissions.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { setGoalRunPhase } from '../../api/lib/agent/goal-runtime.js'
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
async function start(context = ctx, raw: unknown = args) {
  const pending = askUserTool.execute(context, askUserTool.parameters.parse(normalizeToolInput(askUserTool, raw)))
  for (let index = 0; index < 12; index++) await Promise.resolve()
  return { pending }
}
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); mocks.update.mockResolvedValue({ count: 1 }); mocks.clarification.mockResolvedValue(null); scope() })
afterEach(() => { cancelAllQuestions('run'); vi.useRealTimers() })

describe('legacy author questions are information, not permissions', () => {
  it.each([false, true])('returns unanswered information to the Agent without recording default authority (local=%s)', async local => {
    scope(local ? 'bounded' : 'needs_input', local)
    const { pending } = await start()
    await vi.advanceTimersByTimeAsync(env.agentApprovalTimeoutMs + 1)
    const result = await pending
    expect(result).toMatchObject({ questionTimedOut: true, display: { kind: 'question', unanswered: true } })
    expect(result.outcome).toBeUndefined()
    expect(result.failureCode).toBeUndefined()
    expect(mocks.update).toHaveBeenCalledTimes(2)
    expect(mocks.update.mock.lastCall![0].data.status).toBe('running')
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
    expect(result.output).toContain('提问已超时，本轮已结束')
    expect(result.output).not.toContain('默认方案继续')
    expect(result.display).not.toHaveProperty('scopeResolution')
    expect(mocks.update).toHaveBeenCalledTimes(2)
  })
  it('does not make an old question counter a permission barrier', async () => {
    for (let index = 0; index < 3; index++) consumeQuestionBudget('run')
    const { pending } = await start()
    expect(resolveQuestionAnswer('run', 'original-question', '继续讨论')).toBe(true)
    expect(await pending).toMatchObject({ display: { answer: '继续讨论' } })
    expect(mocks.update).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0)
  })
  it('retains a real answer without upgrading an old frozen contract', async () => {
    const original = scope(), before = structuredClone(original)
    const { pending } = await start()
    expect(resolveQuestionAnswer('run', 'original-question', '第一章写入')).toBe(true)
    const result = await pending
    expect(result).toMatchObject({ display: { answer: '第一章写入' } })
    expect(result.semanticTransition).toBeUndefined()
    expect(original).toEqual(before)
    expect(mocks.clarification).toHaveBeenCalledOnce()
  })
  it('allows only the already implemented authenticated clarification transition to continue', async () => {
    mocks.clarification.mockResolvedValue({ targetId: 'writing-scope:original', beforeHash: 'old', afterHash: 'new' })
    const { pending } = await start()
    expect(resolveQuestionAnswer('run', 'original-question', '第一章写入')).toBe(true)
    expect(await pending).toMatchObject({ semanticTransition: { targetId: 'writing-scope:original' }, display: { scopeResolution: 'accepted' } })
    expect(mocks.clarification).toHaveBeenCalledWith(expect.anything(), ctx, expect.objectContaining({ source: 'legacy_question', callId: ctx.callId }))
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not label an ordinary answered preference as a writing-scope grant', async () => {
    scope('bounded')
    const { pending } = await start()
    expect(resolveQuestionAnswer('run', 'original-question', '使用近距离视角')).toBe(true)
    const result = await pending
    expect(result.display).toMatchObject({ answer: '使用近距离视角' })
    expect(result.display).not.toHaveProperty('scopeResolution')
    expect(result.semanticTransition).toBeUndefined()
  })
  it('publishes an owned cover question after its waiter is ready and returns only the exact selected ID to the model', async () => {
    const options = [{ label: '候选一', detail: '蓝色调', coverAssetId: 'owned-cover' }, { label: '暂不应用' }]
    const answer = '候选一（蓝色调）'
    mocks.covers.mockResolvedValue([{ id: 'owned-cover' }])
    const publishQuestion = vi.fn(() => expect(resolveQuestionAnswer(ctx.runId, ctx.callId, { answer })).toBe(true))
    const { pending } = await start({ ...ctx, publishQuestion }, { question: '选哪张封面？', options })
    const result = await pending
    expect(publishQuestion).toHaveBeenCalledOnce()
    expect(mocks.covers).toHaveBeenCalledExactlyOnceWith({ where: { id: { in: ['owned-cover'] }, ownerUserId: ctx.userId, novelId: ctx.novelId }, select: { id: true } })
    expect(result.output).toBe(`作者的回答：${answer}\n作者选择的封面候选 coverAssetId：owned-cover`)
    expect(result.display).toMatchObject({ options, answer })
  })

  it.each(['unavailable', 'ambiguous', 'too-many'] as const)('does not publish invalid cover options: %s', async scenario => {
    mocks.covers.mockResolvedValue([])
    const candidate = { label: '候选一', detail: '蓝色调', coverAssetId: 'foreign-cover' }
    const options = scenario === 'ambiguous' ? [candidate, { label: '候选一（蓝色调）' }]
      : [candidate, { label: '暂不应用' }, ...(scenario === 'too-many' ? [{ label: '候选三' }, { label: '候选四' }] : [])]
    const publishQuestion = vi.fn()
    const { pending } = await start({ ...ctx, publishQuestion }, { question: '选哪张封面？', options })
    expect(await pending).toMatchObject({ outcome: 'failed', failureCode: scenario === 'unavailable' ? 'QUESTION_COVER_UNAVAILABLE'
      : scenario === 'ambiguous' ? 'QUESTION_COVER_AMBIGUOUS' : 'TOOL_SCHEMA_INVALID' })
    expect(publishQuestion).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(resolveQuestionAnswer(ctx.runId, ctx.callId, '暂不应用')).toBe(false)
    if (scenario !== 'unavailable') expect(mocks.covers).not.toHaveBeenCalled()
  })
  it('propagates cancellation without disguising it as a missing author decision', async () => {
    const controller = new AbortController(), { pending } = await start({ ...ctx, signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(mocks.update).toHaveBeenCalledOnce(); expect(mocks.clarification).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an answer at the deadline even if the timer callback has not run', async () => {
    const { pending } = await start()
    vi.setSystemTime(Date.now() + env.agentApprovalTimeoutMs)
    expect(resolveQuestionAnswer('run', 'original-question', '第一章')).toBe(false)
    expect(await pending).toMatchObject({ questionTimedOut: true, display: { unanswered: true } })
    expect(mocks.clarification).not.toHaveBeenCalled()
  })

  it('accepts only the complete ordered batch for the active call and preserves every answer', async () => {
    const questions = [args, { question: '使用什么视角？', options: [{ label: '第一人称' }, { label: '第三人称' }] }]
    const context = { ...ctx, authorQuestionAnswers: new Map() }
    const { pending } = await start(context, { questions, purpose: 'novel_direction' })
    const resolve = (decision: Parameters<typeof resolveQuestionAnswer>[2]) => resolveQuestionAnswer(ctx.runId, ctx.callId, decision)
    expect(resolve({ answer: '第一章' })).toBe(false)
    expect(resolve({ answers: ['第一章'] })).toBe(false)
    expect(resolve({ answers: ['第一章', '  '] })).toBe(false)
    expect(resolve({ answers: ['第一章', '第一人称', '过多答案'] })).toBe(false)
    expect(resolveQuestionAnswer(ctx.runId, 'old-question', { answers: ['第一章', '第一人称'] })).toBe(false)
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(resolve({ answers: [' 第一章 ', '第一人称'] })).toBe(true)
    const result = await pending
    expect(result).toMatchObject({ display: { ...args, questions, answer: '第一章', answers: ['第一章', '第一人称'] } })
    expect(result.output).toBe('1. 写入哪一章？\n作者的回答：第一章\n\n2. 使用什么视角？\n作者的回答：第一人称')
    expect(context.authorQuestionAnswers.get(ctx.callId)).toMatchObject({ answer: '第一章', purpose: 'novel_direction' })
    expect(mocks.clarification).toHaveBeenCalledExactlyOnceWith(expect.anything(), context,
      { ...args, callId: ctx.callId, answer: '第一章', source: 'legacy_question' })
    expect(resolve({ answers: ['第一章', '第一人称'] })).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns an explicit batch cancellation without an answer or clarification', async () => {
    const questions = [args]
    const { pending } = await start(ctx, { questions })
    expect(resolveQuestionAnswer(ctx.runId, ctx.callId, { answer: '第一章' })).toBe(false)
    expect(resolveQuestionAnswer(ctx.runId, ctx.callId, { cancelled: true })).toBe(true)
    const result = await pending
    expect(result).toMatchObject({ questionCancelled: true, display: { ...args, questions, unanswered: true, cancelled: true } })
    expect(setGoalRunPhase).toHaveBeenLastCalledWith(ctx.userId, ctx.runId, 'awaiting_input', 'GOAL_QUESTION_CANCELLED')
    expect(result).not.toHaveProperty('questionTimedOut')
    expect(result.display).not.toHaveProperty('answer')
    expect(mocks.clarification).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

})
