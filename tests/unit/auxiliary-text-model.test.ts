import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
const mocks = vi.hoisted(() => ({ complete: vi.fn(), persist: vi.fn(), report: vi.fn() }))
vi.mock('../../api/lib/ai-service.js', () => ({ generateTextCompletion: mocks.complete }))
vi.mock('../../api/lib/agent/humanity-quality.js', async original => ({
  ...await original<object>(),
  resolveQualityChapterTarget: vi.fn(async () => 'chapter'),
  buildHumanityQualityContext: vi.fn(async () => ({ chapter: { title: '标题', content: '她关上了门。', revision: 1, novel: { categoryName: '故事', tagNames: [] } },
    compilation: null, charter: null, recentChapters: [], feedback: [], profiles: [], anchors: [] })),
  getLatestQualityReport: vi.fn(async () => null), persistHumanityQualityReport: mocks.persist, getQualityReport: mocks.report,
  selectQualityFindings: vi.fn(async () => undefined),
  reserveQualityAutoRepair: vi.fn(async () => true),
}))
// 自动修订前的准入探测在真实事务里读守卫表；本组只验证模型运行时继承，按模块隔离守卫。
const guard = vi.hoisted(() => ({ probe: vi.fn(async () => ({ open: true })) }))
vi.mock('../../api/lib/agent/chapter-review-guard.js', () => ({
  probeChapterReviewRevision: guard.probe, assertChapterReviewRevision: vi.fn(async () => undefined),
  isChapterRevisionChannelOpen: vi.fn(async () => true), readChapterReviewRevisionGuidance: vi.fn(async () => ''),
}))
import { auxiliaryTextModel } from '../../api/lib/agent/auxiliary-text-model.js'
import { qualityAnalyzeTool, qualityRevisionApplyTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { DataAccessError, prisma } from '../../api/lib/prisma.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
afterEach(() => vi.restoreAllMocks())

function runtime(tier: 'lite' | 'custom' | 'speed', multiplierBps = 0): NonNullable<ToolContext['modelRuntime']> {
  return { tier, multiplierBps, provider: 'fixture', modelName: 'selected-model', baseUrl: 'https://selected.invalid', apiKey: 'fixture-only',
    reasoningEffort: 'low', reasoningEfforts: ['low'], reasoningParameterMode: 'omit', visionEnabled: false, contextWindowTokens: 64000 }
}
function context(modelRuntime: ToolContext['modelRuntime']): ToolContext {
  return { userId: 'user', novelId: 'novel', chapterId: 'chapter', sessionId: 'session', runId: 'run', callId: 'call', mode: 'build',
    creativeFreedom: 'bold', qualityMode: 'balanced', modelRuntime, signal: new AbortController().signal, emit: vi.fn() }
}
beforeEach(() => {
  mocks.complete.mockReset()
  mocks.persist.mockReset().mockResolvedValue({ id: 'report', compilationId: null })
  mocks.report.mockReset().mockResolvedValue({ id: 'report', chapterId: 'chapter', chapterRevision: 1, repairRound: 0, status: 'passed', findings: [] })
})

describe('auxiliary text model inheritance', () => {
  it('a needs-attention report cannot be described as quality passed or permission to clear every warning', async () => {
    mocks.complete.mockResolvedValue('{"findings":[]}')
    mocks.report.mockResolvedValue({ id: 'report', chapterId: 'chapter', chapterRevision: 4, repairRound: 0, status: 'needs_repair',
      findings: [{ severity: 'warning', signal: 'emotion_grounding', quote: '她关上了门。', explanation: '待审意见', suggestion: '供作者参考' }] })
    const result = await qualityAnalyzeTool.execute(context(runtime('custom')), {})
    expect(result.output).toContain('绑定 r4，状态=needs_repair')
    expect(result.output).toContain('不能宣称质量检查通过')
    expect(result.output).toContain('不要求为清零意见改稿')
    expect(result.output).toContain('修订须由原始请求明确授权')
  })
  it.each(['lite', 'custom', 'speed'] as const)('preserves the full %s runtime when the selected model is free', tier => {
    const selected = runtime(tier)
    expect(auxiliaryTextModel(selected)).toBe(selected)
    expect(auxiliaryTextModel(undefined)).toBeUndefined()
    expect(auxiliaryTextModel(runtime('speed', 10000))).toBeUndefined()
  })
  it.each(['lite', 'custom'] as const)('keeps %s in actual quality review and evidence correction, never falling back to a paid model', async tier => {
    const selected = runtime(tier)
    mocks.complete.mockImplementation(async (_system, _content, options) => {
      // Simulate exhausted platform credits: an omitted runtime would resolve speed and fail.
      if (options.modelRuntime !== selected) throw new DataAccessError(402, 'CREDITS_EXHAUSTED', 'platform credits exhausted')
      return options.action === 'agent3HumanityCritic'
        ? JSON.stringify({ findings: [{ signal: 'emotion_grounding', severity: 'advisory', quote: '错误引文', explanation: '提示', suggestion: '待审', confidence: 0.9 }] })
        : JSON.stringify({ corrections: [{ index: 0, quote: '她关上了门。' }] })
    })
    const result = await qualityAnalyzeTool.execute(context(selected), {})
    expect(result.outcome).toBeUndefined()
    expect(mocks.complete).toHaveBeenCalledTimes(2)
    expect(mocks.complete.mock.calls.map(call => call[2].action)).toEqual(['agent3HumanityCritic', 'agent3HumanityEvidenceCorrection'])
    for (const call of mocks.complete.mock.calls) expect(call[2].modelRuntime).toBe(selected)
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ criticComplete: true,
      criticFindings: [expect.objectContaining({ quote: '她关上了门。' })] }))
  })
  it.each([
    new DataAccessError(502, 'AI_PROVIDER_TIMEOUT', 'critic correction timed out'),
    new DataAccessError(502, 'AI_PROVIDER_EMPTY_RESPONSE', 'critic correction returned no content'),
    new DataAccessError(402, 'CREDITS_EXHAUSTED', 'critic correction credits exhausted'),
  ])('persists an incomplete report with the original findings before rethrowing correction failure %#', async failure => {
    const findings = [
      { signal: 'emotion_grounding', severity: 'advisory', quote: '她关上了门。', explanation: '已定位', suggestion: '保留', confidence: 0.9 },
      { signal: 'reader_pull', severity: 'warning', quote: '不存在的原文。', explanation: '待校正', suggestion: '复核', confidence: 0.8 },
    ]
    mocks.report.mockResolvedValue({ id: 'report', chapterId: 'chapter', chapterRevision: 1, repairRound: 0, status: 'failed', findings: [] })
    mocks.complete.mockImplementationOnce(async () => JSON.stringify({ findings }))
      .mockImplementationOnce(async () => { throw failure })

    await expect(qualityAnalyzeTool.execute(context(runtime('lite')), {})).rejects.toBe(failure)

    expect(mocks.complete.mock.calls.map(call => call[2].action)).toEqual(['agent3HumanityCritic', 'agent3HumanityEvidenceCorrection'])
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({
      criticComplete: false,
      criticFindings: [
        expect.objectContaining({ quote: '她关上了门。' }),
        expect.objectContaining({ quote: '不存在的原文。' }),
      ],
      deterministicMetrics: expect.any(Object),
      deterministicFindings: expect.any(Array),
    }))
    expect(mocks.report).toHaveBeenCalledOnce()
  })
  it('does not persist a quality report when the author signal aborts during evidence correction', async () => {
    const controller = new AbortController()
    mocks.complete.mockResolvedValueOnce(JSON.stringify({ findings: [
      { signal: 'reader_pull', severity: 'warning', quote: '不存在的原文。', explanation: '待校正', suggestion: '复核', confidence: 0.8 },
    ] })).mockImplementationOnce(async () => {
      controller.abort()
      throw new DataAccessError(502, 'AI_PROVIDER_EMPTY_RESPONSE', 'synthetic late provider error')
    })
    await expect(qualityAnalyzeTool.execute({ ...context(runtime('lite')), signal: controller.signal }, {}))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.complete).toHaveBeenCalledTimes(2)
    expect(mocks.persist).not.toHaveBeenCalled()
    expect(mocks.report).not.toHaveBeenCalled()
  })
  it('accepts a complete empty finding array without another model call or evidence correction', async () => {
    mocks.complete.mockResolvedValueOnce('{"findings":[]}')
    const result = await qualityAnalyzeTool.execute(context(runtime('lite')), {})
    expect(result.outcome).toBeUndefined()
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ criticComplete: true, criticFindings: [] }))
  })
  it('retains the existing valid partial-correction policy and every unresolved judgment', async () => {
    const findings = [
      { signal: 'emotion_grounding', severity: 'advisory', quote: '她关上了门。', explanation: '已定位', suggestion: '保留', confidence: 0.9 },
      { signal: 'reader_pull', severity: 'warning', quote: '不存在的原文。', explanation: '待校正', suggestion: '复核', confidence: 0.8 },
    ]
    mocks.complete.mockResolvedValueOnce(JSON.stringify({ findings }))
      .mockResolvedValueOnce('{"corrections":[]}')
    await qualityAnalyzeTool.execute(context(runtime('lite')), {})
    expect(mocks.complete).toHaveBeenCalledTimes(2)
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({
      criticComplete: true,
      criticFindings: [expect.objectContaining({ quote: '她关上了门。' }), expect.objectContaining({ quote: '不存在的原文。' })],
    }))
  })
  it('does not pass or discard findings when evidence correction returns an empty response', async () => {
    mocks.report.mockResolvedValue({ id: 'report', chapterId: 'chapter', chapterRevision: 1, repairRound: 0, status: 'failed', findings: [] })
    mocks.complete.mockImplementationOnce(async () => JSON.stringify({ findings: [
      { signal: 'emotion_grounding', severity: 'advisory', quote: '她关上了门。', explanation: '已定位', suggestion: '保留', confidence: 0.9 },
      { signal: 'reader_pull', severity: 'warning', quote: '不存在的原文。', explanation: '待校正', suggestion: '复核', confidence: 0.8 },
    ] })).mockResolvedValueOnce('')

    const result = await qualityAnalyzeTool.execute(context(runtime('lite')), {})

    expect(result.outcome).toBe('failed')
    expect(result.output).toContain('引用校正未能完成')
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({
      criticComplete: false,
      criticFindings: [expect.objectContaining({ quote: '她关上了门。' }), expect.objectContaining({ quote: '不存在的原文。' })],
    }))
  })
  it('does not turn failure of the free provider into a passing report or switch to paid fallback', async () => {
    mocks.complete.mockRejectedValue(new DataAccessError(502, 'AI_PROVIDER_INCOMPLETE', 'incomplete'))
    await expect(qualityAnalyzeTool.execute(context(runtime('lite')), {})).rejects.toMatchObject({ code: 'AI_PROVIDER_INCOMPLETE' })
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.persist).not.toHaveBeenCalled()
  })
  it.each(['lite', 'custom'] as const)('keeps %s through explicitly authorized repair and its bounded format retry', async tier => {
    const selected = runtime(tier)
    const prompt = '修复当前章节中作者已选择的质量意见。'
    const run = { id: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', taskRootId: null,
      startRequest: { prompt }, taskSpec: buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt }) }
    const tx = { agentRun: { findFirst: vi.fn(async () => run), findFirstOrThrow: vi.fn(async () => run) },
      agentSession: { findFirst: vi.fn(async () => ({ spawnedFromRunId: null, spawnedFromSessionId: null })) },
      agentChildExecutionGrant: { findUnique: vi.fn(async () => null) } } as unknown as Prisma.TransactionClient
    vi.spyOn(prisma, '$transaction').mockImplementation(async work => (work as (tx: Prisma.TransactionClient) => Promise<unknown>)(tx))
    mocks.report.mockResolvedValue({ id: 'report', chapterId: 'chapter', chapterRevision: 1, repairRound: 0, status: 'needs_repair', deterministicMetrics: { independentCheck: 'complete' }, findings: [
      { id: 'finding', signal: 'emotion_grounding', severity: 'warning', disposition: 'selected', startOffset: 0, endOffset: 6,
        evidenceExcerpt: '她关上了门。', explanation: '提示', suggestion: '待审' },
    ] })
    mocks.complete.mockImplementation(async (_system, _content, options) => {
      if (options.modelRuntime !== selected) throw new DataAccessError(402, 'CREDITS_EXHAUSTED', 'platform credits exhausted')
      return options.action === 'agent3HumanityCritic' ? '{"findings":[]}' : 'invalid repair JSON'
    })
    const checked = await qualityAnalyzeTool.execute({ ...context(selected), creativeFreedom: 'balanced' }, {})
    // 严谨模式在同一次调用内集中修订；清空意见后模型两次都返回非法 JSON，正文保持原样。
    expect(mocks.complete.mock.calls.map(call => call[2].action)).toEqual(['agent3HumanityCritic', 'agent3HumanityRevision', 'agent3HumanityRevisionRetry'])
    expect(checked.summary).toContain('修订未应用')
    expect(checked.snapshot).toBeUndefined()
    const result = await qualityRevisionApplyTool.execute(context(selected), { reportId: 'report' })
    expect(mocks.complete.mock.calls.map(call => call[2].action)).toEqual(['agent3HumanityCritic', 'agent3HumanityRevision', 'agent3HumanityRevisionRetry', 'agent3HumanityRevision', 'agent3HumanityRevisionRetry'])
    for (const call of mocks.complete.mock.calls) expect(call[2].modelRuntime).toBe(selected)
    expect(result.output).toContain('正文保持不变')
    expect(result.snapshot).toBeUndefined()
  })
})
