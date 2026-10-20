import { describe, expect, it } from 'vitest'
import { HUMANITY_CONTEXT_SCENARIOS } from '../agent-evals/humanity-context-scenarios.js'
import { buildCriticInput, buildCriticSystem } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { buildQualityEvidenceSources, coerceCriticFindings } from '../../api/lib/agent/quality-evidence.js'
import { prepareQualityFindings, type buildHumanityQualityContext } from '../../api/lib/agent/humanity-quality.js'

describe('contextual prose prompt and exact-edit contract (no literary score)', () => {
  it.each(['balanced', 'story', 'style'] as const)('assembles same-sentence and new-fact reasoning for independent %s critic', lens => {
    const system = buildCriticSystem(lens)
    for (const rule of ['同句与跨句都检查', '事实必要', '当前表达必要', '不能断言没有新信息', '不得锚前句却建议修改锚外的后句',
      '机器人依规复述', '读者未知的规则', '人物纠正误解', '有意否定对照', '作者合理直述', '不强制转对白', '审美分歧保留 advisory']) expect(system).toContain(rule)
  })
  it.each(HUMANITY_CONTEXT_SCENARIOS)('keeps all synthetic $id prose and evidence in the actual input', sample => {
    const sources = buildQualityEvidenceSources({ userId: 'u', novelId: 'n', chapterId: 'c', chapterRevision: 1 }, sample.content)
    const bundle = { chapter: { id: 'c', title: '合成短景', revision: 1, content: sample.content, novel: { tagNames: [] } },
      compilation: null, charter: null, recentChapters: [], profiles: [], anchors: [], feedback: [], chapterWritingBackground: [],
      originalRequest: '少解释，保留事实与人物声音。' } as unknown as Awaited<ReturnType<typeof buildHumanityQualityContext>>
    const input = buildCriticInput(bundle, {}, sources)
    expect(input).toContain(sample.content)
    expect(sources.entries.map(entry => entry.text).join('')).toBe(sample.content)
    if (!sample.target) return
    const target = sources.entries.find(entry => entry.text === sample.target)!
    expect(target).toBeDefined()
    const result = coerceCriticFindings({ findings: [{ sourceId: target.id, signal: 'explanation_echo', severity: 'advisory',
      explanation: sample.rationale, suggestion: `仅减少证据中解释负担，保留${sample.preserve.join('、')}`, confidence: 0.6 }] }, sources)!
    const prepared = prepareQualityFindings(sample.content, [], result.findings, true, sources)
    expect(prepared.complete).toBe(true)
    expect(prepared.findings).toMatchObject([{ start: sample.content.indexOf(sample.target), evidence: sample.target, severity: 'advisory' }])
    // Replacing only the bound target preserves the preceding scene and facts.
    const finding = prepared.findings[0]
    const replacement = sample.id === 'cross-sentence-crisis' ? '氧气耗尽，舱门自锁。救援艇还要六天。' : '女儿还没上车。她又拨了一遍。'
    const after = sample.content.slice(0, finding.start) + replacement + sample.content.slice(finding.end)
    expect(after.startsWith(sample.content.slice(0, finding.start))).toBe(true)
    for (const fact of sample.preserve) expect(after).toContain(fact)
  })
})
