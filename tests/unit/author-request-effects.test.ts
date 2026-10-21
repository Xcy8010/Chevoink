import { describe, expect, it, vi } from 'vitest'
import { parseAuthorWritingRequest } from '../../api/lib/agent/author-writing-request.js'
import { buildTaskSpec, renderTaskSpec } from '../../api/lib/agent/task-spec.js'
import { restrictToolsToTask, snapshotToolAuthority, intersectToolAuthority } from '../../api/lib/agent/tool-authority.js'
import { getToolsForMode } from '../../api/lib/agent/tools/registry.js'
import { originalRepairAuthority } from '../../api/lib/agent/original-request.js'

const fresh = (prompt: string) => buildTaskSpec({ runId: 'synthetic-run', novelId: 'synthetic-novel',
  chapterId: null, prompt, authorWritingProtocol: 2, researchAdmission: 1, researchNavigationAdmission: 1, networkAdmission: 1 })
const tools = getToolsForMode('build')
const bodyTools = ['chapter_create', 'chapter_write', 'chapter_edit_range', 'chapter_append',
  'story_compiler_prepare', 'chapter_bridge_commit', 'changeset_apply', 'changeset_rollback', 'quality_revision_apply']

describe('fresh request effects without a global chapter prerequisite', () => {
  it.each([
    '为什么天空是蓝色的？',
    '列出三个提升注意力的方法。',
    '我们讨论一下人物动机与叙事距离。',
    '我们讨论一下人物动机，不续写或修改任何作品正文。',
    '请读取已有资料，整理事件时间线。',
    '请比较两个开场的叙事节奏，只给建议，不改正文。',
    '请搜索公开小说，读取开篇章节分析叙事手法，不写正文。',
    '请查找《合成作品》，沿官方目录读取公开章节并总结叙事手法。不续写或修改任何作品正文。',
    '请搜索公开小说并研究语言风格，不创建或修改任何章节。',
    '请解释这条指令的含义：“修改第三章”。本次只讨论，不执行。',
    '请读取第1章，整理人物关系，不改动任何正文。',
    '请只审阅已提供的段落并列出问题，不修改或重写正文。',
    '不要移动章节，解释一下顺序。',
    '请解释代码示例 `保存正文并移动第2章`，本次只讨论。',
  ])('keeps the request readable without inventing a manuscript effect: %s', prompt => {
    const spec = fresh(prompt)
    expect(spec.scope.authorEffects).toMatchObject({ manuscript: false, structure: false })
    expect(spec.scope.writing).toBeUndefined()
    const admitted = restrictToolsToTask(tools, spec)
    expect(admitted.map(tool => tool.name)).toContain('chapter_read')
    expect(admitted.map(tool => tool.name)).not.toEqual(expect.arrayContaining(bodyTools))
    for (const name of bodyTools) expect(admitted.map(tool => tool.name)).not.toContain(name)
    expect(admitted.map(tool => tool.name)).not.toContain('chapter_move')
    const inherited = intersectToolAuthority(tools, 'build', snapshotToolAuthority(admitted, 'build'))
    for (const name of bodyTools) expect(inherited.map(tool => tool.name)).not.toContain(name)
    if (spec.writingPacing === 'conversation_only') expect(renderTaskSpec(spec)).not.toContain('当前版本连续性与质量检查')
  })

  it.each(['或', '和', '及', '与', '以及', '、', ' or ', ' and ', ' nor '])('shares a negated predicate and its object through %s', join => {
    const prompt = `不续写${join}修改第1章。请修改第2章。`
    const request = parseAuthorWritingRequest(prompt)
    expect(request).toMatchObject({ intent: 'revise', ambiguous: false, range: { kind: 'range', start: 2, count: 1 } })
    expect(request.evidence.operations.slice(0, 2).every(operation => operation.polarity === 'negative')).toBe(true)
    expect(request.evidence.operations.at(-1)).toMatchObject({ accepted: true, polarity: 'affirmative' })
  })

  it.each([
    ['先读取资料并总结结论，再修改正文。', 'revise'],
    ['先解释一下限知视角，然后写下一段正文。', 'write'],
    ['先搜索公开小说并分析叙事手法，再修改正文。', 'revise'],
    ['先读前文，再帮我写一点。', 'write'],
    ['帮我写一点。', 'write'],
    ['继续下一章。', 'write'],
    ['请写第3章正文。', 'write'],
    ['请修改第2章正文。', 'revise'],
    ['不要修改第1章，但请修改第2章。', 'revise'],
  ])('retains the actual requested manuscript phase: %s', (prompt, intent) => {
    const spec = fresh(prompt)
    expect(spec.intent).toBe(intent)
    expect(spec.scope.authorEffects).toMatchObject({ manuscript: true, structure: false })
    expect(spec.writingPacing).not.toBe('proposal_only')
    expect(spec.writingPacing).not.toBe('conversation_only')
    expect(restrictToolsToTask(tools, spec).map(tool => tool.name)).toContain('chapter_read')
  })

  it('preserves an explicit plan artifact while denying unrelated body and structure effects', () => {
    const spec = fresh('请研究这本书，再把研究报告保存到计划文件。')
    expect(spec.scope.authorEffects).toMatchObject({ manuscript: false, structure: false })
    const names = restrictToolsToTask(tools, spec).map(tool => tool.name)
    expect(names).toContain('plan_save')
    expect(names).toContain('web_search')
    for (const name of bodyTools) expect(names).not.toContain(name)
    expect(names).not.toContain('chapter_move')
  })

  it('keeps structure permission distinct from rewriting a chapter', () => {
    const spec = fresh('请把第2章移动到第3章之前。')
    expect(spec.intent).toBe('structure')
    expect(spec.scope.authorEffects).toMatchObject({ manuscript: false, structure: true })
    const names = restrictToolsToTask(tools, spec).map(tool => tool.name)
    expect(names).toContain('chapter_move')
    for (const name of bodyTools) expect(names).not.toContain(name)
  })

  it('keeps broad book planning bounded to the existing proposal stage', () => {
    const spec = fresh('请写一本科幻小说。')
    expect(spec).toMatchObject({ intent: 'plan', writingPacing: 'proposal_only', scope: { authorEffects: { manuscript: false, structure: false } } })
    expect(restrictToolsToTask(tools, spec).map(tool => tool.name)).toContain('plan_save')
    expect(restrictToolsToTask(tools, spec).map(tool => tool.name)).not.toContain('chapter_create')
  })

  it('does not upgrade legacy task contracts to the new effect projection', () => {
    const spec = buildTaskSpec({ runId: 'legacy-run', novelId: 'synthetic-novel', prompt: '列出三个方法。' })
    expect(spec.scope.authorEffects).toBeUndefined()
  })

  it.each([
    ['请修改作品简介。', 'novel_update_meta'], ['请更新作品标签。', 'novel_update_meta'],
    ['请把书名改成《新标题》。', 'novel_rename'], ['请把小说改名为新标题。', 'novel_rename'],
    ['请更新第1卷标题。', 'volume_update'],
    ['请修改第1卷标题。', 'volume_update'], ['请设置封面提示词。', 'cover_prompt_set'],
  ])('preserves existing non-body tool authority without requiring a chapter: %s', (prompt, name) => {
    const spec = fresh(prompt)
    expect(spec.scope.authorEffects?.manuscript).toBe(false)
    expect(restrictToolsToTask(tools, spec).map(tool => tool.name)).toContain(name)
    for (const body of bodyTools) expect(restrictToolsToTask(tools, spec).map(tool => tool.name)).not.toContain(body)
  })

  it('preserves the original import feature gate and its existing tool admission when enabled', () => {
    const spec = fresh('请导入上传文件。')
    try {
      vi.stubEnv('NOVEL_IMPORT_ENABLED', 'false')
      expect(restrictToolsToTask(getToolsForMode('build'), spec).map(tool => tool.name)).not.toContain('novel_import')
      vi.stubEnv('NOVEL_IMPORT_ENABLED', 'true')
      expect(restrictToolsToTask(getToolsForMode('build'), spec).map(tool => tool.name)).toContain('novel_import')
      expect(spec.scope.authorEffects?.manuscript).toBe(false)
    } finally { vi.unstubAllEnvs() }
  })

  it.each(['请评估是否需要修改本章。', '检查本章是否需要润色。', '请看看第1章有没有必要润色。', '请修改作品简介。'])(
    'does not mint automatic body repair authority from a non-body request: %s', prompt => {
      expect(originalRepairAuthority({ prompt, spec: fresh(prompt) })).toBe(false)
    })

  it.each([null, { version: 1, requestHash: 'a'.repeat(64), manuscript: false, structure: false }])(
    'rejects a malformed or mismatched original effect receipt', effects => {
      const prompt = '请修改作品简介。', spec = fresh(prompt)
      expect(() => originalRepairAuthority({ prompt, spec: { ...spec, scope: { ...spec.scope, authorEffects: effects } } }))
        .toThrow(expect.objectContaining({ code: 'RUNTIME_RECEIPT_INVALID' }))
    })
  it.each(['请把第1章改名为启程。', '请把第1章标题改成《启程》。', '请重命名第1章为启程。'])(
    'keeps the named chapter as the target of a title predicate: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: { kind: 'range', start: 1, count: 1 }, ambiguous: false })
      expect(fresh(prompt).scope.authorEffects?.manuscript).toBe(true)
    })
})
