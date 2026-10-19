import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceManifest } from './release-package.mjs'
import { observationProgram } from './production-observation.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = '/opt/chevoink/runtime/node-v22.23.2-linux-x64/bin/node'
const exactSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
async function publicBytes(request, url, limit) {
  const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('Public production response unavailable')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > limit) throw new Error('Public production response exceeds limit')
  return bytes
}

export async function inspectProduction(options, { exec = execFileSync, manifest = sourceManifest, request = fetch, now = () => new Date(),
  snapshotSource = readFileSync(new URL('./production-process-snapshot.mjs', import.meta.url), 'utf8') } = {}) {
  const { sourceSha, requestSha, ciRunId, runId, requestId, keyPath, phase = 'preflight', expectedRevision } = options
  if (!exactSha(sourceSha) || !exactSha(requestSha) || sourceSha === requestSha || !/^[1-9]\d*$/.test(runId) || !['preflight', 'postflight'].includes(phase)
    || !/^[1-9]\d*$/.test(ciRunId ?? '') || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId ?? '')
    || typeof keyPath !== 'string' || !keyPath || expectedRevision && !exactSha(expectedRevision)) throw new Error('Invalid observation request')
  if (exec('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== sourceSha) throw new Error('Controller SHA mismatch')
  exec('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: root })
  const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3', '-i', keyPath, 'ubuntu@124.223.188.123',
    `env CHEVOINK_NODE_BINARY=${executable} ${executable} --input-type=module -`]
  const observe = input => JSON.parse(exec(process.platform === 'win32' ? 'ssh.exe' : 'ssh', sshArgs,
    { input: observationProgram(input, snapshotSource), encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024 }))
  const scope = { sourceSha, requestSha, ciRunId, runId, requestId, phase }
  const active = observe({ ...scope, stage: 'discover' })
  if (!exactSha(active.revision) || !/^[a-f0-9]{64}$/.test(active.archiveSha256 ?? '') || expectedRevision && expectedRevision !== active.revision) {
    throw new Error('Active production marker does not match the requested observation')
  }
  // Refuse unknown/unreviewed source or a target outside this controller's lineage.
  exec('git', ['merge-base', '--is-ancestor', active.revision, sourceSha], { cwd: root })
  const result = observe({ ...scope, ...active, stage: 'verify', files: manifest(active.revision, root) })
  if (result.revision !== active.revision || result.archiveSha256 !== active.archiveSha256 || result.runId !== runId
    || result.sourceSha !== sourceSha || result.requestSha !== requestSha || result.ciRunId !== ciRunId || result.requestId !== requestId || result.phase !== phase || result.sourceVerified !== true || result.processVerified !== true
    || result.internalHealth !== true || result.runtime !== '22.23.2') throw new Error('Production evidence mismatch')
  const publicHealth = JSON.parse((await publicBytes(request, 'https://chevoink.chevolink.com/api/health', 65536)).toString('utf8'))
  if (publicHealth.success !== true || publicHealth.data?.appEnv !== 'production') throw new Error('Public production health mismatch')
  const index = await publicBytes(request, 'https://chevoink.chevolink.com', 2 * 1024 * 1024)
  if (createHash('sha256').update(index).digest('hex') !== result.indexSha256) throw new Error('Public production index mismatch')
  return { ...result, observedAt: now().toISOString(), publicHealth: true, publicIndexVerified: true }
}

async function main(argv) {
  const allowed = new Set(['--source-sha', '--request-sha', '--ci-run-id', '--run-id', '--request-id', '--key-path', '--phase', '--expected-revision', '--out'])
  if (argv.length % 2 || argv.some((arg, index) => index % 2 === 0 && !allowed.delete(arg))) throw new Error('Invalid inspection arguments')
  const args = Object.fromEntries(Array.from({ length: argv.length / 2 }, (_, index) => [argv[index * 2], argv[index * 2 + 1]]))
  if (!args['--out']) throw new Error('A new receipt path is required')
  const result = await inspectProduction({ sourceSha: args['--source-sha'], requestSha: args['--request-sha'], ciRunId: args['--ci-run-id'], runId: args['--run-id'], requestId: args['--request-id'], keyPath: args['--key-path'],
    phase: args['--phase'], expectedRevision: args['--expected-revision'] })
  writeFileSync(args['--out'], JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log('CHEVOINK_PRODUCTION_RECEIPT ' + JSON.stringify(result))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { console.error('Production inspection failed; no inspection receipt was issued. Do not retry a deployment.'); process.exitCode = 1 })
}
