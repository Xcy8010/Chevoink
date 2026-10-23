import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TestModule, Vitest } from 'vitest/node'
const files = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), append: vi.fn(), mkdir: vi.fn() }))
vi.mock('node:fs', () => ({ readFileSync: files.read, writeFileSync: files.write, appendFileSync: files.append, mkdirSync: files.mkdir }))
import Reporter from '../../scripts/ci-test-reporter.js'

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('CI_TEST_REVISION', 'isolated-revision'); vi.stubEnv('GITHUB_SHA', 'isolated-revision'); vi.stubEnv('GITHUB_STEP_SUMMARY', 'isolated-summary'); vi.stubEnv('GITHUB_ACTIONS', 'true') })

describe('CI diagnostics preserve failed assertions without minting a pass receipt', () => {
  it.each(['assertion', 'collection', 'unhandled', 'passed'] as const)('records %s evidence before the unchanged strict gate', scenario => {
    files.read.mockReturnValue(JSON.stringify({ revision: 'isolated-revision', count: 1, shards: [{ index: 1, files: ['tests/integration/fixture.test.ts'] }] }))
    const reporter = new Reporter()
    reporter.onInit({ config: { shard: { index: 1, count: 1 }, root: '/isolated' } } as unknown as Vitest)
    const error = { name: 'AssertionError', message: 'expected 1 to equal 2\n::notice::synthetic command text, 100%', stack: 'synthetic-stack' }
    const module = { moduleId: '/isolated/tests/integration/fixture.test.ts', state: () => scenario === 'passed' ? 'passed' : 'failed',
      errors: () => scenario === 'collection' ? [error] : [], children: { allTests: function* () { yield { id: 'synthetic-task', fullName: 'exact failing assertion', options: { mode: 'run' },
        result: () => scenario === 'assertion' ? { state: 'failed', errors: [error] } : { state: 'passed' } } } } } as unknown as TestModule
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (let index = 0; index < 30; index++) reporter.onUserConsoleLog({ taskId: 'synthetic-task', content: '[durable-quality-stage] ' + JSON.stringify({
        event: 'finish', elapsedMs: index, mockOrdinal: 1, cpuUserMs: 1, cpuSystemMs: 0, phase: 'step', ordinal: index, durationMs: 1, outcome: 'fulfilled',
        secret: 'never-forward-this' }) } as Parameters<Reporter['onUserConsoleLog']>[0])
      const run = () => reporter.onTestRunEnd([module], scenario === 'unhandled' ? [error] : [])
      if (scenario === 'passed') expect(run).not.toThrow()
      else expect(run).toThrow()
      expect(files.write.mock.calls[0][0]).toBe('.ci-test-diagnostics/shard-1.json')
      const diagnostic = JSON.parse(String(files.write.mock.calls[0][1]))
      expect(diagnostic.files[0].tests[0].trace).toHaveLength(24)
      expect(diagnostic.files[0].tests[0].trace[0].ordinal).toBe(6)
      expect(JSON.stringify(diagnostic)).not.toContain('never-forward-this')
      expect(stderr.mock.calls.some(([value]) => String(value).includes('title=Durable test phases::'))).toBe(true)
      if (scenario === 'assertion') expect(diagnostic.files[0].tests[0]).toMatchObject({ name: 'exact failing assertion', state: 'failed', errors: [{ message: error.message }] })
      if (scenario === 'assertion') expect(stderr).toHaveBeenCalledWith('::error file=tests/integration/fixture.test.ts,title=CI test failure::exact failing assertion: expected 1 to equal 2%0A::notice::synthetic command text%2C 100%25')
      expect(files.write.mock.calls.some(([filename]) => filename === '.ci-test-reports/shard-1.json')).toBe(scenario === 'passed')
      expect(files.append).toHaveBeenCalledOnce()
    } finally { stderr.mockRestore(); vi.unstubAllEnvs() }
  })
})
