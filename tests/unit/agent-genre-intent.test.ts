import { describe, expect, it } from 'vitest'
import { buildGenreWritingDigest, WRITING_REQUEST_GUIDANCE } from '../../api/lib/agent/knowledge/writing.js'
import { buildCriticSystem } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { buildSkillExecutionDigest, routeSkills } from '../../api/lib/agent/skills/index.js'

describe('current author genre and reading experience', () => {
  it('prioritizes an affirmative urban power fantasy over saved literary or suspense tags', () => {
    const digest = buildGenreWritingDigest(['悬疑', '现实'], 3, '写都市异能爽文第一章，能力觉醒后发现机会。')!
    expect(digest).toContain('爽文的阅读承诺与兑现')
    expect(digest).toContain('首章收益与情绪强度')
    expect(digest).toContain('异能优势与规则')
    expect(digest).toContain('不能把全部收益推迟')
    expect(digest).toContain('不重置成长')
    expect(digest).not.toContain('悬疑的承诺')
  })

  it.each([
    ['不要爽文，改为悬疑', '悬疑的承诺'],
    ['以前是爽文，现在改成慢热言情', '慢热的积累'],
    ['原来是爽文。这次写现实主义故事', '现实题材的经验与后果'],
    ['不是爽文，这次用搞笑喜剧风格', '喜剧的节奏与回响'],
    ['写舒缓的爱情故事，不走爽文套路', '慢热的积累'],
  ])('honors negation and changed style: %s', (request, marker) => {
    const digest = buildGenreWritingDigest(['都市异能爽文'], 3, request)!
    expect(digest).toContain(marker)
    expect(digest).not.toContain('爽文的阅读承诺与兑现')
    expect(digest).not.toContain('首章收益与情绪强度')
  })

  it('does not let a denied saved genre return when no new genre is named', () => {
    expect(buildGenreWritingDigest(['爽文'], 3, '不要爽文')).toBeNull()
    expect(buildGenreWritingDigest(['悬疑'])).toContain('作品标签次级参考')
  })

  it('keeps exact stopping, identity, length and output requirements above soft templates', () => {
    expect(WRITING_REQUEST_GUIDANCE).toContain('人物身份、剧情顺序、篇幅、精确停笔位置及输出格式')
    const digest = buildGenreWritingDigest([], 3, '写都市异能爽文，停在报价前')!
    expect(digest).toContain('不补成交或现金到账')
    expect(digest).toContain('不硬加反派、打脸或收益惩罚')
    expect(digest).toContain('主角独享的优势')
    expect(digest).toContain('主动抓住机会的决定')
    expect(digest).toContain('低谷按作者限定快速交代')
    const route = routeSkills({ mode: 'build', intent: 'write', freedom: 'balanced', prompt: '写都市异能爽文第一章，主角兴奋，停在报价前' })
    const skills = buildSkillExecutionDigest(route, 'balanced')
    expect(skills).toContain('低修辞预算只控制无功能修饰，不代表低情绪')
    expect(skills).toContain('检查可选且默认只读')
    expect(skills).not.toContain('默认执行证据化连续性修订和人类感质量建议')
  })

  it.each(['balanced', 'story', 'style'] as const)('critic %s permits meaningful emotion and panels while preserving evidence requirements', lens => {
    const system = buildCriticSystem(lens)
    expect(system).toContain('刻意情绪排比')
    expect(system).toContain('世界内面板、提示、数值')
    expect(system).toContain('真正重复解释、机械同构或因果缺口')
    expect(system).toContain('连续复制、逐字一致')
    expect(system).toContain('不能要求在指定停笔前强加成交')
    expect(system).toContain('不能授权改文')
  })
})
