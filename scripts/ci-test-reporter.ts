import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { type Reporter, type SerializedError, type TestModule, type Vitest } from 'vitest/node'
import { assertSameFiles, assertTestsPassed, testPath, type TestPlan } from './lib/ci-test-plan.js'
import { parseCiDurableTrace, parseCiDurableCpu, type CiDurableTrace, type CiDurableCpu } from './lib/ci-durable-trace.js'

// A receipt is emitted only after every planned file/test completed. It also
// makes the merge fail closed if artifacts contain duplicate or foreign files.
export default class CiTestReporter implements Reporter {
  private ctx!: Vitest
  private traces = new Map<string, CiDurableTrace[]>()
  private cpu = new Map<string, CiDurableCpu>()
  onInit(ctx: Vitest): void { this.ctx = ctx }
  onUserConsoleLog(log: Parameters<NonNullable<Reporter['onUserConsoleLog']>>[0]): void {
    if (!log.taskId) return
    const profile = parseCiDurableCpu(log.content)
    if (profile && (this.cpu.has(log.taskId) || this.cpu.size < 100)) this.cpu.set(log.taskId, profile)
    const entry = parseCiDurableTrace(log.content)
    if (!entry || !this.traces.has(log.taskId) && this.traces.size >= 100) return
    const entries = this.traces.get(log.taskId) ?? []
    entries.push(entry)
    if (entries.length > 24) entries.shift()
    this.traces.set(log.taskId, entries)
  }
  onTestRunEnd(testModules: ReadonlyArray<TestModule>, unhandledErrors: ReadonlyArray<SerializedError>): void {
    const shard = this.ctx.config.shard
    const plan = JSON.parse(readFileSync('.ci-test-plan.json', 'utf8')) as TestPlan
    if (!shard || shard.count !== plan.count || plan.revision !== (process.env.GITHUB_SHA ?? process.env.CI_TEST_REVISION)) throw new Error('CI report identity mismatch')
    // Failure evidence is independent of the strict passing receipt below.
    // Persist it BEFORE throwing, including collection/hooks/unhandled errors.
    const errorText = (error: SerializedError) => ({ name: error.name, message: String(error.message ?? '').slice(0, 16000),
      stack: String(error.stack ?? '').slice(0, 16000) })
    const diagnostics = { revision: plan.revision, index: shard.index, count: shard.count,
      unhandledErrors: unhandledErrors.map(errorText), files: testModules.map(module => ({ file: testPath(this.ctx.config.root, module.moduleId),
        state: module.state(), errors: module.errors().map(errorText),
        tests: [...module.children.allTests()].map(test => { const result = test.result(); return { name: test.fullName, state: result.state,
          errors: result.state === 'failed' ? result.errors.map(errorText) : [], trace: this.traces.get(test.id) ?? [], cpu: this.cpu.get(test.id) ?? null } }) })) }
    mkdirSync('.ci-test-diagnostics', { recursive: true })
    writeFileSync(`.ci-test-diagnostics/shard-${shard.index}.json`, JSON.stringify(diagnostics) + '\n')
    const failures = diagnostics.files.flatMap(file => [
      ...file.errors.map(error => ({ file: file.file, name: '(module/hooks)', error })),
      ...file.tests.flatMap(test => test.errors.map(error => ({ file: file.file, name: test.name, error }))),
    ])
    // New run diagnostics also appear as ordinary job annotations, so the
    // failing file/assertion is visible without downloading a restricted log.
    // Escape workflow command data; test output cannot inject another command.
    const escape = (value: string) => value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/,/g, '%2C')
    if (process.env.GITHUB_ACTIONS === 'true') {
      for (const failure of failures.slice(0, 50)) console.error(`::error file=${escape(failure.file)},title=CI test failure::${escape(`${failure.name}: ${failure.error.message}`.slice(0, 4000))}`)
      for (const error of diagnostics.unhandledErrors.slice(0, 10)) console.error(`::error title=Unhandled test error::${escape(error.message.slice(0, 4000))}`)
      for (const file of diagnostics.files) for (const test of file.tests) if (test.trace.length) {
        // A bounded existing timing trace also remains visible when a formerly
        // slow case passes, without changing its 5s limit or rerunning it.
        console.error(`::notice file=${escape(file.file)},title=Durable test phases::${escape(JSON.stringify({ name: test.name, state: test.state, trace: test.trace }).slice(0, 12000))}`)
      }
      for (const file of diagnostics.files) for (const test of file.tests) if (test.cpu) {
        console.error(`::notice file=${escape(file.file)},title=Durable test CPU::${escape(JSON.stringify({ name: test.name, state: test.state, cpu: test.cpu }))}`)
      }
    }
    const markdown = [`## Shard ${shard.index}/${shard.count} test diagnostics`,
      `Revision: ${plan.revision}; files: ${diagnostics.files.length}; failed assertions/module errors: ${failures.length}; unhandled: ${unhandledErrors.length}.`,
      ...failures.map(failure => `${failure.file} — ${failure.name}\n\n\`\`\`text\n${failure.error.message.replace(/```/g, "'''")}\n\`\`\``),
      ...diagnostics.unhandledErrors.map(error => `Unhandled: ${error.name}\n\n\`\`\`text\n${error.message.replace(/```/g, "'''")}\n\`\`\``),
    ].join('\n\n') + '\n'
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
    if (failures.length || unhandledErrors.length) console.error(markdown)
    if (unhandledErrors.length) throw new Error('CI test run has unhandled errors')
    const paths = testModules.map(module => testPath(this.ctx.config.root, module.moduleId))
    assertSameFiles(paths, plan.shards[shard.index - 1].files)
    testModules.forEach(assertTestsPassed)
    mkdirSync('.ci-test-reports', { recursive: true })
    writeFileSync(`.ci-test-reports/shard-${shard.index}.json`, JSON.stringify({ revision: plan.revision, index: shard.index, count: shard.count, files: paths }) + '\n')
  }
}
