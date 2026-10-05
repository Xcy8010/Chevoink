import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createVitest } from 'vitest/node'
import { assertBlobNames, makeTestPlan, testPath, validateReceipts, validateTestPlan, type TestPlan, type TestReceipt } from './lib/ci-test-plan.js'

const root = process.cwd()
const revision = process.env.GITHUB_SHA ?? process.env.CI_TEST_REVISION ?? ''
const planPath = '.ci-test-plan.json'
const command = process.argv[2]
const vitest = await createVitest('test', { watch: false })
let files: string[]
try {
  // Vitest's real configured discovery, without importing/running test modules
  // or executing database global setup. Includes future .test.ts/.test.tsx.
  files = (await vitest.globTestSpecifications()).map(spec => testPath(root, spec.moduleId))
} finally {
  await vitest.close()
}

if (command === 'plan') {
  const timings = JSON.parse(readFileSync('scripts/ci-test-timings.json', 'utf8')) as { files: Record<string, number> }
  const weights = files.map(path => ({ path, durationMs: timings.files[path] ?? 2_000 + statSync(resolve(root, path)).size / 20 }))
  const plan = makeTestPlan(weights, revision)
  validateTestPlan(plan, files, revision)
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n')
  const matrix = { include: plan.shards.map(shard => ({ shard: shard.index, count: plan.count })) }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`)
  console.log(`Planned ${files.length} test files across ${plan.count} shards. Estimates (seconds): ${plan.shards.map(shard => Math.round(shard.estimatedMs / 1000)).join(', ')}`)
} else if (command === 'verify-reports') {
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as TestPlan
  validateTestPlan(plan, files, revision)
  assertBlobNames(readdirSync('.vitest-reports'), plan.count)
  const names = readdirSync('.ci-test-reports')
  const expected = plan.shards.map(shard => `shard-${shard.index}.json`)
  if (names.length !== expected.length || expected.some(name => !names.includes(name))) throw new Error('Test receipt files differ from plan')
  validateReceipts(names.map(name => JSON.parse(readFileSync(resolve('.ci-test-reports', name), 'utf8')) as TestReceipt), plan)
  console.log(`Verified ${plan.count} blobs and receipts covering ${files.length} unique test files.`)
} else {
  throw new Error('Expected plan or verify-reports')
}
