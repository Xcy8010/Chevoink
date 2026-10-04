import { describe, expect, it } from 'vitest'
import { configurationCommandText, configurationDirectives } from '../../api/lib/agent/configuration-command.js'

describe('bounded native configuration commands', () => {
  it.each(['请分析下面这句英文的语法："use ultimate"', "请分析 'use ultimate'", '文档写着 use ultimate',
    '如果使用 ultimate 会怎样', '不要切换 ultimate', '比较 speed 和 ultimate', '请解释如何使用 ultimate',
    '这句话使用 ultimate 作为例子', '请写一段讨论 use ultimate 的文章'])('rejects data and discussion: %s', text => {
    expect(configurationCommandText(text)).toBeNull()
  })
  it.each(['请切换到 ultimate', '用 speed 写下一章', '正文写作用 ultimate medium', '全局，质量检查用 standard high',
    '请改为严谨模式', 'please use ultimate medium', '写下一章。请切换到 ultimate'])('accepts actual imperative: %s', text => {
    expect(configurationCommandText(text)).not.toBeNull()
  })
  it('does not grant a model mentioned only in another clause', () => {
    expect(configurationCommandText('请切换到 speed。ultimate 是模型名称')).toBe('请切换到 speed')
  })
  it('splits distinct conjunction commands and binds only a single effort modifier', () => {
    expect(configurationCommandText('正文写作用 speed 和质量检查用 ultimate')).toBe('正文写作用 speed；质量检查用 ultimate')
    expect(configurationCommandText('use ultimate and reasoning high')).toBe('use ultimate reasoning high')
    expect(configurationCommandText('use ultimate and use speed')).toBe('use ultimate；use speed')
    expect(configurationCommandText('use speed and ultimate')).toBeNull()
  })
  it('records direct negative controls as revocation barriers, never write authority', () => {
    expect(configurationCommandText('不要再用 ultimate')).toBeNull()
    expect(configurationDirectives('不要再用 ultimate')).toEqual([{ command: '用 ultimate', revoked: true }])
    expect(configurationDirectives('不要分析 "use ultimate"')).toEqual([])
  })
})
