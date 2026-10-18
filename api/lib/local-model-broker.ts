import { randomUUID } from 'node:crypto'
import { DataAccessError } from './prisma.js'

export class LocalModelTransportError extends DataAccessError {
  constructor(readonly dispatched: boolean, message = '本地模型连接已断开；未自动重发请求，请保持连接器运行。') { super(503, 'LOCAL_MODEL_UNAVAILABLE', message) }
}
type Job = { id: string; body: string }
type Pending = { job: Job; key: string; delivered: boolean; sequence: number; bytes: number; settled: boolean;
  controller?: ReadableStreamDefaultController<Uint8Array>; resolve: (response: Response) => void; reject: (error: Error) => void;
  dispose: () => void; receivedHeaders: () => void; drain?: () => void }
type Device = { seen: number; poll?: { resolve: (job: Job | null) => void; dispose: () => void }; request?: string }
type Frame = { sequence: number; status?: number; contentType?: string; chunk?: string; done?: boolean; error?: boolean }

/** One API process owns transient transport, never durable task/effect authority.
 * Requests are delivered once. A restart loses transport and existing durable
 * unknown/recovery rules decide the task; no connector can replay a job. */
export class LocalModelBroker {
  private devices = new Map<string, Device>()
  private requests = new Map<string, Pending>()
  constructor(private headerTimeout = 300_000, private totalTimeout = 1_200_000) {}
  online(key: string): boolean { const d = this.devices.get(key); return !!d && Date.now() - d.seen < 40_000 }
  active(key: string, id: string): boolean { const p = this.requests.get(id); return !!p && p.key === key && p.delivered }
  private device(key: string): Device {
    for (const [id, d] of this.devices) if (!d.poll && !d.request && Date.now() - d.seen > 60_000) this.devices.delete(id)
    let d = this.devices.get(key)
    if (!d) { if (this.devices.size >= 128) throw new LocalModelTransportError(false, '本地连接器容量已满。'); d = { seen: 0 }; this.devices.set(key, d) }
    return d
  }
  poll(key: string, signal: AbortSignal): Promise<Job | null> {
    signal.throwIfAborted()
    const d = this.device(key)
    if (d.poll) throw new LocalModelTransportError(false, '同一模型已有连接器在线，请先关闭另一实例。')
    d.seen = Date.now()
    const pending = d.request && this.requests.get(d.request)
    if (pending && !pending.delivered) { pending.delivered = true; return Promise.resolve(pending.job) }
    return new Promise((resolve, reject) => {
      const finish = (job: Job | null) => { cleanup(); resolve(job) }
      const abort = () => { cleanup(); reject(signal.reason) }
      const timer = setTimeout(() => finish(null), 20_000)
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); if (d.poll?.resolve === finish) d.poll = undefined }
      d.poll = { resolve: finish, dispose: cleanup }
      signal.addEventListener('abort', abort, { once: true })
    })
  }
  request(key: string, body: string, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted()
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) return Promise.reject(new LocalModelTransportError(false, '本地模型请求超过大小上限。'))
    if (!this.online(key)) return Promise.reject(new LocalModelTransportError(false, '本地连接器未在线，请先在提供模型的电脑上启动连接器。'))
    const d = this.device(key)
    if (d.request || this.requests.size >= 128) return Promise.reject(new LocalModelTransportError(false, '本地模型正在处理请求，请稍后再试。'))
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const abort = () => this.fail(id)
      const headers = setTimeout(abort, this.headerTimeout)
      const total = setTimeout(abort, this.totalTimeout)
      const dispose = () => { clearTimeout(headers); clearTimeout(total); signal?.removeEventListener('abort', abort); this.requests.delete(id); if (d.request === id) d.request = undefined }
      const pending: Pending = { job: { id, body }, key, delivered: false, sequence: 0, bytes: 0, settled: false, resolve, reject, dispose, receivedHeaders: () => clearTimeout(headers) }
      this.requests.set(id, pending); d.request = id
      signal?.addEventListener('abort', abort, { once: true })
      if (d.poll) { pending.delivered = true; d.poll.resolve(pending.job) }
    })
  }
  private fail(id: string) {
    const p = this.requests.get(id)
    if (!p) return
    const error = new LocalModelTransportError(p.delivered)
    if (p.settled) { try { p.controller?.error(error) } catch { /* A consumer may already have cancelled its stream. */ } } else p.reject(error)
    p.drain?.(); p.dispose()
  }
  revoke(key: string) { const d = this.devices.get(key); if (d?.request) this.fail(d.request); d?.poll?.resolve(null); this.devices.delete(key) }
  async frame(key: string, id: string, frame: Frame): Promise<void> {
    const p = this.requests.get(id)
    if (!p || p.key !== key || !p.delivered || p.sequence !== frame.sequence) throw new LocalModelTransportError(false, '连接器请求已过期或响应顺序无效。')
    this.device(key).seen = Date.now()
    if (frame.error) { this.fail(id); return }
    if (frame.sequence === 0) {
      if (!Number.isInteger(frame.status) || frame.status! < 200 || frame.status! > 599 || [204, 205, 304].includes(frame.status!) || frame.chunk || frame.done) throw new LocalModelTransportError(true, '连接器响应头无效。')
      const stream = new ReadableStream<Uint8Array>({
        start: controller => { p.controller = controller },
        pull: () => { p.drain?.(); p.drain = undefined },
        cancel: () => this.fail(id),
      }, { highWaterMark: 65_536, size: chunk => chunk.byteLength })
      p.settled = true
      p.receivedHeaders()
      p.resolve(new Response(stream, { status: frame.status, headers: { 'content-type': frame.contentType === 'text/event-stream' ? 'text/event-stream' : 'application/json' } }))
    } else {
      if (frame.status !== undefined || frame.contentType !== undefined || frame.done && frame.chunk) throw new LocalModelTransportError(true, '连接器响应帧无效。')
      if (frame.chunk) {
        if (frame.chunk.length > 44_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.chunk)) { this.fail(id); throw new LocalModelTransportError(true, '连接器响应片段无效。') }
        const bytes = Buffer.from(frame.chunk, 'base64'); p.bytes += bytes.length
        if (p.bytes > 16 * 1024 * 1024) { this.fail(id); throw new LocalModelTransportError(true, '本地模型响应超过大小上限。') }
        p.controller!.enqueue(bytes)
      }
      if (frame.done) { p.controller!.close(); p.dispose() }
    }
    p.sequence++
    if (!frame.done && p.controller && p.controller.desiredSize !== null && p.controller.desiredSize <= 0) await new Promise<void>(resolve => { p.drain = resolve })
  }
}
export const localModelBroker = new LocalModelBroker()
