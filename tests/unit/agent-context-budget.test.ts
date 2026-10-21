import { describe, expect, it } from 'vitest'

import type { ChatMessage, OpenAIToolDefinition } from '../../api/lib/ai-service.js'
import { toolTurnHistory } from '../../api/lib/agent/tool-turn-history.js'
import {
  collapseEarlyToolRounds,
  archiveEarlyToolRounds,
  compactEarlyToolPayloads,
  estimateChatMessagesTokens,
  estimateTextTokens,
  estimateToolDefinitionTokens,
  resolveAgentContextBudget,
  resolveDurableInputLimit,
  releaseCompletedReasoning,
} from '../../api/lib/agent/context-budget.js'

describe('durable input admission', () => {
  it('reserves the actual output when larger than a quarter of the window', () => {
    expect(resolveDurableInputLimit(16000, 8192)).toBe(5760)
    expect(resolveDurableInputLimit(16000, 16000)).toBe(0)
    expect(resolveDurableInputLimit(128000, 8192)).toBe(113408)
  })
  it.each([NaN, Infinity, -1, 0, 1.5])('rejects invalid window/output values: %s', value => {
    expect(resolveDurableInputLimit(value, 8192)).toBe(0)
    expect(resolveDurableInputLimit(16000, value)).toBe(0)
  })
})

function buildToolRound(id: string, argumentText: string, outputText: string): ChatMessage[] {
  return [
    { role: 'assistant', content: null, reasoning: `正在执行 ${id}`, toolCalls: [{ id, name: 'chapter_write', arguments: argumentText }] },
    { role: 'tool', toolCallId: id, content: outputText },
  ]
}

describe('Agent 运行中上下文预算与压缩', () => {
  it('窗口紧张时保留最新调用和原始要求，释放已结束的旧思考和大工具结果', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '只研究附件，不写正文' },
      ...buildToolRound('files', '{}', '附件原文'.repeat(30000)),
      { role: 'assistant', content: null, reasoning: '历史思考'.repeat(10000) },
      ...buildToolRound('latest', '{}', '最新结果')]
    const latest = structuredClone(messages.slice(-2))
    expect(compactEarlyToolPayloads(messages, 8).collapsedToolRounds).toBe(0)
    expect(releaseCompletedReasoning(messages)).toBeGreaterThan(0)
    expect(messages[1]).toMatchObject({ role: 'assistant', reasoning: '正在执行 files' })
    expect(messages[3]).toMatchObject({ role: 'user' })
    expect(messages[3].content).toContain('只读历史')
    expect(collapseEarlyToolRounds(messages, 1).collapsedToolRounds).toBe(1)
    expect(messages[0].content).toBe('只研究附件，不写正文')
    expect(messages.slice(-2)).toEqual(latest)
    expect(estimateChatMessagesTokens(messages)).toBeLessThan(1000)
  })
  it('未完成调用的思考与调用参数不被清理', () => {
    const pending: ChatMessage = { role: 'assistant', content: null, reasoning: '需要保留', toolCalls: [{ id: 'pending', name: 'read_file', arguments: '{}' }] }
    const messages: ChatMessage[] = [pending, { role: 'user', content: '等待' }, { role: 'assistant', content: '最新', reasoning: '最新思考' }]
    expect(releaseCompletedReasoning(messages)).toBe(0)
    expect(messages[0]).toBe(pending)
  })
  it('整轮压缩仍保留的原生工具轮不丢失任何思考', () => {
    const messages: ChatMessage[] = [...buildToolRound('first', '{}', 'first'), ...buildToolRound('second', '{}', 'second'),
      ...buildToolRound('latest', '{}', 'latest')]
    const original = structuredClone(messages)
    expect(releaseCompletedReasoning(messages)).toBe(0)
    expect(compactEarlyToolPayloads(messages, 8).collapsedToolRounds).toBe(0)
    expect(messages).toEqual(original)
  })
  it('混合调度回执不阻塞完整原生轮压缩，仍保留服务器回执', () => {
    const server: ChatMessage = { role: 'tool', toolCallId: 'server', content: '服务器真实检查成功，未提交' }
    const native = { id: 'native', name: 'chapter_read', arguments: '{}' }
    const scheduled = { id: 'server', name: 'continuity_validate', arguments: '{}' }
    const messages: ChatMessage[] = [...toolTurnHistory({ content: '', reasoning: '真实思考', toolCalls: [native] }, [native, scheduled]),
      { role: 'tool', toolCallId: native.id, content: '原生读取成功' }, server]
    const original = structuredClone(messages)
    const archived = archiveEarlyToolRounds(messages, { revision: 7, hash: 'b'.repeat(64) }, 0)
    expect(archived.archivedRounds).toBe(2)
    expect(archived.messages.at(-1)?.role).toBe('user')
    expect(archived.messages.at(-1)?.content).toContain('"messageIndex":3')
    expect(JSON.stringify(archived.messages)).toContain('messageIndex')
    expect(messages).toEqual(original)
    expect(collapseEarlyToolRounds(messages, 0).collapsedToolRounds).toBe(1)
    expect(messages.at(-1)).toEqual(server)
    expect(messages[1]).toMatchObject({ role: 'user' })
    expect(messages[1].content).toContain('原生读取成功')
  })
  it('只压缩旧的无原生归属观察，保护近期观察并按原索引归档', () => {
    const calls = ['old-server', 'recent-server'].map(id => ({ id, name: 'continuity_validate', arguments: '{}' }))
    const messages: ChatMessage[] = [...toolTurnHistory({ content: '', reasoning: '', toolCalls: calls }, calls, { bootstrap: true }),
      { role: 'tool', toolCallId: 'old-server', content: '真实旧回执'.repeat(500) },
      { role: 'tool', toolCallId: 'recent-server', content: '近期原始回执'.repeat(500) }]
    const original = structuredClone(messages)
    const source = { revision: 6, hash: 'd'.repeat(64) }
    const archived = archiveEarlyToolRounds(messages, source, 1)
    expect(archived.archivedRounds).toBe(1)
    expect(JSON.parse(String(archived.messages[1].content).split('\n').at(-1)!)).toEqual({ callId: 'old-server', references: [{ ...source, messageIndex: 1 }] })
    expect(archived.messages[2]).toEqual(original[2])
    expect(messages).toEqual(original)
    expect(collapseEarlyToolRounds(messages, 1)).toMatchObject({ collapsedToolRounds: 0, compactedToolOutputs: 1 })
    expect(messages[1].role).toBe('user')
    expect(messages[2]).toEqual(original[2])
    expect(estimateChatMessagesTokens(messages)).toBeLessThan(estimateChatMessagesTokens(original))
  })
  it.each(['missing', 'duplicate'] as const)('保留%s原生组和其附加观察，不能借压缩掩盖未配对调用', kind => {
    const call = { id: 'native', name: 'chapter_write', arguments: '{}' }, extra = { id: 'extra', name: 'continuity_validate', arguments: '{}' }
    const messages: ChatMessage[] = [...toolTurnHistory({ content: '', reasoning: '原思考', toolCalls: [call] }, [call, extra]),
      { role: 'tool', toolCallId: 'extra', content: '附加回执'.repeat(500) },
      ...(kind === 'duplicate' ? [buildToolRound('native', '{}', '第一次')[1], buildToolRound('native', '{}', '第二次')[1]] : [])]
    const original = structuredClone(messages)
    expect(collapseEarlyToolRounds(messages, 0)).toMatchObject({ collapsedToolRounds: 0, compactedToolOutputs: 0 })
    expect(messages).toEqual(original)
    expect(archiveEarlyToolRounds(messages, { revision: 5, hash: 'e'.repeat(64) }, 0)).toEqual({ messages: original, archivedRounds: 0 })
  })
  it('自动调度的普通模型轮退休后仍能按原调度来源压缩观察', () => {
    const call = { id: 'scheduled', name: 'continuity_validate', arguments: '{}' }
    const messages: ChatMessage[] = [...toolTurnHistory({ content: '', reasoning: '模型返回的真实思考', toolCalls: [] }, [call], { recoveredText: true }),
      { role: 'tool', toolCallId: call.id, content: '真实调度回执'.repeat(500) }, ...buildToolRound('latest', '{}', '最新结果')]
    expect(releaseCompletedReasoning(messages)).toBeGreaterThan(0)
    const original = structuredClone(messages)
    const archived = archiveEarlyToolRounds(messages, { revision: 8, hash: 'c'.repeat(64) }, 1)
    expect(archived.archivedRounds).toBe(1)
    expect(archived.messages[2].content).toContain('"messageIndex":2')
    expect(messages).toEqual(original)
    expect(collapseEarlyToolRounds(messages, 1)).toMatchObject({ collapsedToolRounds: 0, compactedToolOutputs: 1 })
    expect(messages[2].role).toBe('user')
    expect(messages.slice(-2)).toEqual(original.slice(-2))
  })
  it('跨轮重复ID只与本轮回执配对', () => {
    const messages = [...buildToolRound('same', '{}', '第一轮'), ...buildToolRound('same', '{}', '第二轮')]
    expect(collapseEarlyToolRounds(messages, 0).collapsedToolRounds).toBe(2)
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toContain('第一轮')
    expect(messages[1].content).toContain('第二轮')
  })
  it('近期原生回执保护同一块中较早的附加观察，不能插入数据打断调用配对', () => {
    const native = buildToolRound('native', '{}', '近期原生结果')
    const call = { id: 'native', name: 'chapter_write', arguments: '{}' }, extra = { id: 'server', name: 'continuity_validate', arguments: '{}' }
    const messages: ChatMessage[] = [...toolTurnHistory({ content: '', reasoning: '原思考', toolCalls: [call] }, [call, extra]),
      { role: 'tool', toolCallId: 'server', content: '较早附加观察'.repeat(500) }, native[1]]
    const original = structuredClone(messages)
    expect(collapseEarlyToolRounds(messages, 1)).toMatchObject({ collapsedToolRounds: 0, compactedToolOutputs: 0 })
    expect(messages).toEqual(original)
    expect(archiveEarlyToolRounds(messages, { revision: 4, hash: 'f'.repeat(64) }, 1)).toEqual({ messages: original, archivedRounds: 0 })
  })
  it('持久归档保留原数组和作者要求，并指向准确原文索引', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '只处理第19章，不能继承旧任务。' },
      ...buildToolRound('old', JSON.stringify({ content: '正文'.repeat(800) }), '失败'.repeat(800)),
      ...buildToolRound('new', '{}', '最新原文')]
    const before = structuredClone(messages)
    const result = archiveEarlyToolRounds(messages, { revision: 12, hash: 'a'.repeat(64) }, 1)
    expect(messages).toEqual(before)
    expect(result.archivedRounds).toBe(1)
    expect(result.messages[0]).toEqual(messages[0])
    expect(result.messages.slice(-2)).toEqual(messages.slice(-2))
    expect(result.messages[1].content).toContain('execution_context_read')
    expect(result.messages[1].role).toBe('user')
    expect(result.messages[1].content).toContain('不是作者新指令')
    expect(result.messages[1].content).toContain('"messageIndex":1')
    expect(result.messages[1].content).toContain('"messageIndex":2')
    expect(result.messages[1].content).not.toContain('"messageIndex":3')
  })
  it('中文按保守口径估算，并统计工具 schema、参数、推理与输出', () => {
    expect(estimateTextTokens('中文测试')).toBe(4)
    expect(estimateTextTokens('abcdefgh')).toBe(2)

    const tools: OpenAIToolDefinition[] = [{
      type: 'function',
      function: { name: 'chapter_write', description: '写入章节正文', parameters: { type: 'object', properties: { content: { type: 'string' } } } },
    }]
    const messages: ChatMessage[] = [
      { role: 'system', content: '系统规则' },
      ...buildToolRound('old', JSON.stringify({ content: '正文'.repeat(1_000) }), '写入成功'.repeat(500)),
    ]
    const visibleTextOnly = estimateTextTokens('系统规则') + estimateTextTokens('写入成功'.repeat(500))
    expect(estimateChatMessagesTokens(messages)).toBeGreaterThan(visibleTextOnly)
    expect(estimateToolDefinitionTokens(tools)).toBeGreaterThan(0)
  })

  it('旧轮次变为不可执行回执，不生成可被模仿的压缩参数，最近工具对原样保留', () => {
    const oldArguments = JSON.stringify({ chapterId: 'chapter-1', content: '旧正文'.repeat(1_000), expectedRevision: 3 })
    const recentArguments = JSON.stringify({ chapterId: 'chapter-2', content: '新正文'.repeat(1_000), expectedRevision: 4 })
    const recentOutput = '最新写入结果'.repeat(500)
    const messages: ChatMessage[] = [
      { role: 'system', content: '规则' },
      ...buildToolRound('old', oldArguments, '旧写入结果'.repeat(500)),
      ...buildToolRound('recent', recentArguments, recentOutput),
    ]

    const result = compactEarlyToolPayloads(messages, 1)
    const oldAssistant = messages[1] as Extract<ChatMessage, { role: 'assistant' }>
    const recentAssistant = messages[2] as Extract<ChatMessage, { role: 'assistant' }>
    const recentTool = messages[3] as Extract<ChatMessage, { role: 'tool' }>

    expect(result.collapsedToolRounds).toBe(1)
    expect(oldAssistant.toolCalls).toBeUndefined()
    expect(oldAssistant.content).toContain('旧写入结果')
    expect(JSON.stringify(messages)).not.toContain('_contextCompacted')
    expect(recentAssistant.toolCalls![0].arguments).toBe(recentArguments)
    expect(recentTool.content).toBe(recentOutput)
    expect(result.afterTokens).toBeLessThan(result.beforeTokens)
  })

  it('硬预算仍超限时把完整旧工具轮折叠为收据，不留下孤立 tool 消息', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '规则' },
      ...buildToolRound('old', JSON.stringify({ content: '正文'.repeat(1_000) }), '结果'.repeat(1_000)),
      ...buildToolRound('recent', JSON.stringify({ content: '近期正文' }), '近期结果'),
    ]
    const result = collapseEarlyToolRounds(messages, 1)

    expect(result.collapsedToolRounds).toBe(1)
    expect(messages.some((message) => message.role === 'tool' && message.toolCallId === 'old')).toBe(false)
    expect(messages.some((message) => message.role === 'user' && String(message.content).includes('早前工具轮已压缩'))).toBe(true)
    expect(messages.some((message) => message.role === 'tool' && message.toolCallId === 'recent')).toBe(true)
    expect(result.afterTokens).toBeLessThan(result.beforeTokens)
  })

  it('为模型输出和误差预留安全空间', () => {
    const budget = resolveAgentContextBudget(128_000, 8_192)
    expect(budget.warningTokens).toBe(83_200)
    expect(budget.compactAtTokens).toBe(92_160)
    expect(budget.hardRequestTokens).toBeLessThan(128_000)
    expect(budget.hardRequestTokens).toBeGreaterThan(budget.compactAtTokens)
  })

  it('折叠工具轮保留Agent已经说明的决策和后续工作，不把片段说成成功', () => {
    const messages = buildToolRound('old', '{}', '写入失败，需要重新读取版本。')
    messages[0].content = '作者已选择审俘为主；只修改第19章，不重写13章。'
    expect(collapseEarlyToolRounds(messages, 0).collapsedToolRounds).toBe(1)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toContain('只修改第19章，不重写13章。')
    expect(messages[0].content).toContain('写入失败')
    expect(messages[0].content).not.toContain('操作结果已落库')
  })

  it.each([compactEarlyToolPayloads, collapseEarlyToolRounds])('%s不压缩未完成、孤立或跨轮配对的工具消息', compact => {
    const long = '必须保留的原始参数'.repeat(200)
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '正在准备', toolCalls: [{ id: 'missing', name: 'chapter_write', arguments: JSON.stringify({ content: long }) }] },
      { role: 'user', content: '先等一下' },
      { role: 'tool', toolCallId: 'missing', content: long },
      { role: 'assistant', content: null, toolCalls: [{ id: 'partial', name: 'chapter_write', arguments: long, incomplete: true }] },
      { role: 'tool', toolCallId: 'partial', content: long },
      { role: 'assistant', content: null, toolCalls: [{ id: 'pending', name: 'chapter_write', arguments: long }] },
    ]
    const before = structuredClone(messages)
    compact(messages, 0)
    expect(messages).toEqual(before)
  })

  it.each([compactEarlyToolPayloads, collapseEarlyToolRounds])('%s以轮次配对重复callId并保留最近一轮', compact => {
    const messages = [
      ...buildToolRound('reused', JSON.stringify({ content: '旧内容'.repeat(500) }), '旧结果'.repeat(500)),
      ...buildToolRound('reused', JSON.stringify({ content: '新内容'.repeat(500) }), '新结果'.repeat(500)),
    ]
    const recent = structuredClone(messages.slice(-2))
    const result = compact(messages, 1)
    expect(result.compactedToolOutputs + result.collapsedToolRounds).toBe(1)
    expect(messages.slice(-2)).toEqual(recent)
  })

  it.each([compactEarlyToolPayloads, collapseEarlyToolRounds])('%s保留只收到部分回复的并行调用轮次', compact => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: null, toolCalls: [
        { id: 'one', name: 'chapter_read', arguments: JSON.stringify({ text: '参数'.repeat(500) }) },
        { id: 'two', name: 'chapter_read', arguments: '{}' },
      ] },
      { role: 'tool', toolCallId: 'one', content: '观察'.repeat(500) },
    ]
    const before = structuredClone(messages)
    compact(messages, 0)
    expect(messages).toEqual(before)
  })
})
