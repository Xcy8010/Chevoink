import { expect, it } from 'vitest'

import { createAgentActivityTextStream, readAgentActivityTitle } from '../../shared/agent-activity-title.js'

it('recognizes only an entire leading title line and preserves reply content verbatim', () => {
  const text = '  窗外的钟响了。\n\n    余音未散。\n'
  const title = '<activity-title>核对老周的出场时间</activity-title>'
  expect(readAgentActivityTitle(`${title}\r\n${text}`)).toEqual({ title: '核对老周的出场时间', text })
  expect(readAgentActivityTitle(title)).toEqual({ title: '核对老周的出场时间', text: '' })
  for (const reply of [
    `这行是示例。\n${title}\n${text}`,
    `> ${title}\n${text}`,
    `${title} 一段原话\n${text}`,
    '<activity-title>文字没写完',
  ]) expect(readAgentActivityTitle(reply)).toEqual({ text: reply })
})

it('does not stream fragments of the title or drop text from a split chunk', () => {
  const title = '<activity-title>核对老周的出场时间</activity-title>\n'
  const text = '查看章节后发现，老周是在夜里到的。'
  for (let i = 1; i < title.length; i++) {
    const stream = createAgentActivityTextStream()
    expect(stream.push(title.slice(0, i))).toBe('')
    expect(stream.push(title.slice(i) + text)).toBe('')
    expect(stream.finish(true)).toBe(text)
  }
  const literal = createAgentActivityTextStream()
  expect(literal.push('<activ')).toBe('')
  expect(literal.push('ity-log>这是引用。')).toBe('<activity-log>这是引用。')
  expect(literal.push('\n下一句。')).toBe('\n下一句。')
})

it('releases a literal first-line tag in a no-tool answer, including a tag-only answer', () => {
  const answer = '<activity-title>保留这段文字</activity-title>'
  for (const suffix of ['', '\n这是下一行。']) {
    const stream = createAgentActivityTextStream()
    expect(stream.push(answer.slice(0, 14))).toBe('')
    expect(stream.push(answer.slice(14) + suffix)).toBe('')
    expect(stream.finish(false)).toBe(answer + suffix)
  }
})
