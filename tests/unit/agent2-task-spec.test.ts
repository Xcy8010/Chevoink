import { describe, expect, it } from 'vitest'

import { buildTaskSpec, extractDirectiveCandidates, narrowLegacyResearchTask, renderTaskSpec } from '../../api/lib/agent/task-spec.js'

describe('fresh external craft research admission', () => {
  it.each(['、', '，', '；', '\n'])('bounds direct negative actions at %j without losing research', separator => {
    const prompt = ['只读联网研究', '不创建章节', '不写小说正文', '不改任何稿件', '请优先研究番茄小说《样本》',
      '不要在官网首页泛泛搜索', '不要只凭简介、搜索摘要或同人文字推断原作', '先核官方身份并读取两章公开正文按证据分析'].join(separator)
    const spec = buildTaskSpec({ runId: 'r', novelId: 'n', prompt, researchAdmission: 1 })
    expect(spec).toMatchObject({ intent: 'research_analysis', researchBudget: 'extended', researchTarget: { title: '样本' } })
    expect(spec.writingPacing).toBeUndefined()
    expect(spec.networkAccess).toBeUndefined()
  })
  it.each(['不要创建章节，不要写小说正文，禁止修改稿件', '禁止创建、修改章节', '禁止创建、写入小说正文', '只给润色建议，不修改正文', "Do not create chapters; don't write prose; never edit a novel"])(
    'does not read negative writing as a proposal: %s', restriction => {
      const spec = buildTaskSpec({ runId: 'r', novelId: 'n', prompt: `${restriction}；搜索《样本》官方作者与作品页，读取两章公开正文并按证据分析`, researchAdmission: 1 })
      expect(spec.intent).toBe('research_analysis')
      expect(spec.writingPacing).toBeUndefined()
    })
  it.each(['本次不联网', '不需要联网', '请不要进行任何联网搜索', '不要使用联网搜索', '不要联网', '禁止上网', '不要搜索外部资料', '不要搜索', "Don't browse the web", 'Do not use the internet'])(
    'freezes a real network denial despite contradictory research: %s', restriction => {
      const prompt = `${restriction}，深度研究《样本》并搜索公开章节`
      const spec = buildTaskSpec({ runId: 'r', novelId: 'n', prompt, researchAdmission: 1 })
      expect(spec).toMatchObject({ networkAccess: 'denied', researchBudget: 'standard' })
      expect(renderTaskSpec(spec)).toContain('不预约、不请求供应商、不收工具费')
      expect(buildTaskSpec({ runId: 'old', novelId: 'n', prompt }).networkAccess).toBeUndefined()
    })
  it('freezes only an explicit single title/author and keeps ambiguous targets unknown', () => {
    const spec = buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '联网研究《样本》（作者：测试作者），读取公开正文', researchAdmission: 1 })
    expect(spec.researchTarget).toEqual({ title: '样本', author: '测试作者', textAnalysisRequired: true })
    expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '联网研究《样本》的作者与出版信息，不读取正文', researchAdmission: 1 }).researchTarget)
      .toEqual({ title: '样本', textAnalysisRequired: false })
    expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '联网研究《样本》，分析原文里的修辞与主题', researchAdmission: 1 }).researchTarget?.textAnalysisRequired).toBe(true)
    expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '联网研究《甲》与《乙》的叙事', researchAdmission: 1 }).researchTarget).toBeUndefined()
  })
  const prompt = '联网搜一篇番茄小说，总结写作手法和思路'
  it.each([prompt, '搜索一本小说，分析叙事节奏', '上网查阅《样本》，总结人物塑造',
    '搜索一本小说，总结叙事节奏，只给当前段落的润色建议', '搜索一本小说，总结叙事节奏，不要修改当前段落',
    'Search for a novel and summarize its writing techniques'])('freezes bounded research for a fresh human request: %s', text => {
    const spec = buildTaskSpec({ runId: 'r', novelId: 'n', prompt: text, researchAdmission: 1 })
    expect(spec).toMatchObject({ intent: 'research_analysis', researchBudget: 'extended', expectedOutputs: [{ kind: 'validation_report' }] })
    expect(spec.scope.writing).toBeUndefined()
    const guidance = renderTaskSpec(spec)
    expect(guidance).toContain('最多5次搜索、8次页面获取')
    expect(guidance).toContain('不把平台首页当作品页')
    expect(guidance).toContain('没有读到章节正文')
    expect(guidance).toContain('连续两次读取失败后停止')
  })
  it.each(['番茄能力要完整达标', '番茄小说写作手法', '不要联网搜索小说，只谈写作手法',
    '不要联网，搜索小说并总结写作手法', 'Search for a novel, do not analyze its writing techniques'])('does not mint extended access from missing/negated research evidence: %s', text => {
    expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt: text, researchAdmission: 1 }).researchBudget).toBe('standard')
  })
  it.each([`${prompt}，然后写第一章`, `${prompt}，接着修改当前章节`, `${prompt}，把报告保存到计划文件`,
    '搜索一本小说，总结叙事节奏，然后润色当前段落', '搜索一本小说，总结写作手法，再改写当前句子',
    '联网搜一本小说总结叙事节奏，然后替换这句对白', '搜索一本小说的叙事节奏，然后创建计划文件',
    'Search for a novel and summarize its writing techniques, then polish the current paragraph'])('preserves an explicit mixed writing/persistence workflow: %s', text => {
    expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt: text, researchAdmission: 1 }).intent).not.toBe('research_analysis')
  })
  it('keeps old fallback/resume classification, identity, budget and grants unchanged', () => {
    const old = buildTaskSpec({ runId: 'old-run', novelId: 'n', prompt })
    expect(old).toMatchObject({ intent: 'write', researchBudget: 'standard' })
    expect(narrowLegacyResearchTask(old, prompt)).toBe(old)
    const admitted = buildTaskSpec({ runId: 'new-run', novelId: 'n', prompt, researchAdmission: 1 })
    expect(narrowLegacyResearchTask(admitted, prompt)).toBe(admitted)
    expect(admitted.id).not.toBe(old.id)
  })
})

describe('explicit report length requirement', () => {
  it('keeps a report minimum alongside unrelated prohibitions', () => {
    expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '分析这本小说，分析报告至少10000字，不要写章节' })
      .expectedOutputs[0].minimumChineseCharacters).toBe(10000)
  })
  it.each(['分析报告至少10000字', '至少一万字的分析报告', '研究报告字数不少于1万字'])('freezes a clear in-chat minimum: %s', prompt => {
    const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', prompt: `请分析这本书，${prompt}` })
    expect(spec.expectedOutputs[0].minimumChineseCharacters).toBe(10000)
    expect(spec.expectedOutputs[0].description).toContain('不计代码')
  })
  it.each(['分析这本书，不要一万字报告', '分析报告大约10000字', '把至少一万字的分析报告保存到计划', '写第一章至少3000字'])('does not invent a text-report lower bound: %s', prompt => {
    expect(buildTaskSpec({ runId: 'run', novelId: 'novel', prompt }).expectedOutputs[0].minimumChineseCharacters).toBeUndefined()
  })
})

describe('Agent 2.0 P3 TaskSpec', () => {
  it('narrows legacy research on resume without replacing its task identity, scope or original goals', () => {
    const original = buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '搜索并拆解这本小说' })
    const legacy = { ...original, intent: 'write' as const }
    const repaired = narrowLegacyResearchTask(legacy, '搜索并拆解这本小说')
    expect(repaired).toMatchObject({ id: legacy.id, runId: legacy.runId, scope: legacy.scope,
      goals: legacy.goals, intent: 'research_analysis' })
    expect(narrowLegacyResearchTask(legacy, '继续')).toBe(legacy)
    expect(narrowLegacyResearchTask(legacy, '分析后写第一章')).toBe(legacy)
    expect(narrowLegacyResearchTask(repaired, '搜索并拆解这本小说')).toBe(repaired)
  })
  it.each(['搜索并拆解《样本小说》', '调研并阅读这本书', '分析这本小说，不要写章节', 'Research and analyze this novel', '解读本书的人物变化'])('separates research from creation: %s', prompt => {
    expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt }).intent).toBe('research_analysis')
  })
  it.each(['分析后写第一章', '拆解这本书，然后保存报告到计划', '检查当前章节并修复问题', '续写第十九章'])('does not silently discard an explicit non-research workflow: %s', prompt => {
    expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt }).intent).not.toBe('research_analysis')
  })
  it('识别全书变更并冻结硬约束与交付后置条件', () => {
    const spec = buildTaskSpec({
      runId: 'run-1', novelId: 'novel-1', chapterId: null,
      prompt: '把全书所有章节的林默统一改名为林舟。必须保留引号中的历史旧名，不要逐章整段覆盖。',
    })
    expect(spec.intent).toBe('global_transform')
    expect(spec.hardConstraints.map((item) => item.text)).toEqual(expect.arrayContaining([
      expect.stringContaining('必须保留'), expect.stringContaining('不要逐章'),
    ]))
    expect(spec.expectedOutputs[0].kind).toBe('changeset')
    expect(spec.postconditions.map((item) => item.code)).toContain('CHANGESET_VERIFIED')
  })

  it('只提取作者显式表达的长期指令，不把普通叙述误收为账本', () => {
    expect(extractDirectiveCandidates('写下一章，主角走进雨巷。')).toEqual([])
    expect(extractDirectiveCandidates('以后必须使用第一人称。希望对话更自然。')).toMatchObject([
      { kind: 'must' }, { kind: 'preference' },
    ])
  })

  it('续写指定卷且保护前文时冻结结构与正文后置条件', () => {
    const spec = buildTaskSpec({
      runId: 'run-volume', novelId: 'novel-1', chapterId: null,
      prompt: '在不改动前面内容的情况下续写完整第二卷。',
    })
    expect(spec.postconditions.map((item) => item.code)).toEqual(expect.arrayContaining([
      'STRUCTURE_VALIDATED',
      'EARLIER_CONTENT_UNCHANGED',
    ]))
  })
})
