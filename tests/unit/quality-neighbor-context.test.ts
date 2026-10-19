import { describe, expect, it } from 'vitest'
import { qualityNeighborContext, qualityRepairSurroundings, QUALITY_NEIGHBOR_MAX_CHARS } from '../../api/lib/agent/quality-neighbor-context.js'
import { buildCriticInput, buildQualityRepairContext } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { qualityReviewContextHash, type buildHumanityQualityContext } from '../../api/lib/agent/humanity-quality.js'
import { qualityWorkContextProjection } from '../../api/lib/agent/tools/durable-quality.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

type Bundle = Awaited<ReturnType<typeof buildHumanityQualityContext>>
const neighbor = { id: 'prior', title: '门外', orderIndex: 2, revision: 7, content: '她仍站在门外，钥匙还在邻居手里。' }
const bundle = { chapter: { id: 'now', title: '等候', revision: 1, content: '她没有推门。', novel: { tagNames: [] } },
  charter: null, compilation: null, profiles: [], anchors: [], feedback: [], recentChapters: [neighbor],
  originalRequest: '停在门打开前，保留克制口吻。', chapterWritingBackground: [] } as unknown as Bundle

describe('bounded humanity neighbors and repair intent', () => {
  it('selects latest three then presents chronological identities and complete normal prose', () => {
    const rows = [1, 4, 2, 3].map(orderIndex => ({ ...neighbor, id: `c${orderIndex}`, orderIndex }))
    expect(qualityNeighborContext(rows).map(row => row.id)).toEqual(['c2', 'c3', 'c4'])
    expect(qualityNeighborContext([neighbor])[0]).toMatchObject({ ...neighbor, start: 0, end: neighbor.content.length, truncated: false })
    expect(buildCriticInput(bundle, {})).toContain(JSON.stringify(neighbor.content))
    expect(buildCriticInput(bundle, {})).toContain('"revision":7')
  })
  it('bounds only neighbor tail with explicit omitted range and full-source hash', () => {
    const content = '甲'.repeat(QUALITY_NEIGHBOR_MAX_CHARS + 50)
    const [row] = qualityNeighborContext([{ ...neighbor, content }])
    expect(row).toMatchObject({ start: 50, end: content.length, totalChars: content.length, truncated: true })
    expect(row.content).toHaveLength(QUALITY_NEIGHBOR_MAX_CHARS)
    expect(row.contentHash).not.toBe(qualityNeighborContext([{ ...neighbor, content: '乙' + content.slice(1) }])[0].contentHash)
  })
  it('binds source identity and revision even when prose is unchanged without breaking old work hashes', () => {
    const changed = { ...bundle, recentChapters: [{ ...neighbor, revision: 8, id: 'replacement' }] }
    expect(qualityReviewContextHash(changed)).not.toBe(qualityReviewContextHash(bundle))
    expect(runtimeJson(qualityWorkContextProjection(changed, 9)).hash).not.toBe(runtimeJson(qualityWorkContextProjection(bundle, 9)).hash)
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      expect(runtimeJson(qualityWorkContextProjection(changed, version)).hash).toBe(runtimeJson(qualityWorkContextProjection(bundle, version)).hash)
      expect(qualityWorkContextProjection(bundle, version).recentChapters[0]).toEqual({ title: neighbor.title, content: neighbor.content, orderIndex: neighbor.orderIndex })
    }
  })
  it('gives the patcher author intent and read-only bounded surroundings without extending its patch', () => {
    expect(buildQualityRepairContext(bundle)).toContain(bundle.originalRequest!)
    expect(buildQualityRepairContext(bundle)).toContain(neighbor.content)
    expect(qualityRepairSurroundings('前句。证据。后句。', 3, 6)).toEqual({ start: 3, end: 6, before: '前句。', after: '后句。' })
    const context = qualityRepairSurroundings('甲'.repeat(5000), 2000, 2005)
    expect(context.before).toHaveLength(600)
    expect(context.after).toHaveLength(600)
  })
})
