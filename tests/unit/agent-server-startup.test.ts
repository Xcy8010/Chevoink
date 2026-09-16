import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ recover: vi.fn(), durable: vi.fn().mockResolvedValue([]), listen: vi.fn((_port: number, _host: string, ready: () => void) => { ready(); return { close: vi.fn() } }), schedules: vi.fn(), queue: vi.fn(), styleQueue: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../api/app.js', () => ({ default: { listen: mocks.listen } }))
vi.mock('../../api/config/env.js', () => ({ env: { port: 3001, serverUrl: 'test' } }))
vi.mock('../../api/lib/agent/run-service.js', () => ({ recoverOrphanLoopRuns: mocks.recover, recoverDurableLoopRuns: mocks.durable }))
vi.mock('../../api/lib/agent/productivity.js', () => ({ runDueAgentSchedules: mocks.schedules }))
vi.mock('../../api/lib/agent/request-queue.js', () => ({ dispatchQueuedRequests: mocks.queue }))
vi.mock('../../api/lib/agent/style-learning.js', () => ({ dispatchStyleLearning: mocks.styleQueue }))
vi.mock('../../api/lib/credits.js', () => ({ reconcileCreditRefunds: vi.fn().mockResolvedValue({ examined: 0, settled: 0 }), reconcileTokenSettlements: vi.fn().mockResolvedValue(undefined) }))
it('finishes orphan recovery before listening or launching scheduled/queued runs', async () => {
  let finish!: () => void
  mocks.recover.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  const starting = import('../../api/server.js')
  // 全量并发下动态 import 可能超过默认 1s 等待；放宽超时不改变「恢复先于监听/调度」的断言语义。
  // it 级超时与 waitFor 对齐：否则并发转换慢时会在等待阶段被测试默认 5s 超时截断（全量偶发超时）。
  await vi.waitFor(() => expect(mocks.recover).toHaveBeenCalledTimes(1), { timeout: 15_000, interval: 20 })
  expect(mocks.listen).not.toHaveBeenCalled()
  expect(mocks.schedules).not.toHaveBeenCalled()
  expect(mocks.queue).not.toHaveBeenCalled()
  expect(mocks.styleQueue).not.toHaveBeenCalled()
  expect(mocks.durable).not.toHaveBeenCalled()
  finish()
  await starting
  expect(mocks.listen).toHaveBeenCalledTimes(1)
  expect(mocks.schedules).toHaveBeenCalledTimes(1)
  expect(mocks.durable).toHaveBeenCalledTimes(1)
}, 20_000)
