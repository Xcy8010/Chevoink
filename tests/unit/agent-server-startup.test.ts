import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  recover: vi.fn(), durable: vi.fn().mockResolvedValue([]), stale: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn((_port: number, _host: string, ready: () => void) => { ready(); return { close: vi.fn() } }),
  schedules: vi.fn(), queue: vi.fn().mockResolvedValue(undefined), styleQueue: vi.fn().mockResolvedValue(undefined),
  goals: vi.fn().mockResolvedValue(undefined), goalUsage: vi.fn().mockResolvedValue(undefined),
  importRecovery: vi.fn().mockResolvedValue(undefined),
  importEffects: vi.fn().mockResolvedValue({ processed: 0, failed: 0 }),
  importMaintenanceEnabled: vi.fn().mockReturnValue(false),
  importMaintenance: vi.fn().mockResolvedValue({ failedBlobs: 0 }),
}))
vi.mock('../../api/app.js', () => ({ default: { listen: mocks.listen } }))
vi.mock('../../api/config/env.js', () => ({ env: { port: 3001, serverUrl: 'test' } }))
vi.mock('../../api/lib/agent/run-service.js', () => ({ recoverOrphanLoopRuns: mocks.recover, recoverDurableLoopRuns: mocks.durable, recoverStaleLoopRuns: mocks.stale }))
vi.mock('../../api/lib/agent/productivity.js', () => ({ runDueAgentSchedules: mocks.schedules }))
vi.mock('../../api/lib/agent/request-queue.js', () => ({ dispatchQueuedRequests: mocks.queue }))
vi.mock('../../api/lib/agent/style-learning.js', () => ({ dispatchStyleLearning: mocks.styleQueue }))
// Keep this ordering test at the server boundary. These background services pull
// the writing/import graphs into a dynamic import and may launch real DB work.
vi.mock('../../api/lib/agent/goal-supervisor.js', () => ({ dispatchAgentGoals: mocks.goals }))
vi.mock('../../api/lib/agent/goal-budget.js', () => ({ reconcileGoalUsage: mocks.goalUsage }))
vi.mock('../../api/lib/novel-import-service.js', () => ({ recoverNovelImportJobs: mocks.importRecovery }))
vi.mock('../../api/lib/novel-import-effects.js', () => ({ drainNovelImportEffects: mocks.importEffects }))
vi.mock('../../api/lib/novel-import-maintenance.js', () => ({ isNovelImportMaintenanceEnabled: mocks.importMaintenanceEnabled, maintainNovelImports: mocks.importMaintenance }))
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
  expect(mocks.stale).not.toHaveBeenCalled()
  expect(mocks.goals).not.toHaveBeenCalled()
  expect(mocks.goalUsage).not.toHaveBeenCalled()
  expect(mocks.importRecovery).not.toHaveBeenCalled()
  expect(mocks.importEffects).not.toHaveBeenCalled()
  expect(mocks.importMaintenanceEnabled).not.toHaveBeenCalled()
  expect(mocks.importMaintenance).not.toHaveBeenCalled()
  finish()
  await starting
  expect(mocks.listen).toHaveBeenCalledTimes(1)
  expect(mocks.schedules).toHaveBeenCalledTimes(1)
  expect(mocks.durable).toHaveBeenCalledTimes(1)
  // 60s 周期扫描挂载点：监听就绪后的恢复流程必须拉起运行期僵尸收敛看门狗
  expect(mocks.stale).toHaveBeenCalledTimes(1)
  expect(mocks.goalUsage).toHaveBeenCalledTimes(1)
  expect(mocks.importEffects).toHaveBeenCalledTimes(1)
}, 20_000)
