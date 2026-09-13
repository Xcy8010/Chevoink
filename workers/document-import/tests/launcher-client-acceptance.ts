/** Run ONLY in ephemeral Linux CI as import-launcher-ci, not as the Docker-enabled runner.
 * This file intentionally processes a synthetic PDF; it is NOT a production health command. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { createDocumentImportWorker } from '../../../api/lib/novel-import/worker-client.js'

const command = promisify(execFile)
async function denied(executable: string, args: string[]) {
  try { await command(executable, args, { timeout: 10_000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } }) }
  catch { return }
  throw new Error('unexpected privileged command permission')
}
function pdfFixture() {
  const text = 'BT /F1 12 Tf 30 100 Td (Restricted launcher CI) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`]
  let output = '%PDF-1.4\n'; const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(output.length); output += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = output.length
  output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  return Buffer.from(output + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}
async function main() {
  if (process.platform !== 'linux' || process.getuid?.() === 0) throw new Error('CI requires unprivileged Linux caller')
  const executable = '/usr/local/bin/chevoink-document-import-docker'
  const stagingRoot = '/opt/chevoink/shared/document-import-staging'
  const worker = createDocumentImportWorker({ image: process.argv[2], stagingRoot, dockerExecutable: executable })
  await denied('/usr/bin/docker', ['version', '--format', '{{.Server.Version}}'])
  await denied('/usr/bin/sudo', ['-n', '/usr/bin/docker', 'version'])
  await denied(executable, ['ps', '-a'])
  await denied(executable, ['exec', 'anything', 'sh'])
  await denied(executable, ['rm', '--force', `document-import-${randomUUID()}`])
  if (!(await worker.health()).ready) throw new Error('restricted launcher health failed')
  const bytes = pdfFixture()
  const input = { sourceId: 'launcher-ci', sourceHash: createHash('sha256').update(bytes).digest('hex'), bytes, format: 'pdf' as const }
  const result = await worker.run(input)
  if (!result.pages.some(page => page.blocks.some(block => block.text.includes('Restricted launcher CI')))) throw new Error('launcher PDF did not round trip')
  const controller = new AbortController()
  const pending = worker.run({ ...input, signal: controller.signal })
  const timer = setTimeout(() => controller.abort(), 100)
  try { await pending; throw new Error('cancel unexpectedly completed') }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || !['IMPORT_CANCELLED', 'IMPORT_CLEANUP_FAILED'].includes(String(error.code))) throw error
    // During Docker create, cleanup uncertainty is deliberately surfaced instead of claiming
    // removal. The root launcher's persisted cancellation prevents a late start.
  } finally { clearTimeout(timer) }
  if ((await readdir(stagingRoot)).length) throw new Error('caller staging was not cleaned')
  process.stdout.write(JSON.stringify({ restrictedLauncher: 'passed', dockerSocketGranted: false, sudoDockerGranted: false }) + '\n')
}
void main().catch(() => { process.stderr.write('RESTRICTED_LAUNCHER_CI_FAILED\n'); process.exitCode = 1 })
