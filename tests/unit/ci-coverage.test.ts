import { resolve } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { coverageConfigDefaults } from 'vitest/config'
import config, { ciCoverageThresholds } from '../../vitest.config.js'
import { validateCoverageBlob, validateCoverageSummary } from '../../scripts/lib/ci-coverage.js'

const root = process.cwd(), path = resolve(root, 'api/lib/agent/completion-guard.ts')
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } }
const file = { path, statementMap: { 0: loc }, fnMap: { 0: { name: 'synthetic', loc } }, branchMap: { 0: { type: 'if', loc, locations: [loc, loc] } }, s: { 0: 1 }, f: { 0: 1 }, b: { 0: [1, 0] } }
const TestExclude = createRequire(import.meta.url)('test-exclude') as new (options: Record<string, unknown>) => { shouldInstrument(path: string): boolean; glob(cwd: string): Promise<string[]> }

// Independently encode the documented blob tuple as a flatted reference table.
// Production decoding must validate the graph, not trust arbitrary map keys.
function blob(coverage: unknown = { [path]: file }, version = '3.2.7'): unknown[] {
  const table: unknown[] = [], known = new Map<unknown, string>()
  function ref(value: unknown): unknown {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
    if (known.has(value)) return known.get(value)
    const index = String(table.length)
    known.set(value, index); table.push(null)
    table[Number(index)] = typeof value === 'string' ? value : Array.isArray(value) ? value.map(ref) : Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, ref(item)]))
    return index
  }
  ref([version, [], [], [], coverage, 10])
  return table
}
function summary() {
  const counts = { statements: { total: 100, covered: 30, skipped: 0, pct: 30 }, branches: { total: 100, covered: 73, skipped: 0, pct: 73 }, functions: { total: 100, covered: 52, skipped: 0, pct: 52 }, lines: { total: 100, covered: 30, skipped: 0, pct: 30 } }
  return { total: clone(counts), [path]: clone(counts) }
}

describe('pinned Vitest 3 coverage collection compatibility', () => {
  it('includes ordinary business code while preserving the NUL/encoded/hidden/test exclusions', () => {
    const filter = new TestExclude({ cwd: root, extension: coverageConfigDefaults.extension, exclude: coverageConfigDefaults.exclude })
    const included = (file: string) => filter.shouldInstrument(file)
    const coverage = config.test!.coverage!
    if (coverage.provider !== 'v8') throw new Error('Expected the pinned V8 coverage provider')
    expect(coverage.all).toBe(true)
    expect(coverage.experimentalAstAwareRemapping).toBe(false)
    expect(coverage.include).toBeUndefined()
    expect(coverage.exclude).toBeUndefined()
    expect(coverageConfigDefaults.extension).toEqual(['.js', '.cjs', '.mjs', '.ts', '.mts', '.tsx', '.jsx', '.vue', '.svelte', '.marko', '.astro'])
    expect(included(`${root.replaceAll('\\', '/')}/src/App.tsx`)).toBe(true)
    // Complete Vitest 3.2.7 coverage.extension defaults, not a narrower JS/TS set.
    for (const extension of ['js', 'cjs', 'mjs', 'ts', 'mts', 'tsx', 'jsx', 'vue', 'svelte', 'marko', 'astro']) expect(included(`${root.replaceAll('\\', '/')}/src/component.${extension}`)).toBe(true)
    for (const extension of ['md', 'json', 'yaml', 'css', 'rs', 'toml', 'png', 'svg', 'cts', 'txt', 'ts.txt', 'tsx.map', 'jsx.json']) expect(included(`${root.replaceAll('\\', '/')}/src/file.${extension}`)).toBe(false)
    for (const suffix of ['/\0virtual.ts', '/__x00__virtual.ts', '/.hidden/file.ts', '/tests/unit/file.test.ts', '/node_modules/example/index.js']) expect(included(root.replaceAll('\\', '/') + suffix)).toBe(false)
    expect(ciCoverageThresholds).toEqual({ statements: 30, branches: 73, functions: 52, lines: 30 })
  })
  it('uses the same complete legacy extension set for the real uncovered-file scanner', async () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'chevoink-coverage-extension-'))
    if (!fixture.startsWith(resolve(tmpdir(), 'chevoink-coverage-extension-'))) throw new Error('Unexpected coverage fixture path')
    const included = ['js', 'cjs', 'mjs', 'ts', 'mts', 'tsx', 'jsx', 'vue', 'svelte', 'marko', 'astro'].map(ext => `source.${ext}`)
    const excluded = ['json', 'md', 'css', 'rs', 'toml', 'svg', 'cts', 'ts.txt', 'tsx.map', 'jsx.json'].map(ext => `source.${ext}`)
    try {
      for (const name of [...included, ...excluded]) writeFileSync(resolve(fixture, name), '')
      const files = await new TestExclude({ cwd: fixture, extension: coverageConfigDefaults.extension, exclude: coverageConfigDefaults.exclude }).glob(fixture)
      expect(files.sort()).toEqual(included.sort())
    } finally {
      rmSync(fixture, { recursive: true })
    }
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
  it('preserves official signed branch arrays without relaxing statements/functions or accepting invalid numbers', () => {
    const implicitElse = { type: 'if', loc, locations: [loc, { start: {}, end: {} }] }
    for (const hits of [[1, -1], [2, -7], [3, -61]]) expect(validateCoverageBlob(blob({ [path]: { ...file, branchMap: { 0: implicitElse }, b: { 0: hits } } }), root).totals.branches).toBe(2)
    for (const type of ['if', 'cond-expr', 'binary-expr', 'switch', 'default-arg']) {
      const value = blob({ [path]: { ...file, branchMap: { 0: { ...file.branchMap[0], type } }, b: { 0: [-2, -7] } } })
      const before = clone(value)
      expect(validateCoverageBlob(value, root).totals.branches).toBe(2)
      expect(value).toEqual(before)
    }
    for (const hits of [[1, null], [1, -0.5], [1, '-1'], [1, Infinity], [1, Number.NaN]]) expect(() => validateCoverageBlob(blob({ [path]: { ...file, branchMap: { 0: implicitElse }, b: { 0: hits } } }), root)).toThrow()
    for (const modified of [{ ...file, s: { 0: -1 } }, { ...file, f: { 0: -1 } }]) expect(() => validateCoverageBlob(blob({ [path]: modified }), root)).toThrow()
  })
  it('accepts signed end columns only for the complete official all/empty-report placeholder', () => {
    const position = { start: { line: 1, column: 461 }, end: { line: 17, column: -317 } }
    const empty = { ...file, all: true, s: { 0: 0 }, f: { 0: 0 }, b: { 0: [0] }, fnMap: { 0: { name: '(empty-report)', loc: position, decl: position } }, branchMap: { 0: { type: 'branch', loc: position, locations: [position] } } }
    for (const hit of [0, 1]) {
      const value = blob({ [path]: { ...empty, f: { 0: hit }, b: { 0: [hit] } } }), before = clone(value)
      expect(validateCoverageBlob(value, root).totals).toEqual({ statements: 1, functions: 1, branches: 1, lines: 1 })
      expect(value).toEqual(before)
    }
    for (const bad of [
      { ...empty, all: false }, { ...empty, s: { 0: 1 } }, { ...empty, f: { 0: 2 }, b: { 0: [2] } }, { ...empty, b: { 0: [1] } },
      { ...empty, fnMap: { 0: { ...empty.fnMap[0], name: 'ordinary' } } },
      { ...empty, fnMap: { 0: { ...empty.fnMap[0], decl: loc } } },
      { ...empty, branchMap: { 0: { ...empty.branchMap[0], type: 'if' } } },
      { ...empty, branchMap: { 0: { ...empty.branchMap[0], locations: [loc] } } },
      { ...empty, fnMap: { ...empty.fnMap, 1: empty.fnMap[0] }, f: { 0: 0, 1: 0 } },
      { ...empty, branchMap: { ...empty.branchMap, 1: empty.branchMap[0] }, b: { 0: [0], 1: [0] } },
    ]) expect(() => validateCoverageBlob(blob({ [path]: bad }), root)).toThrow()
    for (const badPosition of [
      ...[null, -0.5, '-317', Infinity, Number.NaN].map(column => ({ ...position, end: { ...position.end, column } })),
      { ...position, start: { ...position.start, column: -1 } },
      { ...position, start: { ...position.start, line: 0 } },
      { ...position, end: { ...position.end, line: 1 } },
      { ...position, start: { ...position.start, line: 18 } },
    ]) {
      const bad = { ...empty, fnMap: { 0: { ...empty.fnMap[0], loc: badPosition, decl: badPosition } }, branchMap: { 0: { ...empty.branchMap[0], loc: badPosition, locations: [badPosition] } } }
      expect(() => validateCoverageBlob(blob({ [path]: bad }), root)).toThrow()
    }
    const statementNegative = { ...empty, statementMap: { 0: position } }
    expect(() => validateCoverageBlob(blob({ [path]: statementNegative }), root)).toThrow()
  })
  it.each([undefined, null, {}, [], [['1', '2', '3', '4']], blob({}), blob({ bogus: {} }), blob(undefined, '4.1.11')])('rejects missing/empty/corrupt/version-mismatched coverage: %s', value => {
    expect(() => validateCoverageBlob(value, root)).toThrow()
  })
  it('rejects invalid references, cycles, mismatched identities/maps, and nonnumeric counts', () => {
    for (const ref of ['999999', '-1', '1.5', '00', '0']) {
      const value = blob(); (value[0] as unknown[])[4] = ref
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
