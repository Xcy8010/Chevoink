// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProcessDuration } from '../../src/features/studio/agent/components/ProcessDuration'
import { MessageTime, UserMessageActions } from '../../src/features/studio/agent/components/MessageActions'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import type { AgentRunTiming } from '../../shared/contracts/agent-events.js'

const timing: AgentRunTiming = { elapsedMs: 2000, activeSince: '2026-10-18T00:00:00Z', status: 'running', lastSeq: 1 }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T00:00:03Z')) })
afterEach(() => { cleanup(); vi.useRealTimers() })

it('ticks from the real start, then freezes and releases the clock on termination', () => {
  const { rerender } = render(<ProcessDuration timing={timing} />)
  expect(screen.getByText('已处理 5秒')).toBeTruthy()
  act(() => vi.advanceTimersByTime(60000))
  expect(screen.getByText('已处理 1分钟5秒')).toBeTruthy()
  rerender(<ProcessDuration timing={{ ...timing, activeSince: null, elapsedMs: 65000, status: 'finished' }} />)
  expect(screen.getByText('用时 1分钟5秒')).toBeTruthy()
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(10000))
  expect(screen.getByText('用时 1分钟5秒')).toBeTruthy()
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
  expect(screen.getByText('已暂停 · 用时 10秒')).toBeTruthy()
  second.unmount()
  render(<ProcessDuration timing={timing} />)
  expect(screen.getByText('已处理 2分钟5秒')).toBeTruthy()
})

it('shows unknown without ticking for incomplete historical evidence', () => {
  render(<ProcessDuration timing={{ elapsedMs: null, activeSince: null, status: 'unknown', lastSeq: 0 }} />)
  expect(screen.getByText('用时 未知')).toBeTruthy()
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
  expect(summary.textContent).toBe('用时 2分钟32秒')
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
