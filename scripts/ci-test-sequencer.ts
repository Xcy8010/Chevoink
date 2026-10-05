import { readFileSync } from 'node:fs'
import { BaseSequencer, type TestSpecification } from 'vitest/node'
import { selectShard, testPath, type TestPlan } from './lib/ci-test-plan.js'

export default class CiTestSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard
    if (!shard) throw new Error('CI sequencer requires a shard')
    const plan = JSON.parse(readFileSync('.ci-test-plan.json', 'utf8')) as TestPlan
    const selected = new Set(selectShard(plan, files.map(file => testPath(this.ctx.config.root, file.moduleId)), process.env.GITHUB_SHA ?? process.env.CI_TEST_REVISION ?? '', shard.index, shard.count))
    return files.filter(file => selected.has(testPath(this.ctx.config.root, file.moduleId)))
  }
}
