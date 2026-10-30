import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import * as originalRequest from '../../api/lib/agent/original-request.js'
import * as writingContext from '../../api/lib/agent/writing-request-context.js'
import * as compiler from '../../api/lib/agent/story-compiler.js'
import { qualityReassessmentContext } from '../../api/lib/agent/quality-reassessment.js'
import { advanceReviewCycle, beginReviewCycle, qualityReviewCycleContext, reviewCycleContentHash, reviewCycleFinding } from '../../api/lib/agent/review-cycle.js'
import { buildCriticInput, buildCriticSystem } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { qualityReviewContextHash, buildHumanityQualityContext } from '../../api/lib/agent/humanity-quality.js'
import { qualityWorkContextProjection, qualityWorkPromptProtocol } from '../../api/lib/agent/tools/durable-quality.js'

type Bundle = Awaited<ReturnType<typeof buildHumanityQualityContext>>
function revise(before: string, edits: Array<Array<{ start: number; end: number; newText: string }>>, evidence = '她没有回答') {
  let body = before, revision = 1
  let cycle = beginReviewCycle({ taskId: 'task', userId: 'u', novelId: 'n', chapterId: 'c' }, {
    compilationId: 'comp', revision, content: body, ready: true, required: { continuity: true, quality: true },
    binding: { contentHash: reviewCycleContentHash(body), continuityBinding: 'actual', qualityReportId: 'q', qualityReportHash: 'a'.repeat(64) },
    findings: [reviewCycleFinding({ source: 'quality', reportId: 'q', findingId: 'f', signal: 'explanation_echo', severity: 'advisory',
      evidence, explanation: '原版存在复述', suggestion: '保留新事实' }, body)],
  })
  for (const ranges of edits) {
    let after = body
    for (const range of [...ranges].sort((a, b) => b.start - a.start)) after = after.slice(0, range.start) + range.newText + after.slice(range.end)
    cycle = advanceReviewCycle(cycle, { beforeRevision: revision, afterRevision: ++revision, before: body, after, ranges })
    body = after
  }
  const prior = qualityReviewCycleContext(cycle, { revision, content: body })!
  return { body, prior, cycle, projection: qualityReassessmentContext(prior, body) }
}
describe('verified reassessment coordinates, never a literary pass', () => {
  it('maps disjoint edits and unchanged issue anchors to the current saved chapter', () => {
    const { body, projection } = revise('门开着。她没有回答。灯亮着。', [[{ start: 0, end: 3, newText: '门被推开了' }], [{ start: 12, end: 15, newText: '暗' }]])
    for (const region of projection.changedRegions) expect(body.slice(region.start, region.end)).toBe(region.text)
    expect(projection.baselineLocations[0]).toMatchObject({ location: 'unchanged', currentAnchor: { start: 6, end: 11, text: '她没有回答' } })
    expect(projection.changedRegions).toHaveLength(2)
  })
  it('marks an edited original issue as unknown and carries the actual replacement', () => {
    const { projection } = revise('她没有回答。', [[{ start: 0, end: 5, newText: '她摇了头' }]])
    expect(projection.baselineLocations[0]).toMatchObject({ location: 'edited_or_unlocated', currentAnchor: null })
    expect(projection.changedRegions[0]).toMatchObject({ text: '摇了头', before: '她', after: '。' })
    expect(projection).not.toHaveProperty('resolved')
  })
  it('keeps a deletion point and adjacent context so lost facts can still be reviewed', () => {
    const { projection } = revise('门开着。她没有回答。灯亮着。', [[{ start: 4, end: 10, newText: '' }]])
    expect(projection.changedRegions).toEqual([{ start: 4, end: 4, text: '', before: '门开着。', after: '灯亮着。' }])
    expect(projection.baselineLocations[0].currentAnchor).toBeNull()
  })
  it('maps overlapping later replacements and earlier insertions without stale offsets', () => {
    const { body, projection } = revise('门开着。她没有回答。', [
      [{ start: 0, end: 3, newText: '门口透着灯光' }],
      [{ start: 2, end: 5, newText: '有光' }],
      [{ start: 0, end: 0, newText: '此时，' }],
    ])
    expect(projection.changedRegions).toEqual([{ start: 0, end: 3, text: '此时，', before: '', after: body.slice(3) },
      { start: 4, end: 8, text: '口有光光', before: '此时，门', after: body.slice(8) }])
    const anchor = projection.baselineLocations[0].currentAnchor!
    expect(body.slice(anchor.start, anchor.end)).toBe('她没有回答')
  })
  it('does not erase an unchanged previously missed issue from the current input', () => {
    const { body, prior } = revise('门开着。她没有回答。', [[{ start: 0, end: 3, newText: '门合上' }]])
    const bundle = { chapter: { id: 'c', title: '测试', revision: 2, content: body, novel: { tagNames: [] } },
      profiles: [], anchors: [], feedback: [], recentChapters: [], charter: null, compilation: null,
      originalRequest: '保留事实，局部修复', chapterWritingBackground: [], priorReviewCycle: prior,
      priorQualityJudgment: { reportId: 'intervening', reportRevision: 1, sourceRevision: 1, independentCheck: 'complete', findings: [] } } as unknown as Bundle
    const input = buildCriticInput(bundle, {})
    expect(input).toContain(body)
    expect(input).toContain('她没有回答')
    expect(input).toContain('intervening')
    expect(input).toContain('当前修订投影')
    expect(buildCriticInput(bundle, {}, undefined, 'humanity-context.v6')).not.toContain('当前修订投影')
    expect(buildCriticInput(bundle, {}, undefined, 'humanity-context.v6')).not.toContain('intervening')
    const { priorQualityJudgment: _history, ...old } = bundle
    expect(qualityWorkContextProjection(bundle, 13)).toEqual(old)
    expect(qualityWorkContextProjection(bundle, 14)).toEqual(bundle)
    expect(qualityWorkPromptProtocol(13)).toBe('humanity-context.v6')
    expect(qualityWorkPromptProtocol(14)).toBe('humanity-context.v7')
    expect(qualityReviewContextHash(bundle, 'humanity-context.v6')).toBe(qualityReviewContextHash(old, 'humanity-context.v6'))
    expect(qualityReviewContextHash(bundle)).not.toBe(qualityReviewContextHash(old))
  })
  it('changes only new prompt rules and retains genuine new issues and the complete review', () => {
    const current = buildCriticSystem('balanced'), frozen = buildCriticSystem('balanced', 'humanity-context.v6')
    expect(current).toContain('不得故意每次只给一条')
    expect(current).toContain('此前遗漏')
    expect(current).toContain('不能仅凭上次未报告就称为回归')
    expect(current).toContain('不隐瞒、不降级、不伪造通过')
    expect(current).toContain('仍需独立检查当前全文')
    expect(frozen).not.toContain('此前遗漏')
    expect(frozen).toContain('不要求每行重复引号')
  })
})


describe('prior judgment scope and stable current report inputs', () => {
  afterEach(() => vi.restoreAllMocks())
  it('loads only the latest complete old-source report in the verified compilation and ignores mutable stale labels', async () => {
    const { body, cycle } = revise('门开着。她没有回答。', [[{ start: 0, end: 3, newText: '门合上' }]])
    vi.spyOn(compiler, 'compilationRunScope').mockResolvedValue({})
    vi.spyOn(originalRequest, 'readOriginalTaskRequest').mockResolvedValue({ taskId: 'task', prompt: '局部修复', sourceRunId: 'r', parentRunId: null, spec: {} } as unknown as Awaited<ReturnType<typeof originalRequest.readOriginalTaskRequest>>)
    vi.spyOn(writingContext, 'readChapterWritingBackground').mockResolvedValue([])
    const prior = { id: 'prior', chapterRevision: 1, status: 'needs_repair', deterministicMetrics: { independentCheck: 'complete', contentHash: 'old', criticResponse: { rawResponse: 'private old full response' } },
      findings: [{ id: 'f', signal: 'explanation_echo', severity: 'advisory', evidenceExcerpt: '她没有回答', explanation: '原判断', suggestion: '保留事实', disposition: 'pending', authorFeedback: null, feedbackReason: null }] }
    const findFirst = vi.fn().mockResolvedValue(prior)
    const chapter = { id: 'c', revision: 2, content: body, title: '合成章', orderIndex: 1, novel: { tagNames: [] } }
    const db = { chapter: { findFirst: vi.fn().mockResolvedValue(chapter), findMany: vi.fn().mockResolvedValue([]) },
      storyCharter: { findUnique: vi.fn().mockResolvedValue(null) }, storyCompilation: { findFirst: vi.fn().mockResolvedValue({ id: 'comp', preparedContext: { reviewCycle: cycle } }) },
      characterVoiceProfile: { findMany: vi.fn().mockResolvedValue([]) }, experienceAnchor: { findMany: vi.fn().mockResolvedValue([]) },
      qualityFinding: { groupBy: vi.fn().mockResolvedValue([]) }, agentDataControl: { findUnique: vi.fn().mockResolvedValue(null) }, chapterQualityReport: { findFirst } } as unknown as Prisma.TransactionClient
    const first = await buildHumanityQualityContext('u', 'n', 'c', 'r', db)
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      userId: 'u', novelId: 'n', chapterId: 'c', compilationId: 'comp', status: { in: ['passed', 'needs_repair', 'repaired', 'stale'] },
      deterministicMetrics: { path: ['independentCheck'], equals: 'complete' },
      OR: [{ chapterRevision: { lt: 2 } }, { status: 'repaired', chapterRevision: 2, AND: [{ deterministicMetrics: { path: ['sourceRevision'], lt: 2 } }] }],
    }, orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }] }))
    expect(first.priorQualityJudgment).toMatchObject({ reportId: 'prior', sourceRevision: 1, independentCheck: 'complete', findings: prior.findings })
    expect(JSON.stringify(first.priorQualityJudgment)).not.toContain('private old full response')
    prior.status = 'stale'
    const second = await buildHumanityQualityContext('u', 'n', 'c', 'r', db)
    expect(qualityReviewContextHash(second)).toBe(qualityReviewContextHash(first))
    db.storyCompilation.findFirst = vi.fn().mockResolvedValue(null)
    findFirst.mockClear()
    expect((await buildHumanityQualityContext('u', 'n', 'c', 'r', db)).priorQualityJudgment).toBeUndefined()
    expect(findFirst).not.toHaveBeenCalled()
  })
})
