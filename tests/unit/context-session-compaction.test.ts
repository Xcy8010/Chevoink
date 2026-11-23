import { beforeEach, expect, it, vi } from 'vitest'
import { compactSessionContext } from '../../api/lib/agent/context-engine.js'

const db = vi.hoisted(() => ({
  agentSession: { findFirst: vi.fn(async () => ({ id: 'session', novelId: 'book' })) },
  contextCheckpoint: { findFirst: vi.fn(async () => null), create: vi.fn() },
  userDirective: { findMany: vi.fn(async () => []) },
  agentMessage: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: db }))

beforeEach(() => {
  vi.clearAllMocks()
  db.$transaction.mockImplementation(work => work(db))
  db.agentMessage.findMany.mockResolvedValue(Array.from({ length: 42 }, (_, i) => ({
    id: `m-${i}`, runId: `r-${i}`, role: 'assistant', createdAt: new Date(i * 1000),
    parts: [{ type: 'text', text: '段'.repeat(6500) }],
    run: { status: i === 2 ? 'paused' : i === 36 ? 'running' : 'completed', outputSummary: `回执 ${i}` },
  })))
  db.contextCheckpoint.create.mockImplementation(async ({ data }) => ({ ...data, id: 'cp', createdAt: new Date() }))
})

it('shares concurrent compaction and keeps a contiguous, token-sized tail before the first open run', async () => {
  const [automatic, manual] = await Promise.all([
    compactSessionContext('user', 'session', 102600),
    compactSessionContext('user', 'session', true),
  ])
  expect(manual).toEqual(automatic)
  expect(db.contextCheckpoint.create).toHaveBeenCalledTimes(1)
  expect(automatic?.summary.completed).toContain('回执 3')
  expect(automatic?.summary.completed).not.toContain('回执 2')
  expect(automatic?.summary.completed).not.toContain('回执 37')
  const actual = (36 - automatic!.sourceMessageCount) * 6500 + automatic!.summaryTokens
  expect(actual).toBeGreaterThan(228000 * 0.4)
  expect(actual).toBeLessThan(228000 * 0.5)
})

it('reuses the published version if a concurrent worker already compacted a different slice', async () => {
  const winner = { id: 'winner', sessionId: 'session', version: 1, sourceHash: 'different-slice', createdAt: new Date() }
  db.contextCheckpoint.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(winner as never)
  expect(await compactSessionContext('user', 'session', true)).toMatchObject({ id: winner.id, version: 1 })
  expect(db.contextCheckpoint.create).not.toHaveBeenCalled()
})
