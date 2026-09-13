import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { hasUnsafeControls, limit, NOVEL_IMPORT_LIMITS, ParseContext } from './parsers/limits.js'
import { runConverter } from './parsers/isolated.js'
import { NovelImportParseError, type NovelImportParseOptions, type ParsedNovelImport } from './parsers/types.js'
import { DocumentWorkerError, type DocumentWorkerInput } from './worker-client.js'
import type { DocumentWorkerResult } from '../../../workers/document-import/protocol.js'

const require = createRequire(import.meta.url)
export const ISOLATED_NOVEL_IMPORT_LIMITS = Object.freeze({ heapMb: 256, youngHeapMb: 32, stackMb: 4, timeoutMs: 120_000 })
export type IsolatedNovelImportParserConfig = {
  /** Trusted operator/test settings; can reduce, never raise, the hard defaults. */
  heapMb?: number
  timeoutMs?: number
  resources?: boolean
  /** Trusted injected sandbox client. Never populated from a request body or environment in a parser. */
  nativeWorker?: { run(input: DocumentWorkerInput): Promise<DocumentWorkerResult> }
}

type ParserMessage =
  | { type: 'result'; value: ParsedNovelImport }
  | { type: 'error'; error: { code: string; message: string; source?: string } }
  | { type: 'converter'; id: number; module: 'mammoth' | 'pdf-parse' | 'sharp'; source: string; buffer: Uint8Array }
  | { type: 'native'; id: number; sourceId: string; sourceHash: string; format: 'doc' | 'pdf' | 'image'; buffer: Uint8Array }

const workerProgram = `
  const {parentPort,workerData}=require('node:worker_threads');
  console.log=console.info=console.warn=console.error=()=>{};
  const controller=new AbortController();
  parentPort.on('message',message=>{if(message.type==='abort')controller.abort();});
  (async()=>{
    const {require:tsRequire}=require(workerData.tsxApi);
    const {parseNovelImportFile}=tsRequire(workerData.entry,workerData.anchor);
    const nativeParser=workerData.nativeEnabled ? tsRequire(workerData.nativeEntry,workerData.anchor).parseNativeThroughSupervisor : undefined;
    const result=await parseNovelImportFile(Buffer.from(workerData.bytes),workerData.filename,{
      encoding:workerData.encoding,signal:controller.signal,resources:workerData.resources,nativeParser,durationMs:workerData.durationMs});
    parentPort.postMessage({type:'result',value:result});
  })().catch(error=>parentPort.postMessage({type:'error',error:{
    code:error && error.name==='NovelImportParseError' ? error.code : 'IMPORT_PARSE_FAILED',
    message:error && error.name==='NovelImportParseError' ? error.message : '文档隔离解析失败。',
    source:error && error.name==='NovelImportParseError' ? error.source : undefined
  }}));
`

/** Protects the API event loop from ALL parsing phases, including Markdown AST, DOCX XML,
 * ZIP scanning and CRC. Hard supervisor timer/termination does not depend on worker yields.
 * Heap limits are V8 limits; bounded Buffers are separate and OS total-RSS QA is still required.
 * Native child helpers are owned/killed by this supervisor, never orphaned by worker termination.
 */
export function createIsolatedNovelImportParser(config: IsolatedNovelImportParserConfig = {}) {
  const heapMb = config.heapMb ?? ISOLATED_NOVEL_IMPORT_LIMITS.heapMb
  const maximumTimeoutMs = config.nativeWorker ? NOVEL_IMPORT_LIMITS.nativeDurationMs : ISOLATED_NOVEL_IMPORT_LIMITS.timeoutMs
  const configuredTimeoutMs = config.timeoutMs ?? maximumTimeoutMs
  limit(Number.isInteger(heapMb) && heapMb >= 32 && heapMb <= ISOLATED_NOVEL_IMPORT_LIMITS.heapMb, '解析 Worker 堆配置无效。')
  limit(Number.isInteger(configuredTimeoutMs) && configuredTimeoutMs >= 1 && configuredTimeoutMs <= maximumTimeoutMs, '解析 Worker 截止时间配置无效。')
  return async (buffer: Buffer, filename: string, options: NovelImportParseOptions = {}): Promise<ParsedNovelImport> => {
    const timeoutMs = /\.(?:txt|md)$/i.test(filename) ? Math.min(configuredTimeoutMs, ISOLATED_NOVEL_IMPORT_LIMITS.timeoutMs) : configuredTimeoutMs
    if (options.signal?.aborted) throw new NovelImportParseError('IMPORT_CANCELLED', '文档解析已取消。')
    limit(buffer.length <= NOVEL_IMPORT_LIMITS.fileBytes, '单文件超过 50 MiB，请拆分文件。', filename)
    if (!filename || filename.length > 2048 || hasUnsafeControls(filename)) throw new NovelImportParseError('FILE_TYPE_MISMATCH', '文件名无效。')
    if (options.encoding && options.encoding.length > 64) throw new NovelImportParseError('IMPORT_ENCODING_AMBIGUOUS', '编码名称无效。')
    // Transfer only a dedicated snapshot, never detach a caller-owned/slab Buffer.
    const input = new ArrayBuffer(buffer.length)
    new Uint8Array(input).set(buffer)
    const controller = new AbortController()
    const context = new ParseContext(controller.signal, timeoutMs)
    return new Promise<ParsedNovelImport>((resolve, reject) => {
      const worker = new Worker(workerProgram, {
        eval: true, execArgv: [],
        workerData: { novelImportWorker: true, bytes: new Uint8Array(input), filename, encoding: options.encoding,
          resources: config.resources === true, nativeEnabled: !!config.nativeWorker, durationMs: timeoutMs,
          nativeEntry: fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './native-bridge.ts' : './native-bridge.js', import.meta.url)),
          tsxApi: require.resolve('tsx/cjs/api'), anchor: fileURLToPath(import.meta.url),
          entry: fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './parser.ts' : './parser.js', import.meta.url)) },
        transferList: [input],
        resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: ISOLATED_NOVEL_IMPORT_LIMITS.youngHeapMb, stackSizeMb: ISOLATED_NOVEL_IMPORT_LIMITS.stackMb },
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot', 'windir', 'temp', 'tmp', 'lang', 'lc_all'].includes(key.toLowerCase()))),
        stdout: true, stderr: true,
      })
      worker.stdout?.resume()
      worker.stderr?.resume()
      const converters = new Set<Promise<void>>()
      let settled = false
      const finish = (error?: Error, value?: ParsedNovelImport) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        controller.abort() // kills any parent-owned native child helper and waits for close
        try { worker.postMessage({ type: 'abort' }) } catch { /* already exited */ }
        void Promise.allSettled([worker.terminate(), ...converters]).then(() => {
          if (error) reject(error)
          // Cleanup is asynchronous and the caller may cancel after a result was received.
          // Do not deliver that result merely because the earlier abort listener was removed.
          else if (options.signal?.aborted) reject(new NovelImportParseError('IMPORT_CANCELLED', '文档解析已取消。'))
          else resolve(value!)
        })
      }
      const abort = () => finish(new NovelImportParseError('IMPORT_CANCELLED', '文档解析已取消。'))
      const timer = setTimeout(() => finish(new NovelImportParseError('IMPORT_LIMIT_EXCEEDED', '文档隔离解析超过截止时间，请拆分文件。')), timeoutMs)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
      worker.on('message', (message: ParserMessage) => {
        if (settled) return
        if (message.type === 'result') { finish(undefined, message.value); return }
        if (message.type === 'error') { finish(new NovelImportParseError(message.error.code, message.error.message, message.error.source)); return }
        if (message.type === 'native') {
          if (!config.nativeWorker || converters.size || !Number.isSafeInteger(message.id) ||
            !['doc', 'pdf', 'image'].includes(message.format) || !/^[a-zA-Z0-9_-]{1,80}$/.test(message.sourceId) ||
            !/^[a-f0-9]{64}$/.test(message.sourceHash) || !(message.buffer instanceof Uint8Array) || message.buffer.length > NOVEL_IMPORT_LIMITS.fileBytes) {
            finish(new NovelImportParseError('IMPORT_PROTOCOL_INVALID', '原生解析调度请求无效。')); return
          }
          const task = Promise.resolve().then(() => config.nativeWorker!.run({ sourceId: message.sourceId,
            sourceHash: message.sourceHash, format: message.format, bytes: message.buffer,
            timeoutMs: Math.max(1000, Math.min(timeoutMs, context.deadline - Date.now())), signal: controller.signal,
          })).then(value => {
            if (!settled) worker.postMessage({ type: 'native-result', id: message.id, value })
          }, error => {
            if (!settled) worker.postMessage({ type: 'native-result', id: message.id, error: {
              code: error instanceof DocumentWorkerError ? error.code : 'IMPORT_PARSE_FAILED', message: '原生文档解析失败，请查看来源或重试。',
            } })
          }).catch(() => finish(new NovelImportParseError('IMPORT_PARSE_FAILED', '原生解析进程通信失败。')))
            .finally(() => { converters.delete(task) })
          converters.add(task)
          return
        }
        if (message.type !== 'converter' || !['mammoth', 'pdf-parse', 'sharp'].includes(message.module) ||
          typeof message.source !== 'string' || message.source.length > 50_000 ||
          !(message.buffer instanceof Uint8Array) || message.buffer.length > NOVEL_IMPORT_LIMITS.fileBytes || converters.size) {
          finish(new NovelImportParseError('IMPORT_PROTOCOL_INVALID', '解析 Worker 返回无效转换请求。')); return
        }
        // Private worker channel: source is checked-in converter code, never upload contents.
        // Only the supervisor owns the child process lifecycle, including Worker OOM/timeout.
        // Buffer conversion and runConverter's initial context.check can throw before a
        // Promise is returned. Keep them inside the rejection chain, never EventEmitter.
        const task = Promise.resolve().then(() =>
          runConverter(message.module, message.source, Buffer.from(message.buffer), context),
        ).then(value => {
          if (!settled) worker.postMessage({ type: 'converter-result', id: message.id, value })
        }, error => {
          if (!settled) worker.postMessage({ type: 'converter-result', id: message.id, error: {
            code: error instanceof NovelImportParseError ? error.code : 'IMPORT_CONVERT_FAILED',
            message: error instanceof NovelImportParseError ? error.message : '文档转换失败。',
            source: error instanceof NovelImportParseError ? error.source : undefined,
          } })
        }).catch(error => {
          // A reply can also fail if the Worker exits before its exit event is delivered.
          finish(error instanceof NovelImportParseError ? error :
            new NovelImportParseError('IMPORT_PARSE_FAILED', '无法向解析 Worker 返回转换结果。'))
        }).finally(() => { converters.delete(task) })
        converters.add(task)
      })
      worker.once('error', (error) => finish(new NovelImportParseError(
        'code' in error && error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'IMPORT_LIMIT_EXCEEDED' : 'IMPORT_PARSE_FAILED',
        '文档隔离解析失败或超过 Worker 堆内存限制。')))
      worker.once('exit', () => { if (!settled) finish(new NovelImportParseError('IMPORT_PARSE_FAILED', '文档解析 Worker 意外退出。')) })
    })
  }
}

/** Use this for untrusted uploads. Pure parseNovelImportFile remains available for unit tests. */
export const parseNovelImportFileIsolated = createIsolatedNovelImportParser()
