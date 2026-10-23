import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IMAGE_RESPONSE_BYTES, readImageResponse, storeImageResponse } from '../../api/lib/agent/provider-image-storage.js'
import { coverProjection } from '../../api/lib/agent/runtime-cover-contract.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { parseCoverImageResponse } from '../../api/lib/ai-service.js'

afterEach(() => vi.unstubAllEnvs())
async function temporary(work: (directory: string) => Promise<void>) {
  const parent = path.resolve(os.tmpdir()), directory = await mkdtemp(path.join(parent, 'chevoink-cover-raw-'))
  if (path.dirname(directory) !== parent || !path.basename(directory).startsWith('chevoink-cover-raw-')) throw Error('Unexpected fixture cleanup target')
  vi.stubEnv('AGENT_IMAGE_RESPONSE_DIR', directory)
  try { await work(directory) }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
}
const identity = () => ({ userId: 'isolated-owner', attemptId: randomUUID(), requestHash: 'a'.repeat(64) })
const chunks = (bytes: Uint8Array) => (async function* () { yield bytes })()

describe('private sealed original image response', () => {
  it('preserves >2MiB raw pixels in a small descriptor and never re-embeds data fallback in the tool receipt', () => temporary(async () => {
    const original = Buffer.from(JSON.stringify({ data: [{ b64_json: 'a'.repeat(3 * 1024 * 1024) }] })), owner = identity()
    const saved = await storeImageResponse(owner, 200, chunks(original))
    expect(saved.body).toBe(original.toString('utf8'))
    expect(Buffer.byteLength(JSON.stringify(runtimeJson(saved.pointer).value))).toBeLessThan(1000)
    expect(await readImageResponse(owner, saved.pointer)).toEqual(saved)
    const urls = parseCoverImageResponse(200, saved.body)
    const projection = coverProjection([{ id: 'original-asset', imageUrl: urls[0] }])
    expect(projection).toMatchObject({ outcome: 'failed', failureCode: 'COVER_STORAGE_PENDING' })
    expect(JSON.stringify(runtimeJson(projection).value)).not.toContain('data:image')
    expect(projection.output).toContain('original-asset')
  }))
  it('repairs a lost DB pointer using only the deterministic owned attempt and refuses a foreign request or corrupt seal', () => temporary(async directory => {
    const owner = identity(), saved = await storeImageResponse(owner, 503, chunks(Buffer.from('not json')))
    expect(await readImageResponse(owner)).toEqual(saved)
    await expect(readImageResponse({ ...owner, requestHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
    expect(await readImageResponse({ ...owner, userId: 'other-owner' })).toBeNull()
    const file = path.join(directory, saved.pointer.storageKey), bytes = await readFile(file)
    await writeFile(file, bytes.subarray(0, bytes.length - 1))
    await expect(readImageResponse(owner)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  }))
  it('publishes exclusively, accepts byte-identical replay and never overwrites a previous completed result', () => temporary(async () => {
    const owner = identity(), saved = await storeImageResponse(owner, 200, chunks(Buffer.from('one')))
    expect(await storeImageResponse(owner, 200, chunks(Buffer.from('one')))).toEqual(saved)
    await expect(storeImageResponse(owner, 200, chunks(Buffer.from('two')))).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect((await readImageResponse(owner))?.body).toBe('one')
  }))
  it.each(['partial', 'overflow'] as const)('never publishes a %s body as complete', scenario => temporary(async directory => {
    const owner = identity()
    const stream = (async function* () {
      yield Buffer.from('partial')
      if (scenario === 'partial') throw Error('lost stream')
      yield Buffer.alloc(IMAGE_RESPONSE_BYTES)
    })()
    await expect(storeImageResponse(owner, 200, stream)).rejects.toThrow()
    expect(await readImageResponse(owner)).toBeNull()
    expect(await readdir(directory)).toEqual([])
  }))
  it('seals an empty complete HTTP body rather than inventing a transport failure', () => temporary(async () => {
    const saved = await storeImageResponse(identity(), 429, chunks(Buffer.alloc(0)))
    expect(saved.body).toBe('')
    expect(saved.pointer.httpStatus).toBe(429)
  }))
})

describe('cover response and bounded projection', () => {
  it('keeps ordered partial candidates, refuses empty/malformed responses and preserves a known HTTP rejection', () => {
    expect(parseCoverImageResponse(200, '{"data":[{"url":"https://images.invalid/one"},{}]}')).toEqual(['https://images.invalid/one'])
    expect(() => parseCoverImageResponse(200, '{"data":[]}')).toThrow(expect.objectContaining({ code: 'AI_PROVIDER_EMPTY_RESPONSE' }))
    expect(() => parseCoverImageResponse(200, 'broken')).toThrow(expect.objectContaining({ code: 'AI_PROVIDER_INVALID_RESPONSE' }))
    expect(() => parseCoverImageResponse(429, '{"error":{}}')).toThrow(expect.objectContaining({ providerStatus: 429 }))
    expect(coverProjection([{ id: 'one', imageUrl: '/api/uploads/novel-covers/one.png' }])).toMatchObject({ display: { kind: 'coverImages' } })
  })
})
