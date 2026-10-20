import { cpuUsage } from 'node:process'

export type DurableTestPhase = 'fixture.setup' | 'fixture.work' | 'fixture.cleanup' | 'step' | 'memory' | 'verification' | 'append'
  | 'lease' | 'chapter.seed' | 'compiler.prepare' | 'compiler.tasks' | 'baseline' | 'runtime.seed' | 'credit.seed'
type PendingPhase = { phase: DurableTestPhase; ordinal: number }
type Cpu = { cpuUserMs: number; cpuSystemMs: number }
export type DurableTestTrace = { event: 'start' | 'finish' | 'abort' | 'mock'; elapsedMs: number; mockOrdinal: number;
  phase?: DurableTestPhase; ordinal?: number; durationMs?: number; outcome?: 'fulfilled' | 'rejected';
  pending?: Array<PendingPhase & Cpu & { durationMs: number }> } & Cpu

/** Test-owned cancellation only. Trace payloads contain fixed phase names and
 * counters, never operation IDs, SQL, requests, responses or error messages. */
export function createDurableTestLifecycle(signal: AbortSignal, trace?: (entry: DurableTestTrace) => void,
  clock = { now: () => performance.now(), cpu: cpuUsage }) {
  const started = clock.now(), cpuStarted = trace ? clock.cpu() : undefined
  const pending = new Map<number, PendingPhase & { began: number; cpu?: ReturnType<typeof cpuUsage> }>(), ordinals = new Map<DurableTestPhase, number>()
  let sequence = 0, mockOrdinal = 0
  const cpuSince = (start = cpuStarted): Cpu => {
    const end = clock.cpu()
    return { cpuUserMs: (end.user - (start?.user ?? end.user)) / 1000, cpuSystemMs: (end.system - (start?.system ?? end.system)) / 1000 }
  }
  const emit = (entry: Omit<DurableTestTrace, 'elapsedMs' | 'mockOrdinal' | keyof Cpu>, cpu = cpuStarted) => {
    if (trace) trace({ ...entry, ...cpuSince(cpu), elapsedMs: clock.now() - started, mockOrdinal })
  }
  const abort = () => {
    if (trace) emit({ event: 'abort', pending: [...pending.values()].map(({ phase, ordinal, began, cpu }) => ({
      phase, ordinal, durationMs: clock.now() - began, ...cpuSince(cpu),
    })) })
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const assertActive = () => signal.throwIfAborted()
  const active = async <T>(work: () => PromiseLike<T>): Promise<T> => {
    assertActive()
    const result = await work()
    assertActive()
    return result
  }
  const phase = async <T>(name: DurableTestPhase, work: () => PromiseLike<T>): Promise<T> => {
    const cleanup = name === 'fixture.cleanup'
    if (!cleanup) assertActive()
    const id = ++sequence, ordinal = (ordinals.get(name) ?? 0) + 1, began = clock.now(), cpu = trace ? clock.cpu() : undefined
    ordinals.set(name, ordinal)
    pending.set(id, { phase: name, ordinal, began, cpu })
    emit({ event: 'start', phase: name, ordinal }, cpu)
    try {
      const result = await work()
      if (!cleanup) assertActive()
      emit({ event: 'finish', phase: name, ordinal, durationMs: clock.now() - began, outcome: 'fulfilled' }, cpu)
      return result
    } catch (error) {
      emit({ event: 'finish', phase: name, ordinal, durationMs: clock.now() - began, outcome: 'rejected' }, cpu)
      throw error
    } finally { pending.delete(id) }
  }
  return { signal, assertActive, active, phase,
    mockRequest() { assertActive(); mockOrdinal++; emit({ event: 'mock' }) },
    dispose() { signal.removeEventListener('abort', abort) },
  }
}
export type DurableTestLifecycle = ReturnType<typeof createDurableTestLifecycle>

/** A Vitest timeout rejects its wrapper before the original callback finishes.
 * The fixture afterEach drains these original promises before restoring mocks.
 * This never waits for an afterEach/onFinished callback from the tracked work. */
export function createDurableFixtureTasks() {
  const pending = new Set<{ task: Promise<void>; reportFailure: (error: unknown) => boolean }>()
  return {
    track(work: () => Promise<void>, reportFailure: (error: unknown) => boolean): Promise<void> {
      const task = Promise.resolve().then(work)
      pending.add({ task, reportFailure })
      // Observe rejection immediately, but retain its record until drain. A
      // fast cleanup failure must not disappear before afterEach takes a snapshot.
      void task.catch(() => {})
      return task
    },
    async drain(): Promise<void> {
      const tasks = [...pending], settled = await Promise.allSettled(tasks.map(item => item.task))
      const errors = settled.flatMap((item, index) => item.status === 'rejected' && tasks[index].reportFailure(item.reason) ? [item.reason] : [])
      tasks.forEach(item => pending.delete(item))
      if (errors.length) throw new AggregateError(errors, 'Durable fixture work or cleanup failed before mock restoration')
    },
  }
}
