import { describe, expect, it } from 'vitest'
import type { buildHumanityQualityContext } from '../../api/lib/agent/humanity-quality.js'
import { qualityReviewContextHash } from '../../api/lib/agent/humanity-quality.js'
import { qualityWorkContextProjection, qualityWorkCriticVersion } from '../../api/lib/agent/tools/durable-quality.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildCriticInput, buildCriticSystem } from '../../api/lib/agent/tools/humanity-quality-tools.js'

type Bundle = Awaited<ReturnType<typeof buildHumanityQualityContext>>
const bundle = { chapter: { id: 'chapter', title: '旧物摊', content: '沈桐看见旧罗盘的价值，决定抓住这次机会。', revision: 1, novel: { tagNames: ['都市'] } },
  charter: null, compilation: { id: 'compiler', bridge: null, sceneTasks: [{ turn: '已问价' }] },
  profiles: [], anchors: [], recentChapters: [], feedback: [], originalRequest: '重写第一章，突出捡漏爽感。',
  chapterWritingBackground: [{ sourceRunId: 'original', compilationId: 'old-compiler', prompt: '沈桐29岁，仓库调度员；1600–1900字；开篇低谷1–2段；问价前停笔。' }] } as unknown as Bundle

describe('frozen quality work across deployments', () => {
  it('keeps v1 and v2 exact hash projections and real report versions while new work binds history', () => {
    const { chapterWritingBackground: _background, originalRequest: _request, ...v1 } = bundle
    const { chapterWritingBackground: _ignored, ...v2 } = bundle
    expect(qualityWorkContextProjection(bundle, 1)).toEqual(v1)
    expect(qualityWorkContextProjection(bundle, 2)).toEqual(v2)
    expect(qualityWorkContextProjection(bundle, 3)).toEqual(bundle)
    expect(qualityWorkContextProjection(bundle, 4)).toEqual(bundle)
    expect([1, 2, 3].map(version => qualityWorkCriticVersion(version as 1 | 2 | 3))).toEqual(['humanity-critic.v2', 'humanity-critic.v3', 'humanity-critic.v4'])
    expect(qualityWorkCriticVersion(4)).toBe('humanity-critic.v5')
    const changedHistory = { ...bundle, chapterWritingBackground: [{ ...bundle.chapterWritingBackground[0], prompt: '当前明确改为2100字。' }] }
    for (const version of [1, 2] as const) expect(runtimeJson(qualityWorkContextProjection(changedHistory, version)).hash).toBe(runtimeJson(qualityWorkContextProjection(bundle, version)).hash)
    expect(runtimeJson(qualityWorkContextProjection(changedHistory, 3)).hash).not.toBe(runtimeJson(qualityWorkContextProjection(bundle, 3)).hash)
    expect(qualityReviewContextHash(changedHistory)).not.toBe(qualityReviewContextHash(bundle))
  })
  it.each([1, 2, 3] as const)('genuine chapter change invalidates v%s without rewriting frozen inputs', version => {
    const frozen = structuredClone(qualityWorkContextProjection(bundle, version))
    const digest = runtimeJson(frozen).hash
    const changed = { ...bundle, chapter: { ...bundle.chapter, revision: 2, content: '作者新正文。' } }
    expect(runtimeJson(qualityWorkContextProjection(changed, version)).hash).not.toBe(digest)
    expect(runtimeJson(frozen).hash).toBe(digest)
  })
  it('both critic paths share historical specifications, current request and exact ending precedence', () => {
    const input = buildCriticInput(bundle, {})
    expect(input).toContain(bundle.originalRequest!)
    expect(input).toContain('仓库调度员')
    expect(input).toContain('1600–1900字')
    expect(input).toContain('不是执行授权')
    expect(input).toContain('已问价')
    const system = buildCriticSystem('balanced')
    expect(system).toContain('场景任务与桥的终态不能推翻作者的精确停笔')
    expect(system).toContain('不得以场景已问价为由')
    expect(system).toContain('不把尚未成交本身当缺陷')
  })
})
