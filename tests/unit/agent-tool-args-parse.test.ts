import { describe, expect, it } from 'vitest'

import { parseToolArgsTolerant } from '../../api/lib/agent/tool-argument-parser.js'

/**
 * 截断残尾深度修复：模型输出被 length 截断时，除未闭括号外还会留下
 * 悬垂逗号/冒号、悬垂键、尾部孤反斜杠，朴素补括号救不了，需 repairTruncatedDeep 兜底。
 */
describe('parseToolArgsTolerant 深度截断修复', () => {
  it('execution mode rejects incomplete nested payloads instead of inventing missing content', () => {
    expect(() => parseToolArgsTolerant('{"tasks":[{"goal":"完整的一项"}', false)).toThrow('结构不完整')
    expect(() => parseToolArgsTolerant('{"body":"只写了一半', false)).toThrow('结构不完整')
  })
  it('repairs nested scene JSON with missing and trailing commas without losing Chinese content', () => {
    const raw = '{"tasks":[{"goal":"审俘破线" "entryState":{"body":["负伤",],},"exitState":{"knowledge":["发现真相"]}}]}'
    expect(parseToolArgsTolerant(raw)).toEqual({ tasks: [{ goal: '审俘破线', entryState: { body: ['负伤'] }, exitState: { knowledge: ['发现真相'] } }] })
  })
  it('悬垂逗号：截断留下的尾部逗号被清理后补齐括号仍可解析', () => {
    const raw = '{"mode":"build","tasks":[{"title":"第 1 章","brief":"写正文",'
    const parsed = parseToolArgsTolerant(raw) as { mode: string; tasks: Array<{ title: string; brief: string }> }
    expect(parsed.mode).toBe('build')
    expect(parsed.tasks[0].title).toBe('第 1 章')
    expect(parsed.tasks[0].brief).toBe('写正文')
  })

  it('悬垂键：只有键和冒号还没等到值时，连键一起切掉保住前面的完整字段', () => {
    const raw = '{"title":"第 2 章","brief":"写第二章正文","mode":'
    const parsed = parseToolArgsTolerant(raw) as { title: string; brief: string; mode?: unknown }
    expect(parsed.title).toBe('第 2 章')
    expect(parsed.brief).toBe('写第二章正文')
    expect(parsed.mode).toBeUndefined()
  })

  it('截断在键名中间：悬垂的半个键被切掉，朴素补括号会留下无值的键而失败', () => {
    const raw = '{"title":"第 3 章","brief"'
    const parsed = parseToolArgsTolerant(raw) as { title: string; brief?: unknown }
    expect(parsed.title).toBe('第 3 章')
    expect(parsed.brief).toBeUndefined()
  })

  it('合法 JSON 原样解析，深度修复不改变正常参数语义', () => {
    const raw = '{"mode":"build","tasks":[{"title":"第 3 章","brief":"写第三章正文，约 3000 字。"}]}'
    const parsed = parseToolArgsTolerant(raw) as { mode: string; tasks: Array<{ title: string }> }
    expect(parsed.mode).toBe('build')
    expect(parsed.tasks).toHaveLength(1)
    expect(parsed.tasks[0].title).toBe('第 3 章')
  })
})


describe('complete execution argument recovery', () => {
  const content = ('## 计划\n- 人物保留原有欲望\n- [ ] 不猜目标 {实际范围}\n').repeat(60)
  it.each([
    ["Here's the JSON:\n", '\n'],
    ['\x60\x60\x60json\n', '\n\x60\x60\x60'],
    ["Author's complete arguments:\n\x60\x60\x60json\n", '\n\x60\x60\x60'],
  ])('ignores wrapper prose/fences but preserves every long Markdown character', (prefix, suffix) => {
    const input = { title: '完整长计划', content }
    expect(parseToolArgsTolerant(prefix + JSON.stringify(input) + suffix, false)).toEqual(input)
  })
  it('preserves raw control characters and escaped single-quoted content', () => {
    const value = '第一段\n第二段\t正文\r\u0000\b\f'
    const raw = '{"title":"计划","content":"' + value + '"}'
    expect(parseToolArgsTolerant(raw, false)).toEqual({ title: '计划', content: value })
    expect(parseToolArgsTolerant("{'title':'计划','content':'人物说\\'保留事实\\'。'}", false))
      .toEqual({ title: '计划', content: "人物说'保留事实'。" })
  })
  it('repairs complete comma syntax without replacing values', () => {
    expect(parseToolArgsTolerant('{"content":"完整正文" "tasks":[{"goal":"事实",},],}', false))
      .toEqual({ content: '完整正文', tasks: [{ goal: '事实' }] })
  })
  it.each([
    '{"title":"计划","content":}', '{"title":"计划","content"}',
    '{"content":"真实残文', '{"tasks":[{"goal":"完整一项"}',
    '{"content":"甲"}{"content":"乙"}', '{"tasks":["甲"}}',
    '{"content":"完整正文"},"planId":"残文', '{"tasks":["甲",,"乙"]}',
  ])('rejects incomplete or ambiguous payloads instead of supplying business tokens: %s', raw => {
    expect(() => parseToolArgsTolerant(raw, false)).toThrow()
  })
})
