import { expect, it, vi } from 'vitest'
import type { AgentExecutionOutbox } from '@prisma/client'
import type { RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import { persistProjectedMessages, projectExecutionFrame } from '../../api/lib/agent/runtime-frame-events.js'
import { readExecutionFrame, readExecutionStateInTransaction } from '../../api/lib/agent/runtime-state.js'
import { readCurrentSavedTaskChapters } from '../../api/lib/agent/saved-chapter-work.js'
import { readWritingPresentation } from '../../api/lib/agent/writing-request-context.js'

const returned = '先比较人物动机。\\n调用 chapter_read，chapterId=target。\n\n保持完整返回文本。'
vi.mock('../../api/lib/agent/runtime-state.js', () => ({
  readExecutionFrame: vi.fn(async (_tx: unknown, _root: string, revision: number) => ({ revision, snapshotHash: 'frame',
    state: revision === 1 ? { phase: 'awaiting_operation', pendingOperationId: 'provider', messages: [] }
      : { phase: 'idle', turn: 1, messages: [{ role: 'assistant', content: '结果正文。', reasoning: returned, privateContext: 'hidden context', providerResponse: { apiKey: 'hidden key' } }] } })),
  readExecutionStateInTransaction: vi.fn(async () => ({})),
}))
vi.mock('../../api/lib/agent/runtime-review-deferral.js', () => ({ projectReviewWriteDeferral: vi.fn(async () => null) }))
vi.mock('../../api/lib/agent/saved-chapter-work.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/saved-chapter-work.js')>(), readCurrentSavedTaskChapters: vi.fn(),
}))
vi.mock('../../api/lib/agent/writing-request-context.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/writing-request-context.js')>(), readWritingPresentation: vi.fn(),
}))

it.each([false, true])('projects and saves manuscript delivery with explicit full-text preference %s', async fullText => {
  const chapter = { id: 'chapter', title: '渡口', orderIndex: 1, revision: 2,
    content: '傍晚，守夜人从小船上跳下来。\n\n他把船票翻过来，认出了发信人的字迹。', contentHash: 'hash', sourceHash: 'proof' }
  const recap = '- **剧情推进** 渡口的旧线索有了新的指向。\n\n需要我先检查下一章的衔接吗？'
  const candidate = { role: 'assistant', content: `${recap}\n\n${chapter.content}` }
  const prior = [{ role: 'assistant', content: null, toolCalls: [{ id: 'write', name: 'chapter_write', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'write', content: '章节已保存。' }]
  vi.mocked(readExecutionFrame)
    .mockResolvedValueOnce({ revision: 2, snapshotHash: 'frame', state: { phase: 'idle', turn: 1, messages: [...prior, candidate] } } as Awaited<ReturnType<typeof readExecutionFrame>>)
    .mockResolvedValueOnce({ revision: 1, snapshotHash: 'prev', state: { phase: 'awaiting_operation', messages: prior } } as Awaited<ReturnType<typeof readExecutionFrame>>)
  vi.mocked(readExecutionStateInTransaction).mockResolvedValueOnce({ root: { userId: 'author', novelId: 'novel' } } as Awaited<ReturnType<typeof readExecutionStateInTransaction>>)
  vi.mocked(readCurrentSavedTaskChapters).mockResolvedValueOnce([chapter])
  vi.mocked(readWritingPresentation).mockResolvedValueOnce(fullText ? { mode: 'full_text', sourceRunId: 'run', sourceMessageId: 'author-message' } : null)
  const upsert = vi.fn()
  const tx = { agentMessage: { findUnique: vi.fn(async () => null), upsert } } as unknown as RuntimeTx
  const source: AgentExecutionOutbox = { id: 'source', taskRootId: 'root', runId: 'run', operationId: null, sequence: 1n,
    type: 'execution.state.saved', eventKey: 'state:root:2', payload: { revision: 2, snapshotHash: 'frame', previousHash: null },
    createdAt: new Date(10), publishedAt: null }
  const events = await projectExecutionFrame(tx, source)
  const text = fullText ? candidate.content : recap
  expect(events).toEqual([{ type: 'text.final', messageId: expect.any(String), text, asReasoning: false }])
  await persistProjectedMessages(tx, source, 'session', events)
  expect(upsert.mock.calls[0][0].create.parts).toEqual([{ type: 'text', text }])
  expect(candidate.content).toContain(chapter.content)
})

it('projects and saves only full returned reasoning from a committed provider frame', async () => {
  const upsert = vi.fn()
  const tx = { agentMessage: { findUnique: vi.fn(async () => null), upsert } } as unknown as RuntimeTx
  const source: AgentExecutionOutbox = { id: 'source', taskRootId: 'root', runId: 'run', operationId: null, sequence: 1n,
    type: 'execution.state.saved', eventKey: 'state:root:2', payload: { revision: 2, snapshotHash: 'frame', previousHash: null },
    createdAt: new Date(10), publishedAt: null }
  const events = await projectExecutionFrame(tx, source)
  expect(events).toEqual([
    { type: 'reasoning.delta', messageId: expect.any(String), delta: returned },
    { type: 'text.final', messageId: expect.any(String), text: '结果正文。', asReasoning: false },
  ])
  await persistProjectedMessages(tx, source, 'session', events.slice(0, 1))
  expect(upsert.mock.calls[0][0].create.parts).toEqual([{ type: 'reasoning', text: returned }])
  expect(JSON.stringify(events)).not.toMatch(/privateContext|providerResponse|hidden context|hidden key/)
})

it('projects an ordinary model turn into separate activity metadata and literal prose', async () => {
  const title = '核对老周的出场时间'
  const text = '前文把这次会面放在了雨停之后。'
  const raw = `<activity-title>${title}</activity-title>\n${text}`
  const toolCalls = [{ id: 'lookup', name: 'chapter_read', arguments: '{"chapterId":"chapter"}' }]
  vi.mocked(readExecutionFrame).mockResolvedValueOnce({
    revision: 2, snapshotHash: 'frame', state: { phase: 'idle', turn: 1, messages: [{ role: 'assistant', content: raw, toolCalls }] },
  } as Awaited<ReturnType<typeof readExecutionFrame>>)
  const rows = new Map<string, { parts: unknown; role: string; sessionId: string; run: { taskRootId: string } }>()
  const tx = { agentMessage: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
    upsert: vi.fn(async ({ where, create }: { where: { id: string }; create: { parts: unknown; role: string; sessionId: string } }) =>
      rows.set(where.id, { ...create, run: { taskRootId: 'root' } })),
  } } as unknown as RuntimeTx
  const source: AgentExecutionOutbox = { id: 'title-source', taskRootId: 'root', runId: 'run', operationId: null, sequence: 1n,
    type: 'execution.state.saved', eventKey: 'state:root:2', payload: { revision: 2, snapshotHash: 'frame', previousHash: null },
    createdAt: new Date(20), publishedAt: null }
  const events = await projectExecutionFrame(tx, source)
  expect(events).toEqual([
    { type: 'activity.title', messageId: expect.any(String), title },
    { type: 'text.final', messageId: expect.any(String), text, asReasoning: false },
  ])
  await persistProjectedMessages(tx, source, 'session', events)
  await persistProjectedMessages(tx, source, 'session', events)
  expect([...rows.values()].map(row => row.parts)).toEqual([[{ type: 'activity-title', title }, { type: 'text', text }]])
  expect(toolCalls).toEqual([{ id: 'lookup', name: 'chapter_read', arguments: '{"chapterId":"chapter"}' }])
})

it('publishes a verified tool-free reply containing the literal marker without interpreting it', async () => {
  const text = '<activity-title>保留这段文字</activity-title>'
  vi.mocked(readExecutionFrame).mockResolvedValueOnce({
    revision: 2, snapshotHash: 'frame', state: { phase: 'idle', turn: 1, messages: [{ role: 'assistant', content: text }] },
  } as Awaited<ReturnType<typeof readExecutionFrame>>)
  const upsert = vi.fn()
  const tx = { agentMessage: { findUnique: vi.fn(async () => null), upsert } } as unknown as RuntimeTx
  const source: AgentExecutionOutbox = { id: 'literal-source', taskRootId: 'root', runId: 'run', operationId: null, sequence: 1n,
    type: 'execution.state.saved', eventKey: 'state:root:2', payload: { revision: 2, snapshotHash: 'frame', previousHash: null },
    createdAt: new Date(20), publishedAt: null }
  const events = await projectExecutionFrame(tx, source)
  expect(events).toEqual([{ type: 'text.final', messageId: expect.any(String), text, asReasoning: false }])
  await persistProjectedMessages(tx, source, 'session', events)
  expect(upsert.mock.calls[0][0].create.parts).toEqual([{ type: 'text', text }])
})

it('recovers only final prose from a committed post-tool frame, without changing the raw provider frame', async () => {
  const text = '雁船在第二章离岸。'
  const raw = '<activity-title>交付核对结果</activity-title>\n' + text
  const before = [
    { role: 'assistant', content: null, toolCalls: [{ id: 'read', name: 'chapter_read', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'read', content: '合成章节。' },
  ]
  const current = { role: 'assistant', content: raw, reasoning: returned }
  type Frame = Awaited<ReturnType<typeof readExecutionFrame>>
  const frames = [
    { revision: 2, snapshotHash: 'frame', state: { phase: 'idle', turn: 2, messages: [...before, current] } } as Frame,
    { revision: 1, snapshotHash: 'frame', state: { phase: 'awaiting_operation', turn: 2, pendingOperationId: 'provider', messages: before } } as Frame,
  ]
  type Saved = { parts: unknown; role: string; sessionId: string; run: { taskRootId: string } }
  let saved: Saved | null = null
  const tx = { agentMessage: {
    findUnique: vi.fn(async () => saved),
    upsert: vi.fn(async ({ create }: { create: Omit<Saved, 'run'> }) => {
      saved = { ...create, run: { taskRootId: 'root' } }
    }),
  } } as unknown as RuntimeTx
  const source = { taskRootId: 'root', runId: 'run', type: 'execution.state.saved', eventKey: 'state:root:2',
    payload: { revision: 2, snapshotHash: 'frame', previousHash: null }, createdAt: new Date() } as AgentExecutionOutbox
  for (let count = 0; count < 2; count++) {
    for (const frame of frames) vi.mocked(readExecutionFrame).mockResolvedValueOnce(frame)
    const events = await projectExecutionFrame(tx, source)
    expect(events).toEqual([
      { type: 'reasoning.delta', messageId: expect.any(String), delta: returned },
      { type: 'text.final', messageId: expect.any(String), text, asReasoning: false },
    ])
    // A state frame is projected more than once under recovery, while the outbox
    // publishes it once. Its persisted author text contains only the prose.
    if (count === 0) await persistProjectedMessages(tx, source, 'session', events)
  }
  expect(saved).toMatchObject({ parts: [{ type: 'reasoning', text: returned }, { type: 'text', text }] })
  expect(current.content).toBe(raw)
})

it.each([
  [undefined, 'chapter_read', null],
  ['chapter_read', 'memory_search', '<activity-title>核对前章</activity-title>'],
  ['chapter_read', 'plan_save', '<activity-title>核对前章</activity-title>'],
] as const)('keeps every silent durable tool round silent: %s → %s', async (prior, name, priorText) => {
  const before = prior ? [{ role: 'assistant', content: priorText, toolCalls: [{ id: 'prior', name: prior, arguments: '{}' }] },
    { role: 'tool', toolCallId: 'prior', content: '已经核对。' }] : []
  const current = { role: 'assistant', content: null, toolCalls: [{ id: 'next', name, arguments: '{}' }] }
  type Frame = Awaited<ReturnType<typeof readExecutionFrame>>
  vi.mocked(readExecutionFrame)
    .mockResolvedValueOnce({ revision: 2, snapshotHash: 'frame',
      state: { phase: 'idle', turn: 2, messages: [...before, current] } } as Frame)
    .mockResolvedValueOnce({ revision: 1, snapshotHash: 'frame',
      state: { phase: 'awaiting_operation', turn: 2, pendingOperationId: 'provider', messages: before } } as Frame)
  const tx = {} as RuntimeTx
  const source = { taskRootId: 'root', runId: 'run', type: 'execution.state.saved', eventKey: 'state:root:2',
    payload: { revision: 2, snapshotHash: 'frame', previousHash: null } } as AgentExecutionOutbox
  const events = await projectExecutionFrame(tx, source)
  expect(events).toEqual([{ type: 'text.final', messageId: expect.any(String), text: '', asReasoning: false }])
  expect(current.content).toBeNull()
})
