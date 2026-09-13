import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importBytesHash, readImportBlob, storeImportStream, validateImportFilename } from '../api/lib/novel-import-storage.js'

let directory = ''
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'novel-import-private-test-'))
  vi.stubEnv('NOVEL_IMPORT_STORAGE_DIR', directory)
})
afterEach(async () => {
  // Only exact files from this freshly created test directory, never recursive.
  if (!path.resolve(directory).startsWith(path.join(os.tmpdir(), 'novel-import-private-test-'))) throw new Error('unsafe fixture cleanup')
  for (const entry of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.blob$/.test(entry)) throw new Error('unexpected fixture file')
    await unlink(path.join(directory, entry))
  }
  await rmdir(directory); vi.unstubAllEnvs()
})
const stream = (parts: string[]) => (async function* () { for (const part of parts) yield Buffer.from(part) })()
describe('private bounded novel import storage', () => {
  it('streams/hash-verifies original bytes with random immutable keys', async () => {
    const stored = await storeImportStream(stream(['原文', '\n第二段']))
    expect(stored.sha256).toBe(importBytesHash('原文\n第二段'))
    expect((await readImportBlob(stored.storageKey, stored.sha256)).toString()).toBe('原文\n第二段')
    const second = await storeImportStream(stream(['原文', '\n第二段']))
    expect(second.storageKey).not.toBe(stored.storageKey)
    await expect(readImportBlob(stored.storageKey, '0'.repeat(64))).rejects.toMatchObject({ code: 'IMPORT_SOURCE_CHANGED' })
  })
  it('rejects oversized streams without leaving a partial blob', async () => {
    await expect(storeImportStream(stream(['1234', '5678']), { maxBytes: 6 })).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
    expect(await readdir(directory)).toHaveLength(0)
  })
  it('aborts before publishing any bytes and deletes only its own partial file', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(storeImportStream(stream(['payload']), { signal: controller.signal })).rejects.toThrow()
    expect(await readdir(directory)).toHaveLength(0)
  })
  it('rejects traversal keys, client paths and public store configuration', async () => {
    await expect(readImportBlob('../secret', '0'.repeat(64))).rejects.toMatchObject({ code: 'IMPORT_SOURCE_INVALID' })
    for (const name of ['../book.txt', 'C:\\book.txt', '/book.txt', 'x\0.txt', 'x.exe']) expect(() => validateImportFilename(name)).toThrow()
    vi.stubEnv('NOVEL_IMPORT_STORAGE_DIR', path.join(directory, 'uploads'))
    await expect(storeImportStream(stream(['no']))).rejects.toMatchObject({ code: 'IMPORT_STORAGE_UNSAFE' })
  })
  it('enforces read cap independently from uploaded size', async () => {
    const stored = await storeImportStream(stream(['123456789']))
    await expect(readImportBlob(stored.storageKey, stored.sha256, 4)).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
  })
})
