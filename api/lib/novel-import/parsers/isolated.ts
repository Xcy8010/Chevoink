import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { ParseContext } from './limits.js'
import { NovelImportParseError } from './types.js'

const require = createRequire(import.meta.url)
const MAX_PROTOCOL_BYTES = 128 * 1024 * 1024
let converterSequence = 0

function converterThroughSupervisor<T>(module: 'mammoth' | 'pdf-parse', source: string, buffer: Buffer, context: ParseContext): Promise<T> {
  const port = parentPort!
  const id = ++converterSequence
  return new Promise<T>((resolve, reject) => {
    const clean = () => { port.removeListener('message', reply); context.signal?.removeEventListener('abort', abort) }
    const abort = () => { clean(); reject(new NovelImportParseError('IMPORT_CANCELLED', '文档解析已取消。')) }
    const reply = (message: { type?: string; id?: number; value?: T; error?: { code: string; message: string; source?: string } }) => {
      if (message.type !== 'converter-result' || message.id !== id) return
      clean()
      if (message.error) reject(new NovelImportParseError(message.error.code, message.error.message, message.error.source))
      else resolve(message.value as T)
    }
    port.on('message', reply)
    context.signal?.addEventListener('abort', abort, { once: true })
    if (context.signal?.aborted) abort()
    else port.postMessage({ type: 'converter', id, module, source, buffer })
  })
}

/** Bounded local Node parsing, never a shell/DOC converter. Native canvas teardown is unsafe
 * in worker_threads on some hosts, so isolate its lifetime in a child process.
 * V8 heap limits do not constitute a hard RSS/OS sandbox; production orchestration supplies that.
 */
export function runConverter<T>(module: 'mammoth' | 'pdf-parse', source: string, buffer: Buffer, context: ParseContext): Promise<T> {
  context.check()
  // Whole-parser isolation delegates subprocess ownership to its supervisor. A terminated
  // or OOM Worker must never leave a native helper running without an owner able to kill it.
  if (!isMainThread && parentPort && workerData?.novelImportWorker === true) return converterThroughSupervisor(module, source, buffer, context)
  return new Promise<T>((resolve, reject) => {
    // Only trusted module resolution and checked-in converter code enter -e; document bytes
    // go to stdin, never command arguments, filenames, environment variables or executable code.
    const program = `
      console.log = console.info = console.warn = console.error = () => {};
      const library = require(${JSON.stringify(require.resolve(module))});
      const chunks = []; let inputBytes = 0;
      process.stdin.on('data', chunk => {
        inputBytes += chunk.length;
        if (inputBytes > 52428800) process.exit(2);
        chunks.push(chunk);
      });
      process.stdin.on('end', async () => {
        const buffer = Buffer.concat(chunks); chunks.length = 0;
        async function convert() { ${source} }
        let message;
        try { message = {value: await convert()}; }
        catch (error) { message = {failure:
          error && error.name === 'PasswordException' ? 'IMPORT_PASSWORD_REQUIRED' :
          error && error.code === 'IMPORT_LIMIT_EXCEEDED' ? error.code : 'IMPORT_CONVERT_FAILED'}; }
        const output = JSON.stringify(message);
        if (Buffer.byteLength(output) > ${MAX_PROTOCOL_BYTES}) process.exit(2);
        process.stdout.write(output, () => process.exit(0));
      });
    `
    const child = spawn(process.execPath, ['--max-old-space-size=256', '--input-type=commonjs', '-e', program], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      // Do not inherit NODE_OPTIONS/preload hooks or provider credentials into document parsing.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot', 'windir', 'temp', 'tmp', 'lang', 'lc_all'].includes(key.toLowerCase()))),
    })
    let failure: Error | undefined
    let outputBytes = 0
    const chunks: Buffer[] = []
    const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL') }
    const cancel = () => stop(new NovelImportParseError('IMPORT_CANCELLED', '文档解析已取消。'))
    const timer = setTimeout(() => stop(new NovelImportParseError('IMPORT_LIMIT_EXCEEDED', '文档解析超时，请拆分文件。')), Math.max(1, context.deadline - Date.now()))
    context.signal?.addEventListener('abort', cancel, { once: true })
    if (context.signal?.aborted) cancel()
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_PROTOCOL_BYTES) stop(new NovelImportParseError('IMPORT_LIMIT_EXCEEDED', '文档解析输出超过安全限制。'))
      else chunks.push(chunk)
    })
    child.stdin.on('error', () => { /* EPIPE after cancellation/startup failure is handled by close. */ })
    child.once('error', () => { failure ??= new NovelImportParseError('IMPORT_CONVERT_FAILED', '无法启动文档解析子进程。') })
    child.once('close', (code) => {
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', cancel)
      if (failure) { reject(failure); return }
      if (code !== 0) { reject(new NovelImportParseError(code === 2 ? 'IMPORT_LIMIT_EXCEEDED' : 'IMPORT_CONVERT_FAILED', '文档解析子进程失败或超出资源限制。')); return }
      try {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { value?: T; failure?: string }
        if (message.failure) reject(new NovelImportParseError(message.failure, message.failure === 'IMPORT_PASSWORD_REQUIRED' ? '请移除文件密码后重试。' : '文档转换失败或超过资源限制。'))
        else if (!('value' in message)) reject(new NovelImportParseError('IMPORT_CONVERT_FAILED', '文档解析返回无效结果。'))
        else resolve(message.value as T)
      } catch { reject(new NovelImportParseError('IMPORT_CONVERT_FAILED', '文档解析返回无效结果。')) }
    })
    child.stdin.end(buffer)
  })
}
