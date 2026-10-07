import { describe, expect, it } from 'vitest'
import { assertBlobNames, assertTestsPassed, makeTestPlan, selectShard, validateReceipts, validateTestPlan, type TestPlan } from '../../scripts/lib/ci-test-plan.js'

const weights = [100, 80, 30, 20, 10].map((durationMs, index) => ({ path: `tests/unit/file-${index}.test.ts`, durationMs }))
const revision = 'test-revision'
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('CI test discovery and balanced assignment', () => {
  it('assigns every discovered file once, deterministically regardless of discovery order', () => {
    const plan = makeTestPlan(weights, revision, 3)
    expect(makeTestPlan([...weights].reverse(), revision, 3)).toEqual(plan)
    validateTestPlan(plan, weights.map(file => file.path), revision)
    expect(plan.shards.map(shard => shard.estimatedMs)).toEqual([100, 80, 60])
    const selected = plan.shards.flatMap(shard => selectShard(plan, weights.map(file => file.path), revision, shard.index, plan.count))
    expect(selected).toHaveLength(weights.length)
    expect(new Set(selected).size).toBe(weights.length)
  })

  it('places a future .tsx file in the least loaded shard automatically', () => {
    const extra = { path: 'tests/unit/new-file.test.tsx', durationMs: 5 }
    const plan = makeTestPlan([...weights, extra], revision, 3)
    expect(plan.shards[2].files).toContain(extra.path)
    validateTestPlan(plan, [...weights, extra].map(file => file.path), revision)
  })

  it('scales between ten and twenty shards as estimated work grows, with no empty shard for small suites', () => {
    expect(makeTestPlan(weights, revision).count).toBe(5)
    const files = Array.from({ length: 40 }, (_, index) => ({ path: `tests/unit/growing-${index}.test.ts`, durationMs: 20_000 }))
    expect(makeTestPlan(files, revision).count).toBe(10)
    expect(makeTestPlan(files.map(file => ({ ...file, durationMs: 30_000 })), revision).count).toBe(14)
    expect(makeTestPlan(files.map(file => ({ ...file, durationMs: 100_000 })), revision).count).toBe(20)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid duration %s', durationMs => {
    expect(() => makeTestPlan([{ ...weights[0], durationMs }], revision)).toThrow('duration')
  })

  it('accepts positive sub-millisecond timings', () => {
    expect(makeTestPlan([{ ...weights[0], durationMs: 0.5 }], revision).shards[0].estimatedMs).toBe(0.5)
  })

  it('rejects duplicate, empty, and escaping discovery sets', () => {
    expect(() => makeTestPlan([], revision)).toThrow()
    expect(() => makeTestPlan([weights[0], weights[0]], revision)).toThrow()
    expect(() => makeTestPlan([{ path: 'tests/../private.test.ts', durationMs: 1 }], revision)).toThrow()
    expect(() => makeTestPlan(weights, '')).toThrow('revision')
  })

  it.each([0, 6, 1.2])('rejects shard count %s', count => {
    expect(() => makeTestPlan(weights, revision, count)).toThrow('count')
  })

  it('fails closed on stale revision, missing/duplicate/new files, and corrupt numbering', () => {
    const plan = makeTestPlan(weights, revision, 3)
    const files = weights.map(file => file.path)
    expect(() => validateTestPlan(plan, files, 'other-revision')).toThrow()
    expect(() => validateTestPlan(plan, files.slice(1), revision)).toThrow()
    expect(() => validateTestPlan(plan, [...files, 'tests/unit/future.test.ts'], revision)).toThrow()
    const duplicate = copy(plan)
    duplicate.shards[1].files.push(duplicate.shards[0].files[0])
    expect(() => validateTestPlan(duplicate, files, revision)).toThrow()
    const wrongIndex = copy(plan)
    wrongIndex.shards[1].index = 3
    expect(() => validateTestPlan(wrongIndex, files, revision)).toThrow()
  })

  it.each([0, 4, 1.5])('rejects invalid shard index %s', index => {
    const plan = makeTestPlan(weights, revision, 3)
    expect(() => selectShard(plan, weights.map(file => file.path), revision, index, 3)).toThrow()
  })

  it('rejects an invocation using a different denominator', () => {
    const plan = makeTestPlan(weights, revision, 3)
    expect(() => selectShard(plan, weights.map(file => file.path), revision, 1, 10)).toThrow()
  })
})

describe('CI report completeness gate', () => {
  it('accepts only completed passing modules and rejects skipped, todo, focused or unfinished tests', () => {
    const passed = { fullName: 'case', options: { mode: 'run' }, result: () => ({ state: 'passed' }) }
    const module = (tests: Array<typeof passed>, state = 'passed') => ({
      moduleId: 'tests/unit/file-0.test.ts', state: () => state, children: { allTests: function* () { yield* tests } },
    })
    expect(() => assertTestsPassed(module([passed, passed]))).not.toThrow()
    for (const tests of [
      [{ ...passed, options: { mode: 'skip' } }],
      [{ ...passed, options: { mode: 'todo' } }],
      [{ ...passed, options: { mode: 'only' } }],
      [{ ...passed, result: () => ({ state: 'failed' }) }],
      [{ ...passed, result: () => ({ state: 'skipped' }) }],
      [{ ...passed, result: () => ({ state: 'pending' }) }],
    ]) {
      expect(() => assertTestsPassed(module(tests))).toThrow('without skips')
    }
    expect(() => assertTestsPassed(module([passed], 'failed'))).toThrow('every test file to pass')
    for (const state of ['queued', 'pending', 'skipped']) expect(() => assertTestsPassed(module([], state))).toThrow('every test file to pass')
  })

  it('requires precisely the planned blob names even as the count changes', () => {
    assertBlobNames(['blob-2-2.json', 'blob-1-2.json'], 2)
    for (const names of [['blob-1-2.json'], ['blob-1-2.json', 'blob-2-3.json'], ['blob-1-2.json', 'blob-2-2.json', 'blob-3-2.json'], ['blob-1-2.json', 'blob-1-2.json'], ['blob-1-2.json', 'blob-2-2.json', 'foreign.txt']]) {
      expect(() => assertBlobNames(names, 2)).toThrow()
    }
  })

  it('verifies each receipt belongs to this revision and contains exactly its assigned files', () => {
    const plan: TestPlan = makeTestPlan(weights, revision, 3)
    const receipts = plan.shards.map(shard => ({ revision, index: shard.index, count: plan.count, files: [...shard.files] }))
    validateReceipts([...receipts].reverse(), plan)
    expect(() => validateReceipts(receipts.slice(1), plan)).toThrow()
    expect(() => validateReceipts([receipts[0], receipts[0], receipts[2]], plan)).toThrow()
    const swapped = copy(receipts)
    ;[swapped[0].files, swapped[1].files] = [swapped[1].files, swapped[0].files]
    expect(() => validateReceipts(swapped, plan)).toThrow()
    expect(() => validateReceipts(receipts.map(receipt => ({ ...receipt, revision: 'foreign' })), plan)).toThrow()
    expect(() => validateReceipts(receipts.map(receipt => ({ ...receipt, count: 10 })), plan)).toThrow()
  })
})
