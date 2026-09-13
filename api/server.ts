import app from './app.js'
import { dispatchStyleLearning } from './lib/agent/style-learning.js'
import { env } from './config/env.js'
import { recoverOrphanLoopRuns, recoverDurableLoopRuns } from './lib/agent/run-service.js'
import { runDueAgentSchedules } from './lib/agent/productivity.js'
import { dispatchQueuedRequests } from './lib/agent/request-queue.js'
import { reconcileCreditRefunds, reconcileTokenSettlements } from './lib/credits.js'
import { recoverNovelImportJobs } from './lib/novel-import-service.js'
import { isNovelImportMaintenanceEnabled, maintainNovelImports } from './lib/novel-import-maintenance.js'

// Do not accept new runs or dispatch schedules while startup recovery is scanning
// old queued/running rows: otherwise a fresh request can be mistaken for an orphan.
await recoverOrphanLoopRuns()

// Recover only existing protocol-one tasks. Discovery rechecks the original
// lease; live owners and stopped roots are never treated as startup orphans.
let refundSweepRunning = false
let importRecoveryRunning = false
function recoverSavedTasks() {
  if ((process.env.NOVEL_IMPORT_ENABLED === 'true' || isNovelImportMaintenanceEnabled()) && !importRecoveryRunning) {
    importRecoveryRunning = true
    void recoverNovelImportJobs().then(() => maintainNovelImports()).then(result => {
      if (result.failedBlobs > 0) console.warn('[novel-import] 私有临时文件清理待重试', { failedBlobs: result.failedBlobs })
    }).catch(() => {
      console.error('[novel-import] 导入恢复暂时不可用，持久记录保留')
    }).finally(() => { importRecoveryRunning = false })
  }
  void recoverDurableLoopRuns().catch(() => {
    console.error('[agent-loop] 持久任务恢复扫描失败，原状态保留，等待下一次扫描')
  })
  if (!refundSweepRunning) {
    refundSweepRunning = true
    void Promise.allSettled([reconcileCreditRefunds(), reconcileTokenSettlements()]).then(results => {
      if (results.some(result => result.status === 'rejected')) console.error('[credits] 费用对账扫描暂时失败，持久记录保留')
    }).finally(() => { refundSweepRunning = false })
  }
}

// 只绑回环地址：Node 只服务 nginx 反代（127.0.0.1:3001），不直接暴露公网，
// 避免绕过 nginx 的限流/体积限制/安全头；本地开发 vite proxy 同样走 localhost
const server = app.listen(env.port, '127.0.0.1', () => {
  console.log(`[chevoink] server ready on ${env.serverUrl}`)
  void runDueAgentSchedules()
  recoverSavedTasks()
})

const scheduleTimer = setInterval(() => {
  void runDueAgentSchedules()
  recoverSavedTasks()
}, 60_000)
scheduleTimer.unref()
const queueTimer = setInterval(() => void dispatchQueuedRequests(), 2000)
queueTimer.unref()
const styleTimer = setInterval(() => {
  void dispatchStyleLearning().catch(() => console.error('[style-learning] 学习队列暂时不可用，未重发模型请求'))
}, 2000)
styleTimer.unref()

process.on('SIGTERM', () => {
  clearInterval(styleTimer)
  clearInterval(queueTimer)
  clearInterval(scheduleTimer)
  console.log('SIGTERM signal received')
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  clearInterval(styleTimer)
  clearInterval(queueTimer)
  clearInterval(scheduleTimer)
  console.log('SIGINT signal received')
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})

export default app
