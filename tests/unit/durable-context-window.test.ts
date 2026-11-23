import { beforeEach, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../api/lib/ai-service.js'
import { estimateChatMessagesTokens } from '../../api/lib/agent/context-budget.js'
import { advanceDurableContext } from '../../api/lib/agent/runtime-checkpoint-step.js'
import type { RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'
import { executionContextReadTool } from '../../api/lib/agent/tools/task-context-tools.js'
import { toOpenAIParameters } from '../../api/lib/agent/tool-schema.js'

const db = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), archive: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-state.js', () => ({ readExecutionStateInTransaction: db.read, saveExecutionStateInTransaction: db.save }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({
  withRunLease: (_lease: unknown, work: (tx: unknown) => unknown) => work({ agentExecutionOutbox: { create: db.archive } }),
}))
const token = { runId: 'run', taskRootId: 'root' } as RunLeaseToken
const messages: ChatMessage[] = [{ role: 'user', content: '保留作者要求' }]
for (let i = 0; i < 3; i++) {
  messages.push({ role: 'assistant', content: '', toolCalls: [{ id: String(i), name: 'chapter_read', arguments: '{}' }] },
    { role: 'tool', toolCallId: String(i), content: '章'.repeat(9000) })
}
const tokens = estimateChatMessagesTokens(messages)
const budget = { contextWindowTokens: 32000, hardLimit: 30000, compactAtTokens: 24960, estimate: estimateChatMessagesTokens, canReadArchive: true }
beforeEach(() => {
  vi.clearAllMocks()
  const name = executionContextReadTool.name
  db.read.mockResolvedValue({ frame: { revision: 2, snapshotHash: 'f'.repeat(64), state: { phase: 'idle', messages } },
    configuration: { tools: [{ function: { name, parameters: toOpenAIParameters(executionContextReadTool.parameters) } }],
      toolAuthority: [{ name, permission: 'allow', alwaysConfirm: false }] } })
  db.save.mockImplementation((_tx, _lease, input) => ({ revision: 3, snapshotHash: 'e'.repeat(64), state: input.snapshot }))
})

it.each(['success', 'invalid quote', 'stale frame', 'under trigger'] as const)('handles a semantic-only pressure boundary: %s', async scenario => {
  const older: ChatMessage = { role: 'assistant', historySourceId: 'm1:text', content: '保留版本甲。' + '文'.repeat(20_000) }
  const author: ChatMessage = { role: 'user', content: '请在当前版本上继续，保持结局。' }
  const original = [older, author]
  const fixture = { frame: { revision: 2, snapshotHash: 'f'.repeat(64), state: { phase: 'idle', messages: original } },
    configuration: { tools: [], toolAuthority: [] }, head: { configurationHash: 'c'.repeat(64) } }
  db.read.mockResolvedValue(fixture)
  const summarize = vi.fn(async () => {
    if (scenario === 'stale frame') db.read.mockResolvedValue({ ...fixture, frame: { ...fixture.frame, revision: 3 } })
    return JSON.stringify({ notes: [{ source: 1, quote: scenario === 'invalid quote' ? '不存在的新内容' : '保留版本甲。' }] })
  })
  const request = advanceDurableContext(token, { ...budget, compactAtTokens: scenario === 'under trigger' ? 30_000 : 18_000, canReadArchive: false, summarize })
  if (scenario === 'stale frame') await expect(request).rejects.toMatchObject({ code: 'RUNTIME_STATE_CONFLICT' })
  else if (scenario === 'success') {
    const result = await request
    expect(result?.state.messages).toEqual([{ role: 'user', content: expect.stringContaining('保留版本甲。') }, author])
    expect(db.archive).toHaveBeenCalledWith({ data: expect.objectContaining({ payload: expect.objectContaining({
      archivedRounds: 0, beforeTokens: estimateChatMessagesTokens(original), afterTokens: estimateChatMessagesTokens(result!.state.messages),
      historyDigest: expect.objectContaining({ sourceIds: ['m1:text'] }),
    }) }) })
  } else expect(await request).toBeNull()
  expect(summarize).toHaveBeenCalledTimes(scenario === 'under trigger' ? 0 : 1)
  expect(db.save).toHaveBeenCalledTimes(scenario === 'success' ? 1 : 0)
  expect(original[0]).toBe(older)
})

it.each(['invalid', 'valid-but-too-long', 'unavailable', 'unknown'] as const)('uses exact history pointers at the hard limit with a %s summary', async outcome => {
  const author: ChatMessage = { role: 'user', content: '作者的约束保持完整。' }
  const completeSentence = '初稿'.repeat(900) + '。'
  const older: ChatMessage = { role: 'assistant', historySourceId: 'm1:text', content: completeSentence.repeat(10) }
  const original = [older, author]
  const fixture = await db.read()
  db.read.mockResolvedValue({ ...fixture, head: { configurationHash: 'c'.repeat(64) },
    frame: { ...fixture.frame, state: { phase: 'idle', messages: original } } })
  const summarize = vi.fn(async () => {
    if (outcome === 'unknown') throw new Error('派发结果未知')
    if (outcome === 'valid-but-too-long') return JSON.stringify({ notes: [{ source: 1, quote: completeSentence }] })
    return '{"notes":[{"source":1,"quote":"捏造内容"}]}'
  })
  const hardLimit = outcome === 'valid-but-too-long' ? 600 : 10_000
  const request = advanceDurableContext(token, { ...budget, hardLimit, compactAtTokens: hardLimit, canReadArchive: false,
    ...(outcome !== 'unavailable' ? { summarize } : {}) })
  if (outcome === 'unknown') {
    await expect(request).rejects.toThrow('派发结果未知')
    expect(db.save).not.toHaveBeenCalled()
  } else {
    const result = await request
    expect(result?.state.messages).toEqual([{ role: 'user', content: expect.stringContaining('m1') }, author])
    expect(db.archive.mock.calls[0][0].data.payload.historyDigest).toBeUndefined()
    expect(estimateChatMessagesTokens(result!.state.messages)).toBeLessThan(hardLimit)
  }
  expect(original).toEqual([older, author])
})

it('can release optional reading material without an archive reader, but never changes a prepared request', async () => {
  const content = '〔材料标题相同的作者原话〕' + '文'.repeat(600)
  const author = { role: 'user' as const, content }
  const optional = { ...author, sessionReadingMaterial: true as const }
  const fixture = { frame: { revision: 2, snapshotHash: 'f'.repeat(64), state: { phase: 'awaiting_operation', messages: [optional, author] } },
    configuration: { tools: [], toolAuthority: [] } }
  db.read.mockResolvedValue(fixture)
  const actualBudget = { ...budget, hardLimit: 1500, compactAtTokens: 1500, canReadArchive: false,
    estimate: (items: ChatMessage[]) => estimateChatMessagesTokens(items) + 300 }
  expect(await advanceDurableContext(token, actualBudget)).toBeNull()
  expect(db.save).not.toHaveBeenCalled()
  db.read.mockResolvedValue({ ...fixture, frame: { ...fixture.frame, state: { ...fixture.frame.state, phase: 'idle' } } })
  const next = await advanceDurableContext(token, actualBudget)
  expect(next?.state.messages).toEqual([author])
  expect(fixture.frame.state.messages).toEqual([optional, author])
  expect(db.archive).toHaveBeenCalledWith({ data: expect.objectContaining({ payload: expect.objectContaining({
    beforeTokens: actualBudget.estimate([optional, author]), afterTokens: actualBudget.estimate([author]), releasedReadingMaterials: 1,
  }) }) })
})

it('compacts the projected request once and retains the author and latest tool result', async () => {
  const next = await advanceDurableContext(token, budget)
  expect(next?.state.messages[0]).toEqual(messages[0])
  expect(next?.state.messages.at(-1)).toEqual(messages.at(-1))
  expect(estimateChatMessagesTokens(next!.state.messages)).toBeLessThan(budget.compactAtTokens)
  expect(db.archive).toHaveBeenCalledWith({ data: expect.objectContaining({ payload: expect.objectContaining({
    beforeTokens: tokens, afterTokens: estimateChatMessagesTokens(next!.state.messages), reason: 'window',
    compactAtTokens: budget.compactAtTokens, contextWindowTokens: budget.contextWindowTokens,
  }) }) })
  expect(messages).toHaveLength(7)
})

it('releases excerpts and archives old rounds together with pointers into the original frame', async () => {
  const optional = { role: 'user' as const, content: '旧章'.repeat(6000), sessionReadingMaterial: true as const }
  const original = [optional, ...messages]
  const fixture = await db.read()
  db.read.mockResolvedValue({ ...fixture, frame: { ...fixture.frame, state: { phase: 'idle', messages: original } } })
  const actualBudget = { ...budget, compactAtTokens: 38000, hardLimit: 38000 }
  const next = await advanceDurableContext(token, actualBudget)
  expect(estimateChatMessagesTokens(next!.state.messages)).toBeLessThanOrEqual(38000 * 0.45)
  expect(next!.state.messages[0]).toEqual(messages[0])
  expect(next!.state.messages.at(-1)).toEqual(messages.at(-1))
  const receipt = String(next!.state.messages[1].content)
  const { references } = JSON.parse(receipt.split('\n').at(-1)!)
  expect(references).toEqual([2, 3].map(messageIndex => ({ revision: 2, hash: 'f'.repeat(64), messageIndex })))
  expect(original[references[1].messageIndex]).toEqual(messages[2])
  expect(db.archive).toHaveBeenCalledOnce()
})

it('keeps an intact frame below the trigger, without a reader, or for a negligible projected saving', async () => {
  expect(await advanceDurableContext(token, { ...budget, compactAtTokens: tokens + 1 })).toBeNull()
  expect(await advanceDurableContext(token, { ...budget, canReadArchive: false })).toBeNull()
  const estimate = (candidate: ChatMessage[]) => candidate.length === messages.length ? tokens : tokens - 1
  expect(await advanceDurableContext(token, { ...budget, compactAtTokens: tokens, estimate })).toBeNull()
  expect(db.save).not.toHaveBeenCalled()
  expect(db.archive).not.toHaveBeenCalled()
})

it('does not archive a model request merely because its stored frame exceeds the byte-level maintenance watermark', async () => {
  const large = Array.from({ length: 12 }, (_, index): ChatMessage[] => [
    { role: 'assistant', content: '', toolCalls: [{ id: String(index), name: 'chapter_read', arguments: '{}' }] },
    { role: 'tool', toolCallId: String(index), content: 'x'.repeat(24_000) },
  ]).flat()
  const fixture = await db.read()
  db.read.mockResolvedValue({ ...fixture, frame: { ...fixture.frame, state: { phase: 'idle', messages: large } } })
  expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(256 * 1024)
  expect(estimateChatMessagesTokens(large)).toBeLessThan(228_000)
  expect(await advanceDurableContext(token, { ...budget, contextWindowTokens: 258000, compactAtTokens: 228000, hardLimit: 228000 })).toBeNull()
  expect(db.archive).not.toHaveBeenCalled()
})
