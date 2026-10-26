import { publicReviewExecution } from '../../../shared/review-lifecycle.js'
import type { AgentStreamEvent, AgentStreamEventBody } from '../../../shared/contracts/index.js'
import { prisma } from '../prisma.js'
import type { Prisma } from '@prisma/client'

/**
 * run 级事件总线：发射 + 持久化 + SSE 桥接（plan/13 §4.6）。
 * - 所有事件按 seq 自增，写入 AgentRunEvent（replay/重连数据源）
 * - live 订阅者实时收到事件；重连用 Last-Event-ID 从 seq+1 续传
 * - 持久化走批量队列，避免 text.delta 高频事件逐条写库
 */

export const legacyExecutionFailureNotice = '任务执行遇到内部异常，已停止后续操作；已保存内容保留，请核对状态后再继续。'
type StoredNoticeEvent = { runId: string; seq: number; type: string; payload: unknown; run?: { errorMessage: string | null } }
type ServerRunNotice = { text: string; status: 'paused' | 'failed' | 'cancelled' }

/** Recognize the old server's adjacent start/text/stop transaction. This is a
 * display projection only; original messages and failure receipts stay intact. */
export function serverRunNotices(events: readonly StoredNoticeEvent[]): Map<string, ServerRunNotice> {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const positions = new Map(events.map(event => [`${event.runId}:${event.seq}`, event])), notices = new Map<string, ServerRunNotice>()
  for (const event of events) {
    if (event.type !== 'text.final') continue
    const body = object(event.payload), before = positions.get(`${event.runId}:${event.seq - 1}`), after = positions.get(`${event.runId}:${event.seq + 1}`)
    const start = object(before?.payload), end = object(after?.payload)
    if (before?.type !== 'message.start' || start.role !== 'assistant' || start.messageId !== body.messageId
      || typeof body.messageId !== 'string' || typeof body.text !== 'string' || !body.text || body.asReasoning !== false) continue
    const status = after?.type === 'run.paused' ? 'paused'
      : after?.type === 'run.finished' && (end.status === 'failed' || end.status === 'cancelled') ? end.status : null
    const reason = event.run?.errorMessage ?? after?.run?.errorMessage
    const serverText = body.text === legacyExecutionFailureNotice || Boolean(reason && (body.text === reason
      || body.text === reason + '已保存的内容保留，本次工作尚未完成。'))
    if (status && serverText && end.outcome === undefined) notices.set(body.messageId, { text: body.text, status })
  }
  return notices
}

export async function loadServerRunNotices(userId: string, runIds: string[]) {
  if (!runIds.length) return new Map<string, ServerRunNotice>()
  const scope = { runId: { in: [...new Set(runIds)] }, run: { userId, runtimeProtocolVersion: 0, taskRootId: null } }
  const select = { runId: true, seq: true, type: true, payload: true, run: { select: { errorMessage: true } } } as const
  const endings = (await prisma.agentRunEvent.findMany({ where: { ...scope, type: { in: ['run.paused', 'run.finished'] } }, select }))
    .filter(event => event.type === 'run.paused' || ['failed', 'cancelled'].includes(String((event.payload as Record<string, unknown>)?.status)))
  if (!endings.length) return new Map<string, ServerRunNotice>()
  const neighbors = await prisma.agentRunEvent.findMany({ where: { ...scope, type: { in: ['message.start', 'text.final'] },
    OR: endings.map(event => ({ runId: event.runId, seq: { in: [event.seq - 2, event.seq - 1].filter(seq => seq > 0) } })) }, select })
  return serverRunNotices([...endings, ...neighbors])
}

export function publicRunEvent(event: AgentStreamEvent, notices: ReadonlyMap<string, ServerRunNotice>): AgentStreamEvent {
  const notice = event.type === 'text.final' ? notices.get(event.messageId) : null
  if (event.type === 'text.final' && notice?.text === event.text && notice.status === 'cancelled') return { ...event, text: '' }
  if (event.type === 'text.final' && notice?.text === event.text) return {
    seq: event.seq, runId: event.runId, ts: event.ts, type: 'error', code: `run_${notice.status}`,
    message: notice.text, recoverable: notice.status === 'paused',
  }
  return publicReviewExecution(event)
}

type EventListener = (event: AgentStreamEvent) => void

export class RunEventBus {
  readonly runId: string
  private seq = 0
  private history: AgentStreamEvent[] = []
  // Only the latest parameter preview per call is retained for live reconnects, never journaled.
  private previews = new Map<string, AgentStreamEvent>()
  private listeners = new Set<EventListener>()
  private pendingPersist: AgentStreamEvent[] = []
  private flushPromise: Promise<void> | null = null
  private closed = false
  private committingTerminal = false
  private terminalWrite: Promise<unknown> | null = null

  constructor(runId: string, initialSeq = 0) {
    if (!Number.isSafeInteger(initialSeq) || initialSeq < 0) throw new Error('无效的事件序号')
    this.runId = runId
    this.seq = initialSeq
  }

  emit(body: AgentStreamEventBody): AgentStreamEvent {
    if (this.closed || this.committingTerminal) {
      throw new Error(`事件总线已关闭：${this.runId}`)
    }

    const event: AgentStreamEvent = {
      seq: ++this.seq,
      runId: this.runId,
      ts: new Date().toISOString(),
      ...body,
    }

    this.reconcilePreviews(event)
    this.history.push(event)
    this.pendingPersist.push(event)
    // Live delivery is non-blocking; flush logs a sanitized failure and retains
    // the batch. close/dispose still observe rejection instead of claiming success.
    void this.flush().catch(() => {})

    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 单个订阅者异常不影响其他订阅者
      }
    }

    return event
  }

  /** Only the legacy start transaction uses this: its status CAS and exact
   * event already committed together. Publish without another seq or DB write. */
  publishPersistedStart(event: Extract<AgentStreamEvent, { type: 'run.started' }>): void {
    if (this.closed || this.committingTerminal || event.runId !== this.runId || event.type !== 'run.started'
      || event.seq !== this.seq + 1 || !Number.isSafeInteger(event.seq) || event.seq > 2147483647
      || this.pendingPersist.length || this.flushPromise) throw new Error('已持久启动事件不匹配当前事件顺序')
    this.seq = event.seq
    this.history.push(event)
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* Publication cannot undo committed start. */ }
    }
  }

  /**
   * 高频预览事件仅保留最新一份用于 SSE 重连。工具正文参数可能每几个 token 更新一次，
   * 不写 agent_run_events，避免把同一篇正文的所有中间副本反复落库；正式 tool.call/result 仍完整持久化。
   */
  emitTransient(body: AgentStreamEventBody): AgentStreamEvent {
    if (this.closed || this.committingTerminal) throw new Error(`事件总线已关闭：${this.runId}`)
    const event: AgentStreamEvent = { seq: ++this.seq, runId: this.runId, ts: new Date().toISOString(), ...body }
    this.reconcilePreviews(event)
    if (event.type === 'tool.delta') {
      this.previews.delete(event.callId)
      this.previews.set(event.callId, event)
      if (this.previews.size > 16) this.previews.delete(this.previews.keys().next().value!)
    }
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* 单个订阅者异常不影响其它订阅者 */ }
    }
    return event
  }

  /** 订阅事件：先补发 sinceSeq 之后的内存历史，再接 live 流 */
  subscribe(listener: EventListener, sinceSeq = 0): () => void {
    const replay = [...this.history, ...this.previews.values()].sort((a, b) => a.seq - b.seq)
    for (const event of replay) {
      if (event.seq > sinceSeq) {
        try {
          listener(event)
        } catch {
          // 历史补发与 live 通知保持同一隔离语义：单个断开的 SSE
          // 响应不能阻止其他订阅者，也不能打断 Agent 运行。
        }
      }
    }

    if (!this.closed) this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get lastSeq(): number {
    return this.seq
  }

  /** A server admission must be durable before it can authorize paid work. */
  async persist(): Promise<void> {
    await this.flush()
  }

  /** State and terminal journal entry share one transaction. Publication stays
   * with the caller so existing post-run housekeeping retains its ordering. */
  async commitTerminal<T>(body: Extract<AgentStreamEventBody, { type: 'run.finished' | 'run.paused' }>,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    preceding: Array<Extract<AgentStreamEventBody, { type: 'message.start' | 'text.final' | 'error' }>> = [], options?: { timeout?: 20000 }): Promise<{ result: T; publish: () => void }> {
    if (this.closed || this.committingTerminal) throw new Error(`事件总线已关闭：${this.runId}`)
    this.committingTerminal = true
    try {
      await this.flush()
      if (this.seq + preceding.length >= 2147483647) throw new Error('事件序号已达上限，不能回绕')
      const events: AgentStreamEvent[] = [...preceding, body].map(item => ({ ...structuredClone(item), runId: this.runId, seq: ++this.seq, ts: new Date().toISOString() }))
      const transaction = prisma.$transaction(async tx => {
        const value = await work(tx)
        for (const event of events) await tx.agentRunEvent.create({ data: { runId: this.runId, seq: event.seq, type: event.type, payload: event as object } })
        return value
      }, options)
      this.terminalWrite = transaction
      const result = await transaction
      let published = false
      return { result, publish: () => {
        if (published) return
        published = true
        this.committingTerminal = false
        this.closed = true
        this.previews.clear()
        this.history.push(...events)
        for (const event of events) for (const listener of this.listeners) {
          try { listener(event) } catch { /* A disconnected listener cannot undo the commit. */ }
        }
      } }
    } catch (error) {
      this.committingTerminal = false
      // Do not reuse the reserved seq after an ambiguous commit response.
      throw error
    } finally {
      this.terminalWrite = null
    }
  }

  /** run 结束后调用：等待落库完成并释放内存 */
  async close(): Promise<void> {
    this.closed = true
    this.previews.clear()
    await this.flush()
    await this.terminalWrite
    this.listeners.clear()
    this.history = []
  }

  private reconcilePreviews(event: AgentStreamEvent): void {
    if (event.type === 'tool.preparation.end') for (const callId of event.callIds) {
      const preview = this.previews.get(callId)
      if (preview?.type === 'tool.delta' && preview.messageId === event.messageId) this.previews.delete(callId)
    }
    if (event.type === 'tool.call' || event.type === 'tool.result' || event.type === 'tool.deferred') this.previews.delete(event.callId)
    if (event.type === 'step.finish' || event.type === 'run.paused' || event.type === 'run.finished'
      || (event.type === 'error' && !event.recoverable)) this.previews.clear()
  }

  private flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise
    if (this.pendingPersist.length === 0) return Promise.resolve()

    this.flushPromise = this.persistPending().then(() => {
      this.flushPromise = null
      // An emit can land after persistPending returns but before this microtask.
      // Join that tail as well, so a closer never observes a false empty flush.
      if (this.pendingPersist.length > 0) return this.flush()
    }, (error: unknown) => {
      this.flushPromise = null
      // Prisma errors can contain SQL, credentials or event payloads. Log only
      // operational identifiers; propagate the error to the explicit closer.
      console.error('[agent-events] 事件持久化失败，批次保留待重试', {
        runId: this.runId,
        pendingCount: this.pendingPersist.length,
      })
      throw error
    })
    return this.flushPromise
  }

  private async persistPending(): Promise<void> {
    while (this.pendingPersist.length > 0) {
      const batch = this.pendingPersist.slice()
      await prisma.agentRunEvent.createMany({
        data: batch.map((event) => ({
          runId: this.runId,
          seq: event.seq,
          type: event.type,
          payload: event as object,
        })),
        // Retry an ambiguous commit using the same (runId, seq), never a new ID.
        skipDuplicates: true,
      })
      // Only the confirmed prefix is removed; emits during await remain queued.
      this.pendingPersist.splice(0, batch.length)
    }
  }
}

const busByRun = new Map<string, RunEventBus>()

export function createRunEventBus(runId: string, initialSeq = 0): RunEventBus {
  if (busByRun.has(runId)) throw new Error('事件总线尚未完成清理，不能覆盖')
  const bus = new RunEventBus(runId, initialSeq)
  busByRun.set(runId, bus)
  return bus
}

export function getRunEventBus(runId: string): RunEventBus | undefined {
  return busByRun.get(runId)
}

export async function disposeRunEventBus(runId: string, expectedBus?: RunEventBus): Promise<void> {
  const bus = busByRun.get(runId)
  if (expectedBus && bus !== expectedBus) return
  if (bus) {
    await bus.close()
    if (busByRun.get(runId) === bus) busByRun.delete(runId)
  }
}

/** Called only after admission has confirmed this run has no active executor.
 * A resume must flush the old journal before replacing it and continue its seq.
 * This is a single-process bridge; durable owner/epoch fencing is still required.
 */
export async function prepareRunEventResume(runId: string): Promise<number> {
  const memorySeq = busByRun.get(runId)?.lastSeq ?? 0
  await disposeRunEventBus(runId)
  const latest = await prisma.agentRunEvent.findFirst({
    where: { runId }, orderBy: { seq: 'desc' }, select: { seq: true },
  })
  return Math.max(memorySeq, latest?.seq ?? 0)
}

/** run 已结束（无 live 总线）时，从 DB 读事件做 replay */
export async function loadPersistedEvents(runId: string, sinceSeq = 0): Promise<AgentStreamEvent[]> {
  const records = await prisma.agentRunEvent.findMany({
    where: { runId, seq: { gt: sinceSeq } },
    orderBy: { seq: 'asc' },
  })

  return records.map((record) => record.payload as unknown as AgentStreamEvent)
}
