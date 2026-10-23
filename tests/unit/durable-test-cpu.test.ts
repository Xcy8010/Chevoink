import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Profiler } from 'node:inspector'
import { startDurableTestCpuProfile, summarizeDurableCpu } from '../support/durable-test-cpu.js'

const root = path.resolve('synthetic-workspace')
const node = (id: number, name: string, url = '', children: number[] = []): Profiler.ProfileNode => ({ id, callFrame: { functionName: name, url, scriptId: '0', lineNumber: 0, columnNumber: 0 }, children })
describe('test-only CPU sampler exports code locations and time, never profile payloads or host paths', () => {
  it('attributes self and inclusive sampled time, distinguishing actual idle time', () => {
    const summary = summarizeDurableCpu({ startTime: 0, endTime: 6000, nodes: [node(1, '(root)', '', [2, 4]),
      node(2, 'readFrame', pathToFileURL(path.join(root, 'api/lib/frame.ts')).href, [3]), node(3, 'nextTick', 'node:internal/process/task_queues'), node(4, '(idle)')],
    samples: [2, 3, 4], timeDeltas: [1000, 2000, 3000] }, root)
    expect(summary).toMatchObject({ samples: 3, totalMs: 6, idleMs: 3, own: [{ file: 'api/lib/frame.ts', name: 'readFrame', selfMs: 1, inclusiveMs: 3 }] })
    expect(JSON.stringify(summary)).not.toContain(root)
  })
  it('suppresses evaluated URLs, unsafe names and unbounded samples before public output', () => {
    const summary = summarizeDurableCpu({ startTime: 0, endTime: 1000, nodes: [node(1, 'unsafe\nprivate text', 'https://private.example/secret')],
      samples: [1, 1], timeDeltas: [1000, -1] }, root)
    expect(summary.self).toEqual([{ file: '[runtime]', name: '(anonymous)', selfMs: 1, inclusiveMs: 1 }])
    expect(JSON.stringify(summary)).not.toMatch(/private|secret|https/)
  })
  it('stops and disconnects one local sampler exactly once without a network listener', async () => {
    const stop = await startDurableTestCpuProfile()
    await new Promise<void>(resolve => setImmediate(resolve))
    const first = stop(), replay = stop()
    expect(replay).toBe(first)
    const summary = await first
    expect(summary.samples).toBeGreaterThanOrEqual(0)
    expect(summary.self.length).toBeLessThanOrEqual(8)
    expect(summary.own.length).toBeLessThanOrEqual(8)
    expect(JSON.stringify(summary)).not.toContain(process.cwd())
  })
})
