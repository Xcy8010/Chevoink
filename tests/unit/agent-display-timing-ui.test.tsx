// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProcessDuration } from '../../src/features/studio/agent/components/ProcessDuration'
import { MessageTime, UserMessageActions } from '../../src/features/studio/agent/components/MessageActions'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import type { AgentRunTiming } from '../../shared/contracts/agent-events.js'
import { useOutgoingMessages } from '../../src/features/studio/agent/outgoing-messages'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'

const timing: AgentRunTiming = { elapsedMs: 2000, activeSince: '2026-10-18T00:00:00Z', status: 'running', lastSeq: 1 }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T00:00:03Z')) })
afterEach(() => { cleanup(); useOutgoingMessages.setState({ items: [], requestClocks: [] }); useAgentStore.getState().resetRun(); vi.useRealTimers() })

it('shows preparation immediately and ticks during response silence, then keeps the same reading on completion', () => {
  const id = useOutgoingMessages.getState().add('scope', 'novel', 'session', '合成请求', [])
  function Display() {
    const clocks = useOutgoingMessages(state => state.requestClocks)
    return <ProcessDuration timing={clocks[0].timing} />
  }
  render(<Display />)
  expect(screen.getByRole('status').textContent).toBe('正在准备中...')
  act(() => vi.advanceTimersByTime(20000))
  expect(screen.queryByLabelText('20 秒')).toBeNull()
  useOutgoingMessages.getState().update(id, { runId: 'run', status: 'sent' })
  useAgentStore.getState().beginRun('run', '合成请求', 'session', [], null, id)
  const apply = useAgentStore.getState().applyEvent
  act(() => apply({ type: 'run.started', runId: 'run', seq: 1, ts: new Date().toISOString(), mode: 'build', title: '任务', agent: { type: 'novelist', title: '助手', model: 'speed' } }))
  expect(screen.getByRole('status').textContent).toBe('正在准备中...')
  act(() => apply({ type: 'text.delta', runId: 'foreign', messageId: 'm', seq: 2, ts: new Date().toISOString(), delta: '别的任务' }))
  expect(screen.getByRole('status').textContent).toBe('正在准备中...')
  act(() => apply({ type: 'text.delta', runId: 'run', messageId: 'm', seq: 2, ts: new Date().toISOString(), delta: '响应' }))
  expect(screen.getByLabelText('0 秒')).toBeTruthy()
  for (let second = 1; second <= 10; second++) {
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByLabelText(`${second} 秒`)).toBeTruthy()
  }
  // Replayed admission and subsequent chunks must not restart the display.
  act(() => apply({ type: 'run.started', runId: 'run', seq: 1, ts: new Date().toISOString(), mode: 'build', title: '任务', agent: { type: 'novelist', title: '助手', model: 'speed' } }))
  act(() => apply({ type: 'text.delta', runId: 'run', messageId: 'm', seq: 3, ts: new Date().toISOString(), delta: '续流' }))
  expect(screen.getByLabelText('10 秒')).toBeTruthy()
  act(() => apply({ type: 'run.finished', runId: 'run', seq: 4, ts: new Date().toISOString(), status: 'succeeded' }))
  expect(screen.getByLabelText('10 秒')).toBeTruthy()
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(30000))
  expect(screen.getByLabelText('10 秒')).toBeTruthy()
})

it('ticks from the real start, then freezes and releases the clock on termination', () => {
  const { rerender } = render(<ProcessDuration timing={timing} />)
  expect(document.querySelector('[data-process-duration]')?.textContent).toBe('已处理 5 秒')
  act(() => vi.advanceTimersByTime(60000))
  expect(document.querySelector('[data-process-duration]')?.textContent).toBe('已处理 1 分钟 5 秒')
  rerender(<ProcessDuration timing={{ ...timing, activeSince: null, elapsedMs: 65000, status: 'finished' }} />)
  expect(document.querySelector('[data-process-duration]')?.textContent).toBe('用时 1 分钟 5 秒')
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(10000))
  expect(document.querySelector('[data-process-duration]')?.textContent).toBe('用时 1 分钟 5 秒')
})

it('shares a single clock among current summaries and gives historical messages none', () => {
  const { unmount } = render(<>
    {Array.from({ length: 100 }, (_, i) => <ProcessDuration key={i} timing={{ ...timing, activeSince: null, elapsedMs: 5000, status: 'finished' }} />)}
    <ProcessDuration timing={timing} /><ProcessDuration timing={timing} />
  </>)
  expect(vi.getTimerCount()).toBe(1)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('restores the same elapsed time after leaving and reentering a session', () => {
  const first = render(<ProcessDuration timing={timing} />)
  first.unmount()
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(120000))
  const second = render(<ProcessDuration timing={{ ...timing, activeSince: null, elapsedMs: 10000, status: 'paused' }} />)
  expect(document.querySelector('[data-process-duration]')?.textContent).toBe('已暂停 · 用时 10 秒')
  second.unmount()
  render(<ProcessDuration timing={timing} />)
  expect(document.querySelector('[data-process-duration]')?.textContent).toBe('已处理 2 分钟 5 秒')
})

it('shows unknown without ticking for incomplete historical evidence', () => {
  render(<ProcessDuration timing={{ elapsedMs: null, activeSince: null, status: 'unknown', lastSeq: 0 }} />)
  expect(document.querySelector('[data-process-duration]')?.textContent).toBe('用时 未知')
  expect(vi.getTimerCount()).toBe(0)
})

it('retains the summary toggle, arrow and collapsed process content', () => {
  function Fixture() {
    const [expanded, setExpanded] = useState(false)
    return <AgentMessageParts parts={[
      { type: 'tool-call', callId: 'read', toolName: 'chapter_read', title: '读取章节', status: 'success' },
      { type: 'text', text: '保留最终回复' },
    ]} streaming={false} runActive={false} blockId="block" summaryCount={1}
      summaryTiming={{ ...timing, activeSince: null, elapsedMs: 152000, status: 'finished' }}
      summaryExpanded={expanded} onToggleSummary={() => setExpanded(value => !value)} />
  }
  const { container } = render(<Fixture />)
  const summary = screen.getByRole('button', { name: '查看 1 项操作' })
  expect(summary.textContent).toBe('用时 2 分钟 32 秒')
  expect(summary.getAttribute('aria-expanded')).toBe('false')
  expect(summary.querySelector('svg')).toBeTruthy()
  expect(container.querySelector('[data-agent-call-id="read"]')).toBeNull()
  expect(screen.getByText('保留最终回复')).toBeTruthy()
  fireEvent.click(summary)
  expect(summary.getAttribute('aria-expanded')).toBe('true')
  expect(container.querySelector('[data-agent-call-id="read"]')).toBeTruthy()
  fireEvent.click(summary)
  expect(summary.getAttribute('aria-expanded')).toBe('false')
})

it('updates both user and assistant labels at midnight and across New Year with one calendar timer', () => {
  vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59))
  const value = new Date(2026, 11, 31, 23, 59).toISOString()
  render(<>
    <UserMessageActions createdAt={value} visible={false} copied={false} disabled={false} onCopy={vi.fn()} onDelete={vi.fn()} onRollback={vi.fn()} />
    <MessageTime value={value} label="完成时间" />
  </>)
  expect(screen.getAllByText('23:59')).toHaveLength(2)
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getAllByText('2026/12/31/23:59')).toHaveLength(2)
  expect(screen.getByRole('group').className).toContain('group-hover/message:opacity-100')
})

it('updates today to month/day after an idle midnight and cleans up on unmount', () => {
  vi.setSystemTime(new Date(2026, 9, 18, 23, 59, 59))
  const { unmount } = render(<MessageTime value={new Date(2026, 9, 18, 15, 24).toISOString()} label="完成时间" />)
  expect(screen.getByText('15:24')).toBeTruthy()
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByText('10/18/15:24')).toBeTruthy()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})


it('animates preparation without a clock until the first response and preserves unknown history', () => {
  const unknown: AgentRunTiming = { elapsedMs: null, activeSince: null, status: 'unknown', lastSeq: 0 }
  const { container, rerender } = render(<ProcessDuration timing={unknown} active />)
  expect(screen.getByRole('status').textContent).toBe('正在准备中...')
  expect(screen.getByRole('status').className).toContain('agent-processing-shimmer')
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(10000))
  expect(screen.getByRole('status').textContent).toBe('正在准备中...')
  expect(unknown.elapsedMs).toBeNull()
  vi.setSystemTime(new Date('2026-10-18T00:00:03Z'))
  rerender(<ProcessDuration timing={{ ...timing, elapsedMs: 56000 }} />)
  expect(screen.getByLabelText('59 秒')).toBeTruthy()
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByLabelText('1 分钟 0 秒')).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
  expect(container.querySelectorAll('.tabular-nums').length).toBeGreaterThan(1)
  rerender(<ProcessDuration timing={unknown} />)
  expect(screen.getByText('未知')).toBeTruthy()
})

it.each([
  [8, '8 秒'], [59, '59 秒'], [60, '1 分钟 0 秒'], [66, '1 分钟 6 秒'],
  [3599, '59 分钟 59 秒'], [3600, '1 小时 0 分钟 0 秒'], [3726, '1 小时 2 分钟 6 秒'],
])('uses the same compact unit layout for running and finished %s seconds', (seconds, label) => {
  const { container, rerender } = render(<ProcessDuration timing={{ elapsedMs: Number(seconds) * 1000, activeSince: new Date().toISOString(), status: 'running', lastSeq: 1 }} />)
  expect(screen.getByLabelText(String(label))).toBeTruthy()
  expect(container.textContent).toBe(`已处理 ${label}`)
  expect(container.querySelector('[class*="6ch"]')).toBeNull()
  const digits = container.querySelectorAll('[class*="2ch"]')
  expect(digits.length).toBe(String(label).split(' ').length / 2)
  for (const digit of digits) expect(digit.className).toContain('tabular-nums')
  rerender(<ProcessDuration timing={{ elapsedMs: Number(seconds) * 1000, activeSince: null, status: 'finished', lastSeq: 2 }} />)
  expect(screen.getByLabelText(String(label))).toBeTruthy()
  expect(container.textContent).toBe(`用时 ${label}`)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([[59000, '59 秒', '1 分钟 0 秒'], [3599000, '59 分钟 59 秒', '1 小时 0 分钟 0 秒']])('carries %s across unit boundaries without changing existing digit slots', (elapsedMs, before, after) => {
  const { container } = render(<ProcessDuration timing={{ elapsedMs: Number(elapsedMs), activeSince: new Date().toISOString(), status: 'running', lastSeq: 1 }} />)
  const secondsSlot = Array.from(container.querySelectorAll('[class*="2ch"]')).at(-1)!
  expect(screen.getByLabelText(String(before))).toBeTruthy()
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByLabelText(String(after))).toBeTruthy()
  expect(container.querySelectorAll('[class*="2ch"]')[Number(elapsedMs) < 60000 ? 1 : 2]).toBe(secondsSlot)
})
