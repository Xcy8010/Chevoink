import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { syncWorkspace, runCommand, isProjectRemote } from './workspace-sync.mjs'
import { checkOfflineReadiness } from './offline-readiness.mjs'
import { startWork } from './start-work.mjs'

function fixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'chevoink sync 空间 ')), remote = path.join(base, 'remote.git')
  const seed = path.join(base, 'seed'), root = path.join(base, 'work'), hooks = path.join(base, 'hooks')
  const gitConfig = path.join(base, 'gitconfig')
  mkdirSync(hooks); writeFileSync(gitConfig, ''); t.after(() => rmSync(base, { recursive: true, force: true }))
  // Only temporary fixture children use this config. Host-global filters (for
  // example runner Git LFS) must not contaminate independent test repositories;
  // the real entrypoint and local hook/filter rejection tests retain all guards.
  const gitEnvironment = (env = process.env) => ({ ...env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' })
  const git = (args, cwd = root, allowFailure = false) => {
    try { return execFileSync('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd() }
    catch (error) { if (allowFailure) return error.status; throw error }
  }
  git(['init', '--bare', '--initial-branch=main', remote], base)
  git(['clone', '--config', `core.hooksPath=${hooks}`, remote, seed], base)
  const identity = directory => { git(['config', 'user.name', 'Fixture'], directory); git(['config', 'user.email', 'fixture@example.invalid'], directory); git(['config', 'commit.gpgsign', 'false'], directory) }
  identity(seed)
  writeFileSync(path.join(seed, 'source.txt'), 'base\n'); git(['add', '.'], seed); git(['commit', '-m', 'base'], seed); git(['push', 'origin', 'main'], seed)
  git(['clone', '--config', `core.hooksPath=${hooks}`, remote, root], base); identity(root)
  const head = () => git(['rev-parse', 'HEAD'])
  const advance = () => { writeFileSync(path.join(seed, 'source.txt'), 'remote\n'); git(['add', '.'], seed); git(['commit', '-m', 'remote change'], seed); git(['push', 'origin', 'main'], seed); return git(['rev-parse', 'HEAD'], seed) }
  const calls = []
  const command = async (program, args, options) => { calls.push(args); return runCommand(program, args, { ...options, env: gitEnvironment(options.env) }) }
  return { root, remote, seed, hooks, base, git, head, advance, calls, options: { root, command, validateRemote: value => value === remote } }
}

test('remote identity accepts only the project HTTPS/SSH forms and never another repository/helper', () => {
  for (const value of ['https://github.com/Xcy8010/Chevoink.git', 'git@github.com:Xcy8010/Chevoink.git', 'ssh://git@github.com/Xcy8010/Chevoink.git']) assert.equal(isProjectRemote(value), true)
  for (const value of ['https://github.com/Xcy8010/Other.git', 'https://evil.example/Xcy8010/Chevoink.git', 'ext::command', '/tmp/repo', 'https://github.com/Xcy8010/Chevoink.git?x=1']) assert.equal(isProjectRemote(value), false)
})
test('equal checkout fetches once, reports checked current state, and never merges or pushes', async t => {
  const f = fixture(t), before = f.head(), result = await syncWorkspace(f.options)
  assert.equal(result.status, 'up_to_date'); assert.equal(result.remoteChecked, true); assert.equal(result.synced, true); assert.equal(f.head(), before)
  assert.equal(f.calls.filter(args => args.includes('fetch')).length, 1)
  assert.ok(f.calls.every(args => !args.some(arg => ['push', 'stash', 'reset', 'clean', 'rebase'].includes(arg))))
})
test('only a clean strictly-behind checkout fast-forwards to the freshly fetched immutable SHA', async t => {
  const f = fixture(t), target = f.advance(), result = await syncWorkspace(f.options)
  assert.equal(result.status, 'fast_forwarded'); assert.equal(f.head(), target); assert.equal(result.exitCode, 0)
  const merge = f.calls.find(args => args.includes('merge'))
  assert.ok(merge.includes('--ff-only') && merge.includes('--no-autostash')); assert.equal(merge.at(-1), target)
  assert.equal(f.git(['status', '--porcelain=v1']), '')
})
for (const kind of ['unstaged', 'staged', 'untracked']) {
  test(`${kind} work is preserved and blocks automatic fetch/fast-forward`, async t => {
    const f = fixture(t), before = f.head(); f.advance()
    const file = path.join(f.root, kind === 'untracked' ? 'private-untracked.txt' : 'source.txt')
    writeFileSync(file, 'keep this work\n'); if (kind === 'staged') f.git(['add', 'source.txt'])
    const result = await syncWorkspace(f.options)
    assert.equal(result.reason, 'worktree_not_clean'); assert.equal(result.remoteChecked, false); assert.equal(f.head(), before)
    assert.equal(readFileSync(file, 'utf8'), 'keep this work\n'); assert.ok(!f.calls.some(args => args.includes('fetch') || args.includes('merge')))
  })
}
for (const kind of ['ahead', 'diverged']) {
  test(`${kind} history is never pushed, merged, reset or rebased`, async t => {
    const f = fixture(t)
    writeFileSync(path.join(f.root, 'local.txt'), 'local'); f.git(['add', '.']); f.git(['commit', '-m', 'local'])
    const before = f.head(); if (kind === 'diverged') f.advance()
    const result = await syncWorkspace(f.options)
    assert.equal(result.status, kind === 'ahead' ? 'local_ahead' : 'diverged'); assert.equal(result.remoteChecked, true); assert.equal(result.synced, false)
    assert.equal(f.head(), before); assert.ok(!f.calls.some(args => args.includes('merge')))
  })
}
for (const kind of ['detached', 'no-upstream', 'cross-branch', 'foreign-remote']) {
  test(`${kind} stops before contacting a remote`, async t => {
    const f = fixture(t)
    if (kind === 'detached') f.git(['checkout', '--detach'])
    if (kind === 'no-upstream') f.git(['branch', '--unset-upstream'])
    if (kind === 'cross-branch') f.git(['config', 'branch.main.merge', 'refs/heads/android-shell'])
    const result = await syncWorkspace(kind === 'foreign-remote' ? { ...f.options, validateRemote: undefined } : f.options)
    assert.equal(result.exitCode, 1); assert.equal(result.remoteChecked, false); assert.ok(!f.calls.some(args => args.includes('fetch')))
  })
}
for (const marker of ['rebase-merge', 'CHERRY_PICK_HEAD', 'index.lock', 'sequencer']) {
  test(`${marker} blocks while preserving the unfinished operation`, async t => {
    const f = fixture(t), file = path.resolve(f.root, f.git(['rev-parse', '--git-path', marker]))
    if (['rebase-merge', 'sequencer'].includes(marker)) mkdirSync(file); else writeFileSync(file, f.head())
    const result = await syncWorkspace(f.options)
    assert.equal(result.reason, 'git_operation_in_progress'); assert.ok(result.snapshot.operations.includes(marker)); assert.ok(!f.calls.some(args => args.includes('fetch')))
  })
}
test('an actual merge conflict and its contents are preserved', async t => {
  const f = fixture(t); f.advance()
  writeFileSync(path.join(f.root, 'source.txt'), 'local\n'); f.git(['add', '.']); f.git(['commit', '-m', 'local conflict']); f.git(['fetch', 'origin'])
  assert.notEqual(f.git(['merge', 'origin/main'], f.root, true), 0)
  const before = readFileSync(path.join(f.root, 'source.txt'), 'utf8'), result = await syncWorkspace(f.options)
  assert.equal(result.snapshot.unmerged, true); assert.equal(result.reason, 'git_operation_in_progress')
  assert.equal(readFileSync(path.join(f.root, 'source.txt'), 'utf8'), before); assert.ok(!f.calls.some(args => args.includes('fetch')))
})
test('explicit offline mode never fetches and never calls cached refs current', async t => {
  const f = fixture(t); f.advance(); writeFileSync(path.join(f.root, 'offline-notes.txt'), 'preserve')
  const result = await syncWorkspace({ ...f.options, offline: true })
  assert.equal(result.status, 'offline_snapshot'); assert.equal(result.exitCode, 2); assert.equal(result.remoteChecked, false); assert.equal(result.synced, false)
  assert.ok(!f.calls.some(args => args.includes('fetch') || args.includes('merge')))
})
test('unavailable remote preserves HEAD and reports an unverified snapshot', async t => {
  const f = fixture(t), before = f.head(); renameSync(f.remote, f.remote + '-unavailable')
  const result = await syncWorkspace(f.options)
  assert.equal(result.status, 'fetch_failed'); assert.equal(result.reason, 'remote_unavailable'); assert.equal(result.remoteChecked, false); assert.equal(f.head(), before)
})
test('authentication denial is distinct from offline and never exposes the credential-bearing diagnostic', async t => {
  const f = fixture(t), command = async (program, args, options) => args.includes('fetch')
    ? { code: 128, reason: '', stdout: '', stderr: 'fatal: Authentication failed for https://DO_NOT_OUTPUT_SECRET@github.com/Xcy8010/Chevoink.git' }
    : f.options.command(program, args, options)
  const result = await syncWorkspace({ ...f.options, command })
  assert.equal(result.reason, 'authentication_or_access_denied'); assert.equal(result.synced, false); assert.ok(!JSON.stringify(result).includes('DO_NOT_OUTPUT_SECRET'))
})
test('fetch timeout kills a real bounded child and never proceeds to comparison/merge', async t => {
  const f = fixture(t), before = f.head(), began = Date.now()
  const command = async (program, args, options) => args.includes('fetch')
    ? runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { ...options, timeoutMs: 80 }) : f.options.command(program, args, options)
  const result = await syncWorkspace({ ...f.options, command })
  assert.equal(result.reason, 'timeout'); assert.equal(result.remoteChecked, false); assert.equal(f.head(), before); assert.ok(Date.now() - began < 5000)
  assert.ok(!f.calls.some(args => args.includes('merge')))
})
test('edits arriving during fetch are preserved and stop the fast-forward', async t => {
  const f = fixture(t), before = f.head(); f.advance()
  const command = async (program, args, options) => {
    const result = await f.options.command(program, args, options)
    if (args.includes('fetch')) writeFileSync(path.join(f.root, 'concurrent.txt'), 'new work')
    return result
  }
  const result = await syncWorkspace({ ...f.options, command })
  assert.equal(result.reason, 'workspace_changed_during_fetch'); assert.equal(f.head(), before)
  assert.equal(readFileSync(path.join(f.root, 'concurrent.txt'), 'utf8'), 'new work')
})
test('remote configuration changed during fetch prevents a fast-forward', async t => {
  const f = fixture(t), before = f.head(); f.advance()
  const command = async (program, args, options) => {
    const result = await f.options.command(program, args, options)
    if (args.includes('fetch')) f.git(['remote', 'set-url', 'origin', 'https://example.invalid/other.git'])
    return result
  }
  const result = await syncWorkspace({ ...f.options, command })
  assert.equal(result.reason, 'workspace_changed_during_fetch'); assert.equal(f.head(), before)
  assert.ok(!f.calls.some(args => args.includes('merge')))
})
test('a timed-out merge is reconciled by observation and never repeated even when HEAD advanced', async t => {
  const f = fixture(t), target = f.advance()
  const command = async (program, args, options) => {
    const result = await f.options.command(program, args, options)
    return args.includes('merge') ? { ...result, code: null, reason: 'timeout' } : result
  }
  const result = await syncWorkspace({ ...f.options, command })
  assert.equal(result.status, 'merge_outcome_needs_review'); assert.equal(result.reason, 'timeout')
  assert.equal(result.snapshot.head, target); assert.equal(f.head(), target); assert.equal(result.synced, false)
  assert.equal(f.calls.filter(args => args.includes('merge')).length, 1)
})
test('linked worktrees resolve operation markers through Git instead of assuming a .git directory', async t => {
  const f = fixture(t), linked = path.join(f.base, 'linked worktree')
  f.git(['worktree', 'add', '-b', 'linked', linked])
  const marker = path.resolve(linked, f.git(['rev-parse', '--git-path', 'CHERRY_PICK_HEAD'], linked))
  writeFileSync(marker, f.head())
  const result = await syncWorkspace({ ...f.options, root: linked })
  assert.equal(result.reason, 'git_operation_in_progress'); assert.ok(result.snapshot.operations.includes('CHERRY_PICK_HEAD'))
  assert.ok(!f.calls.some(args => args.includes('fetch')))
})
for (const kind of ['post-merge', 'reference-transaction', 'filter']) {
  test(`existing ${kind} is neither executed nor disabled during automatic update`, async t => {
    const f = fixture(t), before = f.head(); f.advance()
    if (kind !== 'filter') { const hook = path.join(f.hooks, kind); writeFileSync(hook, '#!/bin/sh\ntouch forbidden-hook-side-effect\n'); chmodSync(hook, 0o755) }
    else f.git(['config', 'filter.example.smudge', 'touch forbidden-filter-side-effect'])
    const result = await syncWorkspace(f.options)
    assert.equal(result.reason, 'checkout_hook_or_filter_requires_manual_review'); assert.equal(f.head(), before)
    assert.ok(!f.calls.some(args => args.includes('fetch') || args.includes('merge')))
  })
}
test('a configured clean filter is stopped before git status can execute it on dirty content', async t => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, '.gitattributes'), '*.txt filter=example\n'); f.git(['add', '.gitattributes']); f.git(['commit', '-m', 'attributes'])
  f.git(['config', 'filter.example.clean', 'touch forbidden-filter-side-effect'])
  writeFileSync(path.join(f.root, 'source.txt'), 'preserve edited contents\n')
  const result = await syncWorkspace(f.options)
  assert.equal(result.reason, 'checkout_hook_or_filter_requires_manual_review'); assert.equal(result.snapshot.dirty, null)
  assert.equal(readFileSync(path.join(f.root, 'source.txt'), 'utf8'), 'preserve edited contents\n')
  assert.ok(!f.calls.some(args => args.includes('status') || args.includes('fetch') || args.includes('merge')))
  assert.throws(() => readFileSync(path.join(f.root, 'forbidden-filter-side-effect')), { code: 'ENOENT' })
})

function offlineFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'chevoink offline ')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (file, bytes) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), bytes) }
  const engines = { node: '22.23.2', npm: '10.9.8' }, packages = { 'node_modules/example': { version: '1.0.0', integrity: 'fixture' } }
  write('package.json', JSON.stringify({ engines, packageManager: 'npm@10.9.8' })); write('package-lock.json', JSON.stringify({ packages: { '': { engines }, ...packages } }))
  write('.node-version', '22.23.2\n'); write('api/server.ts', '// never import this application'); write('scripts/cloud-setup.mjs', '// metadata check only')
  write('node_modules/.package-lock.json', JSON.stringify({ packages }))
  write('prisma/schema.prisma', 'generator client {}\n'); write('node_modules/.prisma/client/schema.prisma', 'generator client {}\r\n')
  for (const file of ['index.js', 'index.d.ts', 'default.js', 'libquery_engine-fixture.so.node']) write('node_modules/.prisma/client/' + file, 'fixture')
  const calls = [], command = async (program, args, options) => { calls.push({ program, args, options }); return { code: 0, reason: '', stdout: args.includes('--version') ? '10.9.8\n' : '{}', stderr: '' } }
  return { root, write, calls, options: { root, command, nodeVersion: '22.23.2', platform: 'linux', env: {} } }
}
test('offline readiness reuses pinned runtime and installed metadata without importing Prisma, DB or server', async t => {
  const f = offlineFixture(t), result = await checkOfflineReadiness(f.options)
  assert.equal(result.readyForLocalChecks, true); assert.equal(result.readyForDatabaseWork, false); assert.equal(result.database.verified, false)
  assert.equal(result.prismaEngineRuntimeVerified, false)
  assert.equal(f.calls.length, 2); assert.ok(f.calls.some(call => call.args.includes('ls') && call.args.includes('--offline') && call.args.includes('--ignore-scripts')))
  assert.ok(f.calls.every(call => call.options.env.npm_config_offline === 'true'))
})
test('the opening entry blocks Git synchronization before inspection when its pinned runtime does not match', async t => {
  const f = offlineFixture(t)
  f.write('.node-version', '0.0.0\n')
  const result = await startWork({ root: f.root })
  assert.equal(result.sync.reason, 'pinned_runtime_required'); assert.equal(result.sync.remoteChecked, false)
  assert.equal(result.sync.snapshot, undefined); assert.equal(result.exitCode, 1)
})
for (const kind of ['wrong-node', 'missing-dependencies', 'lock-mismatch', 'broken-dependency-tree', 'dependency-timeout', 'schema-drift', 'wrong-platform-engine', 'incomplete-source']) {
  test(`offline readiness reports ${kind} without installing or starting anything`, async t => {
    const f = offlineFixture(t), options = { ...f.options }
    if (kind === 'wrong-node') options.nodeVersion = '24.0.0'
    if (kind === 'missing-dependencies') rmSync(path.join(f.root, 'node_modules/.package-lock.json'))
    if (kind === 'lock-mismatch') f.write('node_modules/.package-lock.json', JSON.stringify({ packages: { 'node_modules/example': { version: '2.0.0' } } }))
    if (['broken-dependency-tree', 'dependency-timeout'].includes(kind)) options.command = async (program, args, opts) => args.includes('ls')
      ? { code: kind === 'dependency-timeout' ? null : 1, reason: kind === 'dependency-timeout' ? 'timeout' : '', stdout: '', stderr: 'do not print diagnostic' } : f.options.command(program, args, opts)
    if (kind === 'schema-drift') f.write('prisma/schema.prisma', 'changed')
    if (kind === 'wrong-platform-engine') options.platform = 'win32'
    if (kind === 'incomplete-source') rmSync(path.join(f.root, 'api/server.ts'))
    const result = await checkOfflineReadiness(options)
    assert.equal(result.readyForLocalChecks, false); assert.equal(result.readyForDatabaseWork, false)
    if (kind === 'schema-drift') assert.ok(result.problems.includes('generated_prisma_schema_mismatch'))
    if (kind === 'wrong-platform-engine') assert.ok(result.problems.includes('generated_prisma_platform_engine_missing'))
    assert.ok(f.calls.every(call => !call.args.some(arg => ['ci', 'install', 'generate', 'migrate', 'start', 'dev'].includes(arg))))
  })
}
test('DB configuration presence is not verified isolation and no secret value is read or returned', async t => {
  const f = offlineFixture(t); f.write('tests/.env.test', 'DO_NOT_READ_SECRET\n')
  const result = await checkOfflineReadiness({ ...f.options, env: { APP_ENV: 'production', DATABASE_URL: 'DO_NOT_OUTPUT_SECRET',
    MODEL_API_KEY: 'DO_NOT_PASS_SECRET', NODE_OPTIONS: '--require DO_NOT_LOAD_SECRET', Path: '/runtime', SystemRoot: '/system' } })
  assert.equal(result.database.configPresent, true); assert.equal(result.database.verified, false); assert.equal(result.readyForDatabaseWork, false)
  assert.ok(!JSON.stringify(result).includes('DO_NOT_'))
  for (const call of f.calls) {
    assert.ok(!JSON.stringify(call.options.env).includes('DO_NOT_'))
    assert.equal(call.options.env.Path, '/runtime'); assert.equal(call.options.env.SystemRoot, '/system')
    assert.equal(call.options.env.APP_ENV, undefined)
  }
})
