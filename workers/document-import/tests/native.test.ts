import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createDocumentImportWorker, documentWorkerDockerArgs } from '../../../api/lib/novel-import/worker-client.js'
import { pdf } from '../../../tests/unit/novel-import-parser.fixtures.js'

const image = process.env.DOCUMENT_IMPORT_TEST_IMAGE
const run = promisify(execFile)
const required = process.env.DOCUMENT_IMPORT_NATIVE_REQUIRED === 'true'
it('required native CI cannot silently skip missing Linux/image prerequisites', () => {
  if (required) { expect(process.platform).toBe('linux'); expect(image).toMatch(/^(?:sha256:|[a-z0-9./:_-]+@sha256:)[a-f0-9]{64}$/) }
})
// Explicit opt-in: no auto-pull, build, host native parsing or credential discovery.
it.skipIf(!image || process.platform !== 'linux')('native DOC, mixed PDF and image fixtures run in the restricted container', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'document-import-native-test-'))
  const name = `document-import-${randomUUID()}`
  try {
    await chmod(directory, 0o755)
    const args = documentWorkerDockerArgs(image!, directory, name)
    args[args.length - 1] = '/app/tests/container_smoke.py'
    const { stdout } = await run('docker', args, { shell: false, timeout: 300_000, maxBuffer: 1_048_576,
      env: { PATH: process.env.PATH }, windowsHide: true })
    expect(JSON.parse(stdout).passed).toContain('real-ole-doc-to-docx')
    expect(JSON.parse(stdout).chineseGold.characterErrorRate).toBeLessThanOrEqual(0.02)
    if (process.env.DOCUMENT_IMPORT_NATIVE_REPORT) await writeFile(process.env.DOCUMENT_IMPORT_NATIVE_REPORT, stdout, { flag: 'wx', mode: 0o600 })
  } finally {
    await run('docker', ['rm', '--force', name], { shell: false, timeout: 5000, maxBuffer: 4096,
      env: { PATH: process.env.PATH }, windowsHide: true }).catch(() => undefined)
    if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('document-import-native-test-'))
      await rm(directory, { recursive: true, force: true })
  }
}, 315_000)

it.skipIf(!image || process.platform !== 'linux')('actual supervisor health, hash-bound PDF and cancellation leave no private staging', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'document-import-native-client-'))
  try {
    const worker = createDocumentImportWorker({ stagingRoot: path.join(directory, 'private'), image: image! })
    expect((await worker.health()).ready).toBe(true)
    const bytes = pdf(['Native client source'])
    const input = { sourceId: 'ci-native-client', sourceHash: createHash('sha256').update(bytes).digest('hex'), format: 'pdf' as const, bytes }
    const result = await worker.run(input)
    expect(result.sourceHash).toBe(input.sourceHash)
    expect(result.pages[0].blocks.some(block => block.text.includes('Native client source'))).toBe(true)
    const controller = new AbortController()
    const pending = worker.run({ ...input, signal: controller.signal })
    const timer = setTimeout(() => controller.abort(), 50)
    try { await expect(pending).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' }) }
    finally { clearTimeout(timer) }
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(path.join(directory, 'private'))).toEqual([])
  } finally {
    if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('document-import-native-client-'))
      await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
