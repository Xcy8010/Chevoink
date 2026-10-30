import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { storeImportedNovelCoverDataUrl, storeNovelCoverDataUrl } from '../../api/lib/novel-cover-storage.js'

const mocks = vi.hoisted(() => ({ transcode: vi.fn(), events: [] as Array<{ op: string; file: string; mode?: number | string }> }))
vi.mock('../../api/lib/image-transcode.js', () => ({ transcodeCoverImage: mocks.transcode }))
vi.mock('../../api/config/env.js', async original => ({ ...await original<object>(), env: { ...(await original<{ env: object }>()).env, appEnv: 'development' } }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual,
    chmod: vi.fn(async (...args: Parameters<typeof actual.chmod>) => { mocks.events.push({ op: 'chmod', file: String(args[0]), mode: args[1] }); return actual.chmod(...args) }),
    link: vi.fn(async (...args: Parameters<typeof actual.link>) => { mocks.events.push({ op: 'link', file: String(args[0]) }); return actual.link(...args) }),
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args), changeMode = handle.chmod.bind(handle), sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'chmod').mockImplementation(async mode => { mocks.events.push({ op: 'handle.chmod', file: String(args[0]), mode }); return changeMode(mode) })
      vi.spyOn(handle, 'sync').mockImplementation(async () => { mocks.events.push({ op: 'sync', file: String(args[0]) }); return sync() })
      return handle
    }),
  }
})
const repository = fileURLToPath(new URL('../..', import.meta.url))
const coverModule = new URL('../../api/lib/novel-cover-storage.ts', import.meta.url).href
const attachmentModule = new URL('../../api/lib/agent-attachment-storage.ts', import.meta.url).href
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24)])
const dataUrl = (bytes: Buffer, mime = 'image/png') => 'data:' + mime + ';base64,' + bytes.toString('base64')
let directory: string
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'chevoink-public-cover-')))
  vi.spyOn(process, 'cwd').mockReturnValue(directory)
  mocks.events = []
  mocks.transcode.mockReset().mockResolvedValue({ main: Buffer.from('main-webp'), thumb: Buffer.from('thumb-webp') })
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (path.dirname(directory) !== await realpath(os.tmpdir()) || !path.basename(directory).startsWith('chevoink-public-cover-')) throw Error('Unexpected fixture cleanup target')
  await rm(directory, { recursive: true, force: true })
})
const fileFor = (url: string) => path.join(directory, '.local-storage', 'uploads', 'novel-covers', path.basename(url))
it('explicitly publishes main and thumbnail read permissions and only changes the public leaf directory', async () => {
  const url = await storeNovelCoverDataUrl(dataUrl(png)), main = fileFor(url), thumb = main.replace(/\.webp$/, '.thumb.webp')
  expect(await readFile(main, 'utf8')).toBe('main-webp')
  expect(await readFile(thumb, 'utf8')).toBe('thumb-webp')
  expect(mocks.events.filter(event => event.op === 'chmod' && event.mode === 0o644).map(event => event.file)).toEqual([main, thumb])
  expect(mocks.events.filter(event => event.op === 'chmod' && event.file !== main && event.file !== thumb).map(event => event.file)).toEqual([path.dirname(main)])
})
it.each([['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp']])('keeps original fallback bytes and makes %s public', async (mime, extension) => {
  mocks.transcode.mockResolvedValue(null)
  const raw = Buffer.from('unmodified fallback bytes'), url = await storeNovelCoverDataUrl(dataUrl(raw, mime))
  expect(url.endsWith(extension)).toBe(true)
  expect(await readFile(fileFor(url))).toEqual(raw)
  expect(mocks.events).toContainEqual({ op: 'chmod', file: fileFor(url), mode: 0o644 })
})
it('chmods the imported temporary handle before fsync and atomic publication', async () => {
  const url = await storeImportedNovelCoverDataUrl(dataUrl(png))
  const changed = mocks.events.findIndex(event => event.op === 'handle.chmod' && event.file.endsWith('.tmp') && event.mode === 0o644)
  expect(changed).toBeGreaterThanOrEqual(0)
  expect(mocks.events.findIndex(event => event.op === 'sync')).toBeGreaterThan(changed)
  expect(mocks.events.findIndex(event => event.op === 'link')).toBeGreaterThan(mocks.events.findIndex(event => event.op === 'sync'))
  expect(await readFile(fileFor(url))).toEqual(png)
  expect((await readdir(path.dirname(fileFor(url)))).some(file => file.endsWith('.tmp'))).toBe(false)
})
it('adds read bits only after verifying an existing imported cover and preserves its other permissions', async () => {
  const url = await storeImportedNovelCoverDataUrl(dataUrl(png)), target = fileFor(url)
  await chmod(target, 0o664)
  const original = (await stat(target)).mode
  mocks.events = []
  expect(await storeImportedNovelCoverDataUrl(dataUrl(png))).toBe(url)
  expect(mocks.events).toContainEqual({ op: 'handle.chmod', file: target, mode: original | 0o044 })
  expect(await readFile(target)).toEqual(png)
})
it('retains content verification and does not chmod a mismatching existing imported target', async () => {
  const url = await storeImportedNovelCoverDataUrl(dataUrl(png)), target = fileFor(url)
  await writeFile(target, Buffer.alloc(png.length, 1)); mocks.events = []
  await expect(storeImportedNovelCoverDataUrl(dataUrl(png))).rejects.toMatchObject({ code: 'IMPORT_COVER_INVALID' })
  expect(mocks.events.some(event => event.op === 'handle.chmod' && event.file === target)).toBe(false)
  expect(await readFile(target)).toEqual(Buffer.alloc(png.length, 1))
})
it('reproduces umask 077 in a separate process and asserts actual POSIX public/private modes on Linux', async () => {
  const parentMask = process.umask()
  const script = `
    import assert from 'node:assert/strict'
    import { mkdir, chmod, writeFile, readFile, readdir, stat } from 'node:fs/promises'
    import path from 'node:path'
    const work = process.argv[1]
    const { default: sharp } = await import('sharp')
    const { storeNovelCoverDataUrl, storeImportedNovelCoverDataUrl } = await import(process.argv[2])
    const { storeAgentAttachment } = await import(process.argv[3])
    process.chdir(work)
    const uploads = path.join(work, '.local-storage', 'uploads'), leaf = path.join(uploads, 'novel-covers')
    await mkdir(uploads, { recursive: true }); await chmod(uploads, 0o775)
    const parentMode = (await stat(uploads)).mode
    const before = process.umask(0o077), appliedMask = process.umask(), posix = process.platform !== 'win32'
    if (posix) assert.equal(appliedMask, 0o077)
    const mode = async file => (await stat(file)).mode & 0o777
    const checkMode = async (file, expected) => { const actual = await mode(file); if (posix) assert.equal(actual, expected) }
    try {
      const baseline = path.join(work, 'default-creation')
      await writeFile(baseline, 'baseline')
      await checkMode(baseline, 0o600)
      const png = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#334455' } }).png().toBuffer()
      const asUrl = bytes => 'data:image/png;base64,' + bytes.toString('base64')
      const filename = url => path.join(leaf, path.basename(url))
      const main = filename(await storeNovelCoverDataUrl(asUrl(png)))
      assert.ok(main.endsWith('.webp'))
      await checkMode(leaf, 0o755); await checkMode(main, 0o644); await checkMode(main.replace(/\\.webp$/, '.thumb.webp'), 0o644)
      await chmod(leaf, 0o775)
      for (const [mime, extension] of [['png', 'png'], ['jpeg', 'jpg'], ['webp', 'webp']]) {
        const bytes = Buffer.from('original fallback ' + mime)
        const target = filename(await storeNovelCoverDataUrl('data:image/' + mime + ';base64,' + bytes.toString('base64')))
        assert.ok(target.endsWith('.' + extension)); assert.deepEqual(await readFile(target), bytes); await checkMode(target, 0o644)
      }
      await checkMode(leaf, 0o775)
      const imported = await storeImportedNovelCoverDataUrl(asUrl(png)), target = filename(imported)
      await checkMode(target, 0o644)
      for (const initial of [0o600, 0o664]) {
        await chmod(target, initial)
        assert.equal(await storeImportedNovelCoverDataUrl(asUrl(png)), imported)
        await checkMode(target, initial | 0o044); assert.deepEqual(await readFile(target), png)
      }
      assert.ok(!(await readdir(leaf)).some(name => name.endsWith('.tmp')))
      const attachment = await storeAgentAttachment({ userId: 'synthetic-owner', kind: 'file', name: 'private.txt', dataUrl: 'data:text/plain;base64,cHJpdmF0ZQ==' })
      const privateFile = path.join(uploads, 'agent-attachments', 'synthetic-owner', path.basename(attachment.url))
      await checkMode(privateFile, 0o600); await checkMode(path.dirname(privateFile), 0o700)
      const unrelated = path.join(uploads, 'unrelated')
      await writeFile(unrelated, 'unrelated'); await checkMode(unrelated, 0o600)
      assert.equal((await stat(uploads)).mode, parentMode)
      assert.equal(process.umask(), appliedMask)
      console.log(JSON.stringify({ platform: process.platform, publicFiles: 6, privateUnchanged: true, posixModesAsserted: posix }))
    } finally { process.umask(before) }
  `
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory, coverModule, attachmentModule],
    { cwd: repository, env: { ...process.env, APP_ENV: 'development', VITEST: 'true' } })
  expect(JSON.parse(result.stdout)).toMatchObject({ publicFiles: 6, privateUnchanged: true, posixModesAsserted: process.platform !== 'win32' })
  expect(process.umask()).toBe(parentMask)
})
