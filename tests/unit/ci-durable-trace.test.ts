import { describe, expect, it } from 'vitest'
import { parseCiDurableTrace } from '../../scripts/lib/ci-durable-trace.js'

const counters = { event: 'abort', elapsedMs: 5000, mockOrdinal: 3, cpuUserMs: 4000, cpuSystemMs: 100,
  pending: [{ phase: 'step', ordinal: 5, durationMs: 1000, cpuUserMs: 950, cpuSystemMs: 10 }] }
describe('public CI trace accepts only bounded fixed phase counters', () => {
  it('retains the current stage and CPU counters while stripping arbitrary data', () => {
    expect(parseCiDurableTrace('[durable-quality-stage] ' + JSON.stringify({ ...counters, sql: 'private', request: 'private', pending: [{ ...counters.pending[0], body: 'private' }] }))).toEqual(counters)
  })
  it.each(['ordinary output', '[durable-quality-stage] {broken', '[durable-quality-stage] ' + 'x'.repeat(8192),
    '[durable-quality-stage] ' + JSON.stringify({ ...counters, elapsedMs: -1 }),
    '[durable-quality-stage] ' + JSON.stringify({ ...counters, phase: 'arbitrary private message' })])('does not echo unknown or invalid captured output', content => {
    expect(parseCiDurableTrace(content)).toBeNull()
  })
})
