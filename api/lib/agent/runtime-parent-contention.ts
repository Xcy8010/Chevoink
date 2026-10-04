import { DataAccessError, prisma } from '../prisma.js'

/** Local DB scheduling only: persisted lineage is not execution authority.
 * These fixed limits bound memory, not task budgets or measured capacity. */
export type ParentContentionScope = { userId: string; parentRootId: string }
export const PARENT_CONTENTION_LIMITS = { perRootWaiting: 32, activeRoots: 1024, totalWaiting: 4096 } as const
type Permit = { release: () => void }
type Waiter = { deadline: number; signal?: AbortSignal; accept: (permit: Permit) => void; reject: (error: Error) => void; clear: () => void }
type Entry = { waiting: Waiter[] }
const failure = (code: string, message: string) => new DataAccessError(409, code, message)

/** Each instance is process-local. Database fences remain authoritative across
 * processes; never hold this permit during HTTP or through retry backoff. */
export function createParentContentionGate() {
  const roots = new Map<string, Entry>()
  let waiting = 0
  const acquire = (scope: ParentContentionScope, options: { deadline: number; signal?: AbortSignal }): Promise<Permit> => {
    if (options.signal?.aborted) return Promise.reject(failure('RUNTIME_CONTENTION_ABORTED', '数据库等待已取消，尚未执行。'))
    if (!Number.isFinite(options.deadline) || options.deadline <= Date.now()) return Promise.reject(failure('RUNTIME_CONTENTION_TIMEOUT', '数据库等待已超时，尚未执行。'))
    const key = JSON.stringify([scope.userId, scope.parentRootId])
    const existing = roots.get(key)
    if (!existing && roots.size >= PARENT_CONTENTION_LIMITS.activeRoots
      || existing && (existing.waiting.length >= PARENT_CONTENTION_LIMITS.perRootWaiting || waiting >= PARENT_CONTENTION_LIMITS.totalWaiting)) {
      return Promise.reject(failure('RUNTIME_CONTENTION_CAPACITY', '数据库等待容量已满，尚未执行。'))
    }
    const entry = existing ?? { waiting: [] }
    const permit = (): Permit => {
      let released = false
      return { release() {
        if (released) return
        released = true
        for (;;) {
          const next = entry.waiting.shift()
          if (!next) { roots.delete(key); return }
          waiting--
          next.clear()
          if (next.signal?.aborted) { next.reject(failure('RUNTIME_CONTENTION_ABORTED', '数据库等待已取消，尚未执行。')); continue }
          if (next.deadline <= Date.now()) { next.reject(failure('RUNTIME_CONTENTION_TIMEOUT', '数据库等待已超时，尚未执行。')); continue }
          next.accept(permit())
          return
        }
      } }
    }
    if (!existing) { roots.set(key, entry); return Promise.resolve(permit()) }
    return new Promise((accept, reject) => {
      const cancel = (code: string, message: string) => {
        const index = entry.waiting.indexOf(item)
        if (index < 0) return
        entry.waiting.splice(index, 1)
        waiting--
        item.clear()
        reject(failure(code, message))
      }
      const abort = () => cancel('RUNTIME_CONTENTION_ABORTED', '数据库等待已取消，尚未执行。')
      const item: Waiter = { deadline: options.deadline, signal: options.signal, accept, reject,
        clear() { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) } }
      entry.waiting.push(item)
      waiting++
      const timer = setTimeout(() => cancel('RUNTIME_CONTENTION_TIMEOUT', '数据库等待已超时，尚未执行。'), Math.max(1, options.deadline - Date.now()))
      options.signal?.addEventListener('abort', abort, { once: true })
      // Covers an abort between the initial check and listener attachment.
      if (options.signal?.aborted) abort()
    })
  }
  return { acquire, size: () => ({ roots: roots.size, waiting }) }
}

export const parentContentionGate = createParentContentionGate()

/** One bounded metadata read even for ordinary main runs. It schedules only;
 * ownership, canonical hashes and current lineage are rechecked inside the TX.
 * Completed/cancelled grants keep acquired late evidence on the same key. */
export async function readParentContentionScope(userId: string, runId: string, leaseDeadline = false): Promise<(ParentContentionScope & { isChild: boolean; deadline?: number }) | undefined> {
  const where = { OR: [
    { childRunId: runId, childRun: { userId } },
    { parentRoot: { userId, runs: { some: { id: runId, userId } } } },
  ] }
  if (leaseDeadline) {
    const grant = await prisma.agentChildExecutionGrant.findFirst({ where, select: { parentRootId: true, childRunId: true,
      childRun: { select: { executionLease: { select: { expiresAt: true } } } },
      currentParentRun: { select: { executionLease: { select: { expiresAt: true } } } } } })
    if (!grant) return undefined
    const isChild = grant.childRunId === runId
    const expiry = [grant.currentParentRun?.executionLease?.expiresAt, ...(isChild ? [grant.childRun?.executionLease?.expiresAt] : [])].filter((value): value is Date => value instanceof Date)
    return { userId, parentRootId: grant.parentRootId, isChild,
      ...(expiry.length ? { deadline: Math.min(...expiry.map(value => value.getTime())) } : {}) }
  }
  const grant = await prisma.agentChildExecutionGrant.findFirst({ where, select: { parentRootId: true, childRunId: true } })
  return grant ? { userId, parentRootId: grant.parentRootId, isChild: grant.childRunId === runId } : undefined
}

/** Evidence callers must never bind this hint to worker signal or lease expiry. */
export async function readAttemptContentionScope(userId: string, attemptId: string, leaseDeadline = false) {
  const attempt = await prisma.agentProviderAttempt.findFirst({ where: { id: attemptId, operation: { taskRoot: { userId } } }, select: { runId: true } })
  return attempt ? readParentContentionScope(userId, attempt.runId, leaseDeadline) : undefined
}
