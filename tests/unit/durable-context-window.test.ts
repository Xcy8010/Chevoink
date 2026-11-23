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
