import { spawn } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { assessFilterSafety } from './workspace-attributes.mjs'

/** Bounded child process; kill its own process tree, never a user-selected PID. */
export function runCommand(program, args, { cwd, timeoutMs = 15000, env = process.env, shell = false, input } = {}) {
  return new Promise(resolve => {
    let reason = '', finished = false, outputBytes = 0, stdout = '', stderr = '', fallback
    const child = spawn(program, args, { cwd, env, shell, windowsHide: true, detached: process.platform !== 'win32', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    const finish = (code, errorCode = '') => {
      if (finished) return
      finished = true; clearTimeout(timer); clearTimeout(fallback)
      resolve({ code, reason: reason || errorCode, stdout, stderr })
    }
    const stop = fault => {
      if (reason) return
      reason = fault
      if (child.pid) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          const killTimer = setTimeout(() => { killer.kill(); child.kill() }, 1000)
          killer.on('close', code => { clearTimeout(killTimer); if (code !== 0) child.kill() })
          killer.on('error', () => child.kill())
        } else {
          try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
        }
      }
      fallback = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null) }, 1500)
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    for (const [stream, append] of [[child.stdout, text => { stdout += text }], [child.stderr, text => { stderr += text }]]) {
      stream.setEncoding('utf8')
      stream.on('data', text => { outputBytes += Buffer.byteLength(text); if (outputBytes > 4 * 1024 * 1024) stop('output_limit'); else append(text) })
    }
    child.on('error', error => finish(null, error.code || 'spawn_failed'))
    child.on('close', code => finish(code))
    if (child.stdin) { child.stdin.on('error', () => stop('stdin_error')); child.stdin.end(input) }
  })
}

export function isProjectRemote(value) {
  if (/^git@github\.com:Xcy8010\/Chevoink(?:\.git)?$/i.test(value)) return true
  try {
    const url = new URL(value)
    return ['https:', 'ssh:'].includes(url.protocol) && url.hostname.toLowerCase() === 'github.com'
      && (!url.port || url.port === (url.protocol === 'https:' ? '443' : '22')) && !url.search && !url.hash
      && url.pathname.replace(/\.git$/i, '').toLowerCase() === '/xcy8010/chevoink'
  } catch { return false }
}

const present = file => { try { lstatSync(file); return true } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error } }
const markers = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'BISECT_START',
  'index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock', 'shallow.lock', 'FETCH_HEAD.lock']

/** One explicit opening check. No push, background polling or destructive recovery. */
export async function syncWorkspace({ root, offline = false, timeoutMs = 15000, command = runCommand, validateRemote = isProjectRemote } = {}) {
  const result = { mode: offline ? 'offline' : 'online', status: 'blocked', remoteChecked: false, synced: false, exitCode: 1 }
  let mergeStarted = false
  const git = async (args, allowed = [0], input) => {
    const output = await command('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
      { cwd: root, timeoutMs, input, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', SSH_ASKPASS_REQUIRE: 'never' } })
    if (output.reason || !allowed.includes(output.code)) throw Object.assign(new Error('git_read_failed'), { fault: output.reason || 'git_read_failed' })
    return output.stdout.trimEnd()
  }
  const checkoutSafety = async (head, target) => {
    const customHooks = await git(['config', '--path', '--get', 'core.hooksPath'], [0, 1])
    for (const name of ['post-merge', 'reference-transaction']) {
      const hook = customHooks ? path.resolve(root, customHooks, name) : path.resolve(root, await git(['rev-parse', '--git-path', `hooks/${name}`]))
      if (present(hook)) return { safe: false, status: 'checkout_hook_present' }
    }
    return assessFilterSafety(git, head, target)
  }
  const snapshot = async target => {
    const top = await git(['rev-parse', '--show-toplevel'])
    if (realpathSync(top) !== realpathSync(root)) throw new Error('repository_root_mismatch')
    const head = await git(['rev-parse', '--verify', 'HEAD'])
    const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])
    const operations = []
    for (const marker of markers) if (present(path.resolve(root, await git(['rev-parse', '--git-path', marker])))) operations.push(marker)
    // Status can itself invoke clean filters. Detect them before inspecting content;
    // fetch/merge can also invoke a reference-transaction hook.
    const filterSafety = await checkoutSafety(head, target), manualCheckout = !filterSafety.safe
    const dirty = manualCheckout ? null : Boolean(await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']))
    const unmerged = Boolean(await git(['ls-files', '--unmerged']))
    const tracking = branch ? (await git(['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)', `refs/heads/${branch}`])).split('\0') : []
    return { root: top, head, branch, dirty, unmerged, operations, manualCheckout, filterSafety, remote: tracking[0] || '', remoteRef: tracking[1] || '', upstream: tracking[2] || '' }
  }
  const unsafe = current => !current.branch ? 'detached_head' : current.operations.length ? 'git_operation_in_progress'
    : current.unmerged ? 'unmerged_files' : current.manualCheckout ? 'checkout_hook_or_filter_requires_manual_review' : current.dirty ? 'worktree_not_clean' : ''
  const remoteUrls = remote => git(['remote', 'get-url', '--all', remote])
  try {
    const initial = await snapshot(); result.snapshot = initial
    if (offline) return { ...result, status: 'offline_snapshot', reason: 'freshness_not_checked', exitCode: 2 }
    const issue = unsafe(initial)
    if (issue) return { ...result, reason: issue }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(initial.remote) || initial.remoteRef !== `refs/heads/${initial.branch}`
      || initial.upstream !== `refs/remotes/${initial.remote}/${initial.branch}`) return { ...result, reason: 'unknown_or_cross_branch_upstream' }
    const originalUrls = await remoteUrls(initial.remote), urls = originalUrls.split('\n')
    if (urls.length !== 1 || !validateRemote(urls[0])) return { ...result, reason: 'unverified_remote' }
    const fetched = await command('git', ['-c', 'core.fsmonitor=false', 'fetch', '--no-tags', '--recurse-submodules=no', '--no-auto-maintenance',
      initial.remote, `${initial.remoteRef}:${initial.upstream}`], { cwd: root, timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', SSH_ASKPASS_REQUIRE: 'never' } })
    if (fetched.reason || fetched.code !== 0) {
      const denied = /authentication|permission denied|access denied|forbidden|(?:HTTP|error).*\b(?:401|403)\b|could not read (?:Username|Password)/i.test(fetched.stderr)
      return { ...result, status: 'fetch_failed', reason: fetched.reason || (denied ? 'authentication_or_access_denied' : 'remote_unavailable'), offlineChoice: '--offline' }
    }
    result.remoteChecked = true; result.checkedAt = new Date().toISOString()
    const target = await git(['rev-parse', '--verify', `${initial.upstream}^{commit}`])
    const current = await snapshot(target); result.snapshot = current
    if (current.manualCheckout) return { ...result, reason: 'checkout_hook_or_filter_requires_manual_review' }
    if (unsafe(current) || current.head !== initial.head || current.branch !== initial.branch || current.upstream !== initial.upstream
      || current.remote !== initial.remote || current.remoteRef !== initial.remoteRef || await remoteUrls(initial.remote) !== originalUrls) return { ...result, reason: 'workspace_changed_during_fetch' }
    const [ahead, behind] = (await git(['rev-list', '--left-right', '--count', `${initial.head}...${target}`])).split(/\s+/).map(Number)
    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) throw new Error('invalid_comparison')
    Object.assign(result, { ahead, behind, target })
    if (ahead) return { ...result, status: ahead && behind ? 'diverged' : 'local_ahead', reason: 'manual_review_required' }
    if (!behind) return { ...result, status: 'up_to_date', synced: true, exitCode: 0 }
    const beforeMerge = await snapshot(target)
    if (unsafe(beforeMerge) || beforeMerge.head !== initial.head || beforeMerge.branch !== initial.branch || beforeMerge.upstream !== initial.upstream
      || beforeMerge.remote !== initial.remote || beforeMerge.remoteRef !== initial.remoteRef || await remoteUrls(initial.remote) !== originalUrls
      || await git(['rev-parse', `${initial.upstream}^{commit}`]) !== target) return { ...result, reason: 'workspace_changed_before_fast_forward' }
    mergeStarted = true
    const merged = await command('git', ['-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'merge', '--ff-only', '--no-autostash', '--no-edit', target],
      { cwd: root, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', SSH_ASKPASS_REQUIRE: 'never' } })
    const final = await snapshot(target); result.snapshot = final
    if (merged.reason || merged.code !== 0 || unsafe(final) || final.head !== target || final.branch !== initial.branch
      || final.upstream !== initial.upstream || final.remote !== initial.remote || final.remoteRef !== initial.remoteRef || await remoteUrls(initial.remote) !== originalUrls) {
      return { ...result, status: 'merge_outcome_needs_review', reason: merged.reason || 'postcondition_failed' }
    }
    return { ...result, status: 'fast_forwarded', synced: true, exitCode: 0 }
  } catch (error) {
    return { ...result, status: mergeStarted ? 'merge_outcome_needs_review' : 'blocked', reason: error.fault || 'git_inspection_failed' }
  }
}
