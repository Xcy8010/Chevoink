import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Paired measurements of existing real-PG full chains and compiler dispatch. This runs only
// on their owning shards, using the same DB, fixture, assertions and Node. The
// normal full coverage shard remains the release gate and runs afterwards.
export const dbChainControls = [
  { file: 'tests/integration/agent-fresh-durable-admission.test.ts', name: 'runs a genuine fresh writer through real read, coordinated body/reviews/commit and natural completion' },
  { file: 'tests/integration/agent-durable-runtime-quality.test.ts', name: 'v9-format-full-chain preserves paid results and atomic business effects' },
  ...['chain', 'commit'].map(scenario => ({ file: 'tests/integration/agent-durable-runtime-compiler.test.ts',
    name: scenario + ' preserves compilation identity and atomic effects' })),
]

export function selectDbChainControls(plan, revision, index, count) {
  if (!/^[a-f0-9]{40}$/.test(revision) || plan.version !== 1 || plan.revision !== revision || plan.count !== count
    || !Number.isInteger(index) || index < 1 || index > count || plan.shards?.length !== count
    || plan.shards.some((shard, offset) => shard.index !== offset + 1 || !Array.isArray(shard.files))) throw Error('DB timing plan identity mismatch')
  const all = plan.shards.flatMap(shard => shard.files)
  if (dbChainControls.some(target => all.filter(file => file === target.file).length !== 1)) throw Error('DB timing targets missing or duplicated in full plan')
  return dbChainControls.filter(target => plan.shards[index - 1].files.includes(target.file))
}

export function summarizeDbChainControls(report, targets) {
  if (report.success !== true || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0 || !Array.isArray(report.testResults)) throw Error('DB timing control did not pass')
  const assertions = report.testResults.flatMap(file => (file.assertionResults ?? []).map(test => ({ file: String(file.name).replaceAll('\\', '/'), ...test })))
  const passed = assertions.filter(test => test.status === 'passed')
  if (passed.length !== targets.length || assertions.some(test => !['passed', 'skipped', 'pending'].includes(test.status))) throw Error('DB timing control selected unexpected tests')
  return targets.map(target => {
    const matching = passed.filter(test => test.file.endsWith('/' + target.file) && test.title === target.name)
    if (matching.length !== 1 || !Number.isFinite(matching[0].duration) || matching[0].duration < 0) throw Error('DB timing control missing a completed target')
    return { ...target, mode: 'same-shard-without-coverage', durationMs: Math.round(matching[0].duration * 10) / 10 }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = Number(process.argv[2]), count = Number(process.argv[3])
  const plan = JSON.parse(readFileSync('.ci-test-plan.json', 'utf8'))
  const targets = selectDbChainControls(plan, process.env.GITHUB_SHA ?? '', index, count)
  if (!targets.length) console.log('This shard has no paired DB full-chain measurement.')
  else {
    mkdirSync('.ci-test-diagnostics', { recursive: true })
    const output = `.ci-test-diagnostics/db-control-${index}.json`
    const pattern = targets.map(target => target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$').join('|')
    execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...new Set(targets.map(target => target.file)),
      '--config=./vitest.config.ts', '--testNamePattern=' + pattern, '--no-file-parallelism', '--coverage.enabled=false',
      '--reporter=json', '--outputFile=' + output], { stdio: 'inherit', env: process.env })
    const summary = summarizeDbChainControls(JSON.parse(readFileSync(output, 'utf8')), targets)
    const escape = value => value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/,/g, '%2C')
    for (const entry of summary) console.log(`::notice file=${escape(entry.file)},title=Database chain timing::${escape(JSON.stringify(entry))}`)
  }
}
