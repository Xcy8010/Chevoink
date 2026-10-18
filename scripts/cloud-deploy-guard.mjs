import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readReleaseCi } from './release-ci-read.mjs'

const repository = 'Xcy8010/Chevoink'
export function githubRead(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', endpoint, '--method', 'GET',
    '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'],
  { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }))
}

export function assertCloudIdentity(env, head) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_RUN_ATTEMPT !== '1'
    || !/^[a-f0-9]{40}$/.test(env.SOURCE_SHA ?? '') || env.SOURCE_SHA !== env.GITHUB_SHA
    || head !== env.SOURCE_SHA || !/^[a-f0-9]{40}$/.test(env.EXPECTED_PRODUCTION_SHA ?? '')
    || env.EXPECTED_PRODUCTION_SHA === env.SOURCE_SHA || !/^[1-9]\d*$/.test(env.CI_RUN_ID ?? '')
    || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '')) {
    throw new Error('Cloud deployment requires a first-attempt main dispatch of this exact SHA and a distinct production baseline')
  }
}

export function assertEnvironmentApproval(environment, history, name = 'production') {
  const rules = environment?.protection_rules?.filter(rule => rule.type === 'required_reviewers')
  if (environment?.name !== name || !Number.isSafeInteger(environment.id) || environment.id < 1
    || rules?.length !== 1 || !Array.isArray(rules[0].reviewers) || rules[0].reviewers.length < 1) {
    throw new Error('Protected environment with required reviewers is mandatory')
  }
  if (!Array.isArray(history)) throw new Error('Approval history is unavailable')
  const relevant = history.filter(review => review.environments?.some(item => item.id === environment.id && item.name === name))
  if (relevant.some(review => review.state === 'rejected')
    || !relevant.some(review => review.state === 'approved' && review.user?.type === 'User' && review.user?.login)) {
    throw new Error('Actual human environment approval for this run is mandatory; bypass is not approval')
  }
}

export async function verifyCloudDeployment(env, head, request = githubRead) {
  assertCloudIdentity(env, head)
  const base = `repos/${repository}`
  const environment = await request(`${base}/environments/production`)
  const history = await request(`${base}/actions/runs/${env.GITHUB_RUN_ID}/approvals`)
  assertEnvironmentApproval(environment, history)
  const run = await request(`${base}/actions/runs/${env.CI_RUN_ID}`)
  if (run.path !== '.github/workflows/ci.yml' || run.event !== 'push' || run.head_branch !== 'main') {
    throw new Error('Only the original main push CI workflow is admissible')
  }
  // The maintained reader validates exact SHA, live outcome, all dynamic shards
  // and the complete required job set. Its CI reporter requires zero skips and
  // real PostgreSQL; the merge keeps the original coverage floors.
  return readReleaseCi(env.SOURCE_SHA, env.CI_RUN_ID, request)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const result = await verifyCloudDeployment(process.env, head)
  console.log(JSON.stringify({ sourceSha: head, ciRunId: result.ciRunId, approvalVerified: true }))
}
