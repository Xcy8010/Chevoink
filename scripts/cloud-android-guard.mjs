import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertEnvironmentApproval, githubRead } from './cloud-deploy-guard.mjs'

const repository = 'Xcy8010/Chevoink'
const exactSha = value => /^[a-f0-9]{40}$/.test(value ?? '')

/** Run only from the trusted main checkout, before any candidate executable.
 * Candidate helpers are defense in depth, never the source of admission. */
export async function verifyCloudAndroid(env, controllerHead, request = githubRead) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_RUN_ATTEMPT !== '1'
    || !exactSha(env.GITHUB_SHA) || controllerHead !== env.GITHUB_SHA
    || !exactSha(env.ANDROID_SOURCE_SHA) || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '')) {
    throw new Error('Android admission requires the exact trusted main controller, first attempt and full candidate SHA')
  }
  const base = `repos/${repository}`
  const environment = await request(`${base}/environments/android-signing`)
  const history = await request(`${base}/actions/runs/${env.GITHUB_RUN_ID}/approvals`)
  assertEnvironmentApproval(environment, history, 'android-signing')

  const branch = await request(`${base}/branches/android-shell`)
  if (branch.name !== 'android-shell' || !exactSha(branch.commit?.sha)) throw new Error('Official Android branch identity mismatch')
  // Pin both comparison endpoints to immutable SHAs. Never compare against a
  // moving branch name or accept a similarly named branch in another repository.
  const comparison = await request(`${base}/compare/${env.ANDROID_SOURCE_SHA}...${branch.commit.sha}?per_page=1`)
  if (comparison.base_commit?.sha !== env.ANDROID_SOURCE_SHA || comparison.merge_base_commit?.sha !== env.ANDROID_SOURCE_SHA
    || !['ahead', 'identical'].includes(comparison.status) || comparison.behind_by !== 0
    || !Number.isSafeInteger(comparison.ahead_by) || comparison.ahead_by < 0
    || (comparison.status === 'identical') !== (env.ANDROID_SOURCE_SHA === branch.commit.sha)
    || comparison.status === 'identical' && comparison.ahead_by !== 0
    || comparison.status === 'ahead' && comparison.ahead_by < 1) {
    throw new Error('Candidate is not an exact ancestor of the official Android branch')
  }
  return { controllerSha: controllerHead, sourceSha: env.ANDROID_SOURCE_SHA, androidBranchSha: branch.commit.sha, approvalVerified: true }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  console.log(JSON.stringify(await verifyCloudAndroid(process.env, head)))
}
