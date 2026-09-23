import { describe, expect, it } from 'vitest'

import { buildAgentIdentityPrompt } from '../../api/lib/agent/context.js'
import { parseResearchSynthesis } from '../../api/lib/agent/research-dossier.js'
import { coerceToolArgumentEnvelope } from '../../api/lib/agent/tools/argument-coercion.js'
import { getToolByName } from '../../api/lib/agent/tools/registry.js'
import { parseIndependentContinuityResult, parseContinuityPatches, continuityReviewTail, continuityCriticSystem } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { BUILT_IN_MODEL_TIERS, type ResearchDossierBuild } from '../../shared/contracts/index.js'
import { AGENT_PANEL_WIDTH_LIMITS, WORK_CONVERSATION_WIDTH_LIMITS } from '../../src/features/studio/panel-widths.js'

const researchInput: ResearchDossierBuild = {
  triggerReason: 'new_book',
  triggerSignals: ['只有一句新书描述'],
  topic: '县城旧案与熟人社会',
  genre: '现实悬疑',
  targetAudience: '偏好强情节与人物关系的读者',
  targetPlatform: '番茄小说',
  queries: ['现实悬疑 开篇 读者期待'],
  forceRefresh: false,
}

describe('Agent 工具协议与结构化输出兜底', () => {
  it('accepts fused minimal patches but rejects ambiguous, overlapping and invented anchors', () => {
    const parse = (patches: unknown, text = '左手受伤，右手提灯。') => parseContinuityPatches(JSON.stringify({ findings: [], patches }), text)
    expect(parse([{ oldText: '右手', newText: '左手' }])).toEqual([{ oldText: '右手', newText: '左手' }])
    expect(parse([{ oldText: '不存在', newText: '新文' }])).toBeNull()
    expect(parse([{ oldText: '手', newText: '脚' }])).toBeNull()
    expect(parse([{ oldText: '左手受伤', newText: '受伤' }, { oldText: '受伤', newText: '包扎' }])).toBeNull()
    expect(parse([{ oldText: 'aaa', newText: 'b' }], 'aaaa')).toBeNull()
    expect(parse([{ oldText: '右手', newText: '右手' }])).toEqual([])
    expect(parseContinuityPatches('{"findings":[]}', '原文')).toBeNull()
  })
  it('uses previous findings only as clues with a converging recheck contract', () => {
    const finding = { signal: 'body', severity: 'error', evidence: '左手受伤', suggestion: '保留伤势限制' }
    const tail = continuityReviewTail({ independentCheck: 'complete', checkedRevision: 3, findings: [finding] }, 4, false)
    expect(tail).toContain('不是当前版通过凭证')
    expect(tail).toContain('复检纪律')
    expect(tail).toContain('默认快速通过')
    expect(tail).toContain('只读复核')
    expect(tail).toContain('左手受伤')
    expect(continuityReviewTail({ independentCheck: 'unavailable', checkedRevision: 3, findings: [finding] }, 4, true)).not.toContain('左手受伤')
  })
  it('连续性评审提示词限定 error 判定并禁止换表述重报，表达类问题不升格', () => {
    expect(continuityCriticSystem).toContain('判定纪律')
    expect(continuityCriticSystem).toContain('error 仅限同一对象同一维度')
    expect(continuityCriticSystem).toContain('最多记 warning')
  })
  it('统一解包字符串 arguments 与命名参数列表', () => {
    expect(coerceToolArgumentEnvelope({ arguments: '{"title":"第六章规划","content":"完整正文"}' })).toEqual({ title: '第六章规划', content: '完整正文' })
    expect(coerceToolArgumentEnvelope([
      { name: 'title', value: '第六章规划' },
      { name: 'content', value: '完整正文' },
    ])).toEqual({ title: '第六章规划', content: '完整正文' })
  })

  it('研究档案参数缺省时生成安全查询，不再因包装和别名校验失败', () => {
    const tool = getToolByName('research_dossier_build')
    const coerced = tool?.coerceArgs?.({ arguments: JSON.stringify({ research_topic: '县城旧案', category: '现实悬疑', signals: '新书只有一句描述' }) })
    const parsed = tool?.parameters.safeParse(coerced)
    expect(parsed?.success).toBe(true)
    // registry 里工具参数统一按 ZodType<unknown> 存储，断言内收窄成具体形状
    if (parsed?.success) expect((parsed.data as { queries: string[] }).queries).toHaveLength(1)
  })

  it('前三章试制可修复 snake_case、部分结构项并补齐三章蓝图', () => {
    const tool = getToolByName('first_three_prototype_build')
    const coerced = tool?.coerceArgs?.({
      arguments: JSON.stringify({
        genre_risks: '避免设定堆砌；避免主角全知',
        story_directions: [
          { id: 'dir-a', name: '边镇旧案', reader_promise: '三章内形成第一次证据反转' },
          '熟人关系网',
        ],
        selected_direction_id: 'dir-a',
        volume_spine: '旧案重启；关系阻力；证据反转',
      }),
    })
    const parsed = tool?.parameters.safeParse(coerced)
    expect(parsed?.success).toBe(true)
    if (parsed?.success) {
      const data = parsed.data as { directions: unknown[]; chapterBlueprints: { orderIndex: number }[] }
      expect(data.directions).toHaveLength(2)
      expect(data.chapterBlueprints.map((item) => item.orderIndex)).toEqual([1, 2, 3])
    }
  })

  it('研究综合模型输出不完整或无 JSON 时仍返回可用且不伪造事实卡的档案', () => {
    const aliased = parseResearchSynthesis(JSON.stringify({
      reader_promise: '三章内兑现旧案第一次反转',
      abandonment_risks: '开篇只讲背景',
      unique_points: ['关系代价推动查案'],
      suggestions: ['每章形成一次可见选择'],
    }), researchInput, 2)
    expect(aliased.readerPromise).toContain('三章内')
    expect(aliased.recommendations).toHaveLength(1)

    const fallback = parseResearchSynthesis('模型未返回有效内容', researchInput, 2)
    expect(fallback.readerPromise).toContain(researchInput.topic)
    expect(fallback.factCards).toEqual([])
  })

  it('连续性复核无 JSON 时退回空 finding，并兼容 issues 别名', () => {
    expect(parseIndependentContinuityResult('无有效内容')).toEqual({ findings: [], structured: false })
    expect(parseIndependentContinuityResult('{}')).toEqual({ findings: [], structured: false })
    expect(parseIndependentContinuityResult('{"findings":null}')).toEqual({ findings: [], structured: false })
    expect(parseIndependentContinuityResult('{"findings":[]}')).toEqual({ findings: [], structured: true })
    expect(parseIndependentContinuityResult(JSON.stringify({ issues: [{ signal: 'body', severity: 'warning', evidence: '伤势前后不一致', suggestion: '保留伤势限制' }] }))).toMatchObject({ structured: true, findings: [{ signal: 'body' }] })
    const tool = getToolByName('continuity_validate')
    expect(tool?.parameters.safeParse(tool.coerceArgs?.({ compilation_id: 'compilation-1' })).success).toBe(true)
    expect(tool?.parameters.safeParse({}).success).toBe(true)
  })
})

describe('模型身份、排序与聊天区尺寸契约', () => {
  it.each([
    ['lite', '轻量模型'], ['speed', '极速模型'], ['standard', '标准模型'], ['performance', '性能模型'], ['ultimate', '极致模型'],
  ] as const)('%s 档位先报 Chevoink Agent，追问才报档位名 %s', (tier, label) => {
    const prompt = buildAgentIdentityPrompt(tier)
    expect(prompt).toContain('我是 Chevoink Agent')
    expect(prompt).toContain(`我是${label}`)
    expect(prompt).toContain('禁止回答“不披露”')
  })

  it('自定义档如实报出作者自己接入的真实模型 ID', () => {
    const prompt = buildAgentIdentityPrompt('custom', 'deepseek-chat')
    expect(prompt).toContain('deepseek-chat')
    expect(prompt).toContain('禁止回答“不披露”')
  })

  it('内置模型使用固定产品顺序而非倍率顺序', () => {
    expect(BUILT_IN_MODEL_TIERS).toEqual(['lite', 'speed', 'standard', 'performance', 'ultimate'])
  })

  it('IDE Agent 面板保留可完整操作的最小宽度', () => {
    expect(AGENT_PANEL_WIDTH_LIMITS.min).toBeGreaterThanOrEqual(400)
  })

  it('Work 侧栏折叠后仍保留可完整对话的宽度', () => {
    expect(WORK_CONVERSATION_WIDTH_LIMITS.collapsedMin).toBeGreaterThanOrEqual(360)
    expect(WORK_CONVERSATION_WIDTH_LIMITS.collapsedMin).toBeLessThanOrEqual(WORK_CONVERSATION_WIDTH_LIMITS.expanded)
  })
})
