import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ health: vi.fn(), run: vi.fn(), pure: vi.fn(), parse: vi.fn(), create: vi.fn() }))
vi.mock('../../../api/lib/novel-import/pipeline.js', () => ({
  parseNovelImportDocument: mocks.pure, createNovelImportPipeline: mocks.create,
}))
vi.mock('../../../api/lib/novel-import/worker-client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../api/lib/novel-import/worker-client.js')>()
  return { ...actual, createDocumentImportWorker: vi.fn(() => ({ run: mocks.run, health: mocks.health })) }
})
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks()
  vi.stubEnv('NOVEL_IMPORT_NATIVE_ENABLED', 'true')
  vi.stubEnv('DOCUMENT_IMPORT_WORKER_IMAGE', 'sha256:' + 'a'.repeat(64))
  vi.stubEnv('DOCUMENT_IMPORT_WORKER_STAGING_ROOT', '/private/staging')
  mocks.health.mockResolvedValue({ ready: true, parserVersion: 'test-native' })
  mocks.pure.mockResolvedValue({ mode: 'pure' }); mocks.parse.mockResolvedValue({ mode: 'native' })
  mocks.create.mockReturnValue(mocks.parse)
})
afterEach(() => vi.unstubAllEnvs())
const options = { sourceId: 'source', deadlineAt: Date.now() + 1_800_000 }

describe('operator native composition (no Docker or DB)', () => {
  it('default-off keeps deterministic parsing and never probes native', async () => {
    vi.stubEnv('NOVEL_IMPORT_NATIVE_ENABLED', '')
    const runtime = await import('../../../api/lib/novel-import/runtime.js')
    expect(await runtime.getDocumentImportReadiness()).toEqual({ enabled: false, configured: false, ready: false })
    await runtime.parseConfiguredNovelImportDocument(Buffer.from('x'), 'book.docx', options)
    expect(mocks.pure).toHaveBeenCalledOnce(); expect(mocks.health).not.toHaveBeenCalled()
  })
  it('TXT stays independent of a broken optional native configuration', async () => {
    vi.stubEnv('DOCUMENT_IMPORT_WORKER_IMAGE', '')
    const runtime = await import('../../../api/lib/novel-import/runtime.js')
    await runtime.parseConfiguredNovelImportDocument(Buffer.from('text'), 'book.txt', options)
    expect(mocks.pure).toHaveBeenCalledOnce(); expect(mocks.health).not.toHaveBeenCalled()
    expect(await runtime.getDocumentImportReadiness()).toMatchObject({ configured: false, ready: false })
  })
  it('uses a real probe before native dispatch and preserves the absolute deadline', async () => {
    const runtime = await import('../../../api/lib/novel-import/runtime.js')
    await runtime.parseConfiguredNovelImportDocument(Buffer.from('native'), 'book.doc', options)
    expect(mocks.health).toHaveBeenCalledOnce()
    expect(mocks.parse).toHaveBeenCalledWith(Buffer.from('native'), 'book.doc', options)
    expect(mocks.health.mock.invocationCallOrder[0]).toBeLessThan(mocks.parse.mock.invocationCallOrder[0])
    const readiness = await runtime.getDocumentImportReadiness()
    expect(readiness).toMatchObject({ ready: true, parserVersion: 'test-native' })
    expect(JSON.stringify(readiness)).not.toContain('/private/staging')
    expect(mocks.health).toHaveBeenCalledOnce()
  })
  it('health failure is not silently downgraded to a different parser', async () => {
    mocks.health.mockRejectedValue(new Error('private host path secret'))
    const runtime = await import('../../../api/lib/novel-import/runtime.js')
    await expect(runtime.parseConfiguredNovelImportDocument(Buffer.from('x'), 'book.pdf', options)).rejects.toMatchObject({ code: 'IMPORT_WORKER_UNAVAILABLE' })
    expect(mocks.parse).not.toHaveBeenCalled(); expect(mocks.pure).not.toHaveBeenCalled()
    expect(JSON.stringify(await runtime.getDocumentImportReadiness())).not.toContain('secret')
  })
  it('expired persisted deadline never restarts a thirty-minute worker', async () => {
    const runtime = await import('../../../api/lib/novel-import/runtime.js')
    await expect(runtime.parseConfiguredNovelImportDocument(Buffer.from('x'), 'book.doc', { ...options, deadlineAt: Date.now() - 1 })).rejects.toMatchObject({ code: 'IMPORT_DEADLINE_EXCEEDED' })
    expect(mocks.health).not.toHaveBeenCalled(); expect(mocks.parse).not.toHaveBeenCalled()
  })
  it('pre-cancelled jobs do not start even a health process', async () => {
    const runtime = await import('../../../api/lib/novel-import/runtime.js')
    const controller = new AbortController(); controller.abort()
    await expect(runtime.parseConfiguredNovelImportDocument(Buffer.from('x'), 'book.doc', { ...options, signal: controller.signal })).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
    expect(mocks.health).not.toHaveBeenCalled()
  })
})
