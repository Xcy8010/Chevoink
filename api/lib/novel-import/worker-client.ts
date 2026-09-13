import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  decodeWorkerResponse, DocumentWorkerError, WORKER_LIMITS, WORKER_VERSION, workerRequestSchema,
  type DocumentWorkerResult, type WorkerRequest,
} from '../../../workers/document-import/protocol.js'

export { DocumentWorkerError, WORKER_LIMITS }
export type { DocumentWorkerResult, WorkerArtifact, WorkerPage } from '../../../workers/document-import/protocol.js'

export interface DocumentWorkerConfig {
  /** Dedicated private directory on the SAME Linux host as the Docker daemon. Never a shared upload root. */
  stagingRoot: string
  /** Reviewed local image ID (sha256:...) or repository@sha256:..., never a mutable tag. */
  image: string
  /** Trusted operator config, not request input. No remote Docker contexts/hosts are inherited. */
  dockerExecutable?: string
}
export interface DocumentWorkerInput {
  sourceId: string
  sourceHash: string
  format: WorkerRequest['format']
  bytes: Uint8Array
  signal?: AbortSignal
  timeoutMs?: number
  ocrLanguages?: WorkerRequest['ocrLanguages']
}
const healthSchema = z.object({ version: z.literal('document-import-health/1'), ready: z.literal(true),
  parserVersion: z.string().min(1).max(120), capabilities: z.array(z.enum(['doc', 'pdf', 'ocr:chi_sim+eng', 'ocr:chi_tra+eng', 'ocr:eng'])).length(5),
  languages: z.object({ eng: z.string().regex(/^[a-f0-9]{64}$/), chi_sim: z.string().regex(/^[a-f0-9]{64}$/),
    chi_tra: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict()
export type DocumentWorkerHealth = z.infer<typeof healthSchema>

function imageIsPinned(image: string) {
  return /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64})$/.test(image)
}

/** Exported for contract tests; all arguments are from the supervisor, never uploaded JSON. */
export function documentWorkerDockerArgs(image: string, inputDirectory: string, containerName: string) {
  if (!imageIsPinned(image) || !path.isAbsolute(inputDirectory) || /[,\r\n\0]/.test(inputDirectory) ||
      !/^document-import-[a-f0-9-]{36}$/.test(containerName)) throw new DocumentWorkerError('IMPORT_PROTOCOL_INVALID')
  return ['run', '--rm', '--pull=never', '--name', containerName,
    '--network=none', '--read-only', '--user=10001:10001', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--pids-limit=96', '--cpus=1',
    '--memory=1g', '--memory-swap=1g', '--ipc=none', '--restart=no', '--stop-timeout=1',
    '--label=org.chevoink.document-import=protocol-v1', '--ulimit=nofile=256:256',
    '--ulimit=fsize=67108864:67108864', '--ulimit=core=0:0', '--log-driver=none',
    '--tmpfs=/work:rw,noexec,nosuid,nodev,size=268435456,uid=10001,gid=10001,mode=700',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864,uid=10001,gid=10001,mode=1777',
    '--mount', `type=bind,src=${inputDirectory},dst=/input,readonly`,
    '--env=HOME=/work', '--env=TMPDIR=/tmp', '--env=OMP_THREAD_LIMIT=1',
    '--env=LANG=C.UTF-8', '--env=PYTHONDONTWRITEBYTECODE=1',
    '--entrypoint=/usr/bin/python3', image, '/app/main.py']
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  // Do not forward DATABASE_URL, cloud credentials, proxy variables, DOCKER_HOST or DOCKER_CONTEXT.
  return { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONFIG: '/nonexistent/chevoink-document-import-config' }
}

function invokeDocker(executable: string, args: string[], timeoutMs: number, signal?: AbortSignal,
  maxBytes = WORKER_LIMITS.responseBytes): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DocumentWorkerError('IMPORT_CANCELLED')); return }
    const child = spawn(executable, args, { shell: false, windowsHide: true, env: dockerEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0; let settled = false
    const finish = (error?: DocumentWorkerError, data?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) { child.kill('SIGKILL'); reject(error) } else resolve(data ?? Buffer.alloc(0))
    }
    const abort = () => finish(new DocumentWorkerError('IMPORT_CANCELLED'))
    const timer = setTimeout(() => finish(new DocumentWorkerError('IMPORT_DEADLINE_EXCEEDED')), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout.on('data', (part: Buffer) => {
      if (settled) return
      size += part.length
      if (size > maxBytes) finish(new DocumentWorkerError('IMPORT_LIMIT_EXCEEDED'))
      else chunks.push(part)
    })
    // Drain and discard logs: native errors may contain private text or disk paths.
    child.stderr.on('data', () => {})
    child.on('error', () => finish(new DocumentWorkerError('IMPORT_WORKER_UNAVAILABLE')))
    child.on('close', code => code === 0 ? finish(undefined, Buffer.concat(chunks)) :
      finish(new DocumentWorkerError(code === 125 || code === 127 ? 'IMPORT_WORKER_UNAVAILABLE' : 'IMPORT_PARSE_FAILED')))
  })
}

async function assertPrivateRoot(root: string) {
  if (!path.isAbsolute(root) || path.parse(root).root === root || /[,\r\n\0]/.test(root)) throw new DocumentWorkerError('IMPORT_PROTOCOL_INVALID')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== path.resolve(root) ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new DocumentWorkerError('IMPORT_PROTOCOL_INVALID')
  return path.resolve(root)
}

/** One active job per client instance; caller owns per-user quota, leases, auth and source retention. */
export function createDocumentImportWorker(config: DocumentWorkerConfig) {
  if (!imageIsPinned(config.image)) throw new DocumentWorkerError('IMPORT_PROTOCOL_INVALID')
  const executable = config.dockerExecutable ?? 'docker'
  if (executable !== 'docker' && !path.isAbsolute(executable)) throw new DocumentWorkerError('IMPORT_PROTOCOL_INVALID')
  let busy = false
  const execute = async (input: DocumentWorkerInput, health = false): Promise<DocumentWorkerResult | DocumentWorkerHealth> => {
      if (busy) throw new DocumentWorkerError('IMPORT_LIMIT_EXCEEDED')
      if (input.signal?.aborted) throw new DocumentWorkerError('IMPORT_CANCELLED')
      // Operational sandbox is Linux Docker only. No installed desktop LibreOffice fallback.
      if (process.platform !== 'linux') throw new DocumentWorkerError('IMPORT_WORKER_UNAVAILABLE')
      if (!(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > WORKER_LIMITS.inputBytes)
        throw new DocumentWorkerError('IMPORT_LIMIT_EXCEEDED')
      const parsed = workerRequestSchema.safeParse({ version: WORKER_VERSION, requestId: randomUUID(),
        sourceId: input.sourceId, sourceHash: input.sourceHash, format: input.format,
        timeoutMs: input.timeoutMs ?? WORKER_LIMITS.taskMs, ocrLanguages: input.ocrLanguages ?? 'chi_sim+eng' })
      if (!parsed.success) throw new DocumentWorkerError('IMPORT_PROTOCOL_INVALID')
      const request = parsed.data
      // Snapshot once so caller mutation cannot change staged bytes after hash validation.
      const bytes = Buffer.from(input.bytes)
      if (createHash('sha256').update(bytes).digest('hex') !== request.sourceHash) throw new DocumentWorkerError('IMPORT_PROTOCOL_INVALID')
      busy = true
      let directory: string | undefined
      let root: string | undefined
      let started = false
      let cleanupFailed = false
      let failure: DocumentWorkerError | undefined
      let result: DocumentWorkerResult | DocumentWorkerHealth | undefined
      const containerName = `document-import-${request.requestId}`
      const deadline = Date.now() + request.timeoutMs
      try {
        root = await assertPrivateRoot(config.stagingRoot)
        directory = await mkdtemp(path.join(root, 'job-'))
        // Parent remains 0700. The mounted child is traversable by container UID 10001 only via Docker.
        await chmod(directory, 0o755)
        await writeFile(path.join(directory, 'source'), bytes, { flag: 'wx', mode: 0o444 })
        await writeFile(path.join(directory, 'request.json'), JSON.stringify(request), { flag: 'wx', mode: 0o444 })
        if (input.signal?.aborted) throw new DocumentWorkerError('IMPORT_CANCELLED')
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new DocumentWorkerError('IMPORT_DEADLINE_EXCEEDED')
        started = true
        const args = documentWorkerDockerArgs(config.image, directory, containerName)
        if (health) args[args.length - 1] = '/app/health.py'
        const raw = await invokeDocker(executable, args, remaining, input.signal, health ? 16384 : WORKER_LIMITS.responseBytes)
        if (input.signal?.aborted) throw new DocumentWorkerError('IMPORT_CANCELLED')
        if (health) {
          try { result = healthSchema.parse(JSON.parse(raw.toString('utf8'))) }
          catch { throw new DocumentWorkerError('IMPORT_PROTOCOL_INVALID') }
        } else result = decodeWorkerResponse(raw, request)
      } catch (error) {
        failure = error instanceof DocumentWorkerError ? error : new DocumentWorkerError('IMPORT_WORKER_UNAVAILABLE')
      } finally {
        if (started) {
          // Removing CLI alone does not stop its container. Name is supervisor-generated and exact.
          // A failed rm is checked against current daemon inventory; daemon loss is an explicit failure.
          // Delayed create / supervisor death still requires the operator's labelled-container janitor.
          try {
            await invokeDocker(executable, ['rm', '--force', containerName], 5000, undefined, 4096)
          } catch {
            try {
              const remaining = await invokeDocker(executable, ['ps', '-a', '--filter', `name=^/${containerName}$`, '--format', '{{.ID}}'], 5000, undefined, 4096)
              if (remaining.toString().trim()) cleanupFailed = true
            } catch { cleanupFailed = true }
          }
        }
        if (directory && root) {
          try {
            // Only our random immediate child; never recursively remove stagingRoot.
            if (path.dirname(directory) !== root || !path.basename(directory).startsWith('job-') ||
                (await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) cleanupFailed = true
            else await rm(directory, { recursive: true, force: true, maxRetries: 1 })
          } catch { cleanupFailed = true }
        }
        busy = false
      }
      if (cleanupFailed) throw new DocumentWorkerError('IMPORT_CLEANUP_FAILED')
      if (failure) throw failure
      if (input.signal?.aborted) throw new DocumentWorkerError('IMPORT_CANCELLED')
      if (!result) throw new DocumentWorkerError('IMPORT_PROTOCOL_INVALID')
      return result
  }
  return {
    async run(input: DocumentWorkerInput): Promise<DocumentWorkerResult> {
      const result = await execute(input)
      if ('ready' in result) throw new DocumentWorkerError('IMPORT_PROTOCOL_INVALID')
      return result
    },
    /** Real native dependency probe through identical sandbox/cleanup limits; no user bytes. */
    async health(options: { signal?: AbortSignal } = {}): Promise<DocumentWorkerHealth> {
      const bytes = Buffer.from('document-import-health/1')
      const result = await execute({ sourceId: 'health', sourceHash: createHash('sha256').update(bytes).digest('hex'),
        format: 'pdf', bytes, timeoutMs: 15_000, signal: options.signal }, true)
      if (!('ready' in result)) throw new DocumentWorkerError('IMPORT_PROTOCOL_INVALID')
      return result
    },
  }
}
