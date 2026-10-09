import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

export type TextRequestRecord = {
  usageId: string
  status: 'prepared' | 'terminal' | 'not_dispatched' | 'unknown'
  billingKnown: boolean
}
export type TextRequestTrace = { records: TextRequestRecord[] }
const active = new AsyncLocalStorage<TextRequestTrace>()
type Identity = { userId: string; action: string; targetId?: string | null }
type RecoveryProof = { record: TextRequestRecord; identity: string; consumed: boolean }
const failures = new WeakMap<object, RecoveryProof>()
const identity = (system: string, content: string, options: Identity) => createHash('sha256')
  .update(JSON.stringify([options.userId, options.action, options.targetId ?? null, system, content])).digest('hex')

export const createTextRequestTrace = (): TextRequestTrace => ({ records: [] })
export const withTextRequestTrace = <T>(trace: TextRequestTrace, operation: () => Promise<T>): Promise<T> => active.run(trace, operation)
export const textRequestsFinished = (trace: TextRequestTrace): boolean => trace.records.length > 0
  && trace.records.every(record => record.billingKnown && ['terminal', 'not_dispatched'].includes(record.status))

export function beginTextRequest(usageId: string) {
  const record: TextRequestRecord = { usageId, status: 'prepared', billingKnown: false }
  active.getStore()?.records.push(record)
  return { record, traced: !!active.getStore() }
}

/** A failure proof belongs to one actual request, never its error code alone. */
export function recordTextRequestFailure(error: unknown, record: TextRequestRecord, system: string, content: string, options: Identity) {
  if (error && typeof error === 'object') failures.set(error, { record, identity: identity(system, content, options), consumed: false })
}
export function consumeTextRequestRecovery(error: unknown, system: string, content: string, options: Identity): boolean {
  const proof = error && typeof error === 'object' ? failures.get(error) : undefined
  if (!proof || proof.consumed || !proof.record.billingKnown || proof.record.status !== 'terminal'
    || proof.identity !== identity(system, content, options)) return false
  proof.consumed = true
  return true
}
