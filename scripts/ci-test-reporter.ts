import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { type Reporter, type SerializedError, type TestModule, type Vitest } from 'vitest/node'
import { assertSameFiles, assertTestsPassed, testPath, type TestPlan } from './lib/ci-test-plan.js'

// A receipt is emitted only after every planned file/test completed. It also
// makes the merge fail closed if artifacts contain duplicate or foreign files.
export default class CiTestReporter implements Reporter {
  private ctx!: Vitest
  onInit(ctx: Vitest): void { this.ctx = ctx }
  onTestRunEnd(testModules: ReadonlyArray<TestModule>, unhandledErrors: ReadonlyArray<SerializedError>): void {
    const shard = this.ctx.config.shard
    const plan = JSON.parse(readFileSync('.ci-test-plan.json', 'utf8')) as TestPlan
    if (!shard || shard.count !== plan.count || plan.revision !== (process.env.GITHUB_SHA ?? process.env.CI_TEST_REVISION)) throw new Error('CI report identity mismatch')
    if (unhandledErrors.length) throw new Error('CI test run has unhandled errors')
    const paths = testModules.map(module => testPath(this.ctx.config.root, module.moduleId))
    assertSameFiles(paths, plan.shards[shard.index - 1].files)
    testModules.forEach(assertTestsPassed)
    mkdirSync('.ci-test-reports', { recursive: true })
    writeFileSync(`.ci-test-reports/shard-${shard.index}.json`, JSON.stringify({ revision: plan.revision, index: shard.index, count: shard.count, files: paths }) + '\n')
  }
}
