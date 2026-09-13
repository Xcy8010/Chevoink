import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { documentWorkerDockerArgs } from '../../../api/lib/novel-import/worker-client.js'

const image = process.env.DOCUMENT_IMPORT_TEST_IMAGE
const run = promisify(execFile)
// Explicit opt-in: no auto-pull, build, host native parsing or credential discovery.
it.skipIf(!image || process.platform !== 'linux')('native DOC, mixed PDF and image fixtures run in the restricted container', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'document-import-native-test-'))
  const name = `document-import-${randomUUID()}`
  try {
    await chmod(directory, 0o755)
    const args = documentWorkerDockerArgs(image!, directory, name)
    args[args.length - 1] = '/app/tests/container_smoke.py'
    const { stdout } = await run('docker', args, { shell: false, timeout: 180_000, maxBuffer: 1_048_576,
      env: { PATH: process.env.PATH }, windowsHide: true })
    expect(JSON.parse(stdout).passed).toContain('real-ole-doc-to-docx')
  } finally {
    await run('docker', ['rm', '--force', name], { shell: false, timeout: 5000, maxBuffer: 4096,
      env: { PATH: process.env.PATH }, windowsHide: true }).catch(() => undefined)
    if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('document-import-native-test-'))
      await rm(directory, { recursive: true, force: true })
  }
}, 190_000)
