import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const mocks = vi.hoisted(() => ({
  novel: vi.fn(), generate: vi.fn(), session: vi.fn(), target: vi.fn(), children: vi.fn(), create: vi.fn(), update: vi.fn(),
  message: vi.fn(), run: vi.fn(), activeCount: vi.fn(), activeSession: vi.fn(), start: vi.fn(), fork: vi.fn(),
  taskRuns: vi.fn(), assigned: vi.fn(), admit: vi.fn(),
}))
vi.mock('../../api/config/env.js', () => ({ env: { agentSpawnMaxParallel: 3, agentOrchestrationMaxConcurrent: 4 } }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: {
  novel: { findFirst: mocks.novel },
  agentSession: { findUnique: mocks.session, findFirst: mocks.target, findMany: mocks.children, create: mocks.create, update: mocks.update },
  agentMessage: { findFirst: mocks.message }, agentRun: { findUnique: mocks.run, findFirst: mocks.run },
} }))
vi.mock('../../api/lib/ai-service.js', () => ({ generateCoverImageData: mocks.generate }))
vi.mock('../../api/lib/agent/tools/cover-application.js', () => ({ applyCoverSelection: vi.fn(), prepareCoverSelection: vi.fn() }))
vi.mock('../../api/lib/agent/active-runs.js', () => ({ countActiveRunsByUser: mocks.activeCount, hasActiveRunInSession: mocks.activeSession }))
vi.mock('../../api/lib/agent/task-lineage.js', () => ({ getTaskRunIds: mocks.taskRuns }))
vi.mock('../../api/lib/agent/model-assignment-context.js', () => ({ assignedTaskModel: mocks.assigned }))
vi.mock('../../api/lib/agent/model-assignments.js', () => ({ admitAssignedModel: mocks.admit }))
vi.mock('../../api/lib/agent/run-service.js', () => ({ startLoopRun: mocks.start, forkAgentSessionData: mocks.fork }))

import { coverGenerateTool } from '../../api/lib/agent/tools/cover-tools.js'
import { taskSendTool, taskSpawnTool } from '../../api/lib/agent/tools/task-orchestration-tools.js'

const context = (): ToolContext => ({ userId: 'author', novelId: 'novel', sessionId: 'parent', runId: 'run', chapterId: null,
  callId: 'call', mode: 'build', creativeFreedom: 'stable', qualityMode: 'premium', emit: vi.fn(), signal: new AbortController().signal })
const spawnArgs = (count = 1) => taskSpawnTool.parameters.parse({ tasks: Array.from({ length: count }, (_, index) => ({
  title: `窗口${index + 1}`, brief: '按作者指定分工完成当前章节，并提交自包含的实际交付摘要。',
})) })
const sendArgs = () => taskSendTool.parameters.parse({ sessionId: 'child', prompt: '按原分工核对并修正已保存章节。' })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.novel.mockResolvedValue({ title: '作品标题', displayTitle: null })
  mocks.generate.mockResolvedValue({ images: [] })
  mocks.session.mockResolvedValue({ spawnedFromSessionId: null })
  mocks.target.mockResolvedValue({ id: 'child', title: '子窗口', novelId: 'novel' })
  mocks.children.mockResolvedValue([{ id: 'child', title: '子窗口' }])
  mocks.message.mockResolvedValue({ parts: [{ type: 'text', text: '请打开多个任务窗口分别写第一章和第二章。' }] })
  mocks.run.mockResolvedValue({ modelTier: 'pro', customModelId: null, reasoningEffort: 'high', status: 'completed' })
  mocks.create.mockResolvedValue({ id: 'created-child' })
  mocks.fork.mockResolvedValue({ session: { id: 'forked-child' } })
  mocks.activeCount.mockReturnValue(0)
  mocks.activeSession.mockReturnValue(false)
  mocks.taskRuns.mockResolvedValue(['run'])
  mocks.assigned.mockResolvedValue(null)
  mocks.start.mockResolvedValue({ runId: 'child-run' })
})

describe('legacy cover generation result truth', () => {
  it('fails before dispatch when the owned novel is absent', async () => {
    mocks.novel.mockResolvedValue(null)
    expect(await coverGenerateTool.execute(context(), { prompt: '书封提示词' })).toMatchObject({ outcome: 'failed', failureCode: 'NOVEL_NOT_FOUND' })
    expect(mocks.generate).not.toHaveBeenCalled()
  })
  it('marks an empty generation response as failed without claiming no paid operation occurred', async () => {
    const result = await coverGenerateTool.execute(context(), { prompt: '书封提示词' })
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'COVER_GENERATION_EMPTY' })
    expect(result.resultSemantics).toBeUndefined()
    expect(mocks.generate).toHaveBeenCalledOnce()
  })
  it('preserves a valid partial set of candidates and its original provider URL', async () => {
    const image = { id: 'saved-cover', imageUrl: 'https://provider.example/original.png' }
    mocks.generate.mockResolvedValue({ images: [image] })
    const ctx = context()
    const result = await coverGenerateTool.execute(ctx, { prompt: '书封提示词', count: 2 })
    expect(result.outcome).toBeUndefined()
    expect(result.display).toEqual({ kind: 'coverImages', images: [{ id: image.id, url: image.imageUrl }] })
    expect(result.output).toContain(image.id)
    expect(mocks.generate).toHaveBeenCalledWith('author', expect.objectContaining({ count: 2, novelId: 'novel' }), { signal: ctx.signal })
  })
  it('leaves an unknown provider or persistence outcome on its original error path without retry', async () => {
    const unknown = Object.assign(new Error('result persisted; receipt unavailable'), { code: 'PROVIDER_RESULT_UNKNOWN' })
    mocks.generate.mockRejectedValue(unknown)
    await expect(coverGenerateTool.execute(context(), { prompt: '书封提示词' })).rejects.toBe(unknown)
    expect(mocks.generate).toHaveBeenCalledOnce()
  })
})

describe('legacy task orchestration result truth', () => {
  it.each(['spawn', 'send'] as const)('marks recursive %s refusal failed before side effects', async operation => {
    mocks.session.mockResolvedValue({ spawnedFromSessionId: 'other-parent' })
    const result = operation === 'spawn' ? await taskSpawnTool.execute(context(), spawnArgs()) : await taskSendTool.execute(context(), sendArgs())
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'TASK_ORCHESTRATION_RECURSION_BLOCKED' })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('marks capacity refusal failed before creating any child', async () => {
    mocks.activeCount.mockReturnValue(4)
    expect(await taskSpawnTool.execute(context(), spawnArgs())).toMatchObject({ outcome: 'failed', failureCode: 'TASK_ORCHESTRATION_CAPACITY' })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('preserves the scope guard and does not create an unauthorized child', async () => {
    mocks.message.mockResolvedValue({ parts: [{ type: 'text', text: '只写第一章。' }] })
    await expect(taskSpawnTool.execute(context(), spawnArgs())).rejects.toThrow('没有作者明确')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('preserves a fully started spawn result, event and window identifiers', async () => {
    const ctx = context()
    const result = await taskSpawnTool.execute(ctx, spawnArgs())
    expect(result.outcome).toBeUndefined()
    expect(result.display).toMatchObject({ windows: [{ sessionId: 'created-child', status: 'running' }] })
    expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'task.spawned', sessions: [expect.objectContaining({ sessionId: 'created-child', runId: 'child-run' })] }))
  })
  it('reports a fully rejected batch as failed without inventing windows', async () => {
    mocks.assigned.mockRejectedValue(new Error('model unavailable'))
    const result = await taskSpawnTool.execute(context(), spawnArgs())
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'TASK_SPAWN_FAILED', display: { windows: [] } })
    expect(result.output).toContain('model unavailable')
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('retains successful windows and a created window with unconfirmed start in a partial failure', async () => {
    mocks.create.mockResolvedValueOnce({ id: 'started-child' }).mockResolvedValueOnce({ id: 'unconfirmed-child' })
    mocks.start.mockResolvedValueOnce({ runId: 'started-run' }).mockRejectedValueOnce(new Error('receipt write unavailable'))
    const ctx = context()
    const result = await taskSpawnTool.execute(ctx, spawnArgs(2))
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'TASK_SPAWN_PARTIAL_FAILURE',
      display: { windows: [{ sessionId: 'started-child', status: 'running' }] } })
    expect(result.output).toContain('unconfirmed-child')
    expect(result.output).toContain('启动结果未确认')
    expect(result.output).toContain('不要重复派生')
    expect(result.resultSemantics).toBeUndefined()
    expect(mocks.start).toHaveBeenCalledTimes(2)
    expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ sessions: [expect.objectContaining({ sessionId: 'started-child', runId: 'started-run' })] }))
  })
  it('marks skipped work as a partial capacity failure while preserving the started child', async () => {
    mocks.activeCount.mockReturnValue(3)
    const result = await taskSpawnTool.execute(context(), spawnArgs(2))
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'TASK_SPAWN_PARTIAL_FAILURE', display: { windows: [{ sessionId: 'created-child', status: 'running' }] } })
    expect(result.output).toContain('1 个任务因并行上限')
    expect(mocks.start).toHaveBeenCalledOnce()
  })
  it('retains a created child when no successful start receipt was received', async () => {
    mocks.start.mockRejectedValue(new Error('unknown start result'))
    const result = await taskSpawnTool.execute(context(), spawnArgs())
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'TASK_SPAWN_FAILED' })
    expect(result.output).toContain('created-child')
    expect(result.output).toContain('启动结果未确认')
    expect(result.output).not.toContain('没有成功派生任何')
    expect(result.resultSemantics).toBeUndefined()
  })
  it('retains a forked child identifier if updating its metadata fails', async () => {
    mocks.update.mockRejectedValue(new Error('metadata update unavailable'))
    const result = await taskSpawnTool.execute(context(), { ...spawnArgs(), inherit: 'transcript' })
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'TASK_SPAWN_FAILED' })
    expect(result.output).toContain('forked-child')
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('marks self-send refusal failed without querying or starting the target', async () => {
    expect(await taskSendTool.execute(context(), { ...sendArgs(), sessionId: 'parent' })).toMatchObject({ outcome: 'failed', failureCode: 'TASK_SEND_TARGET_INVALID' })
    expect(mocks.target).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('preserves the current-task send guard before looking up a historical target', async () => {
    mocks.children.mockResolvedValue([])
    await expect(taskSendTool.execute(context(), sendArgs())).rejects.toThrow('不属于当前任务')
    expect(mocks.target).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it.each(['missing', 'busy', 'capacity'] as const)('marks %s send refusal failed before starting', async refusal => {
    if (refusal === 'missing') mocks.target.mockResolvedValue(null)
    if (refusal === 'busy') mocks.activeSession.mockReturnValue(true)
    if (refusal === 'capacity') mocks.activeCount.mockReturnValue(4)
    const result = await taskSendTool.execute(context(), sendArgs())
    expect(result).toMatchObject({ outcome: 'failed', failureCode: { missing: 'TASK_SEND_TARGET_NOT_FOUND', busy: 'TASK_SEND_TARGET_BUSY', capacity: 'TASK_ORCHESTRATION_CAPACITY' }[refusal] })
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('keeps successful send and its started run event intact', async () => {
    const ctx = context()
    const result = await taskSendTool.execute(ctx, sendArgs())
    expect(result.outcome).toBeUndefined()
    expect(result.display).toMatchObject({ mode: 'send', windows: [{ sessionId: 'child', status: 'running' }] })
    expect(mocks.start).toHaveBeenCalledOnce()
    expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ sessions: [expect.objectContaining({ sessionId: 'child', runId: 'child-run' })] }))
  })
  it('preserves unknown send-start evidence and requires a read before another side effect', async () => {
    mocks.start.mockRejectedValue(new Error('receipt unavailable after start'))
    const result = await taskSendTool.execute(context(), sendArgs())
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'TASK_SEND_START_UNCONFIRMED' })
    expect(result.output).toContain('child')
    expect(result.output).toContain('可能已有执行或交付')
    expect(result.output).toContain('先用 task_wait')
    expect(result.output).not.toContain('可稍后重试')
    expect(result.resultSemantics).toBeUndefined()
    expect(mocks.start).toHaveBeenCalledOnce()
  })
})
