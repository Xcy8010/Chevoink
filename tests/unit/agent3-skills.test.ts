import { describe, expect, it } from 'vitest'

import { buildGeneralWritingDigest } from '../../api/lib/agent/knowledge/writing.js'
import {
  buildSkillExecutionDigest,
  loadSkill,
  routeSkills,
  skillCatalog,
} from '../../api/lib/agent/skills/index.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'

describe('Agent 3.0 Skill OS deterministic router', () => {
  it('正文任务确定性装载场景和中文网文 Draft，并记录明确触发原因', () => {
    const decision = routeSkills({
      mode: 'build', intent: 'write', phase: 'draft', freedom: 'balanced',
      prompt: '续写下一章，重点是林舟和母亲在雨夜的对话与关系变化。',
    })

    expect(decision.selected.map((skill) => skill.id)).toEqual(expect.arrayContaining([
      'cn-webfiction-draft.v3',
      'cn-scene-task.v3',
    ]))
    expect(decision.selected.length).toBeLessThanOrEqual(3)
    expect(decision.reasonCodes).toContain('WRITE_CHAPTER')
    expect(decision.estimatedTokens).toBeGreaterThan(0)

    const digest = buildSkillExecutionDigest(decision, 'balanced')
    expect(digest).toContain('已由服务端确定性路由并完整加载')
    expect(digest).toContain('每个场景都要有目标、阻力和状态变化')
    expect(digest).not.toContain('需要时调用 skill_load')
  })

  it('首次 Draft 已支持具体化能力，不再把去机械感全部推迟到修订阶段', () => {
    expect(loadSkill('cn-prose-specificity.v3', 'draft', 'balanced')).toContain('首次写作')
    expect(loadSkill('cn-prose-specificity.v3', 'critique', 'balanced')).toContain('短证据')
    expect(loadSkill('cn-prose-specificity.v3', 'revision', 'balanced')).toContain('只改作者选中的')
  })

  it('只改错别字或普通结构操作不会误触发创作文笔 Skill', () => {
    const typo = routeSkills({
      mode: 'build', intent: 'revise', freedom: 'stable', prompt: '只改一个错别字，不要动其他内容。',
    })
    expect(typo.selected).toHaveLength(0)
    expect(typo.skippedReason).toBe('NON_CREATIVE_OPERATION')

    const structure = routeSkills({
      mode: 'build', intent: 'structure', freedom: 'balanced', prompt: '把第八章移动到第二卷。',
    })
    expect(structure.selected).toHaveLength(0)
    expect(structure.skippedReason).toBe('NON_CREATIVE_OPERATION')
  })

  it('AI 味反馈触发证据化语言修订，但不会加载无关长篇规划', () => {
    const decision = routeSkills({
      mode: 'build', intent: 'revise', freedom: 'balanced',
      prompt: '这段太有AI味了，形容词堆砌而且情绪很虚浮，帮我局部修改。',
    })
    const ids = decision.selected.map((skill) => skill.id)
    expect(ids).toContain('cn-prose-specificity.v3')
    expect(ids).not.toContain('cn-long-outline.v3')
    expect(decision.reasonCodes).toContain('STYLE_RISK_HIGH')
  })

  it('作品关闭的技能不会进入候选或执行上下文', () => {
    const enabledSkillIds = new Set(skillCatalog.map((skill) => skill.id))
    enabledSkillIds.delete('cn-webfiction-draft.v3')
    const decision = routeSkills({
      mode: 'build', intent: 'write', freedom: 'balanced', enabledSkillIds,
      prompt: '续写下一章，推进林舟在雨夜发现线索的剧情。',
    })
    expect(decision.candidates.map((candidate) => candidate.skill.id)).not.toContain('cn-webfiction-draft.v3')
    expect(decision.selected.map((skill) => skill.id)).not.toContain('cn-webfiction-draft.v3')
    expect(buildSkillExecutionDigest(decision, 'balanced')).not.toContain('cn-webfiction-draft.v3')
  })

  it('旧会话中的 2.0 Skill id 可以安全迁移到 3.0 资源', () => {
    expect(loadSkill('scene-craft.v2', 'draft', 'bold')).toContain('cn-scene-task.v3@3.0.1')
    expect(loadSkill('prose-specificity.v2', 'draft', 'balanced')).toContain('首次写作')
  })

  it('常驻写作知识不再强制每章钩子、固定字数或统一动作模板', () => {
    const digest = buildGeneralWritingDigest(6)
    expect(digest).toContain('软质量信号')
    expect(digest).not.toContain('每章结尾必须留钩子')
    expect(digest).not.toContain('开篇 300 字内')
    expect(digest).not.toContain('单次说明不超过 150 字')
  })

  it('自由度进入 TaskSpec，但不能放宽作者硬约束', () => {
    const spec = buildTaskSpec({
      runId: 'run-bold', novelId: 'novel-bold', chapterId: null, creativeFreedom: 'bold',
      prompt: '大胆探索下一章，但必须保持林舟不会读心。',
    })
    expect(spec.creativeFreedom).toBe('bold')
    expect(spec.hardConstraints[0].text).toContain('必须保持')
    expect(loadSkill('cn-webfiction-draft.v3', 'draft', 'bold')).toContain('核心设定和不可逆剧情仍服从作者与故事事实')
  })

  it('内置 Skill 均有版本、许可、负触发和上下文预算', () => {
    expect(skillCatalog.length).toBeGreaterThanOrEqual(10)
    const updated = new Set(['cn-long-outline.v3', 'cn-scene-task.v3', 'cn-webfiction-draft.v3', 'cn-emotion-grounding.v3'])
    expect(skillCatalog.every((skill) => skill.version === (updated.has(skill.id) ? '3.0.1' : '3.0.0'))).toBe(true)
    expect(skillCatalog.every((skill) => skill.negativeTriggers.length > 0)).toBe(true)
    expect(skillCatalog.every((skill) => skill.tokenBudget > 0)).toBe(true)
    const adapted = skillCatalog.filter((skill) => skill.license !== 'internal')
    expect(adapted.every((skill) => skill.attribution?.length)).toBe(true)
  })
})
