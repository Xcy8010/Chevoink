import type { Prisma, PrismaClient } from '@prisma/client'
import { currentGoalEffectScope, currentGoalTransaction, withGoalTransaction, withoutGoalEffects } from './goal-context.js'

const queryKey = Symbol('goal-database-query')
type Database = PrismaClient | Prisma.TransactionClient
type DeferredQuery = { execute: (tx: Database) => Promise<unknown>; executed: boolean }
const writes = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany'])

/** Only goal-owned tool effects use this adapter. Ordinary queries retain native Prisma behavior.
 * Deferring queries preserves Prisma's array-transaction semantics, including reads mixed with writes.
 * Helpers importing the singleton within an existing transaction reuse that SAME transaction. */
export function withGoalDatabaseFences(client: PrismaClient): PrismaClient {
  const delegates = new Map<PropertyKey, unknown>()
  // Restoring a captured public method must not make its implementation call
  // itself. Keep the native transaction entry point separate from the proxy.
  const nativeTransaction = client.$transaction
  const guarded = async <T>(scope: NonNullable<ReturnType<typeof currentGoalEffectScope>>, work: (tx: Prisma.TransactionClient) => Promise<T>, options?: object) => {
    const existing = currentGoalTransaction()
    if (existing) return work(existing)
    return nativeTransaction.call(client, async tx => {
      // The fence queries must use the raw transaction, never recursively enter this adapter.
      const { assertGoalFence } = await import('./goal-fence.js')
      await withoutGoalEffects(() => assertGoalFence(tx, scope))
      return withGoalTransaction(tx, () => work(tx))
    }, options)
  }
  const query = (scope: NonNullable<ReturnType<typeof currentGoalEffectScope>>, execute: DeferredQuery['execute'], write: boolean) => {
    const deferred: DeferredQuery = { execute, executed: false }
    let pending: Promise<unknown> | undefined
    const run = () => {
      if (!pending) {
        deferred.executed = true
        pending = write ? guarded(scope, execute) : execute(currentGoalTransaction() ?? client)
      }
      return pending
    }
    return { [queryKey]: deferred, [Symbol.toStringTag]: 'PrismaPromise',
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject),
      catch: (reject: (reason: unknown) => unknown) => run().catch(reject), finally: (finish: () => void) => run().finally(finish) }
  }
  const transaction = (input: unknown, options?: object) => {
    const scope = currentGoalEffectScope()
    if (!scope) return Reflect.apply(nativeTransaction, client, [input, options])
    if (typeof input === 'function') return guarded(scope, tx => input(tx), options)
    if (!Array.isArray(input)) throw new Error('Invalid goal transaction')
    return guarded(scope, async tx => {
      const result: unknown[] = []
      for (const item of input) {
        const deferred = item?.[queryKey] as DeferredQuery | undefined
        // A foreign/already-executed promise cannot be made atomic retroactively.
        if (!deferred || deferred.executed) throw new Error('Goal transactions require unexecuted scoped Prisma queries')
        deferred.executed = true
        result.push(await deferred.execute(tx))
      }
      return result
    }, options)
  }
  return new Proxy(client, {
    get(target, key, receiver) {
      if (key === '$transaction') {
        const current = Reflect.get(target, key, receiver)
        return current === nativeTransaction ? transaction : current
      }
      if (typeof key === 'string' && ['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe'].includes(key)) {
        return (...args: unknown[]) => {
          const scope = currentGoalEffectScope()
          if (!scope) return Reflect.apply(Reflect.get(target, key), target, args)
          // Raw SQL cannot be reliably classified as read-only; fence it conservatively.
          return query(scope, tx => Reflect.apply(Reflect.get(tx, key), tx, args), true)
        }
      }
      const value = Reflect.get(target, key, receiver)
      if (typeof value === 'function') return value.bind(target)
      if (typeof key !== 'string' || key.startsWith('$') || key.startsWith('_') || !value || typeof value !== 'object'
        || typeof value.findMany !== 'function') return value
      if (!delegates.has(key)) delegates.set(key, new Proxy(value, {
        get(delegate, operation) {
          const method = Reflect.get(delegate, operation)
          if (typeof method !== 'function') return method
          return (...args: unknown[]) => {
            const scope = currentGoalEffectScope()
            if (!scope) return Reflect.apply(method, delegate, args)
            return query(scope, tx => {
              const model = Reflect.get(tx, key)
              return Reflect.apply(Reflect.get(model, operation), model, args)
            }, writes.has(String(operation)))
          }
        },
      }))
      return delegates.get(key)
    },
  })
}
