import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { testExclude, testInclude } from './lib/ci-test-discovery.ts'
import { assertBlobNames, assertCoverageBlobDigest, makeTestPlan, testPath, validateReceipts, validateTestPlan, type TestPlan, type TestReceipt } from './lib/ci-test-plan.ts'

const root = process.cwd()
const revision = process.env.GITHUB_SHA ?? process.env.CI_TEST_REVISION ?? ''
const planPath = '.ci-test-plan.json'
const command = process.argv[2]
if (command === 'plan') {
  // Schedule directly from tracked test paths. The sequencer and merge each
  // compare this plan with independent Vitest discovery before accepting it.
  const paths = [...testInclude.map(pattern => `:(glob)${pattern}`), ...testExclude.map(pattern => `:(exclude,glob)${pattern}`)]
  const files = execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: root, encoding: 'utf8' }).split('\0').slice(0, -1)
  const timings = JSON.parse(readFileSync('scripts/ci-test-timings.json', 'utf8')) as { files: Record<string, number> }
  const weights = files.map(path => ({ path, durationMs: timings.files[path] ?? 2_000 + statSync(resolve(root, path)).size / 20 }))
  const plan = makeTestPlan(weights, revision)
  validateTestPlan(plan, files, revision)
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n')
  const matrix = { include: plan.shards.map(shard => ({ shard: shard.index, count: plan.count })) }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`)
  console.log(`Planned ${files.length} test files across ${plan.count} shards. Estimates (seconds): ${plan.shards.map(shard => Math.round(shard.estimatedMs / 1000)).join(', ')}`)
} else if (command === 'verify-reports') {
  const { createVitest } = await import('vitest/node')
  const vitest = await createVitest('test', { watch: false })
  let files: string[]
  try {
    files = (await vitest.globTestSpecifications()).map(spec => testPath(root, spec.moduleId))
  } finally {
    await vitest.close()
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as TestPlan
  validateTestPlan(plan, files, revision)
  assertBlobNames(readdirSync('.vitest-reports'), plan.count)
  const names = readdirSync('.ci-test-reports')
  const expected = plan.shards.map(shard => `shard-${shard.index}.json`)
  if (names.length !== expected.length || expected.some(name => !names.includes(name))) throw new Error('Test receipt files differ from plan')
  const receipts = expected.map(name => JSON.parse(readFileSync(resolve('.ci-test-reports', name), 'utf8')) as TestReceipt)
  validateReceipts(receipts, plan)
  // The owning shard validates the raw coverage map. Check the exact downloaded
  // bytes before Vitest parses them for the merge.
  for (const [offset, receipt] of receipts.entries()) {
    const index = offset + 1
    const blob = resolve('.vitest-reports', `blob-${index}-${plan.count}.json`)
    const digest = createHash('sha256').update(readFileSync(blob)).digest('hex')
    assertCoverageBlobDigest(receipt, index, digest)
  }
  console.log(`Verified ${plan.count} blobs and receipts covering ${files.length} unique test files.`)
} else {
  throw new Error('Expected plan or verify-reports')
}
