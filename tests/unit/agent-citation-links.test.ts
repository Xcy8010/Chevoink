import { describe, expect, it } from 'vitest'
import { normalizeAgentCitationLinks } from '../../shared/agent-output.js'
import { projectAgentAuthorText } from '../../shared/agent-author-view.js'
import { researchReportSaveParameters } from '../../api/lib/agent/research-sources.js'

describe('research citation output boundaries', () => {
  it('keeps the adjacent Chinese limitation outside the actual link', () => {
    const url = 'https://fiction.example.com/reader/12345'
    const input = `第一章（${url}）：返回内容不可读，未计为已读。`
    const expected = `第一章（<${url}>）：返回内容不可读，未计为已读。`
    expect(normalizeAgentCitationLinks(input)).toBe(expected)
    expect(projectAgentAuthorText(input)).toBe(expected)
    expect(projectAgentAuthorText(expected)).toBe(expected)
  })
  it.each([
    '[章节](https://fiction.example.com/条目）：内容)',
    '<https://fiction.example.com/reader/12345>',
    '`https://fiction.example.com/reader/12345）：示例`',
    '```text\nhttps://fiction.example.com/reader/12345）：示例\n```',
    '> 原文：https://fiction.example.com/reader/12345）：保留引用。',
    '“https://fiction.example.com/reader/12345）：这是被引用的原句。”',
    '原文是"https://fiction.example.com/reader/12345）：这里只是引文。"',
    "原文是'https://fiction.example.com/reader/12345）：这里只是引文。'",
    '[https://fiction.example.com/reader/12345）：标签][src]\n\n[src]: https://fiction.example.com/catalog',
    '![https://fiction.example.com/reader/12345）：标签][src]\n\n[src]: https://fiction.example.com/image.png',
    '<a href="https://fiction.example.com/reader/12345）：文字">正文</a>',
    '<a href="https://fiction.example.com/catalog">https://fiction.example.com/reader/12345）：文字</a>',
    '目录：https://fiction.example.com/reader/12345',
  ])('preserves explicit links and literal source/examples: %s', text => {
    expect(normalizeAgentCitationLinks(text)).toBe(text)
  })
  it('accepts a section update without making the model repeat report metadata', () => {
    const input = { reportId: 'main', expectedRevision: 1,
      section: { id: 'catalog', order: 1, content: '## 官方目录\n仅保存元数据。', citations: [], evidenceKind: 'source_identity' } }
    expect(researchReportSaveParameters.parse(input)).toMatchObject(input)
    expect(researchReportSaveParameters.safeParse({ ...input, expectedRevision: -1 }).success).toBe(false)
    expect(researchReportSaveParameters.safeParse({ ...input, title: '' }).success).toBe(false)
  })
})
