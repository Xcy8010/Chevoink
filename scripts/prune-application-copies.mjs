import * as fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const productionRoot = '/opt/chevoink/app'
const previous = /^previous-([a-f0-9]{40})-for-([a-f0-9]{40})$/
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const digest = value => createHash('sha256').update(value).digest('hex')
const metadata = ['.chevoink-release.json', '.release-health.json', '.release-migration-before.json', '.release-migration-after.json']
const terminal = new Set(['deleted', 'absent_reconciled'])
function fail(code) { throw Object.assign(new Error(code), { code }) }
function code(error) { return /^[A-Z][A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'COPY_STATE_UNVERIFIED' }
function stat(filename) { try { return fs.lstatSync(filename, { bigint: true }) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const identity = value => ({ dev: String(value.dev), ino: String(value.ino) })
const sameIdentity = (value, expected) => value && String(value.dev) === expected.dev && String(value.ino) === expected.ino
const within = (parent, value) => value === parent || value.startsWith(parent + path.sep)
function owned(filename, context, kind) {
  const value = stat(filename)
  if (!value || value.isSymbolicLink() || !value[kind]() || value.uid !== BigInt(context.uid) || String(value.dev) !== context.dev
    || process.platform === 'linux' && (value.mode & 0o022n)) fail('COPY_OWNER_OR_PATH_CHANGED')
  if (fs.realpathSync(filename) !== filename) fail('COPY_PATH_ALIAS')
  return value
}
function bounded(filename) {
  const value = stat(filename)
  if (!value?.isFile() || value.size > 2097152n) fail('COPY_EVIDENCE_INVALID')
  return fs.readFileSync(filename)
}
function marker(directory, context) {
  const file = path.join(directory, '.chevoink-release.json');owned(file, context, 'isFile')
  const bytes = bounded(file), value = JSON.parse(bytes.toString('utf8'))
  if (!/^[a-f0-9]{40}$/.test(value.revision) || !/^[a-f0-9]{64}$/.test(value.archiveSha256)
    || Object.keys(value).sort().join(',') !== 'archiveSha256,revision') fail('COPY_MARKER_INVALID')
  return { revision: value.revision, sha256: digest(bytes) }
}
function completed(root, revision, context) {
  const file = path.join(root, `.release-${revision}.jsonl`);owned(file, context, 'isFile')
  const bytes = bounded(file), rows = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
  if (!rows.length || rows.at(-1).phase !== 'completed' || !rows.some(row => row.phase === 'switched') || !rows.some(row => row.phase === 'healthy')
    || rows.some(row => row.revision !== revision || typeof row.phase !== 'string' || !Number.isFinite(Date.parse(row.at)))) fail('COPY_DEPLOYMENT_INCOMPLETE')
  return digest(bytes)
}
export function parseMountinfo(text) {
  const rows = text.trim().split('\n').filter(Boolean)
  if (!rows.length) fail('COPY_MOUNTS_UNAVAILABLE')
  return rows.map(row => {
    const fields = row.split(' '), separator = fields.indexOf('-')
    const mount = fields[4]?.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8)))
    if (separator < 6 || !path.isAbsolute(mount ?? '')) fail('COPY_MOUNTS_UNAVAILABLE')
    return path.resolve(mount)
  })
}
function noMount(directory, mounts) { if (mounts.some(mount => within(directory, mount))) fail('COPY_NESTED_MOUNT') }
function keeperState(root, context, mounts) {
  const currentPath = path.join(root, 'current');owned(currentPath, context, 'isDirectory');noMount(currentPath, mounts)
  const current = marker(currentPath, context), currentJournal = completed(root, current.revision, context)
  const names = fs.readdirSync(root).filter(name => previous.exec(name)?.[2] === current.revision)
  if (names.length !== 1) fail('COPY_BASELINE_AMBIGUOUS')
  const baselinePath = path.join(root, names[0]);owned(baselinePath, context, 'isDirectory');noMount(baselinePath, mounts)
  const baseline = marker(baselinePath, context)
  if (baseline.revision !== previous.exec(names[0])[1]) fail('COPY_BASELINE_INVALID')
  return { current: { name: 'current', ...current, ...identity(stat(currentPath)) }, baseline: { name: names[0], ...baseline, ...identity(stat(baselinePath)) }, currentJournal }
}
function treeSafe(directory, context, mounts, observe) {
  noMount(directory, mounts);owned(directory, context, 'isDirectory');protectedData(directory)
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name), value = stat(file)
    if (!value) fail('COPY_TREE_CHANGED')
    if (value.isSymbolicLink()) { observe?.(file, value);continue } // unlink only; never traverse a target
    if (value.uid !== BigInt(context.uid) || String(value.dev) !== context.dev) fail('COPY_OWNER_OR_PATH_CHANGED')
    observe?.(file, value)
    if (value.isDirectory()) treeSafe(file, context, mounts, observe)
    else if (!value.isFile()) fail('COPY_SPECIAL_FILE')
  }
}
function protectedData(directory) {
  for (const name of fs.readdirSync(directory)) {
    const value = stat(path.join(directory, name))
    if (['uploads', 'native', 'logs', 'log', 'PGDATA', '.codex', '.aws', '.git'].includes(name)
      || /(^|[-_.])(logs?|pgdata|uploads|backups?|evidence|investigations?|local-diagnostics)($|[-_.])/i.test(name) && value?.isDirectory()
      || /\.log(?:\.\d+)?$/i.test(name) || name === '.env' && !value?.isSymbolicLink()) fail('COPY_PROTECTED_DATA')
    if (name === '.env' && path.resolve(directory, fs.readlinkSync(path.join(directory, name))) !== '/opt/chevoink/shared/app.env') fail('COPY_ENV_LINK_UNVERIFIED')
  }
}
function references(value, target) {
  const normalized = target.replaceAll('\\', '/')
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped + '(?:$|[/\\s"\'?#])').test(value.replaceAll('\\', '/'))
}
function processUse(processes, targets, root) {
  const rootLinks = fs.readdirSync(root).filter(name => stat(path.join(root, name))?.isSymbolicLink()).map(name => path.join(root, name))
  return processes.filter(item => {
    // Direct Node entries and recognized path options resolve relative to cwd.
    // No shell expansion or evaluation is needed to retain these source copies.
    const nodePaths = item.node ? item.args.slice(1).flatMap(argument => {
      const option = /^(?:--(?:require|import|loader|experimental-loader)=|-r)(.+)$/.exec(argument)
      const value = option?.[1] ?? (argument.startsWith('-') ? null : argument)
      return value ? [path.resolve(item.cwd, value)] : []
    }) : []
    const values = [item.cwd, ...item.args, ...nodePaths]
    if (values.some(value => rootLinks.some(link => references(value, link)))) fail('COPY_PROCESS_ROOT_LINK_UNVERIFIED')
    return values.some(value => targets.some(target => references(value, target)))
  }).map(item => item.pid)
}
function dependencyReferences(root, context, processes) {
  const result = []
  const rootLinks = fs.readdirSync(root).filter(name => stat(path.join(root, name))?.isSymbolicLink()).map(name => path.join(root, name))
  function links(directory, source) {
    const value = stat(directory);if (!value) return
    if (value.isSymbolicLink()) {
      const lexical = path.resolve(path.dirname(directory), fs.readlinkSync(directory))
      // Migrated-original root links are opaque and never followed. A link
      // through one cannot prove which ordinary copy is still referenced.
      if (rootLinks.some(link => within(link, lexical))) fail('COPY_DEPENDENCY_ROOT_LINK_UNVERIFIED')
      result.push({ source, target: fs.realpathSync(directory) });return
    }
    if (!value.isDirectory() || value.uid !== BigInt(context.uid) || String(value.dev) !== context.dev) fail('COPY_DEPENDENCIES_UNVERIFIED')
    for (const name of fs.readdirSync(directory)) {
      const full = path.join(directory, name), child = stat(full)
      if (!child) fail('COPY_DEPENDENCIES_UNVERIFIED')
      if (child.isDirectory() || child.isSymbolicLink()) links(full, source)
    }
  }
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('.') || !stat(path.join(root, name))?.isDirectory() || stat(path.join(root, name)).isSymbolicLink()) continue
    links(path.join(root, name, 'node_modules'), name)
  }
  // A Node process outside the application root can still load a linked
  // dependency from an old copy. Inspect its working dependency tree as well.
  for (const item of processes.filter(item => item.node)) {
    if (!path.isAbsolute(item.cwd)) fail('COPY_NODE_PROCESS_UNREADABLE')
    if (!within(root, item.cwd)) links(path.join(item.cwd, 'node_modules'), `pid:${item.pid}`)
  }
  return result
}
/** All recognized Node processes must be inspectable. Other readable same-UID
 * processes also protect references. Raw command lines never enter receipts or CLI output. */
export function readProcessReferences(uid, proc = '/proc') {
  const result = []
  for (const name of fs.readdirSync(proc).filter(value => /^[1-9]\d*$/.test(value))) {
    const base = path.join(proc, name)
    try {
      const status = fs.readFileSync(path.join(base, 'status'), 'utf8')
      if (/^State:\s+Z/m.test(status)) continue
      const owner = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1])
      const comm = fs.readFileSync(path.join(base, 'comm'), 'utf8').trim()
      let args, executable = '', argsError
      try { args = fs.readFileSync(path.join(base, 'cmdline')).toString('utf8').split('\0').filter(Boolean) } catch (error) { argsError = error }
      try { executable = fs.readlinkSync(path.join(base, 'exe')) } catch {}
      const node = /^node(?:js)?(?:$|[ -])/.test(comm) || ['node', 'nodejs'].includes(path.basename(executable)) || ['node', 'nodejs'].includes(path.basename(args?.[0] ?? ''))
      if (!node && owner !== uid) continue
      if (argsError) { if (node) fail('COPY_NODE_PROCESS_UNREADABLE');continue }
      let cwd
      try { cwd = fs.readlinkSync(path.join(base, 'cwd')).replace(/ \(deleted\)$/, '') } catch {
        if (node && stat(path.join(base, 'status')) && !/^State:\s+Z/m.test(fs.readFileSync(path.join(base, 'status'), 'utf8'))) fail('COPY_NODE_PROCESS_UNREADABLE')
        continue
      }
      const values = (args ?? []).map(value => { try { const part = value.slice(value.indexOf('file://'));return part.startsWith('file://') ? fileURLToPath(part) : value } catch { return value } })
      result.push({ pid: Number(name), cwd, args: values, node })
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; if (error.code === 'COPY_NODE_PROCESS_UNREADABLE') throw error;fail('COPY_PROCESS_SNAPSHOT_UNAVAILABLE') }
  }
  return result
}
function environment(options) {
  const root = path.resolve(options.root), value = stat(root)
  if (root !== options.root || fs.realpathSync(root) !== root || !value?.isDirectory() || value.isSymbolicLink() || value.uid !== BigInt(options.uid)) fail('COPY_ROOT_INVALID')
  const context = { uid: options.uid, dev: String(value.dev) }
  owned(root, context, 'isDirectory')
  return { root, context, mounts: parseMountinfo(options.mountinfo()), processes: options.processes() }
}
export function planApplicationCopies(options) {
  const state = environment(options), { root, context, mounts, processes } = state, keep = keeperState(root, context, mounts)
  const dependencies = dependencyReferences(root, context, processes), candidates = [], skipped = []
  for (const name of fs.readdirSync(root).sort()) {
    if (name === 'current' || name === keep.baseline.name || name.startsWith('.')) continue
    const match = previous.exec(name), directory = path.join(root, name), value = stat(directory)
    if (!match || value?.isSymbolicLink()) { skipped.push({ name, reason: value?.isSymbolicLink() ? 'migrated_or_symbolic_link' : name.startsWith('maintenance-') ? 'maintenance_not_implemented' : 'unknown_copy' });continue }
    try {
      owned(directory, context, 'isDirectory');treeSafe(directory, context, mounts);protectedData(directory)
      const original = marker(directory, context), journal = completed(root, match[2], context)
      if (original.revision !== match[1]) fail('COPY_MARKER_NAME_MISMATCH')
      const pids = processUse(processes, [directory], root)
      if (pids.length) fail('COPY_PROCESS_REFERENCE')
      if (dependencies.some(link => link.source !== name && within(directory, link.target))) fail('COPY_DEPENDENCY_REFERENCE')
      candidates.push({ name, revision: match[1], successor: match[2], ...identity(value), markerSha256: original.sha256, journalSha256: journal })
    } catch (error) { skipped.push({ name, reason: code(error) }) }
  }
  return { root, context, keep, candidates, skipped }
}
// Independent cache eligibility: source subdirectories may remain protected or
// writable, but the copy root, deployment identity and every cache item may not.
function cacheParent(state, keep, name, isolated) {
  const { root, context, mounts, processes } = state, match = previous.exec(name)
  if (!match || name === keep.baseline.name) fail('CACHE_PARENT_NOT_RETIRABLE')
  const directory = path.join(root, name), value = owned(directory, context, 'isDirectory')
  noMount(directory, mounts)
  const original = marker(directory, context), journal = completed(root, match[2], context)
  if (original.revision !== match[1]) fail('COPY_MARKER_NAME_MISMATCH')
  const targets = [directory, ...(isolated ? [isolated] : [])]
  if (processUse(processes, targets, root).length) fail('COPY_PROCESS_REFERENCE')
  if (dependencyReferences(root, context, processes).some(link => link.source !== name && targets.some(target => within(target, link.target)))) fail('COPY_DEPENDENCY_REFERENCE')
  const evidence = metadata.filter(item => stat(path.join(directory, item))).map(item => {
    const file = path.join(directory, item);owned(file, context, 'isFile')
    return { name: item, sha256: digest(bounded(file)) }
  })
  return { name, revision: match[1], successor: match[2], ...identity(value), markerSha256: original.sha256, journalSha256: journal, evidence }
}
export function planDependencyCaches(options) {
  const state = environment(options), { root, context, mounts } = state, keep = keeperState(root, context, mounts), candidates = [], skipped = []
  for (const name of fs.readdirSync(root).sort()) {
    if (!previous.test(name) || name === keep.baseline.name || stat(path.join(root, name))?.isSymbolicLink()) continue
    const cache = path.join(root, name, 'node_modules')
    if (!stat(cache)) continue
    try {
      const parent = cacheParent(state, keep, name), value = owned(cache, context, 'isDirectory')
      treeSafe(cache, context, mounts)
      candidates.push({ ...parent, cache: { name: 'node_modules', ...identity(value) } })
    } catch (error) { skipped.push({ name, kind: 'dependency_cache', reason: code(error) }) }
  }
  return { keep, candidates, skipped }
}
// The observed production caches have about 35,000 items each. A separate
// bounded manifest supports them without enlarging the 2 MiB journal reader.
const cacheManifestLimit = 32 * 1024 * 1024, cacheEntryLimit = 100000
function fileDigest(file, expected) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || !sameIdentity(before, identity(expected)) || before.size !== expected.size || before.mtimeNs !== expected.mtimeNs) fail('CACHE_ENTRY_CHANGED')
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(65536)
    let count
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count))
    const after = fs.fstatSync(fd, { bigint: true })
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs) fail('CACHE_ENTRY_CHANGED')
    return hash.digest('hex')
  } finally { fs.closeSync(fd) }
}
function cacheInventory(directory, context, mounts) {
  const value = owned(directory, context, 'isDirectory'), entries = [];let logicalFileBytes = 0n, serializedEntryBytes = 0
  const attributes = value => ({ ...identity(value), uid: Number(value.uid), gid: Number(value.gid), mode: (value.mode & 0o7777n).toString(8) })
  treeSafe(directory, context, mounts, (file, value) => {
    if (entries.length >= cacheEntryLimit || value.uid !== BigInt(context.uid) || String(value.dev) !== context.dev) fail('CACHE_MANIFEST_LIMIT_OR_OWNER')
    const entry = { relative: path.relative(directory, file).split(path.sep).join('/'), ...attributes(value), type: value.isDirectory() ? 'directory' : value.isSymbolicLink() ? 'symlink' : 'file' }
    if (value.isFile()) { entry.size = String(value.size);entry.mtimeNs = String(value.mtimeNs);entry.sha256 = fileDigest(file, value);logicalFileBytes += value.size }
    if (value.isSymbolicLink()) entry.target = fs.readlinkSync(file)
    serializedEntryBytes += Buffer.byteLength(JSON.stringify(entry)) + 1
    if (serializedEntryBytes > cacheManifestLimit) fail('CACHE_MANIFEST_LIMIT')
    entries.push(entry)
  })
  entries.sort((left, right) => left.relative.localeCompare(right.relative))
  return { root: attributes(value), entries, logicalFileBytes: String(logicalFileBytes) }
}
function readCacheManifest(store, job, context, mounts) {
  owned(store, context, 'isDirectory');noMount(store, mounts)
  const file = path.join(store, job.manifest.name), value = owned(file, context, 'isFile')
  if (value.size > BigInt(cacheManifestLimit)) fail('CACHE_MANIFEST_LIMIT')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)), bytes = Buffer.alloc(Number(value.size))
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    if (!sameIdentity(opened, identity(value)) || opened.size !== value.size || opened.mtimeNs !== value.mtimeNs) fail('CACHE_MANIFEST_CHANGED')
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null)
      if (!read) fail('CACHE_MANIFEST_CHANGED')
      offset += read
    }
    const after = fs.fstatSync(fd, { bigint: true })
    if (after.size !== value.size || after.mtimeNs !== value.mtimeNs) fail('CACHE_MANIFEST_CHANGED')
  } finally { fs.closeSync(fd) }
  if (digest(bytes) !== job.manifest.sha256) fail('CACHE_MANIFEST_CHANGED')
  const manifest = JSON.parse(bytes.toString('utf8'))
  if (manifest.version !== 1 || manifest.kind !== 'dependency_cache' || manifest.operationId !== job.operationId
    || !Array.isArray(manifest.entries) || manifest.entries.length > cacheEntryLimit || manifest.entries.length !== job.manifest.entries
    || manifest.logicalFileBytes !== job.manifest.logicalFileBytes || !/^[0-9]+$/.test(manifest.logicalFileBytes)
    || !manifest.root || manifest.root.dev !== job.cache.dev || manifest.root.ino !== job.cache.ino) fail('CACHE_MANIFEST_INVALID')
  const names = new Set();let total = 0n
  for (const entry of manifest.entries) {
    if (typeof entry.relative !== 'string' || !entry.relative || entry.relative.includes('\\') || entry.relative.split('/').some(part => !part || part === '.' || part === '..')
      || path.posix.isAbsolute(entry.relative) || /^[A-Za-z]:/.test(entry.relative) || names.has(entry.relative)
      || !['file', 'directory', 'symlink'].includes(entry.type) || !/^\d+$/.test(entry.dev) || !/^\d+$/.test(entry.ino)
      || entry.dev !== context.dev || entry.uid !== context.uid || !Number.isInteger(entry.gid) || !/^[0-7]{1,4}$/.test(entry.mode)
      || entry.type === 'file' && (!/^\d+$/.test(entry.size) || !/^\d+$/.test(entry.mtimeNs) || !/^[a-f0-9]{64}$/.test(entry.sha256))
      || entry.type === 'symlink' && typeof entry.target !== 'string') fail('CACHE_MANIFEST_INVALID')
    names.add(entry.relative);if (entry.type === 'file') total += BigInt(entry.size)
  }
  if (String(total) !== manifest.logicalFileBytes) fail('CACHE_MANIFEST_INVALID')
  return manifest
}
function verifyCacheInventory(directory, expected, context, mounts, allowMissing) {
  const actual = cacheInventory(directory, context, mounts)
  if (JSON.stringify(actual.root) !== JSON.stringify(expected.root)) fail('CACHE_IDENTITY_CHANGED')
  const entries = new Map(expected.entries.map(entry => [entry.relative, entry]))
  for (const entry of actual.entries) {
    if (!entries.has(entry.relative)) fail('CACHE_UNKNOWN_ENTRY')
    if (JSON.stringify(entry) !== JSON.stringify(entries.get(entry.relative))) fail('CACHE_ENTRY_CHANGED')
  }
  if (!allowMissing && actual.entries.length !== expected.entries.length) fail('CACHE_ENTRY_MISSING')
}
function syncDirectory(directory) {
  if (process.platform === 'win32') return
  const fd = fs.openSync(directory, 'r');try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function append(filename, value, context) {
  owned(filename, context, 'isFile')
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0))
  try { fs.writeSync(fd, JSON.stringify({ ...value, at: new Date().toISOString() }) + '\n');fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function evidence(source, job, store, context, mounts) {
  owned(store, context, 'isDirectory');noMount(store, mounts)
  const directory = path.join(store, job.operationId + '.evidence')
  if (!stat(directory)) { fs.mkdirSync(directory, { mode: 0o700 });syncDirectory(store) }
  owned(directory, context, 'isDirectory');noMount(directory, mounts)
  for (const item of job.evidence) {
    const target = path.join(directory, item.name)
    if (!stat(target)) {
      owned(path.join(source, item.name), context, 'isFile')
      const bytes = bounded(path.join(source, item.name))
      if (digest(bytes) !== item.sha256) fail('COPY_EVIDENCE_CHANGED')
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 })
      const fd = fs.openSync(target, 'r+');try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    }
    owned(target, context, 'isFile')
    if (digest(bounded(target)) !== item.sha256) fail('COPY_EVIDENCE_CHANGED')
  }
  syncDirectory(directory)
}
function readJob(file, id, context) {
  owned(file, context, 'isFile')
  const rows = bounded(file).toString('utf8').trim().split('\n').map(line => JSON.parse(line)), job = rows[0]
  if (job?.version !== 1 || job.state !== 'started' || job.operationId !== id || !uuid.test(id) || !previous.test(job.name)
    || !/^[a-f0-9]{64}$/.test(job.markerSha256) || !/^[a-f0-9]{64}$/.test(job.journalSha256)
    || !/^\d+$/.test(job.dev) || !/^\d+$/.test(job.ino) || !Array.isArray(job.evidence)
    || !job.evidence.some(item => item.name === metadata[0]) || new Set(job.evidence.map(item => item.name)).size !== job.evidence.length
    || job.evidence.some(item => !metadata.includes(item.name) || !/^[a-f0-9]{64}$/.test(item.sha256))
    || rows.some(row => row.operationId !== id || !['started', 'isolated', 'deleting', 'deferred', 'deleted', 'absent_reconciled'].includes(row.state))) fail('COPY_RECEIPT_INVALID')
  if (job.kind === 'dependency_cache') {
    if (job.cache?.name !== 'node_modules' || !/^\d+$/.test(job.cache.dev) || !/^\d+$/.test(job.cache.ino) || job.cache.dev !== job.dev
      || job.manifest?.name !== id + '.cache-manifest.json' || !/^[a-f0-9]{64}$/.test(job.manifest.sha256)
      || !Number.isInteger(job.manifest.entries) || job.manifest.entries < 0 || job.manifest.entries > cacheEntryLimit
      || !/^[0-9]+$/.test(job.manifest.logicalFileBytes) || !job.initialKeep
      || rows.some(row => row.kind !== 'dependency_cache')) fail('CACHE_RECEIPT_INVALID')
  } else if (job.kind !== undefined || job.cache !== undefined || job.manifest !== undefined || rows.some(row => row.kind !== undefined)) fail('COPY_RECEIPT_INVALID')
  const match = previous.exec(job.name)
  if (job.revision !== match[1] || job.successor !== match[2]
    || job.evidence.find(item => item.name === metadata[0]).sha256 !== job.markerSha256
    || rows.slice(1).some((row, index) => row.state === 'started' || terminal.has(rows[index].state))) fail('COPY_RECEIPT_INVALID')
  return { job, last: rows.at(-1), progress: rows.filter(row => ['started', 'isolated', 'deleting'].includes(row.state)).at(-1).state }
}
function resume(file, id, options) {
  const state = environment(options), { root, context } = state, store = path.join(root, '.retired-copies')
  const { job, last, progress } = readJob(file, id, context)
  if (job.kind === 'dependency_cache') return resumeDependencyCache(file, { job, last, progress }, options)
  const expectedKeep = keeperState(root, context, state.mounts)
  if (terminal.has(last.state)) return { operationId: id, state: last.state }
  const source = path.join(root, job.name), isolated = path.join(store, id)
  try {
    const guard = directory => {
      const fresh = environment(options), keep = keeperState(root, context, fresh.mounts)
      owned(store, context, 'isDirectory');noMount(store, fresh.mounts)
      if (JSON.stringify(keep) !== JSON.stringify(expectedKeep)) fail('COPY_KEEPERS_CHANGED')
      if (job.name === keep.baseline.name || !sameIdentity(stat(directory), job)) fail('COPY_IDENTITY_CHANGED')
      if (completed(root, job.successor, context) !== job.journalSha256) fail('COPY_JOURNAL_CHANGED')
      if (processUse(fresh.processes, [source, isolated], root).length) fail('COPY_PROCESS_REFERENCE')
      if (dependencyReferences(root, context, fresh.processes).some(link => link.source !== job.name && [source, isolated].some(target => within(target, link.target)))) fail('COPY_DEPENDENCY_REFERENCE')
      treeSafe(directory, context, fresh.mounts);protectedData(directory)
      const currentMarker = stat(path.join(directory, metadata[0]))
      if (currentMarker && marker(directory, context).sha256 !== job.markerSha256 || !currentMarker && progress !== 'deleting') fail('COPY_MARKER_CHANGED')
      return keep
    }
    if (stat(source) && stat(isolated)) fail('COPY_PATHS_AMBIGUOUS')
    if (!stat(source) && !stat(isolated)) {
      if (progress === 'started') fail('COPY_PATHS_UNKNOWN')
      evidence(isolated, job, store, context, environment(options).mounts)
      append(file, { state: 'absent_reconciled', operationId: id }, context);return { operationId: id, state: 'absent_reconciled' }
    }
    if (stat(source)) {
      if (progress !== 'started') fail('COPY_PATHS_AMBIGUOUS')
      guard(source);evidence(source, job, store, context, environment(options).mounts);guard(source)
      fs.renameSync(source, isolated);syncDirectory(root);syncDirectory(store)
      append(file, { state: 'isolated', operationId: id }, context)
    }
    // Evidence must already exist after a rename, even if the process died
    // before persisting its isolated record. Never read deleted source files.
    evidence(isolated, job, store, context, environment(options).mounts)
    const keep = guard(isolated)
    append(file, { state: 'deleting', operationId: id, verifiedKeep: keep }, context)
    guard(isolated)
    // Only this UUID, fixed under the checked same-device quarantine. rm does
    // not follow symlinks; tree/mount/owner/process checks immediately precede it.
    fs.rmSync(isolated, { recursive: true, force: false, maxRetries: 0 })
    syncDirectory(store);append(file, { state: 'deleted', operationId: id }, context)
    return { operationId: id, state: 'deleted' }
  } catch (error) {
    const reason = code(error)
    if (last.state !== 'deferred' || last.reason !== reason) append(file, { state: 'deferred', operationId: id, reason }, context)
    return { operationId: id, state: 'deferred', reason }
  }
}
function resumeDependencyCache(file, record, options) {
  const { job, last, progress } = record, { root, context } = environment(options), store = path.join(root, '.retired-copies')
  const parent = path.join(root, job.name), source = path.join(parent, 'node_modules'), isolated = path.join(store, job.operationId)
  const result = (state, reason) => ({ operationId: job.operationId, kind: 'dependency_cache', scope: 'node_modules_only', name: job.name,
    state, ...(reason ? { reason } : {}), cacheLogicalFileBytes: job.manifest.logicalFileBytes, sourceRetained: true })
  if (terminal.has(last.state)) return result(last.state)
  try {
    const guardParent = () => {
      const fresh = environment(options), keep = keeperState(root, context, fresh.mounts)
      owned(store, context, 'isDirectory');noMount(store, fresh.mounts)
      if (JSON.stringify(keep) !== JSON.stringify(job.initialKeep)) fail('COPY_KEEPERS_CHANGED')
      const current = cacheParent(fresh, keep, job.name, isolated)
      if (current.dev !== job.dev || current.ino !== job.ino) fail('CACHE_PARENT_IDENTITY_CHANGED')
      if (current.markerSha256 !== job.markerSha256 || current.journalSha256 !== job.journalSha256 || JSON.stringify(current.evidence) !== JSON.stringify(job.evidence)) fail('CACHE_PARENT_METADATA_CHANGED')
      return fresh
    }
    const first = guardParent(), manifest = readCacheManifest(store, job, context, first.mounts)
    const guard = directory => {
      const fresh = guardParent()
      if (!sameIdentity(stat(directory), job.cache)) fail('CACHE_IDENTITY_CHANGED')
      verifyCacheInventory(directory, manifest, context, fresh.mounts, progress === 'deleting')
    }
    if (stat(source) && stat(isolated)) fail('CACHE_PATHS_AMBIGUOUS')
    if (!stat(source) && !stat(isolated)) {
      if (progress !== 'deleting') fail('CACHE_PATHS_UNKNOWN')
      guardParent();append(file, { operationId: job.operationId, kind: job.kind, state: 'absent_reconciled' }, context)
      return result('absent_reconciled')
    }
    if (stat(source)) {
      if (progress !== 'started') fail('CACHE_PATHS_AMBIGUOUS')
      guard(source)
      fs.renameSync(source, isolated);syncDirectory(parent);syncDirectory(store)
      append(file, { operationId: job.operationId, kind: job.kind, state: 'isolated' }, context)
    }
    guard(isolated)
    append(file, { operationId: job.operationId, kind: job.kind, state: 'deleting' }, context)
    guard(isolated)
    fs.rmSync(isolated, { recursive: true, force: false, maxRetries: 0 })
    syncDirectory(store)
    guardParent() // The source and all four metadata paths must still be unchanged.
    append(file, { operationId: job.operationId, kind: job.kind, state: 'deleted' }, context)
    return result('deleted')
  } catch (error) {
    const reason = code(error)
    if (last.state !== 'deferred' || last.reason !== reason) append(file, { operationId: job.operationId, kind: job.kind, state: 'deferred', reason }, context)
    return result('deferred', reason)
  }
}
/** Root/process/mount providers are injectable for temporary-directory tests.
 * Production CLI below accepts no root option and requires the deployment lock. */
export function pruneApplicationCopies(options) {
  const operations = []
  try {
    const state = environment(options), { root, context } = state, store = path.join(root, '.retired-copies')
    keeperState(root, context, state.mounts)
    if (!stat(store)) { fs.mkdirSync(store, { mode: 0o700 });syncDirectory(root) }
    owned(store, context, 'isDirectory');noMount(store, state.mounts)
    const entries = fs.readdirSync(store), receipts = entries.filter(name => uuid.test(name.slice(0, -6)) && name.endsWith('.jsonl'))
    for (const name of entries) {
      const id = name.replace(/\.jsonl$|\.evidence$|\.cache-manifest\.json$/g, '')
      if (!uuid.test(id) || !receipts.includes(id + '.jsonl')) fail('COPY_QUARANTINE_UNKNOWN')
    }
    const records = new Map(receipts.map(name => [name.slice(0, -6), readJob(path.join(store, name), name.slice(0, -6), context)]))
    for (const name of entries.filter(name => name.endsWith('.cache-manifest.json'))) {
      if (records.get(name.slice(0, -'.cache-manifest.json'.length))?.job.kind !== 'dependency_cache') fail('COPY_QUARANTINE_UNKNOWN')
    }
    const pending = receipts.filter(name => {
      const id = name.slice(0, -6), record = records.get(id)
      if (terminal.has(record.last.state) && stat(path.join(store, id))) fail('COPY_QUARANTINE_UNKNOWN')
      return !terminal.has(record.last.state)
    })
    if (pending.length) return { status: 'recovered', operations: pending.map(name => resume(path.join(store, name), name.slice(0, -6), options)) }
    const recreated = new Set([...records.values()].filter(record => record.job.kind === 'dependency_cache' && terminal.has(record.last.state)
      && stat(path.join(root, record.job.name, 'node_modules'))).map(record => record.job.name))
    const plan = planApplicationCopies(options)
    const needsCachePlan = fs.readdirSync(root).some(name => previous.test(name) && name !== plan.keep.baseline.name
      && !stat(path.join(root, name))?.isSymbolicLink() && stat(path.join(root, name, 'node_modules')) && !plan.candidates.some(item => item.name === name))
    const caches = needsCachePlan ? planDependencyCaches(options) : { keep: plan.keep, candidates: [], skipped: [] }
    if (JSON.stringify(plan.keep) !== JSON.stringify(caches.keep)) fail('COPY_KEEPERS_CHANGED')
    for (const candidate of plan.candidates.filter(item => !recreated.has(item.name))) {
      const id = (options.uuid ?? randomUUID)()
      if (!uuid.test(id)) fail('COPY_OPERATION_ID_INVALID')
      const source = path.join(root, candidate.name), proof = []
      for (const name of metadata) if (stat(path.join(source, name))) {
        owned(path.join(source, name), context, 'isFile');proof.push({ name, sha256: digest(bounded(path.join(source, name))), preservedAt: path.join(store, id + '.evidence', name) })
      }
      const file = path.join(store, id + '.jsonl'), job = { version: 1, state: 'started', operationId: id, ...candidate, initialKeep: plan.keep, evidence: proof }
      fs.writeFileSync(file, JSON.stringify({ ...job, at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 })
      const fd = fs.openSync(file, 'r+');try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) };syncDirectory(store)
      operations.push(resume(file, id, options))
      if (operations.at(-1).state === 'deferred') break
    }
    if (!operations.some(item => item.state === 'deferred')) for (const candidate of caches.candidates.filter(item => !recreated.has(item.name) && !plan.candidates.some(full => full.name === item.name))) {
      const id = (options.uuid ?? randomUUID)()
      if (!uuid.test(id)) fail('COPY_OPERATION_ID_INVALID')
      const inventory = cacheInventory(path.join(root, candidate.name, 'node_modules'), context, environment(options).mounts)
      if (inventory.root.dev !== candidate.cache.dev || inventory.root.ino !== candidate.cache.ino) fail('CACHE_IDENTITY_CHANGED')
      const manifest = { version: 1, kind: 'dependency_cache', operationId: id, ...inventory }, bytes = Buffer.from(JSON.stringify(manifest) + '\n')
      if (bytes.length > cacheManifestLimit) fail('CACHE_MANIFEST_LIMIT')
      const manifestName = id + '.cache-manifest.json'
      fs.writeFileSync(path.join(store, manifestName), bytes, { flag: 'wx', mode: 0o600 })
      const manifestFd = fs.openSync(path.join(store, manifestName), 'r+');try { fs.fsyncSync(manifestFd) } finally { fs.closeSync(manifestFd) };syncDirectory(store)
      const job = { version: 1, kind: 'dependency_cache', state: 'started', operationId: id, ...candidate, initialKeep: caches.keep,
        manifest: { name: manifestName, sha256: digest(bytes), entries: inventory.entries.length, logicalFileBytes: inventory.logicalFileBytes } }
      const file = path.join(store, id + '.jsonl')
      fs.writeFileSync(file, JSON.stringify({ ...job, at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 })
      const fd = fs.openSync(file, 'r+');try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) };syncDirectory(store)
      operations.push(resume(file, id, options))
      if (operations.at(-1).state === 'deferred') break
    }
    return { status: 'inspected', keep: plan.keep, operations, skipped: [...plan.skipped, ...caches.skipped,
      ...[...recreated].map(name => ({ name, kind: 'dependency_cache', reason: 'CACHE_RECREATED_AFTER_TERMINAL' }))] }
  } catch (error) { return { status: 'skipped', reason: code(error), ...(operations.length ? { operations } : {}) } }
}
export function lockIsHeld(text, pid, value) {
  const major = ((value.dev >> 8n) & 0xfffn) | ((value.dev >> 32n) & 0xfffff000n)
  const minor = (value.dev & 0xffn) | ((value.dev >> 12n) & 0xffffff00n)
  return text.split('\n').some(line => {
    const row = line.trim().split(/\s+/), parts = row[5]?.split(':')
    return row[1] === 'FLOCK' && row[3] === 'WRITE' && row[4] === String(pid) && parts?.length === 3
      && BigInt('0x' + parts[0]) === major && BigInt('0x' + parts[1]) === minor && parts[2] === String(value.ino)
  })
}
function main() {
  try {
    const held = process.argv.slice(2)
    if (held.length && (held.length !== 1 || held[0] !== '--held-release-lock')) fail('COPY_CLI_ARGUMENTS_INVALID')
    if (process.platform !== 'linux' || process.env.APP_ENV !== 'production' || process.version !== 'v22.23.2'
      || userInfo().username !== 'ubuntu' || process.getuid() !== 1000
      || fs.realpathSync(process.execPath) !== '/opt/chevoink/runtime/node-v22.23.2-linux-x64/bin/node') fail('COPY_PRODUCTION_HOST_MISMATCH')
    const script = fileURLToPath(import.meta.url), context = { uid: 1000, dev: String(stat(productionRoot)?.dev) }
    if (script !== productionRoot + '/current/scripts/prune-application-copies.mjs') fail('COPY_PRODUCTION_SOURCE_MISMATCH')
    owned(productionRoot, context, 'isDirectory');const lock = path.join(productionRoot, '.release.lock');owned(lock, context, 'isFile')
    const flock = '/usr/bin/flock', argumentsForChild = ['-n', '-E', '75', lock, process.execPath, script, '--held-release-lock']
    if (!held.length) {
      const result = spawnSync(flock, argumentsForChild, { encoding: 'utf8', windowsHide: true })
      if (result.status === 75) { process.stdout.write(JSON.stringify({ status: 'skipped', reason: 'release_lock_busy' }) + '\n');return }
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.error || result.status !== 0) { process.exitCode = 1; if (!result.stdout) fail('COPY_LOCK_COMMAND_FAILED') }
      return
    }
    if (fs.realpathSync(`/proc/${process.ppid}/exe`) !== fs.realpathSync(flock)
      || JSON.stringify(fs.readFileSync(`/proc/${process.ppid}/cmdline`).toString('utf8').split('\0').filter(Boolean)) !== JSON.stringify([flock, ...argumentsForChild])
      || !lockIsHeld(fs.readFileSync('/proc/locks', 'utf8'), process.ppid, stat(lock))) fail('COPY_RELEASE_LOCK_UNVERIFIED')
    const result = pruneApplicationCopies({ root: productionRoot, uid: 1000,
      processes: () => readProcessReferences(1000), mountinfo: () => fs.readFileSync('/proc/self/mountinfo', 'utf8') })
    process.stdout.write(JSON.stringify(result) + '\n')
    if (result.status === 'skipped' || result.operations?.some(item => item.state === 'deferred')) process.exitCode = 1
  } catch (error) { process.stdout.write(JSON.stringify({ status: 'skipped', reason: code(error) }) + '\n');process.exitCode = 1 }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
