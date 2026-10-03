// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import { selectAgentActivityRunActive, selectAgentGoalView, selectAgentPanelPhase } from '../../src/features/studio/agent/goal-selectors'
import { useMessageBlockExpansion } from '../../src/features/studio/agent/components/use-message-block-expansion'
import { projectMessages, shouldRenderAuthorMessage } from '../../src/features/studio/agent/lib/message-projection'
import { ProcessingHint } from '../../src/features/studio/agent/components/ProcessingHint'
import type { AgentGoalSnapshot, AgentMessagePart, AgentUIMessage } from '../../shared/contracts/index.js'
import type { AgentRunPhase } from '../../src/features/studio/agent/agentStore'
import { useMemo } from 'react'

afterEach(cleanup)
const parts: AgentMessagePart[] = [
  { type: 'reasoning', text: '执行中的思考' },
  { type: 'tool-call', callId: 'check', toolName: 'quality_analyze', title: '质量检查', status: 'failed', summary: '检查已中断' },
  { type: 'text', text: '检查前的执行记录' },
]

const message = (id: string, runId: string, goalId: string | null = 'g'): AgentUIMessage => ({
  id, runId, role: 'assistant', goalId, parts: parts.map(part => part.type === 'text' ? { ...part, text: `${id}执行记录` }
    : part.type === 'tool-call' ? { ...part, title: `${id}检查`, callId: id } : part), createdAt: '2026-10-01T00:00:00Z',
})
const initialMessages = [message('a1', 'r1')]
const resumedMessages: AgentUIMessage[] = [
  ...initialMessages,
  { id: 'resume', runId: 'r2', goalId: 'g', goalContinuation: true, role: 'user', parts: [{ type: 'text', text: '系统续跑记录' }], createdAt: '2026-10-01T00:01:00Z' },
  message('a2', 'r2'),
]

/** Uses the panel's real projection, expansion controller and parts renderer. */
function Fixture({ status, messages = initialMessages, sessionId = 's', goalId = 'g', runId = 'r1', runPhase = 'running', runGoalId = goalId, revision = 1, objective = '原目标' }: {
  status: AgentGoalSnapshot['status']; messages?: AgentUIMessage[]; sessionId?: string; goalId?: string
  runId?: string | null; runPhase?: AgentRunPhase; runGoalId?: string | null
  revision?: number; objective?: string
}) {
  const goal = { id: goalId, sessionId, status, revision, objective, phase: status === 'active' ? 'executing' : 'idle', currentRunId: runId ?? 'r2' } as AgentGoalSnapshot
  const view = selectAgentGoalView({ goal, goalSessionId: sessionId, sessionId, runId, resumeableRunId: runId ? null : 'r2', runGoalId, phase: runPhase })
  const phase = selectAgentPanelPhase(view, runPhase)
  const active = selectAgentActivityRunActive(view, runPhase)
  const { blockInfoById } = useMemo(() => projectMessages(messages), [messages])
  const { isExpanded, toggle } = useMessageBlockExpansion({ sessionId, messages, blocks: blockInfoById, goalView: view, phase, runId: runId ?? 'r2' })
  return <>
    {messages.map(item => {
      const block = blockInfoById.get(item.id)
      const expanded = isExpanded(block, item.runId)
      if (item.role === 'user') return shouldRenderAuthorMessage(item) ? <div key={item.id}>{item.parts.map(part => part.type === 'text' ? part.text : '').join('')}</div> : null
      return <AgentMessageParts key={item.id} parts={item.parts} streaming={false} runActive={active && item.runId === runId}
        blockId={block?.firstId} summaryCount={item.id === block?.firstId ? block.ops : undefined}
        summaryExpanded={expanded} onToggleSummary={toggle} textCollapsible={item.id !== block?.lastId && (block?.ops ?? 0) > 0} />
    })}
    {active ? <ProcessingHint visible /> : null}
  </>
}

it.each(['paused', 'usage_limited', 'budget_limited', 'blocked', 'cancelled'] as const)('running -> %s keeps operations visible and immediately unmounts stale processing feedback', status => {
  const ui = render(<Fixture status="active" />)
  expect(screen.getByText('正在处理...')).toBeTruthy()
  ui.rerender(<Fixture status={status} />)
  expect(screen.queryByText('正在处理...')).toBeNull()
  expect(screen.getByText('a1检查')).toBeTruthy()
  expect(screen.getByText('a1执行记录')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '已处理 2 个操作' }))
  expect(screen.queryByText('a1检查')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '已处理 2 个操作' }))
  expect(screen.getByText('a1检查')).toBeTruthy()
})

it('continues folding completed work by default', () => {
  render(<Fixture status="completed" />)
  expect(screen.queryByText('a1检查')).toBeNull()
  expect(screen.queryByText('正在处理...')).toBeNull()
})

it('pause -> resume -> completed retains one execution process without presenting internal prompts even during manual expansion', () => {
  const ui = render(<Fixture status="paused" />)
  fireEvent.click(screen.getByRole('button', { name: '已处理 2 个操作' }))
  fireEvent.click(screen.getByRole('button', { name: '已处理 2 个操作' }))
  ui.rerender(<Fixture status="active" messages={resumedMessages} runId="r2" />)
  expect(screen.getByText('a1检查')).toBeTruthy()
  expect(screen.getByText('a2检查')).toBeTruthy()
  expect(screen.queryByText('系统续跑记录')).toBeNull()
  ui.rerender(<Fixture status="completed" messages={resumedMessages} runId="r2" />)
  expect(screen.getAllByRole('button', { name: '已处理 4 个操作' })).toHaveLength(1)
  expect(screen.queryByText('a1检查')).toBeNull()
  expect(screen.queryByText('a2检查')).toBeNull()
  expect(screen.queryByText('a1执行记录')).toBeNull()
  expect(screen.queryByText('系统续跑记录')).toBeNull()
  expect(screen.getByText('a2执行记录')).toBeTruthy()
  expect(screen.queryByText('正在处理...')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '已处理 4 个操作' }))
  expect(screen.getByText('a1检查')).toBeTruthy()
  expect(screen.queryByText('系统续跑记录')).toBeNull()
  ui.rerender(<Fixture status="completed" messages={[...resumedMessages]} runId="r2" />)
  expect(screen.getByText('a1检查')).toBeTruthy()
})

it.each(['active', 'paused', 'completed'] as const)('%s goal history preserves author steering and saved progress after an edited revision without a duplicate prompt', status => {
  const messages: AgentUIMessage[] = [
    { id: 'author', runId: 'r1', goalId: 'g', role: 'user', parts: [{ type: 'text', text: '作者原目标' }], createdAt: '2026-10-01T00:00:00Z' },
    ...initialMessages,
    { ...resumedMessages[1], parts: [{ type: 'text', text: '内部重复原目标' }] },
    { id: 'steering', runId: 'r2', goalId: 'g', goalContinuation: false, role: 'user', parts: [{ type: 'text', text: '作者真实修改要求' }], createdAt: '2026-10-01T00:01:01Z' },
    message('a2', 'r2'),
  ]
  const before = structuredClone(messages)
  const ui = render(<Fixture status={status} messages={messages} runId="r2" revision={2} objective="作者修订后的目标" />)
  expect(screen.getByText('作者原目标')).toBeTruthy()
  expect(screen.getByText('作者真实修改要求')).toBeTruthy()
  expect(screen.queryByText('内部重复原目标')).toBeNull()
  // The genuine steering boundary keeps its own execution block, and both
  // blocks retain their saved operations when the author opens the history.
  const buttons = screen.getAllByRole('button', { name: '已处理 2 个操作' })
  if (!screen.queryByText('a1检查')) fireEvent.click(buttons[0])
  if (!screen.queryByText('a2检查')) fireEvent.click(buttons[1])
  expect(screen.getByText('a1检查')).toBeTruthy()
  expect(screen.getByText('a2检查')).toBeTruthy()
  expect(screen.queryByText('内部重复原目标')).toBeNull()
  ui.rerender(<Fixture status={status} messages={[...messages]} runId={null} runPhase="idle" runGoalId={null} revision={2} objective="作者修订后的目标" />)
  expect(screen.getByText('作者原目标')).toBeTruthy()
  expect(screen.getByText('作者真实修改要求')).toBeTruthy()
  expect(screen.queryByText('内部重复原目标')).toBeNull()
  expect(messages).toEqual(before)
})

it('a successful run cannot fold an unfinished goal', () => {
  const ui = render(<Fixture status="active" runPhase="succeeded" />)
  expect(screen.getByText('a1检查')).toBeTruthy()
  expect(screen.queryByText('正在处理...')).toBeNull()
  ui.rerender(<Fixture status="usage_limited" runPhase="failed" />)
  expect(screen.getByText('a1检查')).toBeTruthy()
})

it.each(['paused', 'usage_limited', 'budget_limited', 'cancelled', 'completed'] as const)('refresh restores unified %s history without a live run', status => {
  render(<Fixture status={status} messages={resumedMessages} runId={null} runPhase="idle" runGoalId={null} />)
  expect(screen.getAllByRole('button', { name: '已处理 4 个操作' })).toHaveLength(1)
  expect(Boolean(screen.queryByText('a1检查'))).toBe(status !== 'completed')
  expect(screen.queryByText('正在处理...')).toBeNull()
})

it('completion and A -> B -> A preserve manually expanded history and isolate duplicate block ids by session', () => {
  const messages = [message('old', 'ordinary', null), ...initialMessages]
  const ui = render(<Fixture status="paused" messages={messages} />)
  fireEvent.click(screen.getAllByRole('button', { name: '已处理 2 个操作' })[0])
  ui.rerender(<Fixture status="completed" messages={messages} />)
  expect(screen.getByText('old检查')).toBeTruthy()
  expect(screen.queryByText('a1检查')).toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: '已处理 2 个操作' })[1])
  ui.rerender(<Fixture status="completed" sessionId="B" messages={messages} />)
  expect(screen.queryByText('old检查')).toBeNull()
  expect(screen.queryByText('a1检查')).toBeNull()
  ui.rerender(<Fixture status="completed" messages={messages} />)
  expect(screen.getByText('old检查')).toBeTruthy()
  expect(screen.getByText('a1检查')).toBeTruthy()
})

it('new goals and later ordinary runs retain their own boundaries and activity', () => {
  const ui = render(<Fixture status="paused" />)
  ui.rerender(<Fixture status="completed" goalId="new-goal" messages={[...initialMessages, message('next', 'next-run', 'new-goal')]} runId="next-run" />)
  expect(screen.getByText('a1检查')).toBeTruthy()
  expect(screen.queryByText('next检查')).toBeNull()
  ui.rerender(<Fixture status="completed" messages={[...initialMessages, message('ordinary', 'ordinary-run', null)]} runId="ordinary-run" runGoalId={null} />)
  expect(screen.getByText('ordinary检查')).toBeTruthy()
  expect(screen.getByText('正在处理...')).toBeTruthy()
})
