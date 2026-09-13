import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDocumentImportWorker, WORKER_LIMITS } from '../../../api/lib/novel-import/worker-client.js'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
// Windows cannot express Linux directory mode bits; only the metadata check is substituted.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const stat = await actual.lstat(...args)
    stat.mode = 0o40700
    return stat
  } }
})
type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }
const originalPlatform = process.platform
let parent: string
let sourceDir: string
let behavior: 'ok' | 'hold' | 'invalid' | 'overflow' | 'unavailable'
let cleanupBreaks = false
let held: FakeChild | undefined
const bytes = Buffer.from('SYNTHETIC opaque bytes; not parsed by a native library')
const input = { sourceId: 'synthetic', sourceHash: createHash('sha256').update(bytes).digest('hex'), format: 'pdf' as const, bytes }

beforeEach(async () => {
  parent = await mkdtemp(path.join(os.tmpdir(), 'document-worker-tests-'))
  sourceDir = path.join(parent, 'private-staging')
  behavior = 'ok'; cleanupBreaks = false; held = undefined
  Object.defineProperty(process, 'platform', { value: 'linux' })
  spawnMock.mockReset().mockImplementation((_executable: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) })
    queueMicrotask(() => {
      if (args[0] === 'rm') { child.emit('close', cleanupBreaks ? 1 : 0); return }
      if (args[0] === 'ps') { child.stdout.write(cleanupBreaks ? 'remaining-container' : ''); child.emit('close', 0); return }
      if (behavior === 'hold') { held = child; return }
      if (behavior === 'unavailable') { child.emit('error', new Error('sensitive host path')); return }
      if (behavior === 'invalid') { child.stdout.write('{broken'); child.emit('close', 0); return }
      if (behavior === 'overflow') { child.stdout.write(Buffer.alloc(WORKER_LIMITS.responseBytes + 1)); return }
      const mount = args.find(a => a.startsWith('type=bind,src='))!
      const dir = mount.slice('type=bind,src='.length).split(',dst=')[0]
      const request = JSON.parse(readFileSync(path.join(dir, 'request.json'), 'utf8'))
      child.stderr.write('private document text must never escape through logs')
      child.stdout.write(JSON.stringify({ version: request.version, requestId: request.requestId, sourceId: request.sourceId,
        sourceHash: request.sourceHash, format: request.format, parserVersion: 'lo25.2-pymupdf1.25-tesseract5.5-prototype1',
        outcome: 'parsed', error: null, warnings: [], totalPages: 1, artifacts: [], convertedArtifactId: null,
        pages: [{ page: 1, width: 100, height: 100, state: 'verified_blank', blocks: [], regions: [], warnings: [] }],
        coverage: { complete: true, processedPages: 1, counts: { native: 0, ocr: 0, needs_review: 0, failed: 0, verified_blank: 1 } } }))
      child.emit('close', 0)
    })
    return child
  })
})
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  // Only a freshly generated test child under the OS temp directory.
  if (path.dirname(parent) === os.tmpdir() && path.basename(parent).startsWith('document-worker-tests-'))
    await rm(parent, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
const worker = () => createDocumentImportWorker({ stagingRoot: sourceDir, image: 'sha256:'+'a'.repeat(64) })
async function waitHeld() { for (let i = 0; i < 100 && !held; i++) await new Promise(resolve => setTimeout(resolve, 5)); expect(held).toBeDefined() }

describe('supervisor lifecycle with fake Docker process and real private staging', () => {
  it('returns verified result, sends no secrets, stops container and removes only its staging', async () => {
    vi.stubEnv('DATABASE_URL', 'fake-secret'); vi.stubEnv('DOCKER_HOST', 'tcp://untrusted'); vi.stubEnv('API_KEY', 'fake-key')
    expect((await worker().run(input)).coverage.complete).toBe(true)
    expect(await readdir(sourceDir)).toEqual([])
    expect(spawnMock.mock.calls[0][2]).toMatchObject({ shell: false, windowsHide: true })
    expect(spawnMock.mock.calls[0][2].env).not.toHaveProperty('DATABASE_URL')
    expect(spawnMock.mock.calls[0][2].env).not.toHaveProperty('DOCKER_HOST')
    expect(spawnMock.mock.calls[0][2].env).not.toHaveProperty('API_KEY')
    expect(spawnMock.mock.calls[1][1].slice(0, 2)).toEqual(['rm', '--force'])
  })
  it.each(['invalid', 'overflow', 'unavailable'] as const)('cleans up on %s result without raw error leakage', async mode => {
    behavior = mode
    const expected = { invalid: 'IMPORT_PROTOCOL_INVALID', overflow: 'IMPORT_LIMIT_EXCEEDED', unavailable: 'IMPORT_WORKER_UNAVAILABLE' }[mode]
    await expect(worker().run(input)).rejects.toMatchObject({ code: expected, message: expected })
    expect(await readdir(sourceDir)).toEqual([])
  })
  it('aborts active process, removes container, ignores late output and releases single execution slot', async () => {
    behavior = 'hold'
    const client = worker(); const controller = new AbortController()
    const running = client.run({ ...input, signal: controller.signal })
    const rejection = expect(running).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
    await waitHeld()
    await expect(client.run(input)).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
    controller.abort(); await rejection
    expect(held!.kill).toHaveBeenCalledWith('SIGKILL')
    held!.stdout.write('late output'); held!.emit('close', 0)
    expect(await readdir(sourceDir)).toEqual([])
    behavior = 'ok'; expect((await client.run(input)).coverage.complete).toBe(true)
  })
  it('enforces finite wall deadline independently of a silent child', async () => {
    behavior = 'hold'
    await expect(worker().run({ ...input, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'IMPORT_DEADLINE_EXCEEDED' })
    expect(await readdir(sourceDir)).toEqual([])
  })
  it('surfaces cleanup uncertainty rather than reporting success', async () => {
    cleanupBreaks = true
    await expect(worker().run(input)).rejects.toMatchObject({ code: 'IMPORT_CLEANUP_FAILED' })
  })
  it('rejects hash mismatch before invoking Docker or creating source staging', async () => {
    await expect(worker().run({ ...input, sourceHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'IMPORT_PROTOCOL_INVALID' })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(await readdir(parent)).toEqual([])
  })
  it('does not publish a result if cancellation arrives during container cleanup', async () => {
    const controller = new AbortController()
    const implementation = spawnMock.getMockImplementation()!
    spawnMock.mockImplementation((...args: unknown[]) => {
      if ((args[1] as string[])[0] === 'rm') controller.abort()
      return implementation(...args)
    })
    await expect(worker().run({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
    expect(await readdir(sourceDir)).toEqual([])
  })
})
