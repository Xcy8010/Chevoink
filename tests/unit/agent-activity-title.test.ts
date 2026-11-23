import { expect, it } from 'vitest'

import { createAgentActivityTextStream, normalizeAgentFinalText, readAgentActivityTitle, visibleAgentActivityTitle } from '../../shared/agent-activity-title.js'

it('recognizes only an entire leading title line and preserves reply content verbatim', () => {
  const text = '  窗外的钟响了。\n\n    余音未散。\n'
  const title = '<activity-title>核对老周的出场时间</activity-title>'
  expect(readAgentActivityTitle(`${title}\r\n${text}`)).toEqual({ title: '核对老周的出场时间', text })
  expect(readAgentActivityTitle(title)).toEqual({ title: '核对老周的出场时间', text: '' })
  for (const reply of [
    `这行是示例。\n${title}\n${text}`,
    `> ${title}\n${text}`,
    `${title} 一段原话\n${text}`,
    '    ' + title + '\n' + text,
    '\t' + title + '\n' + text,
    '<activity-title>文字没写完',
  ]) expect(readAgentActivityTitle(reply)).toEqual({ text: reply })
})

it('omits process-only headlines while keeping summaries of real creative subjects', () => {
  for (const title of ['总结这一步的结果', '正在整理最终回复', '汇总本阶段的工作进展', '收尾总结']) {
    expect(visibleAgentActivityTitle(title)).toBeUndefined()
  }
  for (const title of ['总结第九章的情节', '整理人物关系', '撰写章节摘要']) {
    expect(visibleAgentActivityTitle(title)).toBe(title)
  }
})

it('leaves status to tool receipts, including model titles restored from history', () => {
  for (const title of ['已完成章节复查', '复查完成', '已经查看正文', '未完成']) {
    expect(visibleAgentActivityTitle(title)).toBeUndefined()
  }
  expect(visibleAgentActivityTitle('正在核对第十二章')).toBe('核对第十二章')
  expect(visibleAgentActivityTitle('检查《已完成》的正文')).toBe('检查《已完成》的正文')
})

it('does not stream fragments of the title or drop text from a split chunk', () => {
  const title = '<activity-title>核对老周的出场时间</activity-title>\n'
  const text = '查看章节后发现，老周是在夜里到的。'
  for (let i = 1; i < title.length; i++) {
    const stream = createAgentActivityTextStream()
    expect(stream.push(title.slice(0, i))).toBe('')
    expect(stream.push(title.slice(i) + text)).toBe(text)
    expect(stream.finish(true)).toBe('')
  }
  const literal = createAgentActivityTextStream()
  expect(literal.push('<activ')).toBe('')
  expect(literal.push('ity-log>这是引用。')).toBe('<activity-log>这是引用。')
  expect(literal.push('\n下一句。')).toBe('\n下一句。')
})

it('releases a literal first-line tag in a no-tool answer, including a tag-only answer', () => {
  const answer = '<activity-title>保留这段文字</activity-title>'
  for (const suffix of ['', '\r\n \n']) {
    const stream = createAgentActivityTextStream()
    expect(stream.push(answer.slice(0, 14))).toBe('')
    expect(stream.push(answer.slice(14) + suffix)).toBe('')
    expect(stream.finish(false)).toBe(answer + suffix)
  }
})

it('strips only a complete leading activity line with an ordinary prose body at every chunk boundary', () => {
  const title = '<activity-title>交付结果</activity-title>'
  const body = '\n  雨停以后，雁船才离岸。\n'
  const raw = title + '\r\n' + body
  const literalExamples = [
    title,
    title + '\n \n',
    '```xml\n' + title + '\n```\n' + body,
    '`' + title + '`\n' + body,
    '> ' + title + '\n' + body,
    '    ' + title + '\n' + body,
    ' \t' + title + '\n' + body,
    title.replaceAll('<', '\\<') + '\n' + body,
    title.replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '\n' + body,
  ]
  for (const [content, expected] of [[raw, body], ...literalExamples.map(example => [example, example])]) {
    expect(normalizeAgentFinalText(content)).toBe(expected)
    for (let split = 0; split <= content.length; split++) {
      const stream = createAgentActivityTextStream()
      expect(stream.push(content.slice(0, split)) + stream.push(content.slice(split)) + stream.finish(false)).toBe(expected)
    }
  }
})
