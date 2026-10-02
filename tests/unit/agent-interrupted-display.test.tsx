// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import { keepInterruptedRunExpanded, selectAgentActivityRunActive, selectAgentGoalView, selectAgentPanelPhase } from '../../src/features/studio/agent/goal-selectors'
import { ProcessingHint } from '../../src/features/studio/agent/components/ProcessingHint'
import type { AgentGoalSnapshot, AgentMessagePart } from '../../shared/contracts/index.js'
import { useState } from 'react'

afterEach(cleanup)
const parts: AgentMessagePart[] = [
  { type: 'reasoning', text: '执行中的思考' },
  { type: 'tool-call', callId: 'check', toolName: 'quality_analyze', title: '质量检查', status: 'failed', summary: '检查已中断' },
  { type: 'text', text: '检查前的执行记录' },
]

function Fixture({ status }: { status: AgentGoalSnapshot['status'] }) {
  const goal = { id: 'g', sessionId: 's', status, phase: status === 'active' ? 'executing' : 'idle', currentRunId: 'r' } as AgentGoalSnapshot
  const view = selectAgentGoalView({ goal, goalSessionId: 's', sessionId: 's', runId: 'r', phase: 'running' })
  const phase = selectAgentPanelPhase(view, 'running')
  const active = selectAgentActivityRunActive(view, 'running')
  const [expanded, setExpanded] = useState<boolean>()
  const showExpanded = expanded ?? keepInterruptedRunExpanded(phase, 'r', 'r')
  return <>
    <AgentMessageParts parts={parts} streaming={false} runActive={active} blockId="b" summaryCount={2}
      summaryExpanded={showExpanded} onToggleSummary={() => setExpanded(!showExpanded)} textCollapsible />
    {active ? <ProcessingHint visible /> : null}
  </>
}

it.each(['paused', 'usage_limited', 'budget_limited'] as const)('keeps %s operations visible and immediately unmounts stale processing feedback', status => {
  const ui = render(<Fixture status="active" />)
  expect(screen.getByText('正在处理...')).toBeTruthy()
  ui.rerender(<Fixture status={status} />)
  expect(screen.queryByText('正在处理...')).toBeNull()
  expect(screen.getByText('质量检查')).toBeTruthy()
  expect(screen.getByText('检查前的执行记录')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '已处理 2 个操作' }))
  expect(screen.queryByText('质量检查')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '已处理 2 个操作' }))
  expect(screen.getByText('质量检查')).toBeTruthy()
})

it('continues folding completed work by default', () => {
  render(<Fixture status="completed" />)
  expect(screen.queryByText('质量检查')).toBeNull()
  expect(screen.queryByText('正在处理...')).toBeNull()
})
