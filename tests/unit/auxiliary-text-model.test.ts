import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import { auxiliaryTextModel } from '../../api/lib/agent/auxiliary-text-model.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { DataAccessError } from '../../api/lib/prisma.js'

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
  it('does not turn failure of the free provider into a passing report or switch to paid fallback', async () => {
    mocks.complete.mockRejectedValue(new DataAccessError(502, 'AI_PROVIDER_INCOMPLETE', 'incomplete'))
    await expect(qualityAnalyzeTool.execute(context(runtime('lite')), {})).rejects.toMatchObject({ code: 'AI_PROVIDER_INCOMPLETE' })
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.persist).not.toHaveBeenCalled()
  })
  it.each(['lite', 'custom'] as const)('keeps %s through automatic repair and its bounded format retry', async tier => {
    const selected = runtime(tier)
    mocks.report.mockResolvedValue({ id: 'report', chapterId: 'chapter', chapterRevision: 1, repairRound: 0, status: 'needs_repair', deterministicMetrics: { independentCheck: 'complete' }, findings: [
      { id: 'finding', signal: 'emotion_grounding', severity: 'warning', disposition: 'pending', startOffset: 0, endOffset: 6,
        evidenceExcerpt: '她关上了门。', explanation: '提示', suggestion: '待审' },
    ] })
    mocks.complete.mockImplementation(async (_system, _content, options) => {
      if (options.modelRuntime !== selected) throw new DataAccessError(402, 'CREDITS_EXHAUSTED', 'platform credits exhausted')
      return options.action === 'agent3HumanityCritic' ? '{"findings":[]}' : 'invalid repair JSON'
    })
    const result = await qualityAnalyzeTool.execute({ ...context(selected), creativeFreedom: 'balanced' }, {})
    expect(mocks.complete.mock.calls.map(call => call[2].action)).toEqual(['agent3HumanityCritic', 'agent3HumanityRevision', 'agent3HumanityRevisionRetry'])
    for (const call of mocks.complete.mock.calls) expect(call[2].modelRuntime).toBe(selected)
    expect(result.output).toContain('正文未修改')
    expect(result.output).toContain('同一报告不循环重试')
    expect(result.snapshot).toBeUndefined()
  })
})
