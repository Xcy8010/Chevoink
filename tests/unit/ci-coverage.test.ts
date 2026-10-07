import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import pm from 'picomatch'
import config, { ciCoverageThresholds } from '../../vitest.config.js'
import { validateCoverageBlob, validateCoverageSummary } from '../../scripts/lib/ci-coverage.js'

const root = process.cwd(), path = resolve(root, 'api/lib/agent/completion-guard.ts')
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } }
const file = { path, statementMap: { 0: loc }, fnMap: { 0: { name: 'synthetic', loc } }, branchMap: { 0: { type: 'if', loc, locations: [loc, loc] } }, s: { 0: 1 }, f: { 0: 1 }, b: { 0: [1, 0] } }

// Independently encode the documented blob tuple as a flatted reference table.
// Production decoding must validate the graph, not trust arbitrary map keys.
function blob(coverage: unknown = { [path]: file }, version = '4.1.11'): unknown[] {
  const table: unknown[] = [], known = new Map<unknown, string>()
  function ref(value: unknown): unknown {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
    if (known.has(value)) return known.get(value)
    const index = String(table.length)
    known.set(value, index); table.push(null)
    table[Number(index)] = typeof value === 'string' ? value : Array.isArray(value) ? value.map(ref) : Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, ref(item)]))
    return index
  }
  ref([version, [], [], coverage, 10, {}])
  return table
}
function summary() {
  const counts = { statements: { total: 100, covered: 30, skipped: 0, pct: 30 }, branches: { total: 100, covered: 73, skipped: 0, pct: 73 }, functions: { total: 100, covered: 52, skipped: 0, pct: 52 }, lines: { total: 100, covered: 30, skipped: 0, pct: 30 } }
  return { total: clone(counts), [path]: clone(counts) }
}

describe('Vitest 4 coverage collection compatibility', () => {
  it('includes ordinary business code while preserving the NUL/encoded/hidden/test exclusions', () => {
    const included = (file: string) => pm.isMatch(file, config.test!.coverage!.include!, { contains: true, dot: true, ignore: config.test!.coverage!.exclude })
    expect(included(`${root.replaceAll('\\', '/')}/src/App.tsx`)).toBe(true)
    for (const suffix of ['/\0virtual.ts', '/__x00__virtual.ts', '/.hidden/file.ts', '/tests/unit/file.test.ts', '/node_modules/example/index.js']) expect(included(root.replaceAll('\\', '/') + suffix)).toBe(false)
    expect(ciCoverageThresholds).toEqual({ statements: 30, branches: 73, functions: 52, lines: 30 })
  })
})

describe('CI coverage blob evidence gate', () => {
  it('accepts the pinned six-slot blob and counts actual executable source entries', () => {
    expect(validateCoverageBlob(blob(), root)).toEqual({ files: 1, totals: { statements: 1, functions: 1, branches: 2, lines: 1 } })
  })
  it('accepts the real pinned V8 end-of-line/implicit-else protocol while rejecting malformed endpoints', () => {
    const endOfLine = { start: loc.start, end: { line: 1, column: null } }
    const actual = { ...file, statementMap: { 0: endOfLine }, branchMap: { 0: { type: 'if', loc: endOfLine, locations: [endOfLine, { start: {}, end: {} }] } } }
    expect(validateCoverageBlob(blob({ [path]: actual }), root).totals.branches).toBe(2)
    const bad = { ...actual, statementMap: { 0: { start: {}, end: {} } } }
    expect(() => validateCoverageBlob(blob({ [path]: bad }), root)).toThrow()
    const wrongBranch = { ...actual, branchMap: { 0: { ...actual.branchMap[0], type: 'cond-expr' } } }
    expect(() => validateCoverageBlob(blob({ [path]: wrongBranch }), root)).toThrow()
  })
  it.each([undefined, null, {}, [], [['1', '2', '3', '4']], blob({}, '4.1.11'), blob({ bogus: {} }), blob(undefined, '3.2.4')])('rejects missing/empty/corrupt/version-mismatched coverage: %s', value => {
    expect(() => validateCoverageBlob(value, root)).toThrow()
  })
  it('rejects invalid references, cycles, mismatched identities/maps, and nonnumeric counts', () => {
    for (const ref of ['999999', '-1', '1.5', '00', '0']) {
      const value = blob(); (value[0] as unknown[])[3] = ref
      expect(() => validateCoverageBlob(value, root)).toThrow()
    }
    for (const modified of [
      { ...file, path: 'foreign.ts' },
      { ...file, s: { 1: 1 } },
      { ...file, s: { 0: '1' } },
      { ...file, f: { 0: -1 } },
      { ...file, b: { 0: [1] } },
      { ...file, statementMap: { 0: { start: { line: 0, column: 0 }, end: loc.end } } },
    ]) expect(() => validateCoverageBlob(blob({ [path]: modified }), root)).toThrow()
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => validateCoverageBlob(blob(cyclic), root)).toThrow('cyclic')
  })
})

describe('merged coverage evidence and unchanged floor gate', () => {
  it('accepts exact original floors with consistent file and aggregate counts', () => {
    expect(validateCoverageSummary(summary(), root).files).toBe(1)
  })
  it.each(['statements', 'branches', 'functions', 'lines'] as const)('rejects coverage below the original %s floor', metric => {
    const value = summary()
    for (const entry of [value.total, value[path]]) { entry[metric].covered--; entry[metric].pct-- }
    expect(() => validateCoverageSummary(value, root)).toThrow('unchanged CI floor')
  })
  it.each([undefined, {}, { total: {} }, { total: { statements: { total: 0, covered: 0, skipped: 0, pct: 'Unknown' } } }])('rejects missing or empty merged reports: %s', value => {
    expect(() => validateCoverageSummary(value, root)).toThrow()
  })
  it('rejects fake source keys, nonexistent files, aggregate mismatches and invalid numeric summaries', () => {
    for (const badPath of ['bogus', resolve(root, '../foreign.ts'), resolve(root, 'missing-coverage-source.ts'), root]) {
      expect(() => validateCoverageSummary({ total: summary().total, [badPath]: summary().total }, root)).toThrow()
    }
    for (const bad of [Number.NaN, Infinity, 'Unknown', 101, -1, 29]) {
      const value: Record<string, unknown> = clone(summary())
      const total = value.total as Record<string, Record<string, unknown>>
      total.statements.pct = bad
      expect(() => validateCoverageSummary(value, root)).toThrow()
    }
    const mismatch = summary(); mismatch.total.lines.total++
    expect(() => validateCoverageSummary(mismatch, root)).toThrow()
  })
})
