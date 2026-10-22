import type { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { observePlatformNovel } from '../../api/lib/agent/tools/platform-observation.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const scope = { userId: 'owner', novelId: 'owned-novel', sessionId: 'original-session', runId: 'resumed-run', signal: new AbortController().signal } as ToolContext
type Action = Parameters<typeof observePlatformNovel>[1]
function history(action: Action, args: Record<string, unknown>, charged = true) {
  const effective = action === 'platform_novel_read' ? { novelId: args.novelId, chapterId: args.chapterId ?? null, offset: args.offset ?? 0, limit: args.limit ?? 6000 } : args
  const inputSnapshot = { kind: 'tool', action, input: { callId: 'old-call', args } }
  const result = { toolResult: { output: 'Saved original observation', platformBudget: { version: 1, charged, requestHash: runtimeJson({ action, args: effective }).hash } } }
  const resultHash = runtimeJson(result).hash
  return { id: 'original-operation', inputSnapshot, inputHash: runtimeJson(inputSnapshot).hash,
    effectReceipt: { result, resultHash }, events: [{ taskRootId: 'original-root', eventKey: 'effect:original-operation', payload: { operationId: 'original-operation', resultHash } }] }
}
function client(rows: ReturnType<typeof history>[] = [], owned = true) {
  const tx = { agentRun: { findFirst: vi.fn().mockResolvedValue(owned ? { taskRootId: 'original-root' } : null) },
    agentOperation: { findMany: vi.fn().mockResolvedValue(rows) } }
  return { tx: tx as unknown as Prisma.TransactionClient, queries: tx }
}

describe('original-root platform observations', () => {
  it('stores a charged observation only after a successful current DB read', async () => {
    const { tx, queries } = client(), read = vi.fn().mockResolvedValue({ output: 'Current public result' })
    expect(await observePlatformNovel(scope, 'platform_novel_search', { query: 'topic' }, read, tx))
      .toMatchObject({ output: 'Current public result', platformBudget: { version: 1, charged: true } })
    expect(read).toHaveBeenCalledOnce()
    expect(queries.agentOperation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { taskRootId: 'original-root', kind: 'tool', action: 'platform_novel_search', status: 'succeeded' } }))
  })
  it('reuses the original receipt after run replacement without spending another allowance', async () => {
    const { tx } = client([history('platform_novel_read', { novelId: 'public-book' })]), read = vi.fn()
    expect(await observePlatformNovel(scope, 'platform_novel_read', { novelId: 'public-book', offset: 0, limit: 6000 }, read, tx))
      .toMatchObject({ output: expect.stringContaining('已保存'), platformBudget: { charged: false } })
    expect(read).not.toHaveBeenCalled()
  })
  it.each([['platform_novel_search', 5], ['platform_novel_read', 8]] as const)('preserves the %s allowance across all original-root receipts', async (action, maximum) => {
    const args = (index: number) => action === 'platform_novel_search' ? { query: `topic-${index}` } : { novelId: `public-${index}` }
    const { tx } = client(Array.from({ length: maximum }, (_, index) => history(action, args(index))))
    const read = vi.fn()
    expect(await observePlatformNovel(scope, action, args(maximum), read, tx)).toMatchObject({ summary: expect.stringContaining('预算已用尽'), platformBudget: { charged: false } })
    expect(await observePlatformNovel(scope, action, args(0), read, tx)).toMatchObject({ platformBudget: { charged: false }, output: expect.stringContaining('Saved original observation') })
    expect(read).not.toHaveBeenCalled()
  })
  it('does not count previously reused observations as fresh reads', async () => {
    const rows = [history('platform_novel_search', { query: 'same' }), ...Array.from({ length: 9 }, () => history('platform_novel_search', { query: 'same' }, false))]
    const { tx } = client(rows), read = vi.fn().mockResolvedValue({ output: 'Fresh different result' })
    expect(await observePlatformNovel(scope, 'platform_novel_search', { query: 'different' }, read, tx)).toMatchObject({ platformBudget: { charged: true } })
    expect(read).toHaveBeenCalledOnce()
  })
  it.each(['result', 'input', 'request', 'event', 'duplicate-event'] as const)('rejects damaged %s without clearing the budget or rereading', async damaged => {
    const row = history('platform_novel_search', { query: 'saved' })
    if (damaged === 'result') row.effectReceipt.resultHash = '0'.repeat(64)
    if (damaged === 'input') row.inputHash = '0'.repeat(64)
    if (damaged === 'request') {
      row.effectReceipt.result.toolResult.platformBudget.requestHash = '0'.repeat(64)
      row.effectReceipt.resultHash = runtimeJson(row.effectReceipt.result).hash
      row.events[0].payload.resultHash = row.effectReceipt.resultHash
    }
    if (damaged === 'event') row.events[0].taskRootId = 'another-root'
    if (damaged === 'duplicate-event') row.events.push(row.events[0])
    const { tx } = client([row]), read = vi.fn()
    await expect(observePlatformNovel(scope, 'platform_novel_search', { query: 'new' }, read, tx)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(read).not.toHaveBeenCalled()
  })
  it('requires an owned durable run instead of adopting a caller-supplied budget', async () => {
    const { tx } = client([], false), read = vi.fn()
    await expect(observePlatformNovel(scope, 'platform_novel_search', { query: 'new' }, read, tx)).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    expect(read).not.toHaveBeenCalled()
  })
  it('does not read after cancellation', async () => {
    const { tx } = client(), read = vi.fn(), controller = new AbortController()
    controller.abort()
    await expect(observePlatformNovel({ ...scope, signal: controller.signal }, 'platform_novel_search', { query: 'new' }, read, tx)).rejects.toBeDefined()
    expect(read).not.toHaveBeenCalled()
  })
})
