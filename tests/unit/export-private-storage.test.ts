import { mkdtemp, readFile, writeFile, readdir, rm, symlink, chmod } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readExportFile, storeExportFile, prepareExportStorage, EXPORT_SOURCE_BYTES } from '../../api/lib/export-private-storage.js'
import { parseExportSource } from '../../api/lib/agent/runtime-export-contract.js'

const identity = { userId: 'synthetic-owner', taskRootId: 'synthetic-root', operationKey: 'exec:0', sourceHash: 'a'.repeat(64), argsHash: 'b'.repeat(64) }
let directory: string
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'chevoink-export-unit-')); vi.stubEnv('AGENT_EXPORT_DIR', directory) })
afterEach(async () => {
  vi.unstubAllEnvs()
  const target = path.resolve(directory)
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('chevoink-export-unit-')) throw Error('Unexpected fixture cleanup target')
  await rm(target, { recursive: true, force: true })
})

describe('private export files retain only authenticated complete original bytes', () => {
  it('stores a manuscript beyond operation JSON size, with a sealed bounded pointer and private modes', async () => {
    const body = Buffer.from('合成稿件'.repeat(200000))
    expect(body.length).toBeGreaterThan(2 * 1024 * 1024)
    await prepareExportStorage(identity)
    const saved = await storeExportFile(identity, 'source', body)
    expect(saved.body.equals(body)).toBe(true)
    const restored = await readExportFile(identity, 'source', saved.pointer)
    expect(restored!.body.equals(body)).toBe(true)
    expect(JSON.stringify(saved.pointer).length).toBeLessThan(300)
    expect((await readdir(directory))).toEqual([saved.pointer.key])
    expect(await readExportFile({ ...identity, userId: 'other-owner' }, 'source')).toBeNull()
  })
  it('first complete source wins concurrent publication, while ZIP conflicts never overwrite original bytes', async () => {
    const values = await Promise.all([storeExportFile(identity, 'source', Buffer.from('first')), storeExportFile(identity, 'source', Buffer.from('second'))])
    expect(values[0].pointer).toEqual(values[1].pointer)
    const zip = await storeExportFile(identity, 'zip', Buffer.from('ZIP-original'))
    await expect(storeExportFile(identity, 'zip', Buffer.from('ZIP-other'))).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect((await readExportFile(identity, 'zip', zip.pointer))!.body.toString()).toBe('ZIP-original')
    expect((await readdir(directory)).some(name => name.endsWith('.part'))).toBe(false)
  })
  it.each(['body', 'header', 'seal', 'truncated', 'pointer'] as const)('rejects %s corruption rather than treating it as a fresh source', async change => {
    const saved = await storeExportFile(identity, 'source', Buffer.from('original'))
    const file = path.join(directory, saved.pointer.key), bytes = await readFile(file)
    if (change === 'body') bytes[bytes.indexOf(10) + 1] ^= 1
    if (change === 'header') bytes[0] = 0
    if (change === 'seal') bytes[bytes.length - 1] ^= 1
    if (change !== 'pointer') await writeFile(file, change === 'truncated' ? bytes.subarray(0, 40) : bytes)
    await expect(readExportFile(identity, 'source', change === 'pointer' ? { ...saved.pointer, sha256: 'c'.repeat(64) } : saved.pointer)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  })
  it('rejects an owned pointer at another identity and a missing bound source', async () => {
    const saved = await storeExportFile(identity, 'source', Buffer.from('original'))
    await expect(readExportFile({ ...identity, taskRootId: 'other-root' }, 'source', saved.pointer)).rejects.toMatchObject({ code: 'RUNTIME_STORAGE_UNAVAILABLE' })
    await expect(readExportFile(identity, 'zip', saved.pointer)).rejects.toMatchObject({ code: 'RUNTIME_STORAGE_UNAVAILABLE' })
  })
  it('rejects public storage, unsafe identities, oversized data and malformed source without leaking manuscript text', async () => {
    vi.stubEnv('AGENT_EXPORT_DIR', path.join(directory, 'public', 'exports'))
    await expect(storeExportFile(identity, 'zip', Buffer.from('x'))).rejects.toMatchObject({ code: 'RUNTIME_STORAGE_UNSAFE' })
    vi.stubEnv('AGENT_EXPORT_DIR', directory)
    await expect(storeExportFile({ ...identity, sourceHash: '../elsewhere' }, 'zip', Buffer.from('x'))).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    await expect(storeExportFile(identity, 'source', { byteLength: EXPORT_SOURCE_BYTES + 1 } as Uint8Array)).rejects.toMatchObject({ code: 'RUNTIME_PAYLOAD_TOO_LARGE' })
    expect(() => parseExportSource(Buffer.from('private manuscript, not JSON'))).toThrow('原导出快照格式无效')
  })
  it('rejects symlink and non-private file on hosts supporting POSIX modes', async () => {
    const saved = await storeExportFile(identity, 'source', Buffer.from('original'))
    if (process.platform === 'win32') { expect(saved.body.toString()).toBe('original'); return }
    const file = path.join(directory, saved.pointer.key)
    await chmod(file, 0o644)
    await expect(readExportFile(identity, 'source')).rejects.toMatchObject({ code: 'RUNTIME_STORAGE_UNSAFE' })
    await chmod(file, 0o600)
    const linkedIdentity = { ...identity, operationKey: 'exec:1' }
    const other = await storeExportFile(linkedIdentity, 'source', Buffer.from('owned'))
    await rm(path.join(directory, other.pointer.key))
    await symlink(file, path.join(directory, other.pointer.key))
    await expect(readExportFile(linkedIdentity, 'source')).rejects.toMatchObject({ code: 'RUNTIME_STORAGE_UNSAFE' })
  })
})
