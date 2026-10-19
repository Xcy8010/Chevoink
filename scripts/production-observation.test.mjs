import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { observeProduction, observationProgram } from './production-observation.mjs'
import { inspectProduction } from './inspect-production.mjs'
import { readProductionReceipt, readProductionRun } from './production-receipt.mjs'
import { productionPushRequest, productionRequestTitle, verifyProductionRequestGraph, admitProductionRequest, reconcileProductionRequest } from './production-request.mjs'
import { verifyCloudObservation } from './cloud-deploy-guard.mjs'

const sourceSha = 'a'.repeat(40), baseline = 'b'.repeat(40), archiveSha256 = 'c'.repeat(64)
const requestSha = 'd'.repeat(40)
const requestId = '12345678-1234-1234-1234-123456789abc'
const root = '/opt/chevoink/app/current', index = '<html>fixture</html>', hash = bytes => createHash('sha256').update(bytes).digest('hex')
const scope = { runId: '34', requestId, requestSha, sourceSha, ciRunId: '12', phase: 'preflight' }
const now = () => new Date('2026-10-19T12:00:10Z')
function fixture() {
  const files = new Map([
    [root + '/.chevoink-release.json', JSON.stringify({ revision: baseline, archiveSha256 })],
    [root + '/.node-version', '22.23.2\n'], [root + '/api/server.ts', 'fixture-source\n'],
    [root + '/dist/index.html', index], ['/var/www/chevoink/current/index.html', index],
  ])
  const symbolic = new Set(), aliases = new Map(), reads = [], urls = []
  const directories = new Set([root, root + '/api'])
  const io = {
    lstatSync(name) { return { isDirectory: () => directories.has(name), isFile: () => files.has(name), isSymbolicLink: () => symbolic.has(name), size: files.get(name)?.length ?? 0 } },
    realpathSync: name => aliases.get(name) ?? name,
    readFileSync(name) { reads.push(name); if (!files.has(name)) throw new Error('fixture missing'); return Buffer.from(files.get(name)) },
  }
  const manifest = [{ path: '.node-version', sha256: hash('22.23.2\n') }, { path: 'api/server.ts', sha256: hash('fixture-source\n') }]
  const snapshot = async () => ({ pid: 30, start: 123456, daemonPid: 20, daemonStart: '200' })
  const request = async url => { urls.push(url); assert.equal(url, 'http://127.0.0.1:3001/api/health'); return new Response(JSON.stringify({ success: true, data: { appEnv: 'production', ignoredPrivateField: 'not exported' } })) }
  const input = { ...scope, stage: 'verify', revision: baseline, archiveSha256, files: manifest }
  return { files, reads, symbolic, aliases, urls, manifest, input, deps: { io, snapshot, request, now } }
}

test('observation checks actual source, stable process, internal health and both on-host index copies without exporting env/body', async () => {
  const f = fixture(), result = await observeProduction(f.input, f.deps)
  assert.equal(result.revision, baseline)
  assert.equal(result.sourceFiles, 2)
  assert.equal(result.internalHealth, true)
  assert.equal(result.indexSha256, hash(index))
  assert.equal(result.processSha256, hash(JSON.stringify(await f.deps.snapshot())))
  assert.equal(result.journal, null)
  assert.equal(result.serverObservedAt, now().toISOString())
  assert.ok(f.reads.every(name => !name.includes('.env') && !name.includes('manuscript')))
  assert.ok(!JSON.stringify(result).includes('not exported'))
  assert.deepEqual(await observeProduction({ ...f.input, stage: 'discover' }, f.deps), { revision: baseline, archiveSha256 })
})

for (const scenario of ['marker', 'archive', 'source', 'file-symlink', 'directory-symlink', 'root-alias', 'process-change', 'health', 'index', 'traversal', 'duplicate-source', 'private-path']) {
  test(`observation fails closed on ${scenario}`, async () => {
    const f = fixture()
    if (scenario === 'marker') f.files.set(root + '/.chevoink-release.json', JSON.stringify({ revision: sourceSha, archiveSha256 }))
    if (scenario === 'archive') f.input.archiveSha256 = 'd'.repeat(64)
    if (scenario === 'source') f.files.set(root + '/api/server.ts', 'modified')
    if (scenario === 'file-symlink') f.symbolic.add(root + '/api/server.ts')
    if (scenario === 'directory-symlink') f.aliases.set(root + '/api', '/other/api')
    if (scenario === 'root-alias') f.aliases.set(root, '/other/current')
    if (scenario === 'process-change') { let sequence = 0; f.deps.snapshot = async () => ({ pid: ++sequence }) }
    if (scenario === 'health') f.deps.request = async () => new Response('{"success":false}')
    if (scenario === 'index') f.files.set('/var/www/chevoink/current/index.html', 'old web entry')
    if (scenario === 'traversal') f.input.files = [{ path: 'api/../../shared/app.env', sha256: hash('anything') }]
    if (scenario === 'duplicate-source') f.input.files.push(f.input.files[0])
    if (scenario === 'private-path') f.input.files = [{ path: '.env', sha256: hash('anything') }]
    await assert.rejects(observeProduction(f.input, f.deps))
  })
}
test('postflight requires the actual complete ordered journal for this revision', async () => {
  const f = fixture()
  f.input.phase = 'postflight'; f.input.revision = sourceSha
  f.files.set(root + '/.chevoink-release.json', JSON.stringify({ revision: sourceSha, archiveSha256 }))
  const phases = ['preparing', 'prepared', 'stopping', 'stopped', 'switched', 'healthy', 'completed']
  const journal = phases.map(phase => JSON.stringify({ revision: sourceSha, phase, at: '2026-10-19T12:00:01Z' })).join('\n')
  f.files.set('/opt/chevoink/app/.release-' + sourceSha + '.jsonl', journal)
  assert.equal((await observeProduction(f.input, f.deps)).journal.lastPhase, 'completed')
  for (const invalid of [journal.replace(/completed/g, 'stopping'), journal.replace(sourceSha, baseline), journal.replace(/12:00:01/g, '12:00:59')]) {
    f.files.set('/opt/chevoink/app/.release-' + sourceSha + '.jsonl', invalid)
    await assert.rejects(observeProduction(f.input, f.deps))
  }
})
test('stdin program parses correctly and the snapshot data module import cannot run its CLI/start a daemon', () => {
  const snapshotSource = readFileSync(new URL('./production-process-snapshot.mjs', import.meta.url), 'utf8')
  execFileSync(process.execPath, ['--check', '--input-type=module'], { input: observationProgram({ ...scope, stage: 'discover' }, snapshotSource) })
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(snapshotSource).toString('base64')
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(moduleUrl)});console.log(typeof m.snapshotProductionProcess)`], { encoding: 'utf8' }).trim(), 'function')
})

function receipt(phase = 'preflight') {
  return { schemaVersion: 1, ...scope, phase, revision: phase === 'preflight' ? baseline : sourceSha, archiveSha256,
    sourceVerified: true, sourceFiles: 2, manifestSha256: hash('manifest'), runtime: '22.23.2', processVerified: true, processSha256: hash('process'),
    internalHealth: true, indexSha256: hash(index), serverObservedAt: '2026-10-19T12:00:09Z', observedAt: '2026-10-19T12:00:10Z',
    publicHealth: true, publicIndexVerified: true, journal: phase === 'preflight' ? null : { revision: sourceSha, lastPhase: 'completed', completedAt: '2026-10-19T12:00:08Z' } }
}
function runnerFixture() {
  const calls = [], urls = [], result = receipt()
  const exec = (program, args, options) => {
    calls.push({ program, args, options })
    if (program === 'git') return args[0] === 'rev-parse' ? sourceSha : ''
    assert.match(program, /^ssh(?:\.exe)?$/)
    assert.ok(args.includes('StrictHostKeyChecking=yes'))
    assert.equal(args.at(-2), 'ubuntu@124.223.188.123')
    assert.ok(!options.input.includes('fixture-key-path'))
    return JSON.stringify(options.input.includes('"stage":"discover"') ? { revision: baseline, archiveSha256 } : result)
  }
  const request = async (url, options) => {
    urls.push(url); assert.equal(options.redirect, 'error')
    return url.endsWith('/api/health') ? new Response('{"success":true,"data":{"appEnv":"production"}}') : new Response(index)
  }
  return { calls, urls, result, options: { ...scope, keyPath: 'fixture-key-path' }, deps: { exec, manifest: () => [{ path: 'package.json', sha256: hash('fixture') }], request, now } }
}
test('runner discovers then verifies committed ancestor source, with fixed readonly SSH and public checks', async () => {
  const f = runnerFixture(), result = await inspectProduction(f.options, f.deps)
  assert.equal(result.revision, baseline)
  assert.equal(result.observedAt, now().toISOString())
  assert.equal(f.calls.filter(call => call.program.startsWith('ssh')).length, 2)
  assert.ok(f.calls.some(call => call.program === 'git' && call.args.join(' ') === `merge-base --is-ancestor ${baseline} ${sourceSha}`))
  assert.deepEqual(f.urls, ['https://chevoink.chevolink.com/api/health', 'https://chevoink.chevolink.com'])
})
for (const scenario of ['wrong-controller', 'non-ancestor', 'ssh-failure', 'expected-baseline', 'changed-source', 'wrong-request', 'public-index', 'public-health']) {
  test(`runner refuses ${scenario} without a deployment or retry`, async () => {
    const f = runnerFixture(), exec = f.deps.exec
    if (scenario === 'wrong-controller') f.options.sourceSha = baseline
    if (scenario === 'non-ancestor') f.deps.exec = (program, args, options) => { if (program === 'git' && args[0] === 'merge-base') throw new Error('not an ancestor'); return exec(program, args, options) }
    if (scenario === 'ssh-failure') f.deps.exec = (program, args, options) => { if (program.startsWith('ssh')) throw new Error('no SSH'); return exec(program, args, options) }
    if (scenario === 'expected-baseline') f.options.expectedRevision = sourceSha
    if (scenario === 'changed-source') f.result.revision = sourceSha
    if (scenario === 'wrong-request') f.result.requestId = 'other'
    if (scenario === 'public-index') f.result.indexSha256 = hash('different')
    if (scenario === 'public-health') f.deps.request = async () => new Response('{"success":false}')
    await assert.rejects(inspectProduction(f.options, f.deps))
    assert.ok(f.calls.every(call => call.program === 'git' || /^ssh(?:\.exe)?$/.test(call.program)))
    assert.ok(f.calls.filter(call => call.program.startsWith('ssh')).length <= 2)
  })
}

function runFixture(mode = 'inspect') {
  const run = { id: 34, repository: { full_name: 'Xcy8010/Chevoink' }, path: '.github/workflows/cloud-deploy.yml', event: 'push', head_branch: 'main',
    run_attempt: 1, head_sha: requestSha, status: 'completed', conclusion: 'success', display_title: `${mode} ${sourceSha}${mode === 'deploy' ? ` over ${baseline}` : ''} [${requestId}]`,
    run_started_at: '2026-10-19T12:00:00Z', updated_at: '2026-10-19T12:00:20Z' }
  const job = { name: 'deploy', run_id: 34, status: 'completed', conclusion: 'success' }
  const before = { ...receipt(), observedAt: '2026-10-19T12:00:01Z' }, after = receipt('postflight')
  const publication = { schemaVersion: 1, runId: '34', requestId, requestSha, revision: sourceSha, baseline, ciRunId: '12', archiveSha256,
    publicIndexSha256: hash(index), verifiedAt: '2026-10-19T12:00:09Z' }
  const line = (prefix, value) => '2026-10-19T12:00:11.1234567Z ' + prefix + ' ' + JSON.stringify(value) + '\n'
  const log = () => line('CHEVOINK_PRODUCTION_RECEIPT', before) + (mode === 'inspect' ? ''
    : line('CHEVOINK_DEPLOYMENT_RECEIPT', publication) + line('CHEVOINK_PRODUCTION_RECEIPT', after))
  return { run, job, before, after, publication, line, log, options: { mode, requestId, requestSha, sourceSha, ciRunId: '12', ...(mode === 'deploy' ? { expectedRevision: baseline } : {}), now: Date.parse('2026-10-19T12:00:30Z') } }
}
test('readback distinguishes inspection from a complete publication and binds request/run/SHA/archive/health', () => {
  for (const mode of ['inspect', 'deploy']) {
    const f = runFixture(mode)
    assert.equal(readProductionReceipt(f.run, f.job, f.log(), f.options).revision, mode === 'inspect' ? baseline : sourceSha)
  }
})
test('raw Windows job logs accept CRLF receipt records with seven-digit timestamps without adapter normalization', () => {
  // Actual Windows log framing; all run identities, payloads and times are synthetic.
  for (const mode of ['inspect', 'deploy']) {
    const f = runFixture(mode)
    const commands = '2026-10-19T12:00:00.1234567Z ##[group]Run observation\r\n'
      + '2026-10-19T12:00:00.1234567Z Write-Host "CHEVOINK_PRODUCTION_RECEIPT $receiptJson"\r\n'
    const log = commands + f.log().replace(/\n/g, '\r\n') + '2026-10-19T12:00:12.1234567Z ##[endgroup]\r\n'
    assert.equal(readProductionReceipt(f.run, f.job, log, f.options).revision, mode === 'inspect' ? baseline : sourceSha)
    const mixed = log.replace('##[group]Run observation\r\n', '##[group]Run observation\n')
      .replace(' CHEVOINK_PRODUCTION_RECEIPT ', ' \u001b[32mCHEVOINK_PRODUCTION_RECEIPT ')
    assert.equal(readProductionReceipt(f.run, f.job, mixed, f.options).revision, mode === 'inspect' ? baseline : sourceSha)
  }
})
test('Windows command snippets or untimestamped text cannot substitute for an actual receipt', () => {
  const f = runFixture()
  for (const log of ['2026-10-19T12:00:11.1234567Z Write-Host "CHEVOINK_PRODUCTION_RECEIPT ' + JSON.stringify(f.before) + '"\r\n',
    'CHEVOINK_PRODUCTION_RECEIPT ' + JSON.stringify(f.before) + '\r\n', f.log().replace(/\n/g, '\r\n').replace(/}\r\n$/, '\r\n')]) {
    assert.throws(() => readProductionReceipt(f.run, f.job, log, f.options))
  }
})
for (const scenario of ['expired', 'future', 'wrong-run', 'wrong-request', 'wrong-repo', 'foreign-source', 'requested-source', 'requested-ci', 'rerun', 'failed', 'no-time', 'wrong-job', 'duplicate-proof', 'missing-proof']) {
  test(`readback rejects ${scenario} instead of reporting a current production baseline`, () => {
    const f = runFixture()
    if (scenario === 'expired') f.options.now += 6 * 60 * 1000
    if (scenario === 'future') f.before.observedAt = '2026-10-19T12:01:00Z'
    if (scenario === 'wrong-run') f.before.runId = '35'
    if (scenario === 'wrong-request') f.before.requestId = 'other'
    if (scenario === 'wrong-repo') f.run.repository.full_name = 'fork/Chevoink'
    if (scenario === 'foreign-source') f.before.sourceSha = baseline
    if (scenario === 'requested-source') f.options.sourceSha = baseline
    if (scenario === 'requested-ci') f.options.ciRunId = '13'
    if (scenario === 'rerun') f.run.run_attempt = 2
    if (scenario === 'failed') f.run.conclusion = 'failure'
    if (scenario === 'no-time') f.run.run_started_at = 'invalid'
    if (scenario === 'wrong-job') f.job.name = 'untrusted'
    const log = scenario === 'duplicate-proof' ? f.log() + f.log() : scenario === 'missing-proof' ? '' : f.log()
    assert.throws(() => readProductionReceipt(f.run, f.job, log, f.options))
    assert.throws(() => readProductionReceipt(f.run, f.job, log.replace(/\n/g, '\r\n'), f.options))
  })
}
for (const scenario of ['archive', 'baseline', 'journal', 'health', 'source', 'publication-request', 'publication-ci']) {
  test(`publication readback rejects inconsistent ${scenario}`, () => {
    const f = runFixture('deploy')
    if (scenario === 'archive') f.publication.archiveSha256 = 'd'.repeat(64)
    if (scenario === 'baseline') f.publication.baseline = sourceSha
    if (scenario === 'journal') f.after.journal.lastPhase = 'healthy'
    if (scenario === 'health') f.after.publicHealth = false
    if (scenario === 'source') f.after.sourceVerified = false
    if (scenario === 'publication-request') f.publication.requestId = 'other'
    if (scenario === 'publication-ci') f.publication.ciRunId = '13'
    assert.throws(() => readProductionReceipt(f.run, f.job, f.log(), f.options))
    assert.throws(() => readProductionReceipt(f.run, f.job, f.log().replace(/\n/g, '\r\n'), f.options))
  })
}
test('readback adapter uses only existing authenticated GitHub run/job/log reads', async () => {
  const f = runFixture(), calls = []
  f.job.id = 42
  const request = async endpoint => {
    calls.push(endpoint)
    if (endpoint.endsWith('/runs/34')) return f.run
    if (endpoint.endsWith('/jobs?filter=latest&per_page=100')) return { total_count: 2, jobs: [f.job, { name: 'admit', run_id: 34, status: 'completed', conclusion: 'success' }] }
    if (endpoint.endsWith('/jobs/42/logs')) return f.log()
    throw new Error('Unexpected API target')
  }
  assert.equal((await readProductionRun('34', f.options, request)).revision, baseline)
  assert.equal(calls.length, 3)
  await assert.rejects(readProductionRun('34', f.options, async () => { throw new Error('API unavailable') }))
  await assert.rejects(readProductionRun('../other', f.options, request))
})
test('push request contract rejects missing exact baseline, provenance and extra inputs', () => {
  const input = { schemaVersion: 1, action: 'inspect', sourceSha, requestId, ciRunId: '12' }
  assert.deepEqual(productionPushRequest(input), input)
  assert.equal(productionRequestTitle(input), `inspect ${sourceSha} [${requestId}]`)
  for (const patch of [{ action: 'delete' }, { sourceSha: 'main' }, { ciRunId: undefined }, { requestId: '' }, { expectedRevision: baseline }, { action: 'deploy' }]) {
    assert.throws(() => productionPushRequest({ ...input, ...patch }))
  }
  const publish = { ...input, action: 'deploy', expectedRevision: baseline, inspectionRunId: '33',
    inspectionRequestId: '87654321-1234-1234-1234-123456789abc', inspectionRequestSha: 'e'.repeat(40) }
  assert.equal(productionRequestTitle(publish), `deploy ${sourceSha} over ${baseline} [${requestId}]`)
  assert.throws(() => productionPushRequest({ ...publish, expectedRevision: '' }))
  assert.throws(() => productionPushRequest({ ...publish, expectedRevision: sourceSha }))
})
test('lost push/run result is reconciled by unique request commit and run, never by submitting again', () => {
  const f = runFixture()
  const input = { schemaVersion: 1, action: 'inspect', sourceSha, requestId, ciRunId: '12' }
  assert.deepEqual(reconcileProductionRequest({ total_count: 1, workflow_runs: [f.run] }, input, requestSha), { status: 'located', runId: '34', retryAllowed: false })
  assert.deepEqual(reconcileProductionRequest({ total_count: 0, workflow_runs: [] }, input, requestSha), { status: 'unknown', retryAllowed: false })
  assert.deepEqual(reconcileProductionRequest({ total_count: 2, workflow_runs: [f.run, { ...f.run, id: 35 }] }, input, requestSha), { status: 'unknown', retryAllowed: false })
  assert.throws(() => reconcileProductionRequest({ total_count: 2, workflow_runs: [f.run] }, input, requestSha))
})

function graphFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'chevoink-request-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid'])
  mkdirSync(path.join(directory, '.github'))
  const requestPath = path.join(directory, '.github/production-request.json')
  const write = data => writeFileSync(requestPath, JSON.stringify(data, null, 2) + '\n')
  const commit = message => { git(['add', '.']); git(['commit', '-m', message]); return git(['rev-parse', 'HEAD']) }
  write({ schemaVersion: 1, action: 'none' }); writeFileSync(path.join(directory, 'controller.mjs'), 'trusted source\n')
  const candidate = commit('candidate')
  const input = { schemaVersion: 1, action: 'inspect', sourceSha: candidate, ciRunId: '12', requestId }
  write(input)
  const revision = commit(productionRequestTitle(input))
  const event = { ref: 'refs/heads/main', before: candidate, after: revision, forced: false, created: false, deleted: false,
    repository: { full_name: 'Xcy8010/Chevoink', default_branch: 'main' } }
  const env = { GITHUB_REPOSITORY: 'Xcy8010/Chevoink', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: revision, GITHUB_RUN_ID: '34' }
  return { directory, git, write, commit, candidate, input, revision, event, env }
}
test('complete Git graph binds R to unchanged tested C, without mistaking a bootstrap for a request', t => {
  const f = graphFixture(t)
  assert.deepEqual(verifyProductionRequestGraph(f.revision, f.event, f.git), { eligible: true, requestSha: f.revision, ...f.input })
  assert.equal(verifyProductionRequestGraph(f.candidate, { ...f.event, after: f.candidate }, f.git).eligible, false)
})
for (const scenario of ['workflow-change', 'hidden-change-and-revert', 'merge', 'duplicate-uuid', 'noncanonical', 'symlink', 'wrong-title', 'wrong-before', 'forced', 'foreign-repository', 'wrong-ref', 'wrong-after', 'created', 'deleted']) {
  test(`request graph rejects ${scenario} before production access`, t => {
    const f = graphFixture(t)
    if (scenario === 'workflow-change') writeFileSync(path.join(f.directory, 'controller.mjs'), 'unreviewed source')
    if (scenario === 'hidden-change-and-revert') {
      writeFileSync(path.join(f.directory, 'controller.mjs'), 'hidden'); f.commit('hidden change')
      writeFileSync(path.join(f.directory, 'controller.mjs'), 'trusted source\n')
    }
    if (['workflow-change', 'hidden-change-and-revert', 'duplicate-uuid'].includes(scenario)) {
      f.write({ ...f.input, ...(scenario === 'duplicate-uuid' ? { ciRunId: '13' } : {}), requestId: scenario === 'duplicate-uuid' ? requestId : '87654321-1234-1234-1234-123456789abc' })
      f.event.before = f.git(['rev-parse', 'HEAD']); f.revision = f.commit(productionRequestTitle({ ...f.input, requestId: scenario === 'duplicate-uuid' ? requestId : '87654321-1234-1234-1234-123456789abc' })); f.event.after = f.revision
    }
    if (scenario === 'noncanonical') { writeFileSync(path.join(f.directory, '.github/production-request.json'), JSON.stringify(f.input)); f.git(['add', '.']); f.git(['commit', '--amend', '--no-edit']); f.revision = f.git(['rev-parse', 'HEAD']); f.event.after = f.revision }
    if (scenario === 'symlink') { unlinkSync(path.join(f.directory, '.github/production-request.json')); symlinkSync('../controller.mjs', path.join(f.directory, '.github/production-request.json')); f.git(['add', '.']); f.git(['commit', '--amend', '--no-edit']); f.revision = f.git(['rev-parse', 'HEAD']); f.event.after = f.revision }
    if (scenario === 'merge') {
      f.git(['checkout', '-b', 'topic', f.candidate]); writeFileSync(path.join(f.directory, 'untrusted'), 'x'); f.commit('topic')
      f.git(['checkout', 'main']); f.git(['merge', '--no-ff', 'topic', '-m', productionRequestTitle(f.input)])
      f.event.before = f.revision; f.revision = f.git(['rev-parse', 'HEAD']); f.event.after = f.revision
    }
    if (scenario === 'wrong-title') { f.git(['commit', '--amend', '-m', 'anything']); f.revision = f.git(['rev-parse', 'HEAD']); f.event.after = f.revision }
    if (scenario === 'wrong-before') f.event.before = baseline
    if (scenario === 'forced') f.event.forced = true
    if (scenario === 'foreign-repository') f.event.repository.full_name = 'fork/Chevoink'
    if (scenario === 'wrong-ref') f.event.ref = 'refs/heads/topic'
    if (scenario === 'wrong-after') f.event.after = baseline
    if (scenario === 'created') f.event.created = true
    if (scenario === 'deleted') f.event.deleted = true
    assert.throws(() => verifyProductionRequestGraph(f.revision, f.event, f.git))
  })
}
test('push admission rejects stale main, absent CI and wrong event before protected execution', async t => {
  const f = graphFixture(t)
  const deps = { event: f.event, git: f.git, request: async () => ({ name: 'main', commit: { sha: baseline } }) }
  await assert.rejects(admitProductionRequest(f.env, deps))
  for (const patch of [{ GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_SHA: f.candidate }]) {
    await assert.rejects(admitProductionRequest({ ...f.env, ...patch }, deps))
  }
  await assert.rejects(admitProductionRequest(f.env, { ...deps, request: async endpoint => endpoint.endsWith('/branches/main')
    ? { name: 'main', commit: { sha: f.revision } } : { path: '.github/workflows/ci.yml', event: 'pull_request' } }))
})

function admissionReader(f, inspection) {
  const names = ['plan test shards', 'check / lint / build / audit', 'merge coverage / test report', 'check / lint / test / build / audit', 'test shard 1/2', 'test shard 2/2']
  return async endpoint => {
    if (endpoint.endsWith('/branches/main')) return { name: 'main', commit: { sha: f.revision }, protected: false }
    if (endpoint.endsWith(`/runs/${f.env.GITHUB_RUN_ID}`)) return { id: Number(f.env.GITHUB_RUN_ID), repository: { full_name: 'Xcy8010/Chevoink' },
      path: '.github/workflows/cloud-deploy.yml', event: 'push', head_branch: 'main', head_sha: f.revision, run_attempt: 1,
      display_title: productionRequestTitle(JSON.parse(f.git(['show', `${f.revision}:.github/production-request.json`]))), conclusion: null }
    if (endpoint.endsWith('/environments/production')) return { id: 7, name: 'production', protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'owner' } }] }] }
    if (endpoint.endsWith('/approvals')) return [{ state: 'approved', user: { type: 'User', login: 'owner' }, environments: [{ id: 7, name: 'production' }] }]
    if (endpoint.endsWith('/runs/12')) return { id: 12, repository: { full_name: 'Xcy8010/Chevoink' }, head_sha: f.candidate, name: 'CI',
      path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main', status: 'completed', conclusion: 'success' }
    if (endpoint.includes('/runs/12/jobs?')) return { total_count: names.length, jobs: names.map((name, i) => ({ id: i + 1, run_id: 12, name, status: 'completed', conclusion: 'success' })) }
    if (inspection && endpoint.endsWith('/runs/34')) return inspection.run
    if (inspection && endpoint.includes('/runs/34/jobs?')) return { total_count: 2, jobs: [{ name: 'admit', run_id: 34, status: 'completed', conclusion: 'success' }, { ...inspection.job, id: 42 }] }
    if (inspection && endpoint.endsWith('/jobs/42/logs')) return inspection.log()
    throw new Error('Unexpected fixture API endpoint: ' + endpoint)
  }
}
test('first inspect is admitted with exact original CI while accurately reporting unprotected main', async t => {
  const f = graphFixture(t)
  const result = await admitProductionRequest(f.env, { event: f.event, git: f.git, request: admissionReader(f) })
  assert.equal(result.sourceSha, f.candidate)
  assert.equal(result.requestSha, f.revision)
  assert.equal(result.mainProtected, false)
})
test('deploy admission binds explicit B to a successful fresh inspect of C and rejects changed or stale evidence', async t => {
  const f = graphFixture(t), inspectionSha = f.revision
  const inspected = runFixture('inspect')
  inspected.run.head_sha = inspectionSha; inspected.run.display_title = `inspect ${f.candidate} [${requestId}]`
  inspected.before.sourceSha = f.candidate; inspected.before.requestSha = inspectionSha
  const publish = { schemaVersion: 1, action: 'deploy', sourceSha: f.candidate, ciRunId: '12',
    requestId: '87654321-1234-1234-1234-123456789abc', expectedRevision: baseline, inspectionRunId: '34',
    inspectionRequestId: requestId, inspectionRequestSha: inspectionSha }
  f.write(publish); f.revision = f.commit(productionRequestTitle(publish))
  f.event.before = inspectionSha; f.event.after = f.revision; f.env.GITHUB_SHA = f.revision
  f.env.GITHUB_RUN_ID = '35'
  const deps = { event: f.event, git: f.git, request: admissionReader(f, inspected), now: inspected.options.now }
  assert.equal((await admitProductionRequest(f.env, deps)).expectedRevision, baseline)
  inspected.before.revision = 'e'.repeat(40)
  await assert.rejects(admitProductionRequest(f.env, deps))
  inspected.before.revision = baseline
  await assert.rejects(admitProductionRequest(f.env, { ...deps, now: deps.now + 6 * 60 * 1000 }))
  inspected.run.head_sha = f.candidate
  await assert.rejects(admitProductionRequest(f.env, deps))
})

test('protected push guard rebinds outputs to immutable request and requires actual human approval', async t => {
  const f = graphFixture(t), request = admissionReader(f)
  const env = { ...f.env, SOURCE_SHA: f.candidate, PRODUCTION_REQUEST_SHA: f.revision, CI_RUN_ID: '12',
    PRODUCTION_ACTION: 'inspect', PRODUCTION_REQUEST_ID: requestId, EXPECTED_PRODUCTION_SHA: '' }
  const dependencies = { event: f.event, git: f.git }
  assert.equal((await verifyCloudObservation(env, f.candidate, request, dependencies)).inspectionOnly, true)
  for (const patch of [{ CI_RUN_ID: '13' }, { PRODUCTION_REQUEST_ID: '87654321-1234-1234-1234-123456789abc' },
    { PRODUCTION_REQUEST_SHA: baseline }, { PRODUCTION_ACTION: 'deploy' }]) {
    await assert.rejects(verifyCloudObservation({ ...env, ...patch }, f.candidate, request, dependencies))
  }
  await assert.rejects(verifyCloudObservation(env, f.candidate, endpoint => endpoint.endsWith('/approvals') ? [] : request(endpoint), dependencies))
  await assert.rejects(admitProductionRequest(f.env, { ...dependencies, request: async endpoint => {
    const result = await request(endpoint)
    return endpoint.endsWith('/runs/34') ? { ...result, run_attempt: 2 } : result
  } }))
})
