import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ chat: vi.fn(), tool: vi.fn() }))
vi.mock('../../api/lib/ai-service.js', () => ({ chatWithTools: mocks.chat }))
vi.mock('../../api/lib/agent/loop.js', () => ({ handleToolCall: mocks.tool }))
vi.mock('../../api/lib/agent/goal-runtime.js', () => ({ buildGoalContextMessages: async () => [] }))
vi.mock('../../api/lib/agent/agents.js', () => ({
  getAgentDefinition: () => ({ title: '审阅', model: 'fixture' }), getToolsForAgent: () => [], applySessionToolPolicy: () => [],
}))
vi.mock('../../api/lib/agent2-feature-flags.js', () => ({ resolveAgent2FeatureFlags: () => ({}) }))
vi.mock('../../api/lib/agent/tool-authority.js', () => ({ intersectToolAuthority: () => [], snapshotToolAuthority: () => new Map() }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: {} }))
import { runSubagentInline, type SubagentInlineParams } from '../../api/lib/agent/subagent-runner.js'

const params = (signal = new AbortController().signal): SubagentInlineParams => ({
  subagentCallId: 'same-call', subtaskRunId: 'same-child', name: '子任务', role: 'quality', triggerCondition: '本章', prompt: '审阅本章', task: '原任务',
  mode: 'review', parentRunId: 'same-parent', sessionId: 'same-session', userId: 'user', novelId: 'novel', chapterId: 'chapter', messageId: 'message',
  modelRuntime: { tier: 'speed', multiplierBps: 0, provider: 'fixture', reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: 16000 },
  bus: { emit: vi.fn() }, toolContextBase: { userId: 'user', novelId: 'novel', runId: 'same-parent', sessionId: 'same-session', chapterId: 'chapter',
    mode: 'review', creativeFreedom: 'balanced', qualityMode: 'premium', emit: vi.fn(), signal, toolAuthority: new Map() }, sessionPolicy: null,
})
const usage = { promptTokens: 1000000, completionTokens: 100, totalTokens: 1000100 }
beforeEach(() => vi.clearAllMocks())

it('keeps one progressing child beyond old 24 turns / 16000 tokens without a budget-summary request', async () => {
  let call = 0
  mocks.chat.mockImplementation(async () => ({ content: call >= 30 ? '依据真实已保存内容完成审阅。' : '', reasoning: '', usage,
    toolCalls: call++ >= 30 ? [] : [{ id: `tool-${call}`, name: 'chapter_read', arguments: '{}' }] }))
  mocks.tool.mockImplementation(async () => ({ observation: `正文证据${call}`, part: {
    type: 'tool-call', callId: `tool-${call}`, toolName: 'chapter_read', title: '读取章节', status: 'success', args: {}, summary: '读取真实内容',
  } }))
  const result = await runSubagentInline(params())
  expect(result).toMatchObject({ ok: true, denied: false, turns: 31, toolCallCount: 30 })
  expect(result.usage.totalTokens).toBe(31 * usage.totalTokens)
  expect(mocks.chat).toHaveBeenCalledTimes(31)
  expect(mocks.chat.mock.calls.every(([request]) => request.usageLog.targetId === 'same-child' && request.usageLog.agentRunId === 'same-parent')).toBe(true)
})

it('keeps the existing research report-ID-only boundary without another paid formatting call', async () => {
  let call = 0
  mocks.chat.mockImplementation(async () => ({ content: '', reasoning: '', usage,
    toolCalls: [{ id: `report-${++call}`, name: 'quality_report_get', arguments: '{}' }] }))
  mocks.tool.mockImplementation(async () => ({ observation: `新报告ID-${call}`, part: {
    type: 'tool-call', callId: `report-${call}`, toolName: 'quality_report_get', title: '读取报告', status: 'success', args: {}, summary: '同一正文',
  } }))
  const result = await runSubagentInline({ ...params(), role: 'research' })
  expect(result).toMatchObject({ ok: false, turns: 4, toolCallCount: 4 })
  expect(result.report).toContain('尚未完成')
  expect(mocks.chat).toHaveBeenCalledTimes(4)
})

it('preserves cancellation before dispatch instead of declaring completion', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(runSubagentInline(params(controller.signal))).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.chat).not.toHaveBeenCalled()
})

it.each(['continuity', 'quality', 'lore'] as const)('lets the %s reporting role finish after more than four unchanged body reads', async role => {
  let call = 0
  const body = '本章人物一直在门外等候，没有进入。', report = '核验报告：当前正文只记载门外等候，未将进入写成已经发生。'
  mocks.chat.mockImplementation(async () => {
    const current = ++call
    return { content: current > 8 ? report : '', reasoning: '', usage,
      toolCalls: current > 8 ? [] : [{ id: 'same-read-' + current, name: 'chapter_read', arguments: '{}' }] }
  })
  mocks.tool.mockImplementation(async () => ({ observation: body, part: {
    type: 'tool-call', callId: 'same-read-' + call, toolName: 'chapter_read', title: '读取章节', status: 'success', args: {}, summary: '同一已保存正文',
  } }))
  const result = await runSubagentInline({ ...params(), role })
  expect(result).toMatchObject({ ok: true, denied: false, report, turns: 9, toolCallCount: 8 })
  expect(result.usage.totalTokens).toBe(9 * usage.totalTokens)
  expect(mocks.chat).toHaveBeenCalledTimes(9)
  for (const [request] of mocks.chat.mock.calls) {
    expect(request).toMatchObject({ provider: 'fixture', reasoningEffort: 'high',
      usageLog: { targetId: 'same-child', agentRunId: 'same-parent', multiplierBps: 0 } })
    expect(request.signal).toBeInstanceOf(AbortSignal)
  }
  expect(mocks.chat.mock.calls.at(-1)![0].messages.filter((message: { role: string }) => message.role === 'tool')).toHaveLength(8)
})

it('preserves cancellation after unchanged reads beyond the former writing cutoff', async () => {
  const controller = new AbortController(); let call = 0
  mocks.chat.mockImplementation(async () => ({ content: '', reasoning: '', usage,
    toolCalls: [{ id: 'read-' + ++call, name: 'chapter_read', arguments: '{}' }] }))
  mocks.tool.mockImplementation(async () => {
    if (call === 6) controller.abort()
    return { observation: '同一正文', part: { type: 'tool-call', callId: 'read-' + call, toolName: 'chapter_read', title: '读取', status: 'success', args: {}, summary: '同一正文' } }
  })
  await expect(runSubagentInline(params(controller.signal))).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.chat).toHaveBeenCalledTimes(6); expect(mocks.tool).toHaveBeenCalledTimes(6)
})

it('returns the actual unknown provider failure without another request or a success report', async () => {
  let call = 0
  mocks.chat.mockImplementation(async () => {
    if (++call === 7) throw Error('original provider result unknown')
    return { content: '', reasoning: '', usage, toolCalls: [{ id: 'read-' + call, name: 'chapter_read', arguments: '{}' }] }
  })
  mocks.tool.mockImplementation(async () => ({ observation: '同一正文', part: {
    type: 'tool-call', callId: 'read-' + call, toolName: 'chapter_read', title: '读取', status: 'success', args: {}, summary: '同一正文' } }))
  const result = await runSubagentInline(params())
  expect(result).toMatchObject({ ok: false, denied: false, turns: 7, toolCallCount: 6 })
  expect(result.report).toContain('original provider result unknown')
  expect(result.usage.totalTokens).toBe(6 * usage.totalTokens)
  expect(mocks.chat).toHaveBeenCalledTimes(7)
})

it('retains the actual model context window before dispatching an oversized original task', async () => {
  const input = params(); input.task = '原始任务上下文。'.repeat(20000)
  const result = await runSubagentInline(input)
  expect(result).toMatchObject({ ok: false, denied: false, toolCallCount: 0 })
  expect(result.report).toContain('上下文')
  expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.tool).not.toHaveBeenCalled()
  expect(result.usage.totalTokens).toBe(0)
})
