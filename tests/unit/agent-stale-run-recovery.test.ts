import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 运行期僵尸收敛看门狗（plan/15 缺陷收尾）：进程存活期间终态落库失败或执行器异常
// 退出的旧协议 run 会永远停在 queued/running，前端侧栏持续“执行中”转圈。
// 这里只验证扫描选择、内存执行器保护与容错语义，数据库事务行为由集成用例覆盖。
const mocks = vi.hoisted(() => ({
  findMany: vi.fn<(query: unknown) => Promise<Array<{ id: string; userId: string }>>>(async () => []),
  recoverLegacy: vi.fn(async (_userId: string, _runId: string) => true),
}))

vi.mock('../../api/lib/prisma.js', async original => ({
  ...await original<typeof import('../../api/lib/prisma.js')>(),
  prisma: { agentRun: { findMany: mocks.findMany } },
}))
vi.mock('../../api/lib/agent/runtime-lifecycle.js', async original => ({
  ...await original<typeof import('../../api/lib/agent/runtime-lifecycle.js')>(),
  recoverLegacyOrphanRun: mocks.recoverLegacy,
}))

import { recoverStaleLoopRuns } from '../../api/lib/agent/run-service.js'
import { registerActiveRun, deregisterActiveRun } from '../../api/lib/agent/active-runs.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findMany.mockResolvedValue([])
  mocks.recoverLegacy.mockResolvedValue(true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('stale protocol-zero run watchdog', () => {
  it('converges an executor-less stale run selected by the quiet-window filter', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'zombie', userId: 'author' }])
    await recoverStaleLoopRuns()
    expect(mocks.recoverLegacy).toHaveBeenCalledWith('author', 'zombie')
    const query = mocks.findMany.mock.calls[0][0] as { where: { status: { in: string[] }; updatedAt: { lt: Date } } }
    expect(query.where).toMatchObject({
      engine: 'loop', runtimeProtocolVersion: 0, taskRootId: null,
      status: { in: ['queued', 'running', 'awaiting_approval'] },
    })
    // 静谧窗口：仅收编 5 分钟未更新的行，避免与刚创建/刚退出的执行器竞态；
    // 真正的活跃判据是下方内存登记，等待审批的长挂起任务不会被误杀。
    const quietMs = Date.now() - query.where.updatedAt.lt.getTime()
    expect(quietMs).toBeGreaterThanOrEqual(5 * 60_000 - 1_000)
    expect(quietMs).toBeLessThanOrEqual(5 * 60_000 + 1_000)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('陈旧任务收敛'))
  })

  it('skips a stale-looking run whose executor is still registered in memory', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'live', userId: 'author' }, { id: 'zombie', userId: 'author' }])
    registerActiveRun('live', { controller: new AbortController(), sessionId: 'session', userId: 'author' })
    try {
      await recoverStaleLoopRuns()
      expect(mocks.recoverLegacy).toHaveBeenCalledTimes(1)
      expect(mocks.recoverLegacy).toHaveBeenCalledWith('author', 'zombie')
    } finally {
      deregisterActiveRun('live')
    }
  })

  it('never lets one failed recovery block the rest of the sweep', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'bad', userId: 'author' }, { id: 'good', userId: 'author' }])
    mocks.recoverLegacy.mockImplementationOnce(async () => { throw new Error('Transaction already closed') })
    await recoverStaleLoopRuns()
    expect(mocks.recoverLegacy).toHaveBeenCalledTimes(2)
    expect(mocks.recoverLegacy).toHaveBeenLastCalledWith('author', 'good')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('单条收敛失败'), expect.objectContaining({ runId: 'bad' }))
  })

  it('keeps the sweep retryable when the scan itself fails', async () => {
    mocks.findMany.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(recoverStaleLoopRuns()).resolves.toBeUndefined()
    expect(mocks.recoverLegacy).not.toHaveBeenCalled()
    // 防重入标志必须已在错误路径释放：下一轮周期扫描照常收敛
    mocks.findMany.mockResolvedValue([{ id: 'zombie', userId: 'author' }])
    await recoverStaleLoopRuns()
    expect(mocks.recoverLegacy).toHaveBeenCalledWith('author', 'zombie')
  })

  it('coalesces an overlapping sweep instead of scanning the database twice', async () => {
    let release!: (rows: Array<{ id: string; userId: string }>) => void
    mocks.findMany.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const first = recoverStaleLoopRuns()
    const second = recoverStaleLoopRuns()
    await expect(second).resolves.toBeUndefined()
    expect(mocks.findMany).toHaveBeenCalledTimes(1)
    release([{ id: 'zombie', userId: 'author' }])
    await first
    expect(mocks.recoverLegacy).toHaveBeenCalledWith('author', 'zombie')
    // 收尾后恢复可扫描状态
    mocks.findMany.mockResolvedValue([])
    await recoverStaleLoopRuns()
    expect(mocks.findMany).toHaveBeenCalledTimes(2)
  })
})
