import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const mocks = vi.hoisted(() => ({
  getCreditSummary: vi.fn(),
  creditLedgerFindFirst: vi.fn(),
  creditLedgerFindMany: vi.fn(),
  novelFindMany: vi.fn(),
  sessionUpdateMany: vi.fn(),
}))

vi.mock('../../api/lib/credits.js', () => ({ getCreditSummary: mocks.getCreditSummary }))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message)
    }
  },
  prisma: {
    creditLedgerEntry: {
      findFirst: mocks.creditLedgerFindFirst,
      findMany: mocks.creditLedgerFindMany,
    },
    novel: { findMany: mocks.novelFindMany },
    agentSession: { updateMany: mocks.sessionUpdateMany },
  },
}))

import {
  accountCreditHistoryTool,
  accountCreditsTool,
  accountNovelsTool,
  sessionRenameTool,
} from '../../api/lib/agent/tools/account-tools.js'

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  userId: 'user-1',
  novelId: 'novel-1',
  runId: 'run-1',
  sessionId: 'session-1',
  chapterId: null,
  callId: 'call-1',
  mode: 'build',
  creativeFreedom: 'stable',
  qualityMode: 'premium',
  signal: new AbortController().signal,
  emit: vi.fn(),
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getCreditSummary.mockResolvedValue({ totalRemaining: 12.5, models: [] })
  mocks.creditLedgerFindFirst.mockResolvedValue(null)
  mocks.creditLedgerFindMany.mockResolvedValue([])
  mocks.novelFindMany.mockResolvedValue([])
  mocks.sessionUpdateMany.mockResolvedValue({ count: 1 })
})

describe('account agent tools', () => {
  it('reads credits through the current user scope without changing the account', async () => {
    const result = await accountCreditsTool.execute(context(), {})

    expect(mocks.getCreditSummary).toHaveBeenCalledWith('user-1', expect.anything())
    expect(JSON.parse(result.output)).toMatchObject({ totalRemaining: 12.5 })
  })

  it('limits the novel listing to the current user and paginates by returned count', async () => {
    mocks.novelFindMany.mockResolvedValue([
      { id: 'novel-2', title: 'Owned', displayTitle: null, status: 'draft', wordCount: 3, chapterCount: 1, updatedAt: new Date('2026-01-02') },
    ])

    const result = await accountNovelsTool.execute(context(), { offset: 2, limit: 20 })

    expect(mocks.novelFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { authorId: 'user-1' },
      skip: 2,
      take: 20,
    }))
    expect(JSON.parse(result.output)).toMatchObject({ items: [{ id: 'novel-2' }], nextOffset: null })
  })

  it('rejects a credit cursor that exists for another user before reading the page', async () => {
    mocks.creditLedgerFindFirst.mockResolvedValue(null)

    await expect(accountCreditHistoryTool.execute(context(), { cursor: 'foreign-entry', limit: 2 }))
      .rejects.toMatchObject({ status: 404, code: 'TOOL_READ_NOT_FOUND' })

    expect(mocks.creditLedgerFindFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-entry', userId: 'user-1' },
      select: { id: true, createdAt: true },
    })
    expect(mocks.creditLedgerFindMany).not.toHaveBeenCalled()
  })

  it('uses createdAt and id together for stable same-time credit pagination', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z')
    mocks.creditLedgerFindFirst.mockResolvedValue({ id: 'entry-b', createdAt })
    mocks.creditLedgerFindMany.mockResolvedValue([
      { id: 'entry-a', deltaMilli: -1250, kind: 'usage', sourceType: 'text', modelTier: 'speed', requestTokens: 1, responseTokens: 2, createdAt },
    ])

    const result = await accountCreditHistoryTool.execute(context(), { cursor: 'entry-b', limit: 2 })

    expect(mocks.creditLedgerFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        userId: 'user-1',
        OR: [
          { createdAt: { lt: createdAt } },
          { createdAt, id: { lt: 'entry-b' } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 2,
    }))
    expect(JSON.parse(result.output).entries[0]).toMatchObject({ id: 'entry-a', credits: -1.25 })
  })

  it('updates only the current user/session/novel and keeps the write scoped', async () => {
    await sessionRenameTool.execute(context(), { title: '新任务名' })

    expect(mocks.sessionUpdateMany).toHaveBeenCalledWith({
      where: { id: 'session-1', userId: 'user-1', novelId: 'novel-1' },
      data: { title: '新任务名' },
    })
  })

  it('does not write when session rename is cancelled', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(sessionRenameTool.execute(context({ signal: controller.signal }), { title: '不会写入' }))
      .rejects.toThrow()

    expect(mocks.sessionUpdateMany).not.toHaveBeenCalled()
  })
})
