import { describe, expect, it } from 'vitest'
import { batchReviewSystem, batchReviewWorkSchema, packBatchReviewRequest, projectBatchReview } from '../../api/lib/agent/tools/batch-review.js'
import { estimateChatMessagesTokens } from '../../api/lib/agent/context-budget.js'
import { continuityReviewRequest } from '../../api/lib/agent/continuity-review.js'
import { buildQualityEvidenceSources, locateQuoteSpans, renderQualityEvidenceSources } from '../../api/lib/agent/quality-evidence.js'
import { buildCriticSystem } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { writingPlanContextHash, type WritingPlanContext } from '../../api/lib/agent/writing-plan-context.js'
import { priceTokenEvidence } from '../../api/lib/billing/reservation-policy.js'
import { V1_PRICING_VERSION } from '../../api/lib/billing/pricing.js'

const first = { chapterId: 'chapter-12', title: '借钥匙', orderIndex: 12, revision: 1, content: '周宁把铜钥匙交给老陈。雨下了一夜。' }
const second = { chapterId: 'chapter-13', title: '深夜开仓', orderIndex: 13, revision: 3, content: '周宁从自己的口袋取出铜钥匙。灯还亮着。' }
const entry = (chapterId: string, sourceIds: string[]) => ({
  chapterId, sourceIds, context: [], contextHash: chapterId + '-review', deterministic: [], cached: null, neighborStarts: {},
})
const work = batchReviewWorkSchema.parse({
  version: 1, reviewType: 'continuity', sources: [first, second],
  targets: [entry(first.chapterId, [first.chapterId]), entry(second.chapterId, [second.chapterId, first.chapterId])],
  unavailable: [], system: '独立审稿', content: '合成稿',
})
const conflict = {
  signal: 'object', severity: 'error', quote: '周宁从自己的口袋取出铜钥匙。',
  explanation: '前章已经交出铜钥匙。', suggestion: '检查是否应改成老陈持钥匙。',
  related: { chapterId: first.chapterId, quote: '周宁把铜钥匙交给老陈。' },
}

describe('batch chapter review projection', () => {
  it('reports separate chapter coverage and binds both ends of a cross-chapter conflict', () => {
    const response = JSON.stringify({ chapters: [
      { chapterId: first.chapterId, findings: [] },
      { chapterId: second.chapterId, findings: [conflict, conflict] },
    ] })
    const report = projectBatchReview(work, response, work, true)
    expect(report.chapters.map(chapter => chapter.status)).toEqual(['complete', 'complete'])
    expect(report.chapters[1].findings).toEqual([expect.objectContaining({
      label: '物品状态', evidence: '周宁从自己的口袋取出铜钥匙。',
      related: { chapterId: first.chapterId, title: first.title, evidence: '周宁把铜钥匙交给老陈。' },
    })])
  })

  it('finishes unaffected chapters when one return is missing evidence or structurally incomplete', () => {
    for (const findings of [[{ ...conflict, related: { ...conflict.related, quote: '不在原文中' } }], null]) {
      const response = JSON.stringify({ chapters: [{ chapterId: first.chapterId, findings: [] }, { chapterId: second.chapterId, findings }] })
      const report = projectBatchReview(work, response, work, true)
      expect(report.chapters.map(chapter => chapter.status)).toEqual(['complete', 'incomplete'])
      expect(report.chapters[1].findings ?? []).toEqual([])
    }
  })

  it('retains a current cached chapter through a partial failure without certifying stale prose', () => {
    const frozen = { ...work, targets: [{ ...work.targets[0], cached: [] }, work.targets[1]] }
    const current = { ...work, targets: [work.targets[0], { ...work.targets[1], contextHash: 'revised' }] }
    expect(projectBatchReview(frozen, '', current, false).chapters.map(chapter => chapter.status)).toEqual(['complete', 'stale'])
    expect(projectBatchReview(frozen, '', work, false, '检查已超时，未取得报告。').chapters[1]).toMatchObject({
      status: 'incomplete', detail: '检查已超时，未取得报告。',
    })
  })

  it('does not accept a related quality quote from the omitted part of a long previous chapter', () => {
    const qualityWork = {
      ...work, reviewType: 'quality' as const, targets: [work.targets[0], { ...work.targets[1],
        neighborStarts: { [first.chapterId]: first.content.indexOf('雨') } }],
    }
    const response = JSON.stringify({ chapters: [
      { chapterId: first.chapterId, findings: [] },
      { chapterId: second.chapterId, findings: [{ ...conflict, signal: 'chapter_bridge', severity: 'warning' }] },
    ] })
    expect(projectBatchReview(qualityWork, response, qualityWork, true).chapters.map(chapter => chapter.status)).toEqual(['complete', 'incomplete'])
  })
})

const toolContext = {
  userId: 'author', novelId: 'novel', chapterId: second.chapterId, runId: 'run', sessionId: 'session',
  callId: 'batch', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
  emit: () => {}, signal: new AbortController().signal,
} satisfies ToolContext

it.each(['continuity', 'quality', 'custom'] as const)('binds a repeated quote for %s with a full tool context', reviewType => {
  const source = { ...second, content: '门锁着。\n\n他先去了仓库，门锁着。\n\n门锁着。' }
  const table = buildQualityEvidenceSources({ userId: toolContext.userId, novelId: toolContext.novelId,
    chapterId: source.chapterId, chapterRevision: source.revision }, source.content)
  const anchor = table.entries.at(-1)!
  const frozen = { ...work, reviewType, sources: [first, source], targets: [work.targets[0], { ...work.targets[1], anchors: [{ id: anchor.id, text: anchor.text }] }] }
  const { quote: _quote, related: _related, ...rest } = conflict
  const finding = reviewType === 'quality' ? { ...rest, signal: 'explanation_echo', severity: 'warning' } : rest
  const response = JSON.stringify({ chapters: [
    { chapterId: first.chapterId, findings: [] }, { chapterId: source.chapterId, findings: [{ ...finding, sourceId: anchor.id.slice(0, 13) }] },
  ] })
  const report = projectBatchReview(frozen, response, frozen, true, undefined, toolContext)
  expect(report.chapters[1]).toMatchObject({ status: 'complete', findings: [{ evidence: anchor.text }] })
})

it('rebuilds strict evidence identity for continuity plan alignment', () => {
  const outline = { id: 'outline', title: '大纲', content: '找回钥匙。', planHash: 'outline-hash' }
  const detail = { id: 'detail', title: '细纲', content: '老陈从袋中找回钥匙。', planHash: 'detail-hash' }
  const plan: WritingPlanContext = { version: 1, outline, detail, target: { kind: 'chapter', chapterId: second.chapterId }, parentPlanHash: outline.planHash }
  const frozen = { ...work, targets: [work.targets[0], { ...work.targets[1], plan }] }
  const response = JSON.stringify({ chapters: [{ chapterId: first.chapterId, findings: [] },
    { chapterId: second.chapterId, findings: [], planAlignment: {
      version: 1, planContextHash: writingPlanContextHash(plan), status: 'reviewed', findings: [],
    } }] })
  expect(projectBatchReview(frozen, response, frozen, true, undefined, toolContext).chapters.map(chapter => chapter.status))
    .toEqual(['complete', 'complete'])
})

it('keeps verified evidence and marks the affected chapter incomplete despite a paid response', () => {
  const response = JSON.stringify({ chapters: [{ chapterId: first.chapterId, findings: [] },
    { chapterId: second.chapterId, findings: [conflict, { ...conflict, quote: '虚构引文' }] }] })
  const report = projectBatchReview(work, response, work, true)
  expect(report.chapters[0].status).toBe('complete')
  expect(report.chapters[1]).toMatchObject({ status: 'incomplete', detail: '1 条意见无法定位到原文。', findings: [{ evidence: conflict.quote }] })
  const cached = { ...work, targets: [work.targets[0], { ...work.targets[1], cached: {
    status: 'incomplete' as const, detail: report.chapters[1].detail!, findings: report.chapters[1].findings!,
  } }] }
  expect(projectBatchReview(cached, '', cached, false).chapters[1]).toEqual(report.chapters[1])
  expect(projectBatchReview(work, '{"findings":[]}', work, true).chapters[1]).toMatchObject({
    status: 'incomplete', detail: '模型已返回结果，但报告格式无法读取。',
  })
})

it('compares the same synthetic review set before and after batching with a scripted provider', async () => {
  const clean = { chapterId: 'chapter-14', title: '沿河归家', orderIndex: 14, revision: 1,
    content: '雾从河面退开。老陈收好铜钥匙，返身去厨房给客人倒茶。'.repeat(25) }
  const sourceList = [{ ...first, content: first.content + '周宁在屋檐下等雨停，等来了背着药篓的阿白。'.repeat(25) },
    { ...second, content: second.content + '他蹙起眉头。这个表现清楚地说明他正在皱眉。' +
      '老陈的称谓在这段变成了陈先生。'.replace('这段', '信里') + '两人随后把灯搬进仓库，隔开一扇半掩的门。'.repeat(25) }, clean]
  const targets = sourceList.map((source, index) => entry(source.chapterId, [source.chapterId, ...sourceList.slice(0, index).map(row => row.chapterId)]))
  const customRule = '核对同一人物在不同叙述视角下的称谓。当前段为周宁视角，沿用“老陈”；信中的直接引文允许照录原称谓。'
  const quality = { signal: 'explanation_echo', severity: 'warning', quote: '这个表现清楚地说明他正在皱眉。',
    explanation: '后一处复述已展示的动作。', suggestion: '去掉重复解释。', confidence: 0.98 }
  const custom = { signal: 'appellation', severity: 'advisory', quote: '老陈的称谓在信里变成了陈先生。',
    explanation: '此处仅转述信中称谓，段落叙述继续用老陈。', suggestion: '保留信中称谓，后续统一叙述视角。' }
  const families = { continuity: conflict, quality, custom } as const
  const originals = { taskId: 'synthetic', sourceRunId: 'synthetic', prompt: '连续写三章，检查钥匙交接、行文和称谓。' }
  const prepareSource = (source: typeof first, targetId: string) => ({
    ...source, source: source.chapterId === targetId ? 'current' as const : 'previous' as const,
    table: buildQualityEvidenceSources({ userId: 'author', novelId: 'novel', chapterId: source.chapterId, chapterRevision: source.revision }, source.content),
  })
  const attempts: Array<{ flow: string; scenario: string; ms: number; input: number; output: number; calls: number; credits: number }> = []
  const tokens = (system: string, content: string) => estimateChatMessagesTokens([{ role: 'system', content: system }, { role: 'user', content }])
  const legacyRequest = (family: keyof typeof families, index: number, revised: boolean) => {
    const chapter = sourceList[index]
    const body = revised ? chapter.content.replace(conflict.quote, '老陈从自己的口袋取出铜钥匙。').replace(quality.quote, '') : chapter.content
    const references = sourceList.slice(0, index + 1).map(row => prepareSource(row.chapterId === chapter.chapterId ? { ...row, content: body } : row, chapter.chapterId))
    if (family === 'continuity') return continuityReviewRequest({ original: originals,
      chapter: { id: chapter.chapterId, revision: chapter.revision, content: body } as Parameters<typeof continuityReviewRequest>[0]['chapter'],
      sources: references })
    return family === 'quality' ? { system: buildCriticSystem('balanced'), content: [
      originals.prompt, ...references.slice(0, -1).map(row => row.content), body, renderQualityEvidenceSources(references.at(-1)!.table),
    ].join('\n') } : { system: `独立小说批评。\n${customRule}`, content: `章节：${chapter.title}\n原文：\n${body}` }
  }
  for (const scenario of ['single', 'batch'] as const) for (const flow of ['before', 'after'] as const) {
    for (let sample = 0; sample < (process.env.CHEVOINK_REVIEW_BENCH === '1' ? 30 : 1); sample++) {
      const started = performance.now()
      let input = 0, output = 0, calls = 0, credits = 0, hits = 0, falsePositives = 0
      const request = async (system: string, content: string, response: unknown) => {
        calls++
        const raw = JSON.stringify(response)
        const promptTokens = tokens(system, content), completionTokens = tokens('', raw)
        input += promptTokens; output += completionTokens
        credits += priceTokenEvidence({ version: V1_PRICING_VERSION, modelTier: 'standard', multiplierBps: 10000 }, promptTokens, completionTokens) / 1000
        if (process.env.CHEVOINK_REVIEW_BENCH === '1') await new Promise(resolve => setTimeout(resolve, 12))
        return raw
      }
      const indexes = scenario === 'single' ? [1] : [0, 1, 2]
      for (const [family, finding] of Object.entries(families) as Array<[keyof typeof families, typeof families[keyof typeof families]]>) {
        if (flow === 'after' && scenario === 'batch') {
          const system = batchReviewSystem(family, family === 'custom' ? customRule : '')
          const content = packBatchReviewRequest(sourceList, targets)
          const frozen = { ...work, reviewType: family, targets, sources: sourceList, system, content }
          const raw = await request(system, content, { chapters: sourceList.map((source, index) => ({
            chapterId: source.chapterId, findings: index === 1 ? [finding] : [],
          })) })
          const result = projectBatchReview(frozen, raw, frozen, true)
          expect(result.chapters.every(chapter => chapter.status === 'complete')).toBe(true)
          hits += result.chapters[1].findings?.filter(item => item.evidence === finding.quote).length ?? 0
          falsePositives += (result.chapters[0].findings?.length ?? 0) + (result.chapters[2].findings?.length ?? 0)
        } else {
          for (const index of indexes) {
            const { system, content } = legacyRequest(family, index, false)
            const raw = await request(system, content, { findings: index === 1 ? [finding] : [] })
            const findings = (JSON.parse(raw) as { findings: Array<{ quote: string }> }).findings
              .filter(item => locateQuoteSpans(sourceList[index].content, item.quote).length === 1)
            if (index === 1) hits += findings.filter(item => item.quote === finding.quote).length
            else falsePositives += findings.length
          }
        }
      }
      const revised = sourceList[1].content.replace(conflict.quote, '老陈从自己的口袋取出铜钥匙。').replace(quality.quote, '')
      expect(revised).toContain('老陈从自己的口袋取出铜钥匙。')
      expect(revised).not.toContain(quality.quote)
      expect(revised).toContain(custom.quote)
      if (flow === 'before') {
        for (const family of ['continuity', 'quality'] as const) {
          const { system, content } = legacyRequest(family, 1, true)
          await request(system, content, { findings: [] })
        }
      }
      expect(hits).toBe(3)
      expect(falsePositives).toBe(0)
      expect(calls).toBe((flow === 'after' ? 3 : indexes.length * 3 + 2))
      attempts.push({ flow, scenario, ms: performance.now() - started, input, output, calls, credits })
    }
  }
  if (process.env.CHEVOINK_REVIEW_BENCH === '1') for (const scenario of ['single', 'batch']) for (const flow of ['before', 'after']) {
    const rows = attempts.filter(row => row.scenario === scenario && row.flow === flow).sort((a, b) => a.ms - b.ms)
    console.log(JSON.stringify({ ...rows[0], p50: rows[14].ms, p95: rows[28].ms, n: rows.length }))
  }
})
