import { describe, expect, it } from 'vitest'
import { advanceRunTiming, combineRunTimings, formatRunDuration, recoverRunTiming, recoverSingleExecutionTiming, runElapsedMs, settleRunTiming } from '../../shared/agent-timing.js'
import { formatMessageTime } from '../../src/features/studio/agent/lib/message-time.js'
import { projectBlockTimings, projectMessages } from '../../src/features/studio/agent/lib/message-projection.js'
import type { AgentRunTiming, AgentUIMessage } from '../../shared/contracts/agent-events.js'

const ts = (seconds: number) => new Date(Date.UTC(2026, 9, 18) + seconds * 1000).toISOString()
const event = (type: string, seq: number, seconds: number) => ({ type, seq, ts: ts(seconds) })
describe('local message time', () => {
  it('pads local fields and distinguishes today, another day and another year', () => {
    const now = new Date(2026, 9, 18, 12)
    expect(formatMessageTime(new Date(2026, 9, 18, 0, 5).toISOString(), now)).toBe('00:05')
    expect(formatMessageTime(new Date(2026, 0, 2, 3, 4).toISOString(), now)).toBe('01/02/03:04')
    expect(formatMessageTime(new Date(2025, 11, 31, 23, 59).toISOString(), now)).toBe('2025/12/31/23:59')
    expect(formatMessageTime(new Date(2026, 9, 17, 15, 24).toISOString(), now)).toBe('10/17/15:24')
  })
  it('uses the local calendar on UTC midnight and year boundaries', () => {
    const value = '2026-01-01T01:05:00Z', now = new Date('2026-01-01T16:00:00Z')
    const expected = process.env.TZ === 'America/New_York' ? '2025/12/31/20:05'
      : process.env.TZ === 'Asia/Shanghai' ? '01/01/09:05' : '01:05'
    expect(formatMessageTime(value, now)).toBe(expected)
  })
  it('does not invent absent or invalid times', () => {
    for (const value of [undefined, null, '', 'invalid']) expect(formatMessageTime(value)).toBeNull()
  })
})

describe('execution duration', () => {
  it.each([[0, '0秒'], [59000, '59秒'], [60000, '1分钟0秒'], [152000, '2分钟32秒'],
    [3599000, '59分钟59秒'], [3600000, '1小时0分钟0秒'], [3723000, '1小时2分钟3秒'], [90061000, '25小时1分钟1秒']])('formats %i ms', (ms, result) => {
    expect(formatRunDuration(ms)).toBe(result)
  })
  it('recovers multiple active intervals without paused gaps, and freezes on success/failure/cancellation', () => {
    const transitions = [event('run.started', 1, 1), event('run.paused', 5, 10), event('run.started', 9, 100), event('run.finished', 20, 112)]
    for (const status of ['completed', 'failed', 'cancelled']) {
      const timing = recoverRunTiming({ status, startedAt: ts(0), finishedAt: ts(112) }, transitions)
      expect(runElapsedMs(timing, Date.parse(ts(999)))).toBe(22000)
      expect(runElapsedMs(timing, Date.parse(ts(9999)))).toBe(22000)
    }
  })
  it('deduplicates replay and treats a new admission with a missing stop as unknown', () => {
    const timing = advanceRunTiming(undefined, event('run.started', 2, 0))
    expect(advanceRunTiming(timing, event('run.started', 2, 0))).toBe(timing)
    const repeated = advanceRunTiming(timing, event('run.started', 3, 5))
    expect(runElapsedMs(repeated, Date.parse(ts(10)))).toBeNull()
    expect(advanceRunTiming(repeated, event('run.paused', 2, 4))).toBe(repeated)
  })
  it('never fabricates a historical end, and rejects invalid or backwards clocks', () => {
    const transitions = [event('run.started', 1, 0)]
    expect(recoverRunTiming({ status: 'failed', startedAt: ts(0), finishedAt: null }, transitions).elapsedMs).toBeNull()
    expect(recoverRunTiming({ status: 'completed', startedAt: ts(0), finishedAt: ts(5) }, []).elapsedMs).toBeNull()
    expect(recoverRunTiming({ status: 'paused', startedAt: ts(0), finishedAt: null }, [...transitions, event('run.paused', 2, -1)]).elapsedMs).toBeNull()
    expect(advanceRunTiming(undefined, { type: 'run.started', seq: 1, ts: 'invalid' }).elapsedMs).toBeNull()
    expect(runElapsedMs(advanceRunTiming(undefined, event('run.started', 1, 1)), Date.parse(ts(0)))).toBeNull()
  })
  it('uses a recorded status stop without consuming the next real event sequence', () => {
    const started = advanceRunTiming(undefined, event('run.started', 1, 0))
    const paused = settleRunTiming(started, ts(10), true)
    expect(paused.lastSeq).toBe(1)
    const resumed = advanceRunTiming(paused, event('run.started', 2, 100))
    expect(runElapsedMs(resumed, Date.parse(ts(105)))).toBe(15000)
    expect(settleRunTiming(paused, null, true).elapsedMs).toBe(10000)
  })
  it('uses each durable activation start, excluding the old root start replay', () => {
    const first = recoverSingleExecutionTiming({ status: 'paused', startedAt: ts(0), finishedAt: null }, ts(10), 20)
    const resumed = recoverSingleExecutionTiming({ status: 'running', startedAt: ts(100), finishedAt: null }, null, 1)
    const total = combineRunTimings([first, resumed])
    expect(runElapsedMs(total, Date.parse(ts(105)))).toBe(15000)
    expect(advanceRunTiming(total, event('run.started', 1, 0))).toBe(total)
    expect(recoverSingleExecutionTiming({ status: 'paused', startedAt: ts(0), finishedAt: null }, null, 1).elapsedMs).toBeNull()
  })
  it('deduplicates shared run/root metadata and only ticks the current execution', () => {
    const timing: AgentRunTiming = { scopeId: 'root', sourceRunId: 'r2', elapsedMs: 10000, activeSince: ts(100), status: 'running', lastSeq: 1 }
    const messages: AgentUIMessage[] = ['r1', 'r2', 'r2'].map((runId, i) => ({ id: `a${i}`, runId, goalId: 'g', role: 'assistant', parts: [], createdAt: ts(0), runTiming: timing }))
    const { blockInfoById } = projectMessages(messages)
    expect(runElapsedMs(projectBlockTimings(messages, blockInfoById, 'r2').get('a0')!, Date.parse(ts(105)))).toBe(15000)
    expect(projectBlockTimings(messages, blockInfoById, null).get('a0')).toMatchObject({ activeSince: null, elapsedMs: null, status: 'unknown' })
    expect(combineRunTimings([timing, timing]).elapsedMs).toBeNull() // concurrent witnesses cannot be added safely
  })
})
