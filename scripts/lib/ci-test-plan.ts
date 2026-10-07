import { relative } from 'node:path'

export interface TestWeight { path: string; durationMs: number }
export interface TestShard { index: number; estimatedMs: number; files: string[] }
export interface TestPlan { version: 1; revision: string; count: number; shards: TestShard[] }

// Structural subset of the pinned Vitest 3.2.7 reporter tasks (TestModule/TestCase).
// Keeping the gate duck-typed lets unit tests exercise it without real runner
// objects while the reporter passes actual TestModule instances.
interface RunTest { readonly fullName: string; readonly options: { readonly mode: string }; result(): { readonly state: string } }
interface RunModule { readonly moduleId: string; state(): string; readonly children: { allTests(): Iterable<RunTest> } }
export function assertTestsPassed(testModule: RunModule): void {
  if (testModule.state() !== 'passed') throw new Error(`CI requires every test file to pass: ${testModule.moduleId}`)
  for (const test of testModule.children.allTests()) {
    // Skipped, todo, .only-filtered and unfinished tests all invalidate the
    // receipt so the merged report stays a full-suite gate.
    if (test.options.mode !== 'run' || test.result().state !== 'passed') throw new Error(`CI requires every test to pass without skips: ${test.fullName}`)
  }
}

export function testPath(root: string, file: string): string {
  return relative(root, file).replaceAll('\\', '/')
}

function assertFiles(files: string[]): void {
  if (!files.length || new Set(files).size !== files.length) throw new Error('Test files must be nonempty and unique')
  for (const file of files) {
    if (!/^tests\/.+\.test\.tsx?$/.test(file) || file.split('/').includes('..')) throw new Error(`Invalid test path: ${file}`)
  }
}

export function assertSameFiles(actual: string[], expected: string[]): void {
  assertFiles(actual)
  assertFiles(expected)
  const expectedSet = new Set(expected)
  if (actual.length !== expected.length || actual.some(file => !expectedSet.has(file))) throw new Error('Test file set differs from plan')
}

// Longest-processing-time scheduling: deterministic ties make every worker use
// the same assignment. Unknown/new files participate immediately; no allowlist.
export function makeTestPlan(weights: TestWeight[], revision: string, count?: number): TestPlan {
  assertFiles(weights.map(file => file.path))
  if (!revision) throw new Error('Test plan requires a revision')
  if (weights.some(file => !Number.isFinite(file.durationMs) || file.durationMs <= 0)) throw new Error('Invalid test duration')
  const totalMs = weights.reduce((sum, file) => sum + file.durationMs, 0)
  const shardCount = count ?? Math.min(weights.length, Math.max(10, Math.min(20, Math.ceil(totalMs / 90_000))))
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > weights.length) throw new Error('Invalid shard count')
  const shards: TestShard[] = Array.from({ length: shardCount }, (_, index) => ({ index: index + 1, estimatedMs: 0, files: [] }))
  for (const file of [...weights].sort((a, b) => b.durationMs - a.durationMs || a.path.localeCompare(b.path, 'en'))) {
    const target = shards.reduce((best, shard) => shard.estimatedMs < best.estimatedMs ? shard : best)
    target.files.push(file.path)
    target.estimatedMs += file.durationMs
  }
  return { version: 1, revision, count: shardCount, shards }
}

export function validateTestPlan(plan: TestPlan, files: string[], revision: string): void {
  if (plan.version !== 1 || plan.revision !== revision || !revision) throw new Error('Test plan revision/version mismatch')
  if (!Number.isInteger(plan.count) || plan.count < 1 || plan.count > files.length || plan.shards.length !== plan.count) throw new Error('Test plan count mismatch')
  for (const [offset, shard] of plan.shards.entries()) {
    if (shard.index !== offset + 1 || !Number.isFinite(shard.estimatedMs) || shard.estimatedMs <= 0) throw new Error('Invalid planned shard')
    assertFiles(shard.files)
  }
  assertSameFiles(plan.shards.flatMap(shard => shard.files), files)
}

export function selectShard(plan: TestPlan, files: string[], revision: string, index: number, count: number): string[] {
  validateTestPlan(plan, files, revision)
  if (count !== plan.count || !Number.isInteger(index) || index < 1 || index > count) throw new Error('Requested shard differs from plan')
  return plan.shards[index - 1].files
}

export function assertBlobNames(names: string[], count: number): void {
  const expected = Array.from({ length: count }, (_, index) => `blob-${index + 1}-${count}.json`)
  if (names.length !== expected.length || new Set(names).size !== names.length || expected.some(name => !names.includes(name))) throw new Error('Missing, extra, or misnumbered Vitest blob report')
}

export interface TestReceipt { revision: string; index: number; count: number; files: string[] }
export function validateReceipts(receipts: TestReceipt[], plan: TestPlan): void {
  if (receipts.length !== plan.count || new Set(receipts.map(receipt => receipt.index)).size !== plan.count) throw new Error('Missing or duplicate test receipt')
  for (const receipt of receipts) {
    if (receipt.revision !== plan.revision || receipt.count !== plan.count || !Number.isInteger(receipt.index) || receipt.index < 1 || receipt.index > plan.count) throw new Error('Test receipt identity mismatch')
    assertSameFiles(receipt.files, plan.shards[receipt.index - 1].files)
  }
}
