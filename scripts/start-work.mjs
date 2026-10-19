import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncWorkspace } from './workspace-sync.mjs'
import { checkOfflineReadiness, workspaceRoot } from './offline-readiness.mjs'

export async function startWork({ root = workspaceRoot, offline = false } = {}) {
  let readiness = await checkOfflineReadiness({ root })
  if (!offline && !readiness.runtime) {
    return { sync: { mode: 'online', status: 'blocked', reason: 'pinned_runtime_required', remoteChecked: false, synced: false, exitCode: 1 }, readiness, exitCode: 1 }
  }
  const sync = await syncWorkspace({ root, offline })
  // A fast-forward may change the manifest, lock or schema we just inspected.
  if (sync.status === 'fast_forwarded') readiness = await checkOfflineReadiness({ root })
  return { sync, readiness, exitCode: sync.exitCode || (readiness.readyForLocalChecks ? 0 : 1) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length > 1 || args.length === 1 && args[0] !== '--offline') throw new Error('Usage: node scripts/start-work.mjs [--offline]')
  const result = await startWork({ offline: args[0] === '--offline' })
  console.log(result.sync.synced ? '远端已核对；请按就绪检查结果选择本地工作。' : '未确认最新：仅为本地快照；不会自动覆盖或推送。')
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.exitCode
}
