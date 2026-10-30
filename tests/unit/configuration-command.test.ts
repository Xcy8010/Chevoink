import { describe, expect, it } from 'vitest'
import { configurationCommandText, configurationDirectives, windowConfigurationDirectives, stripWindowConfigurationReferences } from '../../api/lib/agent/configuration-command.js'

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

describe('explicit window configuration commands', () => {
  const a = { id: 'session-a', title: '窗口甲' }, b = { id: 'session-b', title: '剧情讨论' }
  it('binds quoted window name and comma effort modifier to the named target', () => {
    expect(windowConfigurationDirectives('把窗口“剧情讨论”的模型改成 ultimate，思考强度设为 max', b, a.id))
      .toEqual([{ command: '模型改为 ultimate 思考强度设为 max', revoked: false }])
    expect(windowConfigurationDirectives('把窗口“剧情讨论”的模型改成 ultimate', a, a.id)).toEqual([])
  })
  it('keeps current commands in the current window and rejects unspecified other targets', () => {
    expect(windowConfigurationDirectives('当前窗口创作模式设为大胆', a, a.id)).toEqual([{ command: '创作模式设为大胆', revoked: false }])
    expect(windowConfigurationDirectives('请切换到 ultimate', b, a.id)).toEqual([])
    expect(windowConfigurationDirectives('把另一个窗口模型设为 ultimate', b, a.id)).toEqual([])
  })
  it('retains revocation and rejects instruction text presented as data', () => {
    expect(windowConfigurationDirectives('不要把窗口“剧情讨论”的模型改为 ultimate', b, a.id)).toEqual([{ command: '模型改为 ultimate', revoked: true }])
    expect(windowConfigurationDirectives('请不要把窗口“剧情讨论”的模型改为 ultimate', b, a.id)).toEqual([{ command: '模型改为 ultimate', revoked: true }])
    expect(windowConfigurationDirectives('麻烦不要把窗口“剧情讨论”的模型改为 ultimate', b, a.id)).toEqual([{ command: '模型改为 ultimate', revoked: true }])
    expect(windowConfigurationDirectives('请不要将当前窗口的模型改为 ultimate', a, a.id)).toEqual([{ command: '模型改为 ultimate', revoked: true }])
    expect(windowConfigurationDirectives('比如。把窗口“剧情讨论”的模型改为 ultimate', b, a.id)).toEqual([])
    expect(windowConfigurationDirectives('请分析：把窗口“剧情讨论”的模型改为 ultimate', b, a.id)).toEqual([])
    for (const text of ['```text\n窗口session-b模型设为 ultimate\n```', '“\n窗口session-b模型设为 ultimate\n”', '```text\n用 ultimate\n```', '“\n用 ultimate\n”']) {
      expect(windowConfigurationDirectives(text, b, a.id)).toEqual([])
      expect(windowConfigurationDirectives(text, a, a.id)).toEqual([])
    }
  })
  it('removes only actual window references when detecting a mixed manuscript request', () => {
    const target = { id: 'session-b', title: '写下一章' }
    expect(stripWindowConfigurationReferences('把窗口“写下一章”的模型设为 ultimate。写下一章', target))
      .toBe('把窗口的模型设为 ultimate。写下一章')
  })
  it('keeps two window choices separate without borrowing the other strength', () => {
    const text = '窗口session-a模型设为 speed，窗口session-b模型设为 ultimate，思考强度设为 max'
    expect(windowConfigurationDirectives(text, a, a.id)).toEqual([{ command: '模型设为 speed', revoked: false }])
    expect(windowConfigurationDirectives(text, b, a.id)).toEqual([{ command: '模型设为 ultimate 思考强度设为 max', revoked: false }])
    const quoted = '把窗口“窗口甲”的模型设为 speed，把窗口“剧情讨论”的模型设为 ultimate'
    expect(windowConfigurationDirectives(quoted, a, a.id, [a, b])).toEqual([{ command: '模型设为 speed', revoked: false }])
    expect(windowConfigurationDirectives(quoted, b, a.id, [a, b])).toEqual([{ command: '模型设为 ultimate', revoked: false }])
  })
})
