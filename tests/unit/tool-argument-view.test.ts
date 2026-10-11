import { describe, expect, it } from 'vitest'

import { describeToolArguments, getToolTargetTitle } from '../../src/features/studio/agent/tool-argument-view'

describe('工具详情的人类可读映射', () => {
  it('把长正文映射为字数，隐藏参数值与正文片段', () => {
    const rows = describeToolArguments({ chapterId: 'chapter-1', content: '第一段正文。'.repeat(30), position: 3 })
    expect(rows).toEqual([{ label: '正文内容', value: '180 字' }])
    expect(rows.map((row) => row.value).join('\n')).not.toContain('{"')
    expect(rows.map((row) => row.value).join('\n')).not.toMatch(/chapter-1|第一段正文|^3$/)
  })

  it('优先使用工具结果里的真实章节或计划名称作为导航标题', () => {
    expect(getToolTargetTitle({ kind: 'chapterRef', chapterId: 'chapter-1', title: '演练', wordCount: 1763 }, {})).toBe('演练')
    expect(getToolTargetTitle({ kind: 'planFile', artifactId: 'plan-1', title: '全书大纲', content: '' }, {})).toBe('全书大纲')
  })
})
