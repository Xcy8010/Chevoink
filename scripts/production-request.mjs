import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readReleaseCi } from './release-ci-read.mjs'
import { readProductionRun } from './production-receipt.mjs'

export const productionRequestPath = '.github/production-request.json'
const repository = 'Xcy8010/Chevoink', workflow = '.github/workflows/cloud-deploy.yml'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const id = value => typeof value === 'string' && /^[1-9]\d*$/.test(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
const fail = () => { throw new Error('Production push request is invalid, stale or unbound') }
const gitRead = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 }).trimEnd()

export function githubRead(endpoint) {
  const text = execFileSync('gh', ['api', endpoint, '--method', 'GET', '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28'], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  return endpoint.endsWith('/logs') ? text : JSON.parse(text)
}

/** Canonical data only: no arbitrary refs, commands, hosts, paths or tokens. */
export function productionPushRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1) fail()
  const keys = input.action === 'none' ? ['schemaVersion', 'action']
    : ['schemaVersion', 'action', 'sourceSha', 'ciRunId', 'requestId', ...(input.action === 'deploy'
      ? ['expectedRevision', 'inspectionRunId', 'inspectionRequestId', 'inspectionRequestSha'] : [])]
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) fail()
  if (input.action === 'none') return { schemaVersion: 1, action: 'none' }
  if (!['inspect', 'deploy'].includes(input.action) || !sha(input.sourceSha) || !id(input.ciRunId) || !uuid(input.requestId)) fail()
  if (input.action === 'deploy' && (!sha(input.expectedRevision) || input.expectedRevision === input.sourceSha
    || !id(input.inspectionRunId) || !uuid(input.inspectionRequestId) || !sha(input.inspectionRequestSha)
    || input.inspectionRequestId === input.requestId)) fail()
  return Object.fromEntries(keys.map(key => [key, input[key]]))
}

export function productionRequestTitle(input) {
  const request = productionPushRequest(input)
  if (request.action === 'none') fail()
  return `${request.action} ${request.sourceSha}${request.action === 'deploy' ? ` over ${request.expectedRevision}` : ''} [${request.requestId}]`
}

export function readGitProductionRequest(revision, git = gitRead) {
  if (!sha(revision)) fail()
  if (!/^100644 blob [a-f0-9]{40}\t\.github\/production-request\.json$/.test(git(['ls-tree', revision, '--', productionRequestPath]))) fail()
  const bytes = git(['show', `${revision}:${productionRequestPath}`])
  if (Buffer.byteLength(bytes) > 4096) fail()
  const request = productionPushRequest(JSON.parse(bytes))
  if (bytes !== JSON.stringify(request, null, 2)) fail()
  return request
}

/** The controller independently repeats these complete Git-object checks
 * before offering a specific run's approval link. R cannot prove its own
 * workflow integrity against a malicious repository writer. */
export function verifyProductionRequestGraph(requestSha, event, git = gitRead) {
  if (!sha(requestSha) || event?.repository?.full_name !== repository || event.repository.default_branch !== 'main'
    || event.ref !== 'refs/heads/main' || event.after !== requestSha || !sha(event.before) || /^0+$/.test(event.before)
    || event.forced !== false || event.deleted !== false || event.created !== false) fail()
  const input = readGitProductionRequest(requestSha, git)
  if (input.action === 'none') return { eligible: false, requestSha }
  if (input.sourceSha === requestSha || git(['log', '-1', '--format=%B', requestSha]) !== productionRequestTitle(input)) fail()
  git(['merge-base', '--is-ancestor', input.sourceSha, requestSha])
  const commits = git(['rev-list', '--reverse', `${input.sourceSha}..${requestSha}`]).split('\n')
  if (!commits.length || commits.length > 128 || commits.at(-1) !== requestSha) fail()
  let parent = input.sourceSha
  const requests = new Map(), ids = new Set()
  for (const revision of commits) {
    const ancestry = git(['rev-list', '--parents', '-n', '1', revision]).split(' ')
    if (ancestry.length !== 2 || ancestry[0] !== revision || ancestry[1] !== parent
      || git(['diff-tree', '--no-commit-id', '--name-only', '-r', parent, revision]) !== productionRequestPath) fail()
    const prior = readGitProductionRequest(revision, git)
    if (prior.action === 'none' || prior.sourceSha !== input.sourceSha || ids.has(prior.requestId)) fail()
    ids.add(prior.requestId); requests.set(revision, prior); parent = revision
    if (revision === requestSha && ancestry[1] !== event.before) fail()
  }
  if (git(['diff', '--name-only', input.sourceSha, requestSha, '--']) !== productionRequestPath) fail()
  if (input.action === 'deploy') {
    const inspection = requests.get(input.inspectionRequestSha)
    if (inspection?.action !== 'inspect' || inspection.requestId !== input.inspectionRequestId || inspection.ciRunId !== input.ciRunId) fail()
  }
  return { eligible: true, requestSha, ...input }
}

export async function verifyCandidateCi(input, request = githubRead) {
  const run = await request(`repos/${repository}/actions/runs/${input.ciRunId}`)
  if (run.path !== '.github/workflows/ci.yml' || run.event !== 'push' || run.head_branch !== 'main') fail()
  return readReleaseCi(input.sourceSha, input.ciRunId, request)
}

export async function admitProductionRequest(env, { event, git = gitRead, request = githubRead, now = Date.now() } = {}) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'push'
    || env.GITHUB_RUN_ATTEMPT !== '1' || !sha(env.GITHUB_SHA) || !id(env.GITHUB_RUN_ID)) fail()
  event ??= JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  const input = verifyProductionRequestGraph(env.GITHUB_SHA, event, git)
  if (!input.eligible) return input
  const branch = await request(`repos/${repository}/branches/main`)
  if (branch.name !== 'main' || branch.commit?.sha !== input.requestSha) fail()
  const run = await request(`repos/${repository}/actions/runs/${env.GITHUB_RUN_ID}`)
  if (String(run.id) !== env.GITHUB_RUN_ID || run.repository?.full_name !== repository || run.path !== workflow
    || run.event !== 'push' || run.head_branch !== 'main' || run.head_sha !== input.requestSha || run.run_attempt !== 1
    || run.display_title !== productionRequestTitle(readGitProductionRequest(input.requestSha, git)) || run.conclusion != null) fail()
  await verifyCandidateCi(input, request)
  if (input.action === 'deploy') {
    const receipt = await readProductionRun(input.inspectionRunId, { mode: 'inspect', sourceSha: input.sourceSha,
      requestSha: input.inspectionRequestSha, requestId: input.inspectionRequestId, ciRunId: input.ciRunId, now }, request)
    if (receipt.revision !== input.expectedRevision) fail()
  }
  return { ...input, mainProtected: branch.protected === true }
}

/** A lost push/run result never authorizes another request or a re-run. */
export function reconcileProductionRequest(listing, input, requestSha) {
  const title = productionRequestTitle(input)
  if (!sha(requestSha) || !Array.isArray(listing?.workflow_runs) || listing.total_count !== listing.workflow_runs.length) fail()
  const matches = listing.workflow_runs.filter(run => run.repository?.full_name === repository && run.path === workflow
    && run.event === 'push' && run.head_branch === 'main' && run.head_sha === requestSha && run.display_title === title)
  if (matches.length !== 1 || matches[0].run_attempt !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id < 1) {
    return { status: 'unknown', retryAllowed: false }
  }
  return { status: 'located', runId: String(matches[0].id), retryAllowed: false }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--admit') fail()
  const result = await admitProductionRequest(process.env)
  const outputs = { eligible: String(result.eligible), source_sha: result.sourceSha ?? '', ci_run_id: result.ciRunId ?? '',
    request_id: result.requestId ?? '', action: result.action ?? '', expected_revision: result.expectedRevision ?? '' }
  if (!process.env.GITHUB_OUTPUT) fail()
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''))
  console.log(JSON.stringify(result))
}
