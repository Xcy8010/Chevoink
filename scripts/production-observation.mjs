import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { snapshotProductionProcess } from './production-process-snapshot.mjs'

/** Runs on production via stdin. Reads only fixed source/marker/index/journal
 * paths, existing PM2 RPC and internal health; never loads app.env or starts PM2. */
export async function observeProduction(input, { io = fs, snapshot = snapshotProductionProcess, request = fetch, now = () => new Date() } = {}) {
  const root = '/opt/chevoink/app/current'
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
  const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  const fail = () => { throw new Error('Production observation did not verify; inspect actual state before any mutation.') }
  function read(filename, limit = 8 * 1024 * 1024) {
    const stat = io.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail()
    const bytes = io.readFileSync(filename)
    if (bytes.length > limit) fail()
    return bytes
  }
  function marker() {
    const value = JSON.parse(read(root + '/.chevoink-release.json', 4096).toString('utf8'))
    if (!sha(value.revision) || !hex(value.archiveSha256)) fail()
    return { revision: value.revision, archiveSha256: value.archiveSha256 }
  }
  if (!['discover', 'verify'].includes(input.stage) || !sha(input.sourceSha) || !sha(input.requestSha) || input.requestSha === input.sourceSha || !/^[1-9]\d*$/.test(input.runId) || !/^[1-9]\d*$/.test(input.ciRunId ?? '')
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.requestId ?? '')
    || !['preflight', 'postflight'].includes(input.phase)) fail()
  if (!io.lstatSync(root).isDirectory() || io.realpathSync(root) !== root) fail()
  const active = marker()
  if (input.stage === 'discover') return active
  if (active.revision !== input.revision || input.archiveSha256 !== active.archiveSha256
    || !Array.isArray(input.files) || !input.files.length || input.files.length > 5000) fail()
  const before = await snapshot()
  const seen = new Set()
  let totalBytes = 0
  for (const file of input.files) {
    if (!file || typeof file.path !== 'string' || !hex(file.sha256) || seen.has(file.path)
      || !(/^(api|shared|prisma)\//.test(file.path) || ['.node-version', 'package.json', 'package-lock.json', 'ecosystem.config.cjs'].includes(file.path))) fail()
    const segments = file.path.split('/')
    if (segments.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) fail()
    let parent = root
    for (const part of segments.slice(0, -1)) {
      parent += '/' + part
      if (!io.lstatSync(parent).isDirectory() || io.realpathSync(parent) !== parent) fail()
    }
    const bytes = read(root + '/' + file.path)
    totalBytes += bytes.length
    if (totalBytes > 128 * 1024 * 1024 || hash(bytes) !== file.sha256) fail()
    seen.add(file.path)
  }
  const runtime = read(root + '/.node-version', 64).toString().trim()
  if (runtime !== '22.23.2' || process.versions.node !== runtime) fail()
  const response = await request('http://127.0.0.1:3001/api/health', { redirect: 'error', signal: AbortSignal.timeout(5000) })
  const healthText = await response.text()
  if (!response.ok || Buffer.byteLength(healthText) > 65536) fail()
  const health = JSON.parse(healthText)
  if (health.success !== true || health.data?.appEnv !== 'production') fail()
  const indexSha256 = hash(read(root + '/dist/index.html', 2 * 1024 * 1024))
  if (indexSha256 !== hash(read('/var/www/chevoink/current/index.html', 2 * 1024 * 1024))) fail()
  let journal = null
  if (input.phase === 'postflight') {
    if (active.revision !== input.sourceSha) fail()
    const rows = read('/opt/chevoink/app/.release-' + input.sourceSha + '.jsonl', 65536).toString('utf8').trim().split('\n').map(line => JSON.parse(line))
    const phases = rows.map(row => row.phase)
    const expected = ['preparing', 'prepared', ...(phases.includes('migrating') ? ['migrating', 'migrated'] : []), 'stopping', 'stopped', 'switched', 'healthy', 'completed']
    if (JSON.stringify(phases) !== JSON.stringify(expected) || rows.some(row => row.revision !== input.sourceSha || !Number.isFinite(Date.parse(row.at)))
      || rows.some((row, index) => index > 0 && Date.parse(row.at) < Date.parse(rows[index - 1].at))) fail()
    journal = { revision: input.sourceSha, lastPhase: 'completed', completedAt: rows.at(-1).at }
  }
  const after = await snapshot()
  if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(active) !== JSON.stringify(marker())) fail()
  const serverObservedAt = now().toISOString()
  if (journal && Date.parse(journal.completedAt) > Date.parse(serverObservedAt)) fail()
  return { schemaVersion: 1, phase: input.phase, runId: input.runId, requestId: input.requestId, requestSha: input.requestSha, sourceSha: input.sourceSha, ciRunId: input.ciRunId,
    serverObservedAt, revision: active.revision, archiveSha256: active.archiveSha256,
    sourceVerified: true, sourceFiles: input.files.length, manifestSha256: hash(JSON.stringify(input.files)),
    runtime, processVerified: true, processSha256: hash(JSON.stringify(after)),
    internalHealth: true, indexSha256, journal }
}

/** Code and manifest come from the reviewed controller, not the running app. */
export function observationProgram(input, snapshotSource) {
  return `import * as fs from 'node:fs';\nimport { createHash } from 'node:crypto';\ntry { const { snapshotProductionProcess } = await import(${JSON.stringify('data:text/javascript;base64,' + Buffer.from(snapshotSource).toString('base64'))});\nconsole.log(JSON.stringify(await (${observeProduction.toString()})(${JSON.stringify(input)}, {io:fs,snapshot:snapshotProductionProcess})));\n} catch { console.error('Production observation unavailable; no state was changed.'); process.exitCode=1; }\n`
}
