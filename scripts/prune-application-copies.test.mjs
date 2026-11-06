import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseMountinfo, planApplicationCopies, pruneApplicationCopies, readProcessReferences, lockIsHeld } from './prune-application-copies.mjs'

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
