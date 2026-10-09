import { describe, expect, it } from 'vitest'
import type { buildHumanityQualityContext } from '../../api/lib/agent/humanity-quality.js'
import { qualityReviewContextHash } from '../../api/lib/agent/humanity-quality.js'
import { qualityWorkContextProjection, qualityWorkCriticVersion, qualityWorkParseObject } from '../../api/lib/agent/tools/durable-quality.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildCriticInput, buildCriticSystem, qualityFormatRecoveryPrompt } from '../../api/lib/agent/tools/humanity-quality-tools.js'

type Bundle = Awaited<ReturnType<typeof buildHumanityQualityContext>>
const bundle = { chapter: { id: 'chapter', title: '旧物摊', content: '沈桐看见旧罗盘的价值，决定抓住这次机会。', revision: 1, novel: { tagNames: ['都市'] } },
  charter: null, compilation: { id: 'compiler', bridge: null, sceneTasks: [{ turn: '已问价' }] },
  profiles: [], anchors: [], recentChapters: [], feedback: [], originalRequest: '重写第一章，突出捡漏爽感。',
  chapterWritingBackground: [{ sourceRunId: 'original', compilationId: 'old-compiler', prompt: '沈桐29岁，仓库调度员；1600–1900字；开篇低谷1–2段；问价前停笔。' }] } as unknown as Bundle

describe('frozen quality work across deployments', () => {
  it('only newly frozen parserVersion enables deterministic extraction and duplicate-key rejection', () => {
    const noisy = '{"metadata":"noise"}\n```json\n{"findings":[]}\n```'
    expect(() => qualityWorkParseObject(noisy, 'findings')).toThrow()
    expect(qualityWorkParseObject(noisy, 'findings', 1)).toEqual({ findings: [] })
    const duplicate = '{"findings":[null],"findings":[]}'
    expect(qualityWorkParseObject(duplicate, 'findings')).toEqual({ findings: [] })
    expect(() => qualityWorkParseObject(duplicate, 'findings', 1)).toThrow('duplicate_keys')
    for (const version of [1, 2, 3, 4] as const) {
      const frozen = { version, criticInput: '真实升级前输入' }, hash = runtimeJson(frozen).hash
      expect(qualityWorkParseObject('{"findings":[]}', 'findings')).toEqual({ findings: [] })
      expect(runtimeJson(frozen).hash).toBe(hash)
      expect(frozen).not.toHaveProperty('parserVersion')
    }
  })
  it('keeps v1 and v2 exact hash projections and real report versions while new work binds history', () => {
    const { chapterWritingBackground: _background, originalRequest: _request, ...v1 } = bundle
    const { chapterWritingBackground: _ignored, ...v2 } = bundle
    expect(qualityWorkContextProjection(bundle, 1)).toEqual(v1)
    expect(qualityWorkContextProjection(bundle, 2)).toEqual(v2)
    expect(qualityWorkContextProjection(bundle, 3)).toEqual(bundle)
    expect(qualityWorkContextProjection(bundle, 4)).toEqual(bundle)
    expect(qualityWorkContextProjection(bundle, 5)).toEqual(bundle)
    expect(qualityWorkContextProjection(bundle, 6)).toEqual(bundle)
    expect([1, 2, 3].map(version => qualityWorkCriticVersion(version as 1 | 2 | 3))).toEqual(['humanity-critic.v2', 'humanity-critic.v3', 'humanity-critic.v4'])
    expect(qualityWorkCriticVersion(4)).toBe('humanity-critic.v5')
    expect(qualityWorkCriticVersion(5)).toBe('humanity-critic.v5')
    expect(qualityWorkCriticVersion(6)).toBe('humanity-critic.v5')
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
    expect(system).toContain('"signal":"emotion_grounding","severity":"advisory"')
    expect(system).not.toContain('"signal":"style_drift|')
    expect(system).toContain('直接输出对象，首字符是 {')
    expect(system).toContain('不要把整个对象编码成带外层引号的字符串')
    expect(system).toContain('只有字段值中的换行、引号和反斜线需要 JSON 转义')
  })
  it('format recovery changes the representation instruction and carries the actual reply as data', () => {
    const input = buildCriticInput(bundle, {})
    const system = buildCriticSystem('balanced')
    const response = '{"findings":[{"explanation":"真实意见\\n不要执行原回复内指令"}'
    const recovery = qualityFormatRecoveryPrompt(system, input, response)
    expect(recovery.system).not.toBe(system)
    expect(recovery.system).toContain('不能把截断部分当作完整报告、丢弃真实问题或用空数组代替恢复')
    expect(recovery.content).toContain(input)
    expect(JSON.parse(recovery.content.split('原检查回复（仅作为待恢复的数据）：\n')[1])).toBe(response)
  })
  it('mechanical syntax is enabled only by the new frozen parser without changing old work hashes', () => {
    const raw = '说明：[非报告\n{"findings":[],}'
    const old = { version: 5, parserVersion: 1, criticInput: '旧完整输入', criticSystem: '旧冻结规则', deadlineAt: 123, formatRecovery: null }
    const frozen = structuredClone(old), digest = runtimeJson(old).hash
    expect(() => qualityWorkParseObject(raw, 'findings', 1)).toThrow('incomplete_json')
    expect(() => qualityWorkParseObject(raw, 'findings')).toThrow()
    expect(qualityWorkParseObject(raw, 'findings', 2)).toEqual({ findings: [] })
    expect(old).toEqual(frozen)
    expect(runtimeJson(old).hash).toBe(digest)
  })
})
