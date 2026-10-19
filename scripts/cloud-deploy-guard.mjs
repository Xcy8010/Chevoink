import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { admitProductionRequest, githubRead, verifyCandidateCi } from './production-request.mjs'

const repository = 'Xcy8010/Chevoink'
export { githubRead }

function assertControllerIdentity(env, head) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main'
    || !['workflow_dispatch', 'push'].includes(env.GITHUB_EVENT_NAME) || env.GITHUB_RUN_ATTEMPT !== '1'
    || !/^[a-f0-9]{40}$/.test(env.SOURCE_SHA ?? '')
    || (env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? env.SOURCE_SHA !== env.GITHUB_SHA
      : env.PRODUCTION_REQUEST_SHA !== env.GITHUB_SHA || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || env.SOURCE_SHA === env.GITHUB_SHA)
    || head !== env.SOURCE_SHA || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '')) {
    throw new Error('Cloud production requires the exact first-attempt main controller and request identity')
  }
}
export function assertCloudIdentity(env, head) {
  assertControllerIdentity(env, head)
  if (!/^[a-f0-9]{40}$/.test(env.EXPECTED_PRODUCTION_SHA ?? '')
    || env.EXPECTED_PRODUCTION_SHA === env.SOURCE_SHA || !/^[1-9]\d*$/.test(env.CI_RUN_ID ?? '')) {
    throw new Error('Cloud deployment requires this exact tested SHA and an explicit distinct production baseline')
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

async function verifyApproval(env, request) {
  const base = `repos/${repository}`
  const environment = await request(`${base}/environments/production`)
  const history = await request(`${base}/actions/runs/${env.GITHUB_RUN_ID}/approvals`)
  assertEnvironmentApproval(environment, history)
}
async function verifyOriginalCi(env, request) {
  // The maintained reader validates exact SHA, live outcome, all dynamic shards
  // and the complete required job set. Its CI reporter requires zero skips and
  // real PostgreSQL; the merge keeps the original coverage floors.
  return verifyCandidateCi({ sourceSha: env.SOURCE_SHA, ciRunId: env.CI_RUN_ID }, request)
}

/** Both modes execute reviewed controller code with a write-capable identity:
 * exact original CI and approval are mandatory before credentials materialize. */
export async function verifyCloudObservation(env, head, request = githubRead, pushDependencies = {}) {
  assertControllerIdentity(env, head)
  if (!['inspect', 'deploy'].includes(env.PRODUCTION_ACTION)
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(env.PRODUCTION_REQUEST_ID ?? '')
    || env.EXPECTED_PRODUCTION_SHA && !/^[a-f0-9]{40}$/.test(env.EXPECTED_PRODUCTION_SHA)
    || !/^[1-9]\d*$/.test(env.CI_RUN_ID ?? '')) throw new Error('Invalid production observation mode or CI')
  if (env.PRODUCTION_ACTION === 'deploy' && (!/^[a-f0-9]{40}$/.test(env.EXPECTED_PRODUCTION_SHA ?? '')
    || env.EXPECTED_PRODUCTION_SHA === env.SOURCE_SHA)) throw new Error('An explicit distinct approved production baseline is required')
  if (env.GITHUB_EVENT_NAME === 'push') {
    const input = await admitProductionRequest(env, { ...pushDependencies, request })
    if (!input.eligible || input.sourceSha !== env.SOURCE_SHA || input.ciRunId !== env.CI_RUN_ID
      || input.action !== env.PRODUCTION_ACTION || input.requestId !== env.PRODUCTION_REQUEST_ID
      || (input.expectedRevision ?? '') !== (env.EXPECTED_PRODUCTION_SHA ?? '')) throw new Error('Admitted request outputs differ from immutable Git data')
    await verifyApproval(env, request)
    return { ciRunId: input.ciRunId, inspectionOnly: input.action === 'inspect', requestSha: input.requestSha }
  }
  await verifyApproval(env, request)
  return { ...await verifyOriginalCi(env, request), inspectionOnly: env.PRODUCTION_ACTION === 'inspect' }
}

export async function verifyCloudDeployment(env, head, request = githubRead) {
  assertCloudIdentity(env, head)
  if (env.GITHUB_EVENT_NAME === 'push') return verifyCloudObservation({ ...env, PRODUCTION_ACTION: 'deploy' }, head, request)
  await verifyApproval(env, request)
  return verifyOriginalCi(env, request)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (process.argv.length > 3 || process.argv[2] && process.argv[2] !== '--observe') throw new Error('Invalid admission arguments')
  const result = process.argv[2] === '--observe' ? await verifyCloudObservation(process.env, head) : await verifyCloudDeployment(process.env, head)
  console.log(JSON.stringify({ sourceSha: head, ciRunId: result.ciRunId, inspectionOnly: result.inspectionOnly ?? false, approvalVerified: true }))
}
