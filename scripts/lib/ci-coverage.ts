import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { ciCoverageThresholds } from '../../vitest.config.js'

const metrics = ['statements', 'branches', 'functions', 'lines'] as const
type Metric = typeof metrics[number]
type Counts = { total: number; covered: number; skipped: number; pct: number }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid coverage object')
  return value as Record<string, unknown>
}
const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid coverage count')
  return value
}
function sourcePath(value: unknown, root: string) {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) throw new Error('Invalid coverage source path')
  const path = relative(resolve(root), value)
  if (path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path) || !existsSync(value) || !statSync(value).isFile()) throw new Error('Coverage source is outside the current checkout or missing')
}
function location(value: unknown) {
  const loc = record(value), start = record(loc.start), end = record(loc.end)
  const startLine = count(start.line), endLine = count(end.line)
  // ast-v8-to-istanbul remaps an end-of-line column to Infinity. The official
  // blob JSON serializes that endpoint as null; start positions stay concrete.
  const startColumn = count(start.column), endColumn = end.column === null ? Infinity : count(end.column)
  if (!startLine || endLine < startLine || endLine === startLine && endColumn < startColumn) throw new Error('Invalid coverage location')
  return startLine
}
function sameKeys(left: Record<string, unknown>, right: Record<string, unknown>) {
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length || keys.some(key => !/^(?:0|[1-9]\d*)$/u.test(key) || !Object.hasOwn(right, key))) throw new Error('Coverage counters and maps differ')
}

/** Vitest 3.2.7 blob.ts serializes [version, files, errors, modules, coverage,
 * duration] as a six-slot tuple using the flatted protocol.
 * Decode only its acyclic coverage graph; other slots may contain test cycles.
 * Strings inside graph objects are table references; table strings are literals.
 * Reject corrupt references/cycles rather than interpreting arbitrary JSON keys. */
export function validateCoverageBlob(value: unknown, root: string) {
  if (!Array.isArray(value) || !Array.isArray(value[0]) || value[0].length !== 6) throw new Error('Invalid Vitest blob tuple')
  const table: unknown[] = value
  const tuple: unknown[] = value[0]
  const visiting = new Set<number>(), decoded = new Map<number, unknown>()
  function reference(ref: unknown): unknown {
    if (typeof ref !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(ref)) throw new Error('Invalid Vitest blob reference')
    const index = Number(ref)
    if (!Number.isSafeInteger(index) || index >= table.length || visiting.has(index)) throw new Error('Invalid or cyclic Vitest blob reference')
    if (decoded.has(index)) return decoded.get(index)
    const entry = table[index]
    if (typeof entry === 'string') return entry
    if (!entry || typeof entry !== 'object') throw new Error('Invalid Vitest blob reference entry')
    visiting.add(index)
    const result: unknown = Array.isArray(entry) ? entry.map(decode) : Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, decode(item)]))
    visiting.delete(index)
    decoded.set(index, result)
    return result
  }
  function decode(entry: unknown): unknown {
    if (typeof entry === 'string') return reference(entry)
    if (entry === null || typeof entry === 'number' || typeof entry === 'boolean') return entry
    throw new Error('Invalid unreferenced Vitest blob graph object')
  }
  if (reference(tuple[0]) !== '3.2.7') throw new Error('Vitest coverage blob version mismatch')
  // Validate envelope references without traversing unrelated cyclic test graphs.
  for (const slot of [1, 2, 3]) {
    const ref = tuple[slot]
    if (typeof ref !== 'string' || !/^[1-9]\d*$/u.test(ref) || Number(ref) >= table.length) throw new Error('Invalid Vitest blob envelope reference')
    if (!Array.isArray(table[Number(ref)])) throw new Error('Invalid Vitest blob envelope')
  }
  if (typeof tuple[5] !== 'number' || !Number.isFinite(tuple[5]) || tuple[5] < 0) throw new Error('Invalid Vitest blob duration')
  const coverage = record(reference(tuple[4]))
  const paths = Object.keys(coverage)
  if (!paths.length) throw new Error('Empty coverage blob')
  const totals = { statements: 0, branches: 0, functions: 0, lines: 0 }
  for (const path of paths) {
    sourcePath(path, root)
    const file = record(coverage[path])
    if (file.path !== path) throw new Error('Coverage file identity mismatch')
    const statements = record(file.s), functions = record(file.f), branches = record(file.b)
    const statementMap = record(file.statementMap), functionMap = record(file.fnMap), branchMap = record(file.branchMap)
    sameKeys(statements, statementMap); sameKeys(functions, functionMap); sameKeys(branches, branchMap)
    const lines = new Set<number>()
    for (const [id, hits] of Object.entries(statements)) { count(hits); lines.add(location(statementMap[id])); totals.statements++ }
    for (const [id, hits] of Object.entries(functions)) { count(hits); location(record(functionMap[id]).loc); totals.functions++ }
    for (const [id, hits] of Object.entries(branches)) {
      const branch = record(branchMap[id])
      if (!Array.isArray(hits) || !hits.length || !Array.isArray(branch.locations) || branch.locations.length !== hits.length) throw new Error('Invalid coverage branch counters')
      location(branch.loc)
      // ast-v8-to-istanbul emits signed branch counts from V8 range subtraction.
      // Preserve the official numeric array; Istanbul covers branches iff > 0.
      if (hits.some(hit => typeof hit !== 'number' || !Number.isSafeInteger(hit))) throw new Error('Invalid coverage branch count')
      branch.locations.forEach((value, index) => {
        const loc = record(value)
        // Istanbul represents the implicit else of `if (...) return ...` with
        // empty endpoints. Its enclosing branch still has a real source loc.
        if (branch.type === 'if' && hits.length === 2 && index === 1 && !Object.keys(record(loc.start)).length && !Object.keys(record(loc.end)).length) return
        location(loc)
      })
      totals.branches += hits.length
    }
    totals.lines += lines.size
  }
  if (metrics.some(metric => !totals[metric])) throw new Error('Coverage blob has empty executable denominators')
  return { files: paths.length, totals }
}

function summaryCounts(value: unknown): Counts {
  const metric = record(value)
  const total = count(metric.total), covered = count(metric.covered), skipped = count(metric.skipped)
  const expected = total ? Math.floor(10000 * covered / total) / 100 : 100
  if (covered > total || skipped > total || typeof metric.pct !== 'number' || !Number.isFinite(metric.pct) || metric.pct !== expected) throw new Error('Invalid coverage percentage or counts')
  return { total, covered, skipped, pct: metric.pct }
}

/** An empty Istanbul summary has pct="Unknown"; Vitest's numeric comparison
 * does not reject it. Independently require real sources, exact totals and all
 * four unchanged CI floors after the ordinary Vitest merge/threshold gate. */
export function validateCoverageSummary(value: unknown, root: string) {
  const summary = record(value), total = record(summary.total)
  const paths = Object.keys(summary).filter(key => key !== 'total')
  if (!paths.length) throw new Error('Empty merged coverage summary')
  const summed = Object.fromEntries(metrics.map(metric => [metric, { total: 0, covered: 0, skipped: 0 }])) as Record<Metric, Omit<Counts, 'pct'>>
  for (const path of paths) {
    sourcePath(path, root)
    const file = record(summary[path])
    for (const metric of metrics) {
      const counts = summaryCounts(file[metric])
      for (const key of ['total', 'covered', 'skipped'] as const) summed[metric][key] += counts[key]
    }
  }
  const totals = {} as Record<Metric, Counts>
  for (const metric of metrics) {
    const counts = summaryCounts(total[metric])
    if (!counts.total || (['total', 'covered', 'skipped'] as const).some(key => counts[key] !== summed[metric][key])) throw new Error('Merged coverage denominators are empty or inconsistent')
    if (counts.pct < ciCoverageThresholds[metric]) throw new Error(`Coverage ${metric} ${counts.pct}% is below the unchanged CI floor ${ciCoverageThresholds[metric]}%`)
    totals[metric] = counts
  }
  return { files: paths.length, totals }
}
