import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dbChainControls, selectDbChainControls, summarizeDbChainControls } from './ci-db-chain-control.mjs'
const revision = 'a'.repeat(40)
const plan = () => ({ version: 1, revision, count: 4, shards: [
  { index: 1, files: [dbChainControls[0].file] }, { index: 2, files: ['tests/unit/other.test.ts'] }, { index: 3, files: [dbChainControls[1].file] },
  { index: 4, files: [dbChainControls[2].file] },
] })
test('only the existing full-chain owner shards run exact paired controls', () => {
  assert.deepEqual(selectDbChainControls(plan(), revision, 1, 4), [dbChainControls[0]])
  assert.deepEqual(selectDbChainControls(plan(), revision, 2, 4), [])
  assert.deepEqual(selectDbChainControls(plan(), revision, 3, 4), [dbChainControls[1]])
  assert.deepEqual(selectDbChainControls(plan(), revision, 4, 4), dbChainControls.slice(2))
})
for (const failure of ['revision', 'count', 'index', 'missing', 'duplicate']) test(`rejects ${failure} timing-plan evidence`, () => {
  const value = plan()
  if (failure === 'revision') value.revision = 'b'.repeat(40)
  if (failure === 'missing') value.shards[0].files = []
  if (failure === 'duplicate') value.shards[1].files.push(dbChainControls[0].file)
  assert.throws(() => selectDbChainControls(value, revision, failure === 'index' ? 5 : 1, failure === 'count' ? 2 : 4))
})
const result = () => ({ success: true, numFailedTests: 0, numFailedTestSuites: 0, testResults: [{
  name: '/workspace/' + dbChainControls[0].file, assertionResults: [{ title: dbChainControls[0].name, status: 'passed', duration: 3123.45 }],
}] })
test('publishes only completed synthetic test name/location/timing, never raw output', () => {
  const report = result(); report.testResults[0].assertionResults[0].failureMessages = ['not published']
  assert.deepEqual(summarizeDbChainControls(report, [dbChainControls[0]]), [{ ...dbChainControls[0], mode: 'same-shard-without-coverage', durationMs: 3123.5 }])
})
for (const failure of ['failed', 'skipped', 'missing', 'extra', 'unknown-time']) test(`rejects ${failure} timing-control result`, () => {
  const report = result(), tests = report.testResults[0].assertionResults
  if (failure === 'failed') report.success = false
  if (failure === 'skipped') tests[0].status = 'skipped'
  if (failure === 'missing') tests.length = 0
  if (failure === 'extra') tests.push({ ...tests[0], title: 'unexpected' })
  if (failure === 'unknown-time') tests[0].duration = undefined
  assert.throws(() => summarizeDbChainControls(report, [dbChainControls[0]]))
})
