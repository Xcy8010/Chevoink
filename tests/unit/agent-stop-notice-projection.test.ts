import { describe, expect, it, vi } from 'vitest'
vi.mock('../../api/lib/prisma.js', () => ({ prisma: {} }))
import { publicRunEvent, serverRunNotices } from '../../api/lib/agent/events.js'
import type { AgentStreamEvent } from '../../shared/contracts/index.js'

describe('server stop explanations use run status rather than novel prose', () => {
  const stored = (status: 'failed' | 'paused' | 'cancelled') => [
    { runId: 'r', seq: 10, type: 'message.start', payload: { messageId: 'notice', role: 'assistant' } },
    { runId: 'r', seq: 11, type: 'text.final', run: { errorMessage: 'Original technical stop reason' }, payload: { messageId: 'notice', text: 'Original technical stop reason', asReasoning: false } },
    { runId: 'r', seq: 12, type: status === 'paused' ? 'run.paused' : 'run.finished', payload: { status } },
  ]
  const event: AgentStreamEvent = { runId: 'r', seq: 11, ts: '2026-10-26T12:00:00Z', type: 'text.final',
    messageId: 'notice', text: 'Original technical stop reason', asReasoning: false }
  it.each(['failed', 'paused'] as const)('preserves %s failure truth and immutable old records', status => {
    const rows = stored(status), original = structuredClone(rows), notices = serverRunNotices(rows)
    expect(publicRunEvent(event, notices)).toEqual({ runId: 'r', seq: 11, ts: event.ts, type: 'error',
      code: 'run_' + status, message: event.text, recoverable: status === 'paused' })
    expect(rows).toEqual(original)
    expect(event.type).toBe('text.final')
  })
  it('keeps author cancellation truthful without turning it into a failure', () => {
    expect(publicRunEvent(event, serverRunNotices(stored('cancelled')))).toEqual({ ...event, text: '' })
  })
  it('does not suppress novel prose, a success delivery or unrelated/partial event history', () => {
    for (const rows of [stored('failed').slice(1), stored('failed').slice(0, 2),
      stored('failed').map(row => row.seq === 10 ? { ...row, runId: 'other' } : row),
      stored('failed').map(row => row.seq === 12 ? { ...row, payload: { status: 'succeeded' } } : row),
      [...stored('failed').slice(0, 2), { runId: 'r', seq: 12, type: 'step.finish', payload: {} },
        { runId: 'r', seq: 13, type: 'run.finished', payload: { status: 'failed' } }]]) {
      expect(publicRunEvent(event, serverRunNotices(rows))).toBe(event)
    }
  })
  it('retains a real research partial delivery even next to a pause', () => {
    const text = '旧城门的描写采用限知视角；研究尚未完成。',
      rows = stored('paused').map(row => row.seq === 11 ? { ...row, payload: { messageId: 'notice', text, asReasoning: false } } : row)
    const research = { ...event, text }
    expect(publicRunEvent(research, serverRunNotices(rows))).toBe(research)
  })
  it('retains a limited delivery whose outcome proves the published artifact', () => {
    const rows = stored('paused').map(row => row.seq === 12 ? { ...row, payload: { status: 'paused', outcome: 'limited' } } : row)
    expect(publicRunEvent(event, serverRunNotices(rows))).toBe(event)
  })

})
