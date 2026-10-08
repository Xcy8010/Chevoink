import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ createMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), transaction: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: { agentRunEvent: db, $transaction: db.transaction } }))

import { createRunEventBus, disposeRunEventBus, getRunEventBus, prepareRunEventResume, RunEventBus } from '../../api/lib/agent/events.js'

function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function settleMicrotasks() {
  for (let step = 0; step < 12; step++) await Promise.resolve()
}
const emit = (bus: RunEventBus) => bus.emit({ type: 'run.paused', reason: 'user_stop' })

beforeEach(() => {
  db.createMany.mockReset().mockResolvedValue({ count: 1 })
  db.findFirst.mockReset().mockResolvedValue(null)
  db.create.mockReset().mockResolvedValue({})
  db.transaction.mockReset().mockImplementation(async (work: (tx: { agentRunEvent: { create: typeof db.create } }) => Promise<unknown>) =>
    work({ agentRunEvent: { create: db.create } }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('R01 event journal persistence', () => {
  it.each([true, false])('author continue waits for its journal before paid work (saved=%s)', async saved => {
    const pending = deferred(), paidWork = vi.fn()
    db.createMany.mockImplementationOnce(() => pending.promise)
    const bus = new RunEventBus('author-admission', 72)
    bus.emit({ type: 'run.started', agent: { type: 'writingOrchestrator', title: '创作', model: 'speed' },
      mode: 'build', title: '继续', authorContinue: { eventId: 'pause-72', afterSeq: 72 } })
    const admission = bus.persist().then(paidWork)
    const result = admission.then(() => 'saved', () => 'failed')
    await settleMicrotasks()
    expect(paidWork).not.toHaveBeenCalled()
    if (saved) pending.resolve()
    else pending.reject(new Error('journal unavailable'))
    expect(await result).toBe(saved ? 'saved' : 'failed')
    expect(paidWork).toHaveBeenCalledTimes(saved ? 1 : 0)
    await bus.close()
  })

  it('replays only the latest preparation in seq order without persisting body snapshots', async () => {
    const bus = new RunEventBus('preview-reconnect')
    const preview = { type: 'tool.delta' as const, messageId: 'm', callId: 'c', toolName: 'chapter_write', title: '写入章节正文', argsChars: 0 }
    bus.emit({ type: 'message.start', messageId: 'm', role: 'assistant' })
    bus.emitTransient(preview)
    bus.emit({ type: 'reasoning.delta', messageId: 'm', delta: '准备正文' })
    bus.emitTransient({ ...preview, argsChars: 80 })
    const listener = vi.fn()
    bus.subscribe(listener)
    expect(listener.mock.calls.map(([event]) => event.seq)).toEqual([1, 3, 4])
    expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ ...preview, argsChars: 80 })
    const reconnect = vi.fn()
    bus.subscribe(reconnect, 3)
    expect(reconnect).toHaveBeenCalledOnce()
    await bus.close()
    expect(db.createMany.mock.calls.flatMap(([arg]) => arg.data.map((event: { type: string }) => event.type)))
      .toEqual(['message.start', 'reasoning.delta'])
  })

  it.each(['tool.call', 'tool.result', 'step.finish', 'run.paused'] as const)('%s removes obsolete previews from reconnect', async type => {
    const bus = new RunEventBus('preview-cleanup')
    bus.emitTransient({ type: 'tool.delta', messageId: 'm', callId: 'c', toolName: 'chapter_write', title: '写入', argsChars: 8 })
    if (type === 'tool.call') bus.emit({ type, messageId: 'm', callId: 'c', toolName: 'chapter_write', title: '写入', args: {} })
    else if (type === 'tool.result') bus.emit({ type, messageId: 'm', callId: 'c', toolName: 'chapter_write', ok: false, summary: '未执行', durationMs: 0 })
    else if (type === 'step.finish') bus.emit({ type, turn: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
    else (await bus.commitTerminal({ type, reason: 'user_stop' }, async () => ({}))).publish()
    const listener = vi.fn()
    bus.subscribe(listener)
    expect(listener.mock.calls.map(([event]) => event.type)).toEqual([type])
    await bus.close()
  })

  it('bounds retained preparation snapshots', async () => {
    const bus = new RunEventBus('preview-bound')
    for (let i = 0; i < 20; i++) bus.emitTransient({ type: 'tool.delta', messageId: 'm', callId: String(i), argsChars: i })
    const listener = vi.fn()
    bus.subscribe(listener)
    expect(listener).toHaveBeenCalledTimes(16)
    expect(listener.mock.calls[0][0].callId).toBe('4')
    await bus.close()
    expect(db.createMany).not.toHaveBeenCalled()
  })
  it('publishes a terminal event once, only after the state/journal transaction', async () => {
    const bus = new RunEventBus('terminal-commit')
    const listener = vi.fn()
    bus.subscribe(listener)
    const work = vi.fn(async () => ({ status: 'completed' }))
    const terminal = await bus.commitTerminal({ type: 'run.paused', reason: 'user_stop' }, work)
    expect(terminal.result).toEqual({ status: 'completed' })
    expect(work).toHaveBeenCalledOnce()
    expect(db.create).toHaveBeenCalledOnce()
    expect(listener).not.toHaveBeenCalled()
    terminal.publish()
    terminal.publish()
    expect(listener).toHaveBeenCalledOnce()
    expect(db.createMany).not.toHaveBeenCalled()
    await bus.close()
  })

  it('does not publish a terminal event when its journal write fails', async () => {
    const bus = new RunEventBus('terminal-failed')
    const listener = vi.fn()
    bus.subscribe(listener)
    db.create.mockRejectedValueOnce(new Error('terminal journal unavailable'))
    await expect(bus.commitTerminal({ type: 'run.paused', reason: 'user_stop' }, async () => ({}))).rejects.toThrow('journal unavailable')
    expect(listener).not.toHaveBeenCalled()
    expect(bus.lastSeq).toBe(1)
    const error = bus.emit({ type: 'error', code: 'run_status_unconfirmed', message: 'state unconfirmed', recoverable: false })
    expect(error.seq).toBe(2)
    await bus.close()
  })

  it('close waits for an in-flight terminal transaction', async () => {
    const pending = deferred()
    db.create.mockImplementationOnce(() => pending.promise)
    const bus = new RunEventBus('terminal-close')
    const write = bus.commitTerminal({ type: 'run.paused', reason: 'user_stop' }, async () => ({}))
    await settleMicrotasks()
    let closed = false
    const closing = bus.close().then(() => { closed = true })
    await settleMicrotasks()
    expect(closed).toBe(false)
    pending.resolve()
    await write
    await closing
    expect(closed).toBe(true)
  })

  it('drains an emit arriving between batch completion and shared-promise settlement', async () => {
    const bus = new RunEventBus('microtask-tail')
    emit(bus)
    // createMany has resolved; its batch is consumed, but the flush completion
    // reaction has not run yet. This tail must not be stranded behind it.
    await Promise.resolve()
    emit(bus)
    await bus.close()
    expect(db.createMany.mock.calls.flatMap(([arg]) => arg.data.map((event: { seq: number }) => event.seq))).toEqual([1, 2])
  })

  it('rejects replacing an existing bus instead of discarding its journal', async () => {
    const bus = createRunEventBus('no-replacement')
    emit(bus)
    expect(() => createRunEventBus(bus.runId)).toThrow('不能覆盖')
    expect(getRunEventBus(bus.runId)).toBe(bus)
    await disposeRunEventBus(bus.runId)
  })

  it('resumes above persisted seq and preserves transient high water marks in process', async () => {
    db.findFirst.mockResolvedValue({ seq: 72 })
    const initialSeq = await prepareRunEventResume('resume-db')
    const bus = createRunEventBus('resume-db', initialSeq)
    expect(emit(bus).seq).toBe(73)
    bus.emitTransient({ type: 'run.paused', reason: 'user_stop' })
    expect(await prepareRunEventResume('resume-db')).toBe(74)
    expect(getRunEventBus('resume-db')).toBeUndefined()
  })

  it('will not read the resume high water mark until the old journal commits', async () => {
    const write = deferred()
    db.createMany.mockImplementationOnce(() => write.promise)
    const bus = createRunEventBus('resume-held')
    emit(bus)
    const resuming = prepareRunEventResume(bus.runId)
    await settleMicrotasks()
    expect(db.findFirst).not.toHaveBeenCalled()
    write.resolve()
    expect(await resuming).toBe(1)
    expect(db.findFirst).toHaveBeenCalledOnce()
  })

  it('close waits for the in-flight write and every subsequently queued batch', async () => {
    const first = deferred()
    const second = deferred()
    db.createMany.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const bus = new RunEventBus('held-write')
    emit(bus)
    emit(bus)
    let closed = false
    const closing = bus.close().then(() => { closed = true })
    await settleMicrotasks()
    expect(closed).toBe(false)
    first.resolve()
    await settleMicrotasks()
    expect(db.createMany).toHaveBeenCalledTimes(2)
    expect(closed).toBe(false)
    second.resolve()
    await closing
    expect(closed).toBe(true)
    expect(db.createMany.mock.calls.map(([arg]) => arg.data.map((event: { seq: number }) => event.seq))).toEqual([[1], [2]])
  })

  it('retains a failed batch before newer events and retries without re-numbering', async () => {
    db.createMany.mockRejectedValueOnce(new Error('offline'))
    const bus = new RunEventBus('retry-order')
    const first = emit(bus)
    await settleMicrotasks()
    const second = emit(bus)
    await bus.close()
    expect(db.createMany).toHaveBeenCalledTimes(2)
    expect(db.createMany.mock.calls[1][0]).toMatchObject({
      skipDuplicates: true,
      data: [{ seq: 1, payload: first }, { seq: 2, payload: second }],
    })
  })

  it('surfaces close failure, preserves replay, seals new emits, and permits a later close retry', async () => {
    const write = deferred()
    db.createMany.mockImplementationOnce(() => write.promise)
    const bus = new RunEventBus('retry-close')
    emit(bus)
    const closing = expect(bus.close()).rejects.toThrow('offline')
    write.reject(new Error('offline'))
    await closing
    expect(() => emit(bus)).toThrow()
    expect(() => bus.emitTransient({ type: 'run.paused', reason: 'user_stop' })).toThrow()
    const listener = vi.fn()
    bus.subscribe(listener)
    expect(listener).toHaveBeenCalledOnce()
    await bus.close()
    expect(db.createMany).toHaveBeenCalledTimes(2)
    const afterClose = vi.fn()
    bus.subscribe(afterClose)
    expect(afterClose).not.toHaveBeenCalled()
  })

  it('does not lose a committed batch when its acknowledgement fails', async () => {
    const persisted = new Map<number, unknown>()
    let attempts = 0
    db.createMany.mockImplementation(async (arg: { skipDuplicates: boolean; data: { seq: number; payload: unknown }[] }) => {
      expect(arg.skipDuplicates).toBe(true)
      for (const row of arg.data) if (!persisted.has(row.seq)) persisted.set(row.seq, row.payload)
      if (++attempts === 1) throw new Error('commit acknowledgement lost')
      return { count: arg.data.length }
    })
    const bus = new RunEventBus('ambiguous-commit')
    const event = emit(bus)
    await settleMicrotasks()
    await bus.close()
    expect(attempts).toBe(2)
    expect([...persisted.values()]).toEqual([event])
  })

  it('dispose retains the registered bus until the shared write has committed', async () => {
    const write = deferred()
    db.createMany.mockImplementationOnce(() => write.promise)
    const bus = createRunEventBus('dispose-held')
    emit(bus)
    const first = disposeRunEventBus(bus.runId)
    const second = disposeRunEventBus(bus.runId)
    const retainedWhilePending = getRunEventBus(bus.runId)
    write.resolve()
    await Promise.all([first, second])
    expect(retainedWhilePending).toBe(bus)
    expect(db.createMany).toHaveBeenCalledOnce()
    expect(getRunEventBus(bus.runId)).toBeUndefined()
  })

  it('keeps a failed disposal discoverable for retry and does not leak raw errors to logs', async () => {
    db.createMany.mockRejectedValueOnce(new Error('postgres://secret/body-content'))
    const bus = createRunEventBus('dispose-failed')
    emit(bus)
    const closing = expect(disposeRunEventBus(bus.runId)).rejects.toThrow()
    await closing
    expect(getRunEventBus(bus.runId)).toBe(bus)
    expect(vi.mocked(console.error).mock.calls.flat().map(String).join(' ')).not.toContain('postgres://secret')
    await disposeRunEventBus(bus.runId)
    expect(getRunEventBus(bus.runId)).toBeUndefined()
  })
})
