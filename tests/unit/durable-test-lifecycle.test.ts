import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { createDurableFixtureTasks, createDurableTestLifecycle, type DurableTestTrace } from '../support/durable-test-lifecycle.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('durable test cancellation and fixture ownership', () => {
  it.for(['synthetic scenario'])('uses the actual Vitest context for %s without altering scenario identity', async (scenario, { signal }) => {
    const lifecycle = createDurableTestLifecycle(signal)
    expect(scenario).toBe('synthetic scenario')
    await lifecycle.phase('step', async () => { expect(lifecycle.signal).toBe(signal); expect(signal.aborted).toBe(false) })
    lifecycle.dispose()
  })

  it('waits for in-flight work and mandatory cleanup before restoring mocks, without another step or dispatch', async () => {
    const controller = new AbortController(), lifecycle = createDurableTestLifecycle(controller.signal), tasks = createDurableFixtureTasks()
    const inFlight = deferred(), cleaning = deferred(), cleanupEntered = deferred(), entered = deferred(), events: string[] = []
    const dispatch = vi.fn(), reason = new Error('synthetic test timeout')
    const task = tasks.track(async () => {
      try {
        await lifecycle.phase('step', async () => { events.push('in-flight'); entered.resolve(); await inFlight.promise; events.push('settled') })
        await lifecycle.phase('step', async () => { dispatch(); events.push('later step') })
      } finally {
        await lifecycle.phase('fixture.cleanup', async () => {
          events.push('cleanup'); cleanupEntered.resolve(); await cleaning.promise; events.push('cleaned')
        })
        lifecycle.dispose()
      }
    }, error => controller.signal.aborted && error !== controller.signal.reason)
    await entered.promise
    controller.abort(reason)
    const afterEach = tasks.drain().finally(() => { events.push('restore mocks') })
    await Promise.resolve()
    expect(events).toEqual(['in-flight'])
    expect(() => lifecycle.mockRequest()).toThrow(reason)
    inFlight.resolve()
    await cleanupEntered.promise
    expect(events).toEqual(['in-flight', 'settled', 'cleanup'])
    cleaning.resolve()
    await expect(task).rejects.toBe(reason)
    await afterEach
    expect(events).toEqual(['in-flight', 'settled', 'cleanup', 'cleaned', 'restore mocks'])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('captures a committed setup owner before the post-await cancellation check and still cleans it', async () => {
    const controller = new AbortController(), lifecycle = createDurableTestLifecycle(controller.signal), created = deferred<{ id: string }>()
    const nextCreate = vi.fn(), remove = vi.fn(), entered = deferred()
    let owner: string | undefined
    const fixture = (async () => {
      try {
        await lifecycle.phase('fixture.setup', async () => {
          await lifecycle.active(async () => {
            entered.resolve()
            const row = await created.promise
            owner = row.id
            return row
          })
          await lifecycle.active(async () => { nextCreate() })
        })
      } finally {
        if (owner) await lifecycle.phase('fixture.cleanup', async () => { remove(owner) })
        lifecycle.dispose()
      }
    })()
    await entered.promise
    controller.abort(new Error('synthetic setup timeout'))
    created.resolve({ id: 'synthetic-owner' })
    await expect(fixture).rejects.toBe(controller.signal.reason)
    expect(nextCreate).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledExactlyOnceWith('synthetic-owner')
  })

  it('retains a fast cleanup rejection until drain and observes it without an unhandled rejection', async () => {
    const tasks = createDurableFixtureTasks(), failure = new Error('synthetic cleanup failure'), events: string[] = [], unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const cleanup = async () => { events.push('cleanup failed'); throw failure }
      const task = tasks.track(async () => {
        try { events.push('work') }
        finally { await cleanup() }
      }, () => true)
      // The original timed-out callback can reject before afterEach starts.
      await setImmediate()
      const drain = tasks.drain().finally(() => { events.push('restore mocks') })
      await expect(drain).rejects.toMatchObject({ errors: [failure] })
      await expect(task).rejects.toBe(failure)
      expect(events).toEqual(['work', 'cleanup failed', 'restore mocks'])
      expect(unhandled).not.toHaveBeenCalled()
      await expect(tasks.drain()).resolves.toBeUndefined()
    } finally { process.removeListener('unhandledRejection', unhandled) }
  })

  it('keeps on-time expected work rejection with its original test assertion', async () => {
    const tasks = createDurableFixtureTasks(), expected = new Error('synthetic expected rejection')
    const task = tasks.track(async () => { throw expected }, () => false)
    await expect(task).rejects.toBe(expected)
    await expect(tasks.drain()).resolves.toBeUndefined()
  })

  it('diagnoses both failed work and failed cleanup while retaining the cleanup error for drain', async () => {
    const controller = new AbortController(), entries: DurableTestTrace[] = [], tasks = createDurableFixtureTasks()
    const lifecycle = createDurableTestLifecycle(controller.signal, entry => entries.push(entry))
    const workError = new Error('synthetic work failure'), cleanupError = new Error('synthetic cleanup failure')
    const task = tasks.track(async () => {
      try { await lifecycle.phase('fixture.work', async () => { throw workError }) }
      finally {
        try { await lifecycle.phase('fixture.cleanup', async () => { throw cleanupError }) }
        finally { lifecycle.dispose() }
      }
    }, () => true)
    await expect(task).rejects.toBe(cleanupError)
    await expect(tasks.drain()).rejects.toMatchObject({ errors: [cleanupError] })
    expect(entries.filter(entry => entry.event === 'finish').map(entry => ({ phase: entry.phase, outcome: entry.outcome })))
      .toEqual([{ phase: 'fixture.work', outcome: 'rejected' }, { phase: 'fixture.cleanup', outcome: 'rejected' }])
    expect(JSON.stringify(entries)).not.toContain('failure')
  })

  it('waits for every fixture before surfacing cleanup failure', async () => {
    const tasks = createDurableFixtureTasks(), second = deferred(), firstError = new Error('first cleanup failed')
    const failed = tasks.track(async () => { throw firstError }, () => true)
    const pending = tasks.track(() => second.promise, () => true)
    let restored = false
    const drain = tasks.drain().finally(() => { restored = true })
    await expect(failed).rejects.toBe(firstError)
    expect(restored).toBe(false)
    second.resolve()
    await pending
    await expect(drain).rejects.toMatchObject({ errors: [firstError] })
    expect(restored).toBe(true)
  })
})

describe('sanitized durable quality stage trace', () => {
  it('records monotonic wall/CPU deltas, mock ordinals and the timeout pending stage without error data', async () => {
    let wall = 0, user = 1000, system = 2000
    const clock = { now: () => wall, cpu: () => ({ user, system }) }, entries: DurableTestTrace[] = [], controller = new AbortController()
    const lifecycle = createDurableTestLifecycle(controller.signal, entry => entries.push(entry), clock), inFlight = deferred()
    const reason = new Error('must-not-be-logged: synthetic request/body')
    const work = lifecycle.phase('step', async () => { lifecycle.mockRequest(); await inFlight.promise })
    wall = 15; user = 3000; system = 3000
    controller.abort(reason)
    expect(entries.find(entry => entry.event === 'abort')).toEqual({ event: 'abort', elapsedMs: 15, mockOrdinal: 1, cpuUserMs: 2, cpuSystemMs: 1,
      pending: [{ phase: 'step', ordinal: 1, durationMs: 15, cpuUserMs: 2, cpuSystemMs: 1 }] })
    inFlight.resolve()
    await expect(work).rejects.toBe(reason)
    wall = 20; user = 4000; system = 3500
    await lifecycle.phase('fixture.cleanup', async () => { wall = 24; user = 5000; system = 4000 })
    const cleanup = entries.find(entry => entry.event === 'finish' && entry.phase === 'fixture.cleanup')
    expect(cleanup).toMatchObject({ elapsedMs: 24, durationMs: 4, cpuUserMs: 1, cpuSystemMs: 0.5, outcome: 'fulfilled' })
    expect(entries.map(entry => entry.elapsedMs)).toEqual([...entries.map(entry => entry.elapsedMs)].sort((a, b) => a - b))
    expect(JSON.stringify(entries)).not.toContain('must-not-be-logged')
    lifecycle.dispose()
  })

  it('does not sample CPU or log for the other scenarios, and refuses already-cancelled work', async () => {
    const controller = new AbortController(), cpu = vi.fn(() => ({ user: 0, system: 0 })), work = vi.fn(async () => undefined)
    const lifecycle = createDurableTestLifecycle(controller.signal, undefined, { now: () => 0, cpu })
    await lifecycle.phase('step', work)
    controller.abort(new Error('synthetic cancellation'))
    await expect(lifecycle.phase('verification', work)).rejects.toBe(controller.signal.reason)
    await expect(lifecycle.active(work)).rejects.toBe(controller.signal.reason)
    expect(work).toHaveBeenCalledOnce()
    expect(cpu).not.toHaveBeenCalled()
    lifecycle.dispose()
  })
})
