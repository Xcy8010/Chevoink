import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { assertCloudIdentity, assertEnvironmentApproval, verifyCloudDeployment } from './cloud-deploy-guard.mjs'
import { assertCloudRuntime } from './cloud-setup.mjs'
import { verifyCloudAndroid } from './cloud-android-guard.mjs'

const sha = 'a'.repeat(40)
const env = { GITHUB_REPOSITORY: 'Xcy8010/Chevoink', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_RUN_ATTEMPT: '1', SOURCE_SHA: sha, GITHUB_SHA: sha, EXPECTED_PRODUCTION_SHA: 'b'.repeat(40), CI_RUN_ID: '12', GITHUB_RUN_ID: '34' }
const protectedEnvironment = { id: 7, name: 'production', protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'owner' } }] }] }
const approval = [{ state: 'approved', user: { type: 'User', login: 'owner' }, environments: [{ id: 7, name: 'production' }] }]
const names = ['plan test shards', 'check / lint / build / audit', 'merge coverage / test report', 'check / lint / test / build / audit', 'test shard 1/2', 'test shard 2/2']
test('portable setup rejects runtime drift without modifying the lockfile or database', () => {
  const engines = { node: '22.23.2', npm: '10.9.8' }
  assertCloudRuntime('22.23.2', '10.9.8', '22.23.2', engines)
  assert.throws(() => assertCloudRuntime('22.0.0', '10.9.8', '22.23.2', engines))
  assert.throws(() => assertCloudRuntime('22.23.2', '11.0.0', '22.23.2', engines))
  assert.throws(() => assertCloudRuntime('22.23.2', '10.9.8', '22.0.0', engines))
})
function reader(change = {}) {
  const run = { id: 12, repository: { full_name: 'Xcy8010/Chevoink' }, head_sha: sha, name: 'CI', status: 'completed', conclusion: 'success',
    path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main', ...change }
  return async endpoint => endpoint.endsWith('/production') ? protectedEnvironment : endpoint.endsWith('/approvals') ? approval
    : endpoint.includes('/jobs?') ? { total_count: names.length, jobs: names.map((name, index) => ({ id: index + 1, run_id: 12, name, status: 'completed', conclusion: 'success' })) } : run
}

test('only exact first-attempt main dispatch identity is admitted', () => {
  assertCloudIdentity(env, sha)
  for (const [key, value] of Object.entries({ GITHUB_REPOSITORY: 'fork/Chevoink', GITHUB_REF: 'refs/heads/topic', GITHUB_EVENT_NAME: 'push',
    GITHUB_RUN_ATTEMPT: '2', SOURCE_SHA: 'c'.repeat(40), GITHUB_SHA: 'c'.repeat(40), EXPECTED_PRODUCTION_SHA: sha, CI_RUN_ID: '../12', GITHUB_RUN_ID: '' })) {
    assert.throws(() => assertCloudIdentity({ ...env, [key]: value }, sha), undefined, key)
  }
  assert.throws(() => assertCloudIdentity(env, 'c'.repeat(40)))
})
test('environment name alone, approval bypass, foreign environment and rejection fail closed', () => {
  assertEnvironmentApproval(protectedEnvironment, approval)
  for (const environment of [{ name: 'production' }, { ...protectedEnvironment, protection_rules: [] },
    { ...protectedEnvironment, protection_rules: [{ type: 'required_reviewers', reviewers: [] }] }, { ...protectedEnvironment, name: 'staging' }]) {
    assert.throws(() => assertEnvironmentApproval(environment, approval))
  }
  for (const history of [null, [], [{ ...approval[0], environments: [{ id: 8, name: 'production' }] }],
    [{ ...approval[0], state: 'rejected' }], [{ ...approval[0], user: { type: 'Bot', login: 'bot' } }], [...approval, { ...approval[0], state: 'rejected' }]]) {
    assert.throws(() => assertEnvironmentApproval(protectedEnvironment, history))
  }
})
test('uses live maintained CI admission and rejects forged names, wrong SHA or event', async () => {
  assert.equal((await verifyCloudDeployment(env, sha, reader())).ciRunId, '12')
  for (const change of [{ path: '.github/workflows/fake.yml' }, { event: 'pull_request' }, { head_branch: 'topic' },
    { head_sha: 'c'.repeat(40) }, { conclusion: 'failure' }]) {
    await assert.rejects(verifyCloudDeployment(env, sha, reader(change)))
  }
  await assert.rejects(verifyCloudDeployment(env, sha, async () => { throw new Error('API unavailable') }), /API unavailable/)
})
test('workflow preserves single production concurrency, strict SSH and maintained entrypoint', () => {
  const workflow = readFileSync(new URL('../.github/workflows/cloud-deploy.yml', import.meta.url), 'utf8')
  assert.match(workflow, /group: chevoink-production\s+cancel-in-progress: false/)
  assert.match(workflow, /name: production/)
  assert.match(workflow, /\.\/scripts\/deploy-production\.ps1 -ExpectedCurrentRevision/)
  assert.doesNotMatch(workflow, /ssh-keyscan|StrictHostKeyChecking=no|continue-on-error/)
  assert.match(workflow, /WindowsIdentity\]::GetCurrent\(\)\.User.Value/)
  assert.match(workflow, /\*\$\{credentialSid\}:\(R,D\)/)
  assert.match(workflow, /\[IO.File\]::Delete\(\$keyPath\)/)
  const deploy = readFileSync(new URL('./deploy-production.ps1', import.meta.url), 'utf8')
  assert.match(deploy, /'StrictHostKeyChecking=yes'/)
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(ci, /TEST_DATABASE_REQUIRED: 'true'/)
  assert.match(ci, /image: postgres:16/)
  assert.match(ci, /verify-reports/)
  assert.match(ci, /ci-coverage\.ts summary/)
})

const androidSha = 'c'.repeat(40), androidHead = 'd'.repeat(40)
const androidEnv = { ...env, ANDROID_SOURCE_SHA: androidSha }
function androidReader(change = {}) {
  const evidence = {
    environment: { ...protectedEnvironment, name: 'android-signing' },
    history: [{ ...approval[0], environments: [{ id: 7, name: 'android-signing' }] }],
    branch: { name: 'android-shell', commit: { sha: androidHead } },
    comparison: { base_commit: { sha: androidSha }, merge_base_commit: { sha: androidSha }, status: 'ahead', ahead_by: 2, behind_by: 0 },
    ...change,
  }
  const calls = []
  const request = async endpoint => {
    calls.push(endpoint)
    if (endpoint.endsWith('/environments/android-signing')) return evidence.environment
    if (endpoint.endsWith('/approvals')) return evidence.history
    if (endpoint.endsWith('/branches/android-shell')) return evidence.branch
    if (endpoint === `repos/Xcy8010/Chevoink/compare/${androidSha}...${evidence.branch.commit.sha}?per_page=1`) return evidence.comparison
    throw new Error('Unexpected or foreign API target')
  }
  return { calls, request }
}
test('trusted main admits only exact official Android ancestors after actual signing approval', async () => {
  const fixture = androidReader()
  assert.deepEqual(await verifyCloudAndroid(androidEnv, sha, fixture.request), {
    controllerSha: sha, sourceSha: androidSha, androidBranchSha: androidHead, approvalVerified: true,
  })
  assert.deepEqual(fixture.calls, [
    'repos/Xcy8010/Chevoink/environments/android-signing', 'repos/Xcy8010/Chevoink/actions/runs/34/approvals',
    'repos/Xcy8010/Chevoink/branches/android-shell', `repos/Xcy8010/Chevoink/compare/${androidSha}...${androidHead}?per_page=1`,
  ])
  const identical = androidReader({ branch: { name: 'android-shell', commit: { sha: androidSha } },
    comparison: { base_commit: { sha: androidSha }, merge_base_commit: { sha: androidSha }, status: 'identical', ahead_by: 0, behind_by: 0 } })
  assert.equal((await verifyCloudAndroid(androidEnv, sha, identical.request)).sourceSha, androidSha)
})
test('Android rejects wrong dispatch/controller/attempt/input before reading candidate evidence', async () => {
  for (const patch of [{ GITHUB_REF: 'refs/heads/android-shell' }, { GITHUB_REPOSITORY: 'fork/Chevoink' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_SHA: androidSha }, { ANDROID_SOURCE_SHA: 'android-shell' }, { GITHUB_RUN_ID: '' }]) {
    const fixture = androidReader()
    await assert.rejects(verifyCloudAndroid({ ...androidEnv, ...patch }, sha, fixture.request))
    assert.equal(fixture.calls.length, 0)
  }
  const fixture = androidReader()
  await assert.rejects(verifyCloudAndroid(androidEnv, androidHead, fixture.request))
  assert.equal(fixture.calls.length, 0)
})
test('Android rejects foreign SHA, wrong branch, non-ancestor/merge-base and missing approvals', async () => {
  const comparison = { base_commit: { sha: androidSha }, merge_base_commit: { sha: androidSha }, status: 'ahead', ahead_by: 2, behind_by: 0 }
  for (const patch of [
    { branch: { name: 'foreign-android', commit: { sha: androidHead } } },
    { branch: { name: 'android-shell', commit: { sha: 'unknown' } } },
    { comparison: { ...comparison, base_commit: { sha } } },
    { comparison: { ...comparison, merge_base_commit: { sha } } },
    { comparison: { ...comparison, status: 'diverged' } },
    { comparison: { ...comparison, behind_by: 1 } },
    { comparison: { ...comparison, status: 'identical', ahead_by: 0 } },
    { environment: { name: 'android-signing', id: 7, protection_rules: [] } },
    { history: [] }, { history: approval },
  ]) await assert.rejects(verifyCloudAndroid(androidEnv, sha, androidReader(patch).request))
  await assert.rejects(verifyCloudAndroid(androidEnv, sha, async () => { throw new Error('API unavailable') }), /API unavailable/)
})
test('Android workflow executes trusted admission before checking out or running candidate files', () => {
  const workflow = readFileSync(new URL('../.github/workflows/cloud-android.yml', import.meta.url), 'utf8')
  assert.match(workflow, /if: github.repository == 'Xcy8010\/Chevoink' && github.ref == 'refs\/heads\/main'\s/)
  assert.doesNotMatch(workflow, /github.ref == 'refs\/heads\/android-shell'/)
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}\s+path: controller/)
  assert.match(workflow, /working-directory: controller\s+run: node scripts\/cloud-android-guard.mjs/)
  assert.match(workflow, /ref: \$\{\{ inputs.source_sha \}\}\s+path: android/)
  const guard = workflow.indexOf('run: node scripts/cloud-android-guard.mjs')
  const candidate = workflow.indexOf('name: Checkout admitted Android candidate separately')
  const exact = workflow.indexOf('name: Verify exact candidate checkout before executing candidate files')
  const execute = workflow.indexOf('run: ./scripts/cloud-build-android.Tests.ps1')
  assert.ok(guard > 0 && candidate > guard && exact > candidate && execute > exact)
  assert.match(workflow, /shell: pwsh\s+working-directory: android/)
  assert.match(workflow, /android\/cloud-output\/\*\.apk/)
  assert.match(workflow, /uses: android-actions\/setup-android@v3\s+with:\s+packages: platform-tools\s/)
  assert.match(workflow, /sdkmanager\.bat 'platforms;android-36' 'build-tools;36\.0\.0'/)
})
