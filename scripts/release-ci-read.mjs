import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReleaseCi } from './release-ci.mjs'

// This deployment entrypoint is scoped to the configured production repository.
const repository = 'Xcy8010/Chevoink'
const executionOptions = { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  stdio: ['pipe', 'pipe', 'pipe'] }
const metadataEndpoint = /^repos\/Xcy8010\/Chevoink\/actions\/(?:runs\/[1-9]\d*(?:\/jobs\?filter=latest&per_page=100)?|workflows\/ci\.yml\/runs\?head_sha=[a-f0-9]{40}&status=success&per_page=20)$/

function parseMetadata(output) {
  try { return JSON.parse(output) }
  catch { throw new Error('GitHub CI metadata response is not valid JSON') }
}

function nativeMetadata(endpoint, execute) {
  let token
  try {
    token = execute('gh', ['auth', 'token', '--hostname', 'github.com'], { ...executionOptions, timeout: 10000 }).replace(/\r?\n$/, '')
  } catch { throw new Error('GitHub CLI authentication is unavailable for CI metadata') }
  if (token.length > 255 || !/^(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|[a-fA-F0-9]{40})$/.test(token)) {
    throw new Error('GitHub CLI returned an invalid authentication token')
  }
  const config = [
    `url = "https://api.github.com/${endpoint}"`, 'request = "GET"',
    `header = "Authorization: Bearer ${token}"`, 'header = "Accept: application/vnd.github+json"',
    'header = "X-GitHub-Api-Version: 2022-11-28"', 'user-agent = "Chevoink-release-ci-read"',
    'silent', 'show-error', 'connect-timeout = 15', 'max-time = 60', 'proto = "=https"', 'max-redirs = 0',
    'write-out = "\\n%{http_code}"',
  ].join('\n') + '\n'
  let output
  try {
    output = execute(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe'), ['--disable', '--config', '-'],
      { ...executionOptions, input: config })
  } catch { throw new Error('Native HTTPS CI metadata request failed') }
  const separator = output.lastIndexOf('\n')
  if (separator < 0 || output.slice(separator + 1) !== '200') throw new Error('Native HTTPS CI metadata did not return HTTP 200')
  return parseMetadata(output.slice(0, separator))
}

/** Transport dependencies are injectable for offline tests; callers cannot
 * select a host, method, credential source or local CI success override. */
export function ghApi(endpoint, { platform = process.platform, execute = execFileSync } = {}) {
  if (typeof endpoint !== 'string' || !metadataEndpoint.test(endpoint)) throw new Error('CI metadata endpoint is not allowed')
  let output
  try {
    output = execute('gh', ['api', endpoint, '--hostname', 'github.com', '--method', 'GET',
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'], executionOptions)
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr : Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : ''
    const eof = [`Get "https://api.github.com/${endpoint}": EOF`, `Get "https://api.github.com/${endpoint}": unexpected EOF`].includes(stderr.trim())
    if (platform === 'win32' && Number.isInteger(error?.status) && error.status > 0 && eof) return nativeMetadata(endpoint, execute)
    throw new Error('GitHub CLI CI metadata request failed')
  }
  return parseMetadata(output)
}

/** Live readonly API evidence, using the existing CLI identity. Never accepts a local success override. */
export async function readReleaseCi(revision, requestedRunId, request = ghApi) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid candidate SHA')
  let runId = requestedRunId == null || requestedRunId === '' ? null : String(requestedRunId)
  if (runId === null) {
    const listing = await request(`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${revision}&status=success&per_page=20`)
    const selected = listing.workflow_runs?.find(run => run.head_sha === revision && run.name === 'CI'
      && run.status === 'completed' && run.conclusion === 'success')
    if (!selected) throw new Error('No completed successful CI for this exact SHA')
    runId = String(selected.id)
  }
  if (!/^\d+$/.test(runId) || !Number.isSafeInteger(Number(runId)) || Number(runId) < 1) throw new Error('Invalid CI run ID')
  const base = `repos/${repository}/actions/runs/${runId}`
  const run = await request(base)
  if (String(run.id) !== runId || run.repository?.full_name !== repository) throw new Error('CI run repository or identity mismatch')
  const report = await request(`${base}/jobs?filter=latest&per_page=100`)
  if (!Array.isArray(report.jobs) || report.total_count !== report.jobs.length || report.jobs.length > 100
    || report.jobs.some(job => String(job.run_id) !== runId)) throw new Error('Incomplete or unrelated CI job evidence')
  const ci = { headSha: run.head_sha, workflowName: run.name, status: run.status, conclusion: run.conclusion,
    jobs: report.jobs.map(job => ({ databaseId: job.id, name: job.name, status: job.status, conclusion: job.conclusion })) }
  assertReleaseCi(ci, revision)
  return { ciRunId: runId, ci }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 3 || process.argv.length > 4) throw new Error('Usage: release-ci-read.mjs SHA [CI_RUN_ID]')
  console.log(JSON.stringify(await readReleaseCi(process.argv[2], process.argv[3])))
}
