import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseMountinfo, planApplicationCopies, planDependencyCaches, pruneApplicationCopies, readProcessReferences, lockIsHeld } from './prune-application-copies.mjs'

const sha = character => character.repeat(40)
const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const oldName = `previous-${sha('b')}-for-${sha('c')}`
const baseline = `previous-${sha('c')}-for-${sha('d')}`
const oldestName = `previous-${sha('a')}-for-${sha('b')}`
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 })
const mount = directory => `1 0 0:1 / ${directory.replaceAll('\\', '\\134').replaceAll(' ', '\\040')} rw - ext4 fixture rw\n`
const link = (target, destination) => fs.symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir')
function fixture(t, oldest = false) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chevoink-copy-test-')))
  t.after(() => {
    assert.equal(path.dirname(base), fs.realpathSync(os.tmpdir()))
    assert.match(path.basename(base), /^chevoink-copy-test-/)
    fs.rmSync(base, { recursive: true, force: true })
  })
  const root = path.join(base, 'app');fs.mkdirSync(root)
  const copy = (name, revision) => {
    const directory = path.join(root, name);fs.mkdirSync(directory)
    json(path.join(directory, '.chevoink-release.json'), { revision, archiveSha256: 'f'.repeat(64) })
    json(path.join(directory, '.release-health.json'), { success: true })
    fs.writeFileSync(path.join(directory, 'source.js'), 'export const version = 1\n')
    return directory
  }
  const journal = (revision, phases = ['switched', 'healthy', 'completed']) => fs.writeFileSync(path.join(root, `.release-${revision}.jsonl`), phases.map(phase => JSON.stringify({ revision, phase, at: '2026-11-07T00:00:00Z' })).join('\n') + '\n', { mode: 0o600 })
  copy('current', sha('d'));copy(baseline, sha('c'));copy(oldName, sha('b'))
  journal(sha('d'));journal(sha('c'))
  if (oldest) { copy(oldestName, sha('a'));journal(sha('b')) }
  let next = 0
  const options = { root, uid: Number(fs.lstatSync(root).uid), processes: () => [], mountinfo: () => mount(path.parse(root).root), uuid: () => ids[next++] }
  return { base, root, options, copy, journal, old: path.join(root, oldName), store: path.join(root, '.retired-copies') }
}
function preparedJob(f, state, partial = false) {
  const candidate = planApplicationCopies(f.options).candidates.find(item => item.name === oldName)
  fs.mkdirSync(f.store, { mode: 0o700 })
  const evidencePath = path.join(f.store, ids[0] + '.evidence');fs.mkdirSync(evidencePath, { mode: 0o700 })
  const evidence = ['.chevoink-release.json', '.release-health.json'].map(name => {
    const bytes = fs.readFileSync(path.join(f.old, name));fs.writeFileSync(path.join(evidencePath, name), bytes, { mode: 0o600 })
    return { name, sha256: hash(bytes), preservedAt: path.join(evidencePath, name) }
  })
  const job = { version: 1, operationId: ids[0], state: 'started', ...candidate, evidence }
  const rows = [job]
  if (state !== 'started') {
    fs.renameSync(f.old, path.join(f.store, ids[0]))
    rows.push({ operationId: ids[0], state: 'isolated' })
    if (state === 'deleting') rows.push({ operationId: ids[0], state: 'deleting' })
    if (partial) fs.unlinkSync(path.join(f.store, ids[0], '.chevoink-release.json'))
  }
  const receipt = path.join(f.store, ids[0] + '.jsonl')
  fs.writeFileSync(receipt, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
  return { receipt, isolated: path.join(f.store, ids[0]), evidencePath }
}

test('retains current + exact baseline; deletes only proven older copies with raw external evidence', t => {
  const f = fixture(t, true), bytes = fs.readFileSync(path.join(f.old, '.chevoink-release.json'))
  const journal = fs.readFileSync(path.join(f.root, `.release-${sha('c')}.jsonl`))
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.status, 'inspected', JSON.stringify(result));assert.deepEqual(result.operations.map(row => row.state), ['deleted', 'deleted'])
  assert(fs.existsSync(path.join(f.root, 'current')));assert(fs.existsSync(path.join(f.root, baseline)))
  assert(!fs.existsSync(f.old));assert(!fs.existsSync(path.join(f.root, oldestName)))
  assert.deepEqual(fs.readFileSync(path.join(f.root, `.release-${sha('c')}.jsonl`)), journal)
  const receipt = fs.readFileSync(path.join(f.store, ids[1] + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(receipt[0].name, oldName);assert.deepEqual(receipt.map(row => row.state), ['started', 'isolated', 'deleting', 'deleted'])
  const preserved = receipt[0].evidence.find(item => item.name === '.chevoink-release.json')
  assert.deepEqual(fs.readFileSync(preserved.preservedAt), bytes);assert.equal(preserved.sha256, hash(bytes))
})

test('unknown release, maintenance and migrated-original symlinks remain opaque and untouched', t => {
  const f = fixture(t), target = path.join(f.base, 'migrated-original');fs.mkdirSync(target);fs.writeFileSync(path.join(target, 'sentinel'), 'keep')
  const migrated = `previous-${sha('e')}-for-${sha('b')}`;link(target, path.join(f.root, migrated))
  fs.mkdirSync(path.join(f.root, 'release-' + sha('e')));fs.mkdirSync(path.join(f.root, 'maintenance-' + sha('f')))
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.status, 'inspected', JSON.stringify(result));assert.equal(result.operations[0].state, 'deleted')
  assert.equal(result.skipped.find(item => item.name === migrated).reason, 'migrated_or_symbolic_link')
  assert.equal(result.skipped.find(item => item.name.startsWith('maintenance')).reason, 'maintenance_not_implemented')
  assert.equal(fs.readFileSync(path.join(target, 'sentinel'), 'utf8'), 'keep');assert(fs.lstatSync(path.join(f.root, migrated)).isSymbolicLink())
})

for (const field of ['marker', 'journal']) test(`rejects unproven ${field} without mutation`, t => {
  const f = fixture(t)
  if (field === 'marker') json(path.join(f.old, '.chevoink-release.json'), { revision: sha('a'), archiveSha256: 'f'.repeat(64) })
  else f.journal(sha('c'), ['switched', 'healthy'])
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations.length, 0);assert(fs.existsSync(f.old));assert.equal(result.skipped.length, 1)
})

test('ambiguous current baseline blocks the whole round', t => {
  const f = fixture(t);f.copy(`previous-${sha('e')}-for-${sha('d')}`, sha('e'))
  assert.deepEqual(pruneApplicationCopies(f.options), { status: 'skipped', reason: 'COPY_BASELINE_AMBIGUOUS' });assert(fs.existsSync(f.old))
})

test('noncanonical root and changed owner are rejected', t => {
  const f = fixture(t)
  assert.equal(pruneApplicationCopies({ ...f.options, root: f.root + path.sep }).reason, 'COPY_ROOT_INVALID')
  assert.equal(pruneApplicationCopies({ ...f.options, uid: f.options.uid + 1 }).reason, 'COPY_ROOT_INVALID')
})

test('nested same-device bind mount rejects old source copy', t => {
  const f = fixture(t);fs.mkdirSync(path.join(f.old, 'mounted'))
  const options = { ...f.options, mountinfo: () => f.options.mountinfo() + mount(path.join(f.old, 'mounted')) }
  const result = pruneApplicationCopies(options)
  assert.equal(result.operations.length, 0);assert.equal(result.skipped[0].reason, 'COPY_NESTED_MOUNT');assert(fs.existsSync(f.old))
})

for (const entry of ['.env', 'uploads', 'native', 'logs', 'PGDATA', 'unrecognized-runtime.log', 'backup-data']) test(`protects runtime data ${entry}`, t => {
  const f = fixture(t), destination = path.join(f.old, entry)
  if (entry === '.env' || entry.endsWith('.log')) fs.writeFileSync(destination, 'private')
  else fs.mkdirSync(destination)
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations.length, 0);assert.equal(result.skipped[0].reason, 'COPY_PROTECTED_DATA');assert(fs.existsSync(destination))
})

for (const kind of ['cwd', 'argument', 'other-user-readable']) test(`protects running ${kind} reference without leaking command line`, t => {
  const f = fixture(t), secret = 'DO_NOT_OUTPUT_CREDENTIAL'
  const processRow = { pid: 42, cwd: kind === 'cwd' ? f.old : f.base, args: kind === 'cwd' ? [secret] : ['node', '--import=' + path.join(f.old, 'source.js'), secret], node: kind !== 'other-user-readable' }
  const result = pruneApplicationCopies({ ...f.options, processes: () => [processRow] })
  assert.equal(result.operations.length, 0);assert.equal(result.skipped[0].reason, 'COPY_PROCESS_REFERENCE');assert(!JSON.stringify(result).includes(secret))
})

test('dependency symlink from kept current protects target copy', t => {
  const f = fixture(t);link(f.old, path.join(f.root, 'current', 'node_modules'))
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations.length, 0);assert.equal(result.skipped[0].reason, 'COPY_DEPENDENCY_REFERENCE');assert(fs.existsSync(f.old))
})

test('external Node cwd dependency symlink protects target copy', t => {
  const f = fixture(t), cwd = path.join(f.base, 'external-node');fs.mkdirSync(cwd);link(f.old, path.join(cwd, 'node_modules'))
  const result = pruneApplicationCopies({ ...f.options, processes: () => [{ pid: 42, cwd, args: ['node'], node: true }] })
  assert.equal(result.operations.length, 0);assert.equal(result.skipped[0].reason, 'COPY_DEPENDENCY_REFERENCE')
})

test('changing keepers after preparation defers the original UUID before any rename', t => {
  const f = fixture(t);let calls = 0
  const options = { ...f.options, processes: () => {
    if (++calls === 4) json(path.join(f.root, 'current', '.chevoink-release.json'), { revision: sha('d'), archiveSha256: 'e'.repeat(64) })
    return []
  } }
  const result = pruneApplicationCopies(options)
  assert.equal(result.operations[0].state, 'deferred');assert.equal(result.operations[0].reason, 'COPY_KEEPERS_CHANGED');assert(fs.existsSync(f.old))
  assert(fs.existsSync(path.join(f.store, ids[0] + '.jsonl')))
})

for (const progress of ['started', 'isolated', 'deleting']) test(`same UUID recovers ${progress} before enumerating any new copies`, t => {
  const f = fixture(t, true), job = preparedJob(f, progress, progress === 'deleting')
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.status, 'recovered');assert.deepEqual(result.operations, [{ operationId: ids[0], state: 'deleted' }])
  assert(!fs.existsSync(f.old));assert(!fs.existsSync(job.isolated));assert(fs.existsSync(path.join(f.root, oldestName)))
  assert(fs.existsSync(path.join(job.evidencePath, '.chevoink-release.json')))
})

test('rename-before-isolated-record crash is reconciled under the same UUID', t => {
  const f = fixture(t), job = preparedJob(f, 'started');fs.renameSync(f.old, job.isolated)
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.status, 'recovered');assert.equal(result.operations[0].state, 'deleted');assert(!fs.existsSync(job.isolated))
})

test('after-delete-before-terminal-record crash reconciles absence only with preserved evidence', t => {
  const f = fixture(t), job = preparedJob(f, 'deleting');fs.rmSync(job.isolated, { recursive: true })
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations[0].state, 'absent_reconciled')
})

test('missing quarantine evidence prevents absent reconciliation', t => {
  const f = fixture(t), job = preparedJob(f, 'deleting');fs.rmSync(job.isolated, { recursive: true });fs.unlinkSync(path.join(job.evidencePath, '.chevoink-release.json'))
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations[0].state, 'deferred');assert.notEqual(result.operations[0].reason, undefined)
})

test('mounted quarantine or evidence tree defers recovery without following it', t => {
  const f = fixture(t), job = preparedJob(f, 'isolated')
  const result = pruneApplicationCopies({ ...f.options, mountinfo: () => f.options.mountinfo() + mount(job.evidencePath) })
  assert.equal(result.status, 'skipped');assert.equal(result.reason, 'COPY_NESTED_MOUNT');assert(fs.existsSync(job.isolated))
})

test('unknown quarantine entry and corrupt/torn receipt remain untouched', t => {
  const f = fixture(t), job = preparedJob(f, 'isolated');fs.appendFileSync(job.receipt, '{"operationId":')
  assert.equal(pruneApplicationCopies(f.options).status, 'skipped');assert(fs.existsSync(job.isolated))
  fs.mkdirSync(path.join(f.store, 'unknown-target'))
  assert.equal(pruneApplicationCopies(f.options).reason, 'COPY_QUARANTINE_UNKNOWN');assert(fs.existsSync(job.isolated))
})

test('process reference appearing after isolation defers deletion', t => {
  const f = fixture(t), job = preparedJob(f, 'isolated')
  const result = pruneApplicationCopies({ ...f.options, processes: () => [{ pid: 10, cwd: job.isolated, args: ['node'], node: true }] })
  assert.equal(result.operations[0].reason, 'COPY_PROCESS_REFERENCE');assert(fs.existsSync(job.isolated))
})

test('recognizable live Node with unreadable cwd blocks snapshot; readable same-UID nonNode protects refs', t => {
  const f = fixture(t), proc = path.join(f.base, 'proc');fs.mkdirSync(proc)
  const pid = path.join(proc, '42');fs.mkdirSync(pid)
  fs.writeFileSync(path.join(pid, 'status'), `State:\tS\nUid:\t${f.options.uid}\t${f.options.uid}\n`)
  fs.writeFileSync(path.join(pid, 'comm'), 'node\n');fs.writeFileSync(path.join(pid, 'cmdline'), 'node\0source.js\0')
  assert.throws(() => readProcessReferences(f.options.uid, proc), { code: 'COPY_NODE_PROCESS_UNREADABLE' })
  fs.writeFileSync(path.join(pid, 'comm'), 'bash\n');fs.writeFileSync(path.join(pid, 'cmdline'), 'bash\0');link(f.old, path.join(pid, 'cwd'))
  const rows = readProcessReferences(f.options.uid, proc)
  assert.equal(rows[0].node, false);assert.equal(rows[0].cwd, f.old)
  assert.equal(pruneApplicationCopies({ ...f.options, processes: () => rows }).skipped[0].reason, 'COPY_PROCESS_REFERENCE')
})

test('mountinfo requires a parseable complete snapshot and decodes escaped paths', () => {
  assert.throws(() => parseMountinfo(''), { code: 'COPY_MOUNTS_UNAVAILABLE' })
  assert.throws(() => parseMountinfo('garbage'), { code: 'COPY_MOUNTS_UNAVAILABLE' })
  assert.deepEqual(parseMountinfo(mount(path.resolve(os.tmpdir(), 'with space'))), [path.resolve(os.tmpdir(), 'with space')])
})

test('kernel lock proof binds flock type, owning parent PID and exact device/inode', () => {
  const value = { dev: 0x801n, ino: 456n }, line = '1: FLOCK ADVISORY WRITE 123 08:01:456 0 EOF\n'
  assert.equal(lockIsHeld(line, 123, value), true);assert.equal(lockIsHeld(line, 124, value), false)
  assert.equal(lockIsHeld(line.replace('FLOCK', 'POSIX'), 123, value), false)
  assert.equal(lockIsHeld(line, 123, { ...value, ino: 457n }), false)
})

test('production CLI rejects arbitrary root options before reading host state', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./prune-application-copies.mjs', import.meta.url)), '--root', os.tmpdir()], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 1);assert.deepEqual(JSON.parse(result.stdout), { status: 'skipped', reason: 'COPY_CLI_ARGUMENTS_INVALID' })
})


test('unlinking a source dependency link never removes the external target', t => {
  const f = fixture(t), target = path.join(f.base, 'external-dependency');fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'keep.js'), 'keep')
  link(target, path.join(f.old, 'node_modules'))
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations[0].state, 'deleted');assert(!fs.existsSync(f.old))
  assert.equal(fs.readFileSync(path.join(target, 'keep.js'), 'utf8'), 'keep')
})

test('completed receipt with an unexpected surviving quarantine remains unknown', t => {
  const f = fixture(t), job = preparedJob(f, 'isolated')
  fs.appendFileSync(job.receipt, JSON.stringify({ operationId: ids[0], state: 'deleted' }) + '\n')
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.reason, 'COPY_QUARANTINE_UNKNOWN');assert(fs.existsSync(job.isolated))
})


for (const entry of ['backups', 'uploads', 'logs', 'PGDATA', 'investigation', 'evidence', 'local-diagnostics', 'native', '.env']) test(`nested runtime or investigation data ${entry} preserves the entire copy`, t => {
  const f = fixture(t), directory = path.join(f.old, 'api', entry)
  fs.mkdirSync(path.dirname(directory), { recursive: true })
  const sentinel = entry === '.env' ? directory : path.join(directory, 'sentinel')
  if (entry !== '.env') fs.mkdirSync(directory)
  fs.writeFileSync(sentinel, 'preserve original bytes')
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations.length, 0);assert.equal(result.skipped[0].reason, 'COPY_PROTECTED_DATA')
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve original bytes');assert(fs.existsSync(f.old))
})

for (const entry of ['evidence', 'investigation', 'local-diagnostics']) test(`top-level ${entry} is evidence, not disposable metadata`, t => {
  const f = fixture(t), directory = path.join(f.old, entry);fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'sentinel'), 'keep')
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations.length, 0);assert.equal(result.skipped[0].reason, 'COPY_PROTECTED_DATA')
  assert.equal(fs.readFileSync(path.join(directory, 'sentinel'), 'utf8'), 'keep')
})

for (const progress of ['isolated', 'deleting']) test(`nested protected data blocks same-UUID ${progress} recovery`, t => {
  const f = fixture(t), job = preparedJob(f, progress, progress === 'deleting')
  const directory = path.join(job.isolated, 'api', 'evidence');fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'sentinel'), 'keep after isolation')
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.status, 'recovered');assert.equal(result.operations[0].state, 'deferred')
  assert.equal(result.operations[0].reason, 'COPY_PROTECTED_DATA')
  assert.equal(fs.readFileSync(path.join(directory, 'sentinel'), 'utf8'), 'keep after isolation')
})

test('root-link-mediated dependency remains opaque and blocks deletion of its real source target', t => {
  const f = fixture(t), module = path.join(f.old, 'node_modules');fs.mkdirSync(module)
  fs.writeFileSync(path.join(module, 'sentinel.js'), 'still imported')
  const alias = path.join(f.root, 'alias');link(f.old, alias)
  link(path.join(alias, 'node_modules'), path.join(f.root, 'current', 'node_modules'))
  const result = pruneApplicationCopies(f.options)
  assert.deepEqual(result, { status: 'skipped', reason: 'COPY_DEPENDENCY_ROOT_LINK_UNVERIFIED' })
  assert.equal(fs.readFileSync(path.join(module, 'sentinel.js'), 'utf8'), 'still imported')
  assert(fs.lstatSync(alias).isSymbolicLink());assert(fs.existsSync(f.old))
})


for (const argument of ['entry', 'require-equals', 'require-next', 'import-equals', 'short-require']) test(`relative Node ${argument} path protects its original source copy`, t => {
  const f = fixture(t), relative = path.join(oldName, 'api', 'server.js')
  fs.mkdirSync(path.join(f.old, 'api'));fs.writeFileSync(path.join(f.old, 'api', 'server.js'), 'keep active code')
  const args = argument === 'entry' ? ['node', relative]
    : argument === 'require-equals' ? ['node', '--require=' + relative, '-e', 'void 0']
      : argument === 'require-next' ? ['node', '--require', relative, '-e', 'void 0']
        : argument === 'short-require' ? ['node', '-r' + relative, '-e', 'void 0']
          : ['node', '--import=' + relative, '-e', 'void 0']
  const result = pruneApplicationCopies({ ...f.options, processes: () => [{ pid: 42, cwd: f.root, args, node: true }] })
  assert.equal(result.operations.length, 0);assert.equal(result.skipped[0].reason, 'COPY_PROCESS_REFERENCE')
  assert.equal(fs.readFileSync(path.join(f.old, 'api', 'server.js'), 'utf8'), 'keep active code')
})

test('relative Node entry through opaque root alias also fails closed without following its target', t => {
  const f = fixture(t);link(f.old, path.join(f.root, 'alias'))
  const result = pruneApplicationCopies({ ...f.options, processes: () => [{ pid: 42, cwd: f.root, args: ['node', path.join('alias', 'source.js')], node: true }] })
  assert.equal(result.operations.length, 0)
  assert.equal(result.skipped.find(item => item.name === oldName).reason, 'COPY_PROCESS_ROOT_LINK_UNVERIFIED')
  assert.equal(fs.readFileSync(path.join(f.old, 'source.js'), 'utf8'), 'export const version = 1\n')
})


function cacheFixture(t) {
  const f = fixture(t), cache = path.join(f.old, 'node_modules')
  fs.mkdirSync(path.join(f.old, 'plan', 'evidence'), { recursive: true })
  fs.writeFileSync(path.join(f.old, 'plan', 'evidence', 'sentinel.json'), '{"preserve":true}\n')
  fs.mkdirSync(path.join(f.old, 'api'));fs.chmodSync(path.join(f.old, 'api'), 0o775)
  fs.writeFileSync(path.join(f.old, 'api', 'source.js'), 'source must remain')
  json(path.join(f.old, '.release-migration-before.json'), { catalog: 'before' })
  json(path.join(f.old, '.release-migration-after.json'), { catalog: 'after' })
  for (const directory of [cache, path.join(f.root, 'current', 'node_modules'), path.join(f.root, baseline, 'node_modules')]) {
    fs.mkdirSync(path.join(directory, 'pkg'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(directory, 'pkg', 'index.js'), 'dependency bytes')
    fs.mkdirSync(path.join(directory, 'empty'), { mode: 0o700 })
  }
  return { ...f, cache }
}
function retainedSource(directory) {
  const records = []
  function walk(directory) {
    for (const name of fs.readdirSync(directory).filter(name => name !== 'node_modules')) {
      const file = path.join(directory, name), value = fs.lstatSync(file, { bigint: true })
      records.push({ path: file, dev: String(value.dev), ino: String(value.ino), mode: String(value.mode), ...(value.isFile() ? { sha256: hash(fs.readFileSync(file)) } : {}) })
      if (value.isDirectory() && !value.isSymbolicLink()) walk(file)
    }
  }
  walk(directory);return records
}
function cacheJournal(f) {
  const receipt = path.join(f.store, ids[0] + '.jsonl')
  return { receipt, rows: fs.readFileSync(receipt, 'utf8').trim().split('\n').map(JSON.parse), isolated: path.join(f.store, ids[0]), manifest: path.join(f.store, ids[0] + '.cache-manifest.json') }
}
function preparedCacheJob(f, progress = 'isolated') {
  const receipt = path.join(f.store, ids[0] + '.jsonl'), isolated = path.join(f.store, ids[0])
  const processes = () => (progress === 'started' ? fs.existsSync(receipt) : fs.existsSync(isolated))
    ? [{ pid: 43, cwd: progress === 'started' ? f.old : isolated, args: ['node'], node: true }] : []
  const result = pruneApplicationCopies({ ...f.options, processes })
  assert.equal(result.operations?.[0]?.state, 'deferred', JSON.stringify(result))
  assert.equal(result.operations[0].reason, 'COPY_PROCESS_REFERENCE')
  const job = cacheJournal(f)
  if (progress === 'deleting') fs.appendFileSync(job.receipt, JSON.stringify({ operationId: ids[0], kind: 'dependency_cache', state: 'deleting' }) + '\n')
  return { ...job, progress }
}

test('cache-only deletion leaves source, protected evidence and four metadata files at their original paths and hashes', t => {
  const f = cacheFixture(t), original = retainedSource(f.old)
  const current = retainedSource(path.join(f.root, 'current', 'node_modules')), keptBaseline = retainedSource(path.join(f.root, baseline, 'node_modules'))
  assert.equal(planApplicationCopies(f.options).candidates.length, 0)
  assert.equal(planDependencyCaches(f.options).candidates[0].cache.name, 'node_modules')
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.status, 'inspected', JSON.stringify(result));assert.equal(result.operations.length, 1)
  assert.equal(result.operations[0].kind, 'dependency_cache');assert.equal(result.operations[0].scope, 'node_modules_only')
  assert.equal(result.operations[0].state, 'deleted');assert.equal(result.operations[0].cacheLogicalFileBytes, String(Buffer.byteLength('dependency bytes')))
  assert.equal(result.operations[0].sourceRetained, true);assert(!fs.existsSync(f.cache));assert.deepEqual(retainedSource(f.old), original)
  assert.deepEqual(retainedSource(path.join(f.root, 'current', 'node_modules')), current)
  assert.deepEqual(retainedSource(path.join(f.root, baseline, 'node_modules')), keptBaseline)
  const journal = cacheJournal(f), manifest = JSON.parse(fs.readFileSync(journal.manifest, 'utf8'))
  assert.deepEqual(journal.rows.map(row => row.state), ['started', 'isolated', 'deleting', 'deleted'])
  assert(journal.rows.every(row => row.kind === 'dependency_cache'))
  assert.equal(journal.rows[0].manifest.sha256, hash(fs.readFileSync(journal.manifest)))
  assert.equal(journal.rows[0].evidence.length, 4);assert.equal(manifest.entries.length, 3)
  assert(fs.statSync(journal.receipt).size < 2097152)
})

for (const kind of ['marker', 'journal', 'process', 'cross-dependency']) test(`cache-only common ${kind} qualification cannot be bypassed by a full-copy failure`, t => {
  const f = cacheFixture(t);let options = f.options
  if (kind === 'marker') json(path.join(f.old, '.chevoink-release.json'), { revision: sha('a'), archiveSha256: 'f'.repeat(64) })
  if (kind === 'journal') f.journal(sha('c'), ['switched', 'healthy'])
  if (kind === 'process') options = { ...options, processes: () => [{ pid: 42, cwd: f.root, args: ['node', path.join(oldName, 'api', 'source.js')], node: true }] }
  if (kind === 'cross-dependency') { const destination = path.join(f.root, 'current', 'node_modules');fs.rmSync(destination, { recursive: true });link(f.cache, destination) }
  const result = pruneApplicationCopies(options)
  assert.equal(result.operations.length, 0);assert(fs.existsSync(path.join(f.cache, 'pkg', 'index.js')))
  assert(result.skipped.some(item => item.name === oldName && item.kind === 'dependency_cache'))
})

test('cache-only keeps current and exact-baseline caches and skips unknown and migrated roots', t => {
  const f = cacheFixture(t), unknown = path.join(f.root, 'release-' + sha('e'));fs.mkdirSync(unknown)
  const target = path.join(f.base, 'original-copy');fs.mkdirSync(target);fs.mkdirSync(path.join(target, 'node_modules'))
  link(target, path.join(f.root, `previous-${sha('e')}-for-${sha('b')}`))
  const plan = planDependencyCaches(f.options)
  assert.deepEqual(plan.candidates.map(item => item.name), [oldName])
  assert(fs.existsSync(path.join(target, 'node_modules')));assert(fs.existsSync(unknown))
})

test('cache-only never follows a node_modules root symlink', t => {
  const f = cacheFixture(t), target = path.join(f.base, 'external-cache');fs.renameSync(f.cache, target);link(target, f.cache)
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations.length, 0);assert(result.skipped.some(item => item.kind === 'dependency_cache' && item.reason === 'COPY_OWNER_OR_PATH_CHANGED'))
  assert.equal(fs.readFileSync(path.join(target, 'pkg', 'index.js'), 'utf8'), 'dependency bytes')
})

test('cache-only refuses nested same-device mounts without traversing or renaming the cache', t => {
  const f = cacheFixture(t), options = { ...f.options, mountinfo: () => f.options.mountinfo() + mount(path.join(f.cache, 'pkg')) }
  const result = pruneApplicationCopies(options)
  assert.equal(result.operations.length, 0);assert(result.skipped.some(item => item.kind === 'dependency_cache' && item.reason === 'COPY_NESTED_MOUNT'))
  assert(fs.existsSync(f.cache))
})

for (const name of ['evidence', 'investigation', 'logs', '.git', 'PGDATA', '.env']) test(`cache-only strict recursive guard preserves nested ${name}`, t => {
  const f = cacheFixture(t), file = path.join(f.cache, 'pkg', name)
  if (name === '.env') fs.writeFileSync(file, 'private fixture')
  else { fs.mkdirSync(file);fs.writeFileSync(path.join(file, 'sentinel'), 'preserve') }
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations.length, 0);assert(result.skipped.some(item => item.kind === 'dependency_cache' && item.reason === 'COPY_PROTECTED_DATA'))
  assert(fs.existsSync(file))
})

for (const kind of ['parent', 'cache']) test(`cache-only binds the ${kind} inode before isolation`, t => {
  const f = cacheFixture(t);let changed = false
  const processes = () => {
    if (!changed && fs.existsSync(path.join(f.store, ids[0] + '.jsonl'))) {
      changed = true
      if (kind === 'cache') { fs.renameSync(f.cache, path.join(f.base, 'original-cache'));fs.mkdirSync(f.cache) }
      else {
        const saved = path.join(f.base, 'original-source');fs.renameSync(f.old, saved);fs.mkdirSync(f.old)
        for (const name of ['.chevoink-release.json', '.release-health.json', '.release-migration-before.json', '.release-migration-after.json']) fs.copyFileSync(path.join(saved, name), path.join(f.old, name))
      }
    }
    return []
  }
  const result = pruneApplicationCopies({ ...f.options, processes })
  assert.equal(result.operations[0].state, 'deferred')
  assert.equal(result.operations[0].reason, kind === 'cache' ? 'CACHE_IDENTITY_CHANGED' : 'CACHE_PARENT_IDENTITY_CHANGED')
  assert(fs.existsSync(kind === 'cache' ? path.join(f.base, 'original-cache') : path.join(f.base, 'original-source')))
})

test('cache-only binds the quarantine inode after isolation', t => {
  const f = cacheFixture(t);let changed = false
  const isolated = path.join(f.store, ids[0])
  const result = pruneApplicationCopies({ ...f.options, processes: () => {
    if (!changed && fs.existsSync(isolated)) { changed = true;fs.renameSync(isolated, path.join(f.base, 'original-cache'));fs.mkdirSync(isolated);fs.writeFileSync(path.join(isolated, 'sentinel'), 'replacement') }
    return []
  } })
  assert.equal(result.operations[0].state, 'deferred');assert.equal(result.operations[0].reason, 'CACHE_IDENTITY_CHANGED')
  assert.equal(fs.readFileSync(path.join(isolated, 'sentinel'), 'utf8'), 'replacement')
})

for (const kind of ['keeper', 'marker', 'fourth-metadata']) test(`cache-only refuses a ${kind} change after registration`, t => {
  const f = cacheFixture(t);let changed = false
  const result = pruneApplicationCopies({ ...f.options, processes: () => {
    if (!changed && fs.existsSync(path.join(f.store, ids[0] + '.jsonl'))) {
      changed = true
      if (kind === 'keeper') json(path.join(f.root, 'current', '.chevoink-release.json'), { revision: sha('d'), archiveSha256: 'e'.repeat(64) })
      if (kind === 'marker') json(path.join(f.old, '.chevoink-release.json'), { revision: sha('b'), archiveSha256: 'e'.repeat(64) })
      if (kind === 'fourth-metadata') json(path.join(f.old, '.release-migration-after.json'), { catalog: 'changed' })
    }
    return []
  } })
  assert.equal(result.operations[0].state, 'deferred');assert.equal(result.operations[0].reason, kind === 'keeper' ? 'COPY_KEEPERS_CHANGED' : 'CACHE_PARENT_METADATA_CHANGED')
  assert(fs.existsSync(f.cache))
})

for (const progress of ['started', 'isolated', 'deleting']) test(`cache-only same UUID resumes ${progress} and retains protected source`, t => {
  const f = cacheFixture(t), original = retainedSource(f.old), job = preparedCacheJob(f, progress)
  if (progress === 'deleting') fs.unlinkSync(path.join(job.isolated, 'pkg', 'index.js'))
  f.copy(oldestName, sha('a'));f.journal(sha('b'))
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.status, 'recovered');assert.equal(result.operations.length, 1);assert.equal(result.operations[0].operationId, ids[0])
  assert.equal(result.operations[0].kind, 'dependency_cache');assert.equal(result.operations[0].state, 'deleted')
  assert(!fs.existsSync(f.cache));assert(!fs.existsSync(job.isolated));assert.deepEqual(retainedSource(f.old), original)
  assert(fs.existsSync(path.join(f.root, oldestName)))
})

for (const change of ['missing-before-deleting', 'unknown-entry', 'content', 'file-inode']) test(`cache-only recovery rejects ${change}`, t => {
  const f = cacheFixture(t), job = preparedCacheJob(f, change === 'missing-before-deleting' ? 'isolated' : 'deleting')
  const file = path.join(job.isolated, 'pkg', 'index.js')
  if (change === 'missing-before-deleting') fs.unlinkSync(file)
  if (change === 'unknown-entry') fs.writeFileSync(path.join(job.isolated, 'unknown.js'), 'not registered')
  if (change === 'content') fs.writeFileSync(file, 'changed content')
  if (change === 'file-inode') { fs.renameSync(file, path.join(f.base, 'original-module.js'));fs.writeFileSync(file, 'dependency bytes') }
  const result = pruneApplicationCopies(f.options)
  const expected = { 'missing-before-deleting': 'CACHE_ENTRY_MISSING', 'unknown-entry': 'CACHE_UNKNOWN_ENTRY', content: 'CACHE_ENTRY_CHANGED', 'file-inode': 'CACHE_ENTRY_CHANGED' }
  assert.equal(result.operations[0].state, 'deferred');assert.equal(result.operations[0].reason, expected[change]);assert(fs.existsSync(job.isolated))
})

test('cache-only recovery rechecks new process references and bind mounts', t => {
  const f = cacheFixture(t), job = preparedCacheJob(f)
  const busy = pruneApplicationCopies({ ...f.options, processes: () => [{ pid: 44, cwd: job.isolated, args: ['node'], node: true }] })
  assert.equal(busy.operations[0].reason, 'COPY_PROCESS_REFERENCE')
  const mounted = pruneApplicationCopies({ ...f.options, mountinfo: () => f.options.mountinfo() + mount(path.join(job.isolated, 'pkg')) })
  assert.equal(mounted.reason ?? mounted.operations[0].reason, 'COPY_NESTED_MOUNT');assert(fs.existsSync(job.isolated))
})

test('cache-only after-delete crash reconciles absence with unchanged original metadata and manifest', t => {
  const f = cacheFixture(t), original = retainedSource(f.old), job = preparedCacheJob(f, 'deleting');fs.rmSync(job.isolated, { recursive: true })
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations[0].state, 'absent_reconciled');assert.equal(result.operations[0].kind, 'dependency_cache')
  assert.deepEqual(retainedSource(f.old), original)
})

test('cache-only never deletes a cache recreated after its terminal receipt', t => {
  const f = cacheFixture(t);assert.equal(pruneApplicationCopies(f.options).operations[0].state, 'deleted')
  fs.mkdirSync(f.cache);fs.writeFileSync(path.join(f.cache, 'sentinel'), 'new unknown cache')
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations.length, 0);assert(result.skipped.some(item => item.reason === 'CACHE_RECREATED_AFTER_TERMINAL'))
  assert.equal(fs.readFileSync(path.join(f.cache, 'sentinel'), 'utf8'), 'new unknown cache')
  assert.equal(cacheJournal(f).rows.filter(row => row.state === 'started').length, 1)
})

test('cache-only manifest may exceed the legacy 2 MiB receipt limit but is separately pinned and bounded', t => {
  const f = cacheFixture(t), job = preparedCacheJob(f)
  const bytes = Buffer.concat([fs.readFileSync(job.manifest), Buffer.alloc(2097152, 0x20)]);fs.writeFileSync(job.manifest, bytes)
  const rows = job.rows;rows[0].manifest.sha256 = hash(bytes);fs.writeFileSync(job.receipt, rows.map(JSON.stringify).join('\n') + '\n')
  assert(fs.statSync(job.manifest).size > 2097152);assert(fs.statSync(job.receipt).size < 2097152)
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations[0].state, 'deleted', JSON.stringify(result))
})

for (const kind of ['digest', 'size']) test(`cache-only refuses changed manifest ${kind}`, t => {
  const f = cacheFixture(t), job = preparedCacheJob(f)
  if (kind === 'digest') fs.appendFileSync(job.manifest, ' ')
  else fs.truncateSync(job.manifest, 32 * 1024 * 1024 + 1)
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations[0].state, 'deferred');assert.equal(result.operations[0].reason, kind === 'digest' ? 'CACHE_MANIFEST_CHANGED' : 'CACHE_MANIFEST_LIMIT')
  assert(fs.existsSync(job.isolated))
})

test('legacy full-copy receipts cannot be reinterpreted by adding a cache manifest field', t => {
  const f = fixture(t), job = preparedJob(f, 'isolated')
  const rows = fs.readFileSync(job.receipt, 'utf8').trim().split('\n').map(JSON.parse);rows[0].cache = { name: 'node_modules', dev: rows[0].dev, ino: rows[0].ino }
  fs.writeFileSync(job.receipt, rows.map(JSON.stringify).join('\n') + '\n')
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.reason, 'COPY_RECEIPT_INVALID');assert(fs.existsSync(job.isolated))
})


test('cache-only nested dependency links are unlinked without deleting their external targets', t => {
  const f = cacheFixture(t), external = path.join(f.base, 'external-dependency');fs.mkdirSync(external)
  fs.writeFileSync(path.join(external, 'sentinel'), 'external bytes');link(external, path.join(f.cache, 'linked-package'))
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations[0].state, 'deleted');assert(!fs.existsSync(f.cache))
  assert.equal(fs.readFileSync(path.join(external, 'sentinel'), 'utf8'), 'external bytes')
})

test('cache-only recovery refuses a changed registered symlink', t => {
  const f = cacheFixture(t), first = path.join(f.base, 'link-first'), second = path.join(f.base, 'link-second')
  fs.mkdirSync(first);fs.mkdirSync(second);link(first, path.join(f.cache, 'linked-package'))
  const job = preparedCacheJob(f, 'deleting'), saved = path.join(job.isolated, 'linked-package')
  fs.unlinkSync(saved);link(second, saved)
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations[0].reason, 'CACHE_ENTRY_CHANGED');assert(fs.existsSync(job.isolated))
  assert(fs.existsSync(first));assert(fs.existsSync(second))
})

test('cache-only recovery refuses a replacement parent even when its metadata bytes match', t => {
  const f = cacheFixture(t), job = preparedCacheJob(f), saved = path.join(f.base, 'original-parent');fs.renameSync(f.old, saved);fs.mkdirSync(f.old)
  for (const name of ['.chevoink-release.json', '.release-health.json', '.release-migration-before.json', '.release-migration-after.json']) fs.copyFileSync(path.join(saved, name), path.join(f.old, name))
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations[0].reason, 'CACHE_PARENT_IDENTITY_CHANGED');assert(fs.existsSync(job.isolated));assert(fs.existsSync(saved))
})

test('cache-only recovery refuses missing original metadata before reconciling a deleted cache', t => {
  const f = cacheFixture(t), job = preparedCacheJob(f, 'deleting');fs.rmSync(job.isolated, { recursive: true });fs.unlinkSync(path.join(f.old, '.release-migration-after.json'))
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.operations[0].state, 'deferred');assert.equal(result.operations[0].reason, 'CACHE_PARENT_METADATA_CHANGED')
})

test('an orphan cache manifest never authorizes fresh cache deletion', t => {
  const f = cacheFixture(t);fs.mkdirSync(f.store, { mode: 0o700 })
  json(path.join(f.store, ids[0] + '.cache-manifest.json'), { version: 1, kind: 'dependency_cache' })
  const result = pruneApplicationCopies(f.options)
  assert.equal(result.reason, 'COPY_QUARANTINE_UNKNOWN');assert(fs.existsSync(f.cache))
})
