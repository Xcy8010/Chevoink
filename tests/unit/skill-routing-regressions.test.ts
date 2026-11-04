import { describe, expect, it } from 'vitest'
import { isMechanicalOnly, routeSkills, skillCatalog, type AgentSkill } from '../../api/lib/agent/skills/index'
import { nextSkillPhase } from '../../api/lib/agent/skills/lifecycle'

const ids = (prompt: string, intent: 'write' | 'plan' | 'revise' = 'write', catalog = skillCatalog) => routeSkills({ mode: 'build', intent, prompt, freedom: 'balanced', catalog }).selected.map(s => s.id)

describe('Work skill routing regressions', () => {
  it('loads ordinary prose responsibilities without asking the author for skill keywords', () => {
    for (const prompt of ['写下一章', '接着刚才的情节写', '完成这场戏']) {
      expect(ids(prompt)).toEqual(expect.arrayContaining([
        'cn-character-voice.v3', 'cn-emotion-grounding.v3', 'cn-prose-specificity.v3',
      ]))
    }
    const frozen = routeSkills({ mode: 'build', intent: 'write', freedom: 'balanced', prompt: '写下一章', routerVersion: '4.0.0' })
    expect(frozen.reasonCodes).not.toContain('DRAFT_FOUNDATION')
    const disabled = skillCatalog.filter(skill => skill.id !== 'cn-character-voice.v3')
    expect(ids('写下一章', 'write', disabled)).not.toContain('cn-character-voice.v3')
    const nonDraft = routeSkills({ mode: 'build', intent: 'write', phase: 'scene', freedom: 'balanced', prompt: '写下一章' })
    expect(nonDraft.reasonCodes).not.toContain('DRAFT_FOUNDATION')
  })
  it('loads both planning skills in Work build mode without altering immutable resources', () => {
    expect(ids('为新书设计定位和长篇分卷大纲', 'plan')).toEqual(expect.arrayContaining(['cn-project-positioning.v3', 'cn-long-outline.v3']))
    expect(skillCatalog[0].modes).toEqual(['plan'])
    const author: AgentSkill = { ...skillCatalog[0], id: 'private-planning', owner: 'user' }
    expect(ids('新书定位', 'plan', [author])).toEqual([])
    expect(ids('新书定位', 'plan', skillCatalog.filter(s => s.id !== 'cn-project-positioning.v3'))).not.toContain('cn-project-positioning.v3')
  })
  it.each(['先创建章节，再续写正文', '打开计划，创作下一章', '调整标题和格式，并润色对白', '给主角写一段对话，格式用剧本格式'])('does not reject mixed creative request: %s', prompt => {
    expect(isMechanicalOnly(prompt)).toBe(false)
    expect(ids(prompt).length).toBeGreaterThan(0)
  })
  it.each(['只改一个错别字，不要润色', '调整格式，不要修改内容', '导出全书', '打开计划', '删除第三章'])('keeps pure operations out: %s', prompt => {
    expect(isMechanicalOnly(prompt)).toBe(true)
    expect(ids(prompt, 'revise')).toEqual([])
  })
  it('does not suppress author-defined negative triggers in mixed creation', () => {
    const author: AgentSkill = { ...skillCatalog[3], owner: 'user', id: 'author', negativeTriggers: [/不要动对白/] }
    expect(ids('续写正文，但不要动对白', 'write', [author])).toEqual([])
  })
})

describe('skill lifecycle uses successful receipts only', () => {
  const part = { type: 'tool-call' as const, callId: 'c', toolName: 'scene_task_build', title: '场景', args: {}, status: 'success' as const }
  it('advances at verified milestones, not generic reads or text', () => {
    expect(nextSkillPhase('story_compiler_prepare', part, 'write', '续写')).toBe('scene')
    expect(nextSkillPhase('scene_task_build', part, 'write', '续写')).toBe('draft')
    expect(nextSkillPhase('chapter_write', part, 'write', '续写')).toBe('critique')
    expect(nextSkillPhase('chapter_read', part, 'write', '续写')).toBeNull()
    expect(nextSkillPhase('plan_save', part, 'plan', '规划')).toBeNull()
  })
  it.each(['failed', 'denied', 'running'] as const)('does not advance for %s or mechanical/read-only work', status => {
    expect(nextSkillPhase('scene_task_build', { ...part, status }, 'write', '续写')).toBeNull()
    expect(nextSkillPhase('chapter_write', part, 'global_transform', '替换名字')).toBeNull()
    expect(nextSkillPhase('chapter_write', part, 'revise', '只改错别字')).toBeNull()
  })
})
