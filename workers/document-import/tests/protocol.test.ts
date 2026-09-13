import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { documentWorkerDockerArgs, createDocumentImportWorker } from '../../../api/lib/novel-import/worker-client.js'
import { decodeWorkerResponse, WORKER_VERSION, workerRequestSchema, type WorkerResponse } from '../protocol.js'
import path from 'node:path'

const request = workerRequestSchema.parse({ version: WORKER_VERSION, requestId: 'req1', sourceId: 'src1',
  sourceHash: 'a'.repeat(64), format: 'pdf', timeoutMs: 1000, ocrLanguages: 'chi_sim+eng' })
function valid(): WorkerResponse {
  return { ...request, parserVersion: 'lo25.2-pymupdf1.25-tesseract5.5-prototype1', outcome: 'parsed', error: null,
    warnings: [], totalPages: 1, convertedArtifactId: null, artifacts: [],
    pages: [{ page: 1, width: 100, height: 100, state: 'native', warnings: [], regions: [],
      blocks: [{ id: 'p1-n1', text: '原文不改写', method: 'native', bbox: [1, 1, 90, 20], confidence: null, regionId: null, duplicateOf: null }] }],
    coverage: { complete: true, processedPages: 1, counts: { native: 1, ocr: 0, needs_review: 0, failed: 0, verified_blank: 0 } },
  } as WorkerResponse
}
function wire(result: WorkerResponse) {
  // Request-only fields do not belong in response.
  const copy = { ...result } as Record<string, unknown>
  delete copy.timeoutMs; delete copy.ocrLanguages
  return Buffer.from(JSON.stringify(copy))
}
describe('strict offline wire protocol', () => {
  it('retains original text and requires hash/source/request identity', () => {
    expect(decodeWorkerResponse(wire(valid()), request).pages[0].blocks[0].text).toBe('原文不改写')
    for (const key of ['sourceId', 'sourceHash', 'requestId'] as const) {
      const r = valid(); r[key] = key === 'sourceHash' ? 'b'.repeat(64) : 'other'
      expect(() => decodeWorkerResponse(wire(r), request)).toThrow('IMPORT_PROTOCOL_INVALID')
    }
  })
  it.each(['../escape', '/etc/passwd', 'C:\\secret', 'a;curl', 'a\nflag', '--network=host'])('rejects source ID injection %s', sourceId => {
    expect(workerRequestSchema.safeParse({ ...request, sourceId }).success).toBe(false)
  })
  it('rejects arbitrary paths, extra credentials, bad languages and limits', () => {
    for (const extra of [{ inputPath: '/etc/passwd' }, { apiKey: 'fake' }, { ocrLanguages: 'eng;sh' },
      { timeoutMs: 0 }, { timeoutMs: 1_800_001 }, { timeoutMs: 2.2 }]) {
      expect(workerRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false)
    }
  })
  it('rejects missing, repeated or unordered pages and forged coverage', () => {
    const mutations: ((r: WorkerResponse) => void)[] = [r => { r.totalPages = 2 }, r => { r.pages[0].page = 2 },
      r => { r.pages.push(r.pages[0]); r.totalPages = 2 }, r => { r.coverage.counts.native = 2 },
      r => { r.pages[0].state = 'needs_review' }, r => { r.coverage.processedPages = 0 },
      r => { r.totalPages = null }, r => { r.pages[0].blocks[0].bbox = [0, 0, 10000, 1] }]
    for (const mutate of mutations) { const r = valid(); mutate(r); expect(() => decodeWorkerResponse(wire(r), request)).toThrow() }
  })
  it('retains good pages alongside explicit failed pages, never complete', () => {
    const r = valid()
    r.totalPages = 2; r.outcome = 'needs_review'; r.coverage.complete = false; r.coverage.counts.failed = 1
    r.pages.push({ page: 2, width: 0, height: 0, state: 'failed', warnings: ['IMPORT_DEADLINE_EXCEEDED'], blocks: [], regions: [] })
    expect(decodeWorkerResponse(wire(r), request).coverage).toEqual(r.coverage)
  })
  it('does not allow a blank classification to hide text or image regions', () => {
    const r = valid(); r.pages[0].state = 'verified_blank'; r.coverage.counts.native = 0; r.coverage.counts.verified_blank = 1
    expect(() => decodeWorkerResponse(wire(r), request)).toThrow()
  })
  it('rejects malformed UTF8, extra response fields, unbound block refs and duplicate IDs', () => {
    expect(() => decodeWorkerResponse(Buffer.from([0xff]), request)).toThrow()
    const r = valid(); r.pages[0].blocks[0].duplicateOf = 'missing'
    expect(() => decodeWorkerResponse(wire(r), request)).toThrow()
    expect(() => decodeWorkerResponse(Buffer.from(JSON.stringify({ ...JSON.parse(wire(valid()).toString()), path: '/tmp/a' })), request)).toThrow()
    const dup = valid(); dup.pages[0].blocks.push(dup.pages[0].blocks[0])
    expect(() => decodeWorkerResponse(wire(dup), request)).toThrow()
  })
  it('verifies artifact hashes, canonical base64, magic and dimensions', () => {
    const r = valid()
    const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.write('IHDR', 12); png.writeUInt32BE(2, 16); png.writeUInt32BE(3, 20)
    r.artifacts.push({ id: 'img1', mediaType: 'image/png', sha256: createHash('sha256').update(png).digest('hex'),
      byteLength: png.length, base64: png.toString('base64'), width: 2, height: 3 })
    // Header validation isn't a full image decode; native decoding must stay in sandbox.
    expect(decodeWorkerResponse(wire(r), request).artifacts[0].bytes).toEqual(png)
    for (const mutation of [{ sha256: 'b'.repeat(64) }, { width: 4 }, { byteLength: 23 }, { base64: png.toString('base64')+'\n' }, { id: '../x' }]) {
      const altered = structuredClone(r); Object.assign(altered.artifacts[0], mutation)
      expect(() => decodeWorkerResponse(wire(altered), request)).toThrow()
    }
  })
})

describe('sandbox invocation contract', () => {
  const image = 'sha256:'+'a'.repeat(64)
  const name = 'document-import-12345678-1234-1234-1234-123456789012'
  it('requires immutable local image and restrictive single input mount', () => {
    const args = documentWorkerDockerArgs(image, path.resolve('private-input'), name)
    for (const flag of ['--network=none', '--read-only', '--user=10001:10001', '--cap-drop=ALL', '--pull=never',
      '--memory=1g', '--memory-swap=1g', '--cpus=1', '--pids-limit=96', '--security-opt=no-new-privileges:true']) expect(args).toContain(flag)
    expect(args.filter(a => a === '--mount')).toHaveLength(1)
    expect(args.some(a => a.includes('dst=/input,readonly'))).toBe(true)
    expect(args).not.toContain('--privileged'); expect(args.join(' ')).not.toContain('docker.sock')
  })
  it('rejects mutable tags and CSV mount-option injection', () => {
    expect(() => createDocumentImportWorker({ stagingRoot: path.resolve('staging'), image: 'worker:latest' })).toThrow()
    expect(() => documentWorkerDockerArgs(image, path.resolve('input,readonly=false'), name)).toThrow()
    expect(() => documentWorkerDockerArgs(image, 'relative', name)).toThrow()
    expect(() => documentWorkerDockerArgs(image, path.resolve('staging'), '--privileged')).toThrow()
  })
  it('honors abort before any staging or native process launch', async () => {
    const worker = createDocumentImportWorker({ stagingRoot: path.resolve('never-created'), image })
    await expect(worker.run({ sourceId: 'x', sourceHash: 'a'.repeat(64), format: 'doc', bytes: Buffer.from('data'),
      signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
  })
})
