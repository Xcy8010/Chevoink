// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { AgentGoalBar } from '../../src/features/studio/agent/components/AgentGoalBar'
import { GoalEditorDialog } from '../../src/features/studio/agent/components/GoalEditorDialog'
import { formatCreditsMicros, formatGoalReason } from '../../src/features/studio/agent/components/goal-formatters'
import { GoalModeChip } from '../../src/features/studio/agent/components/GoalModeChip'
import type { AgentGoalDetail, AgentGoalSnapshot } from '../../shared/contracts/agent-goal.js'
import { activateComposerDraft, promoteComposerDraft } from '../../src/features/studio/agent/composer-drafts'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'
import { buildGoalResumeModel } from '../../src/features/studio/agent/goal-command'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const goal: AgentGoalSnapshot = {
  id: 'goal-1', sessionId: 'session-1', novelId: 'novel-1', objective: '完成第一卷大纲并写好前三章', revision: 1, pendingRevision: null,
  status: 'active', phase: 'executing', stateVersion: 2, currentRunId: 'run-1', reasonCode: null,
  tokenLimit: '50000', tokensUsed: '1200', tokensReserved: '100', creditsUsedMicros: '3000', activeTimeMs: '120000', activeTimeLimitMs: '3600000',
  activeSince: '2026-09-27T00:00:00.000Z', serverTime: '2026-09-27T00:02:00.000Z', createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:02:00.000Z', finishedAt: null,
}

it('toggles the compact draft entry and opens details for an active goal', () => {
  const onOpen = vi.fn(), onCancel = vi.fn()
  const view = render(<GoalModeChip active={false} draft onOpen={onOpen} onCancel={onCancel} busy={false} />)
  fireEvent.click(screen.getByRole('button', { name: '取消目标模式' }))
  expect(onCancel).toHaveBeenCalledOnce()
  expect(onOpen).not.toHaveBeenCalled()
  view.rerender(<GoalModeChip active draft={false} onOpen={onOpen} onCancel={onCancel} busy={false} />)
  expect(screen.queryByRole('button', { name: '打开目标详情' })).toBeNull()
  expect(screen.queryByRole('button', { name: '取消目标模式' })).toBeNull()
  view.rerender(<GoalModeChip active draft onOpen={onOpen} onCancel={onCancel} busy={false} />)
  fireEvent.click(screen.getByRole('button', { name: '打开目标详情' }))
  expect(onOpen).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '取消目标模式' }))
  expect(onCancel).toHaveBeenCalledTimes(2)
  view.rerender(<GoalModeChip active draft onOpen={onOpen} onCancel={onCancel} busy />)
  fireEvent.click(screen.getByRole('button', { name: '取消目标模式' }))
  expect(onCancel).toHaveBeenCalledTimes(2)
})

it('renders goal status and routes bar actions', () => {
  const callbacks = { onEdit: vi.fn(), onPause: vi.fn(), onResume: vi.fn(), onCancel: vi.fn(), onExpand: vi.fn(), onDismiss: vi.fn() }
  const view = render(<AgentGoalBar goal={goal} busy={false} {...callbacks} />)
  expect(screen.getByText('进行中的目标')).toBeTruthy()
  expect(screen.getByText(goal.objective)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '修改目标' }))
  fireEvent.click(screen.getByRole('button', { name: '暂停目标' }))
  fireEvent.click(screen.getByRole('button', { name: '取消目标' }))
  fireEvent.click(screen.getByRole('button', { name: '展开目标详情' }))
  expect(callbacks.onEdit).toHaveBeenCalledOnce()
  expect(callbacks.onPause).toHaveBeenCalledOnce()
  expect(callbacks.onCancel).toHaveBeenCalledOnce()
  expect(callbacks.onExpand).toHaveBeenCalledOnce()
  view.rerender(<AgentGoalBar goal={{ ...goal, status: 'paused', phase: 'idle', activeSince: null }} busy={false} {...callbacks} />)
  fireEvent.click(screen.getByRole('button', { name: '继续目标' }))
  expect(callbacks.onResume).toHaveBeenCalledOnce()
})

it('keeps active duration across snapshots and counts an active waiting interval', () => {
  vi.useFakeTimers()
  const performanceNow = vi.spyOn(performance, 'now').mockReturnValue(1_000)
  const view = render(<AgentGoalBar goal={{ ...goal, activeTimeMs: '0', phase: 'awaiting_input' }} busy={false} onEdit={vi.fn()} onPause={vi.fn()} onResume={vi.fn()} onCancel={vi.fn()} onExpand={vi.fn()} onDismiss={vi.fn()} />)
  expect(screen.getByText('2分00秒')).toBeTruthy()

  performanceNow.mockReturnValue(2_500)
  view.rerender(<AgentGoalBar goal={{ ...goal, activeTimeMs: '0', phase: 'awaiting_input' }} busy={false} onEdit={vi.fn()} onPause={vi.fn()} onResume={vi.fn()} onCancel={vi.fn()} onExpand={vi.fn()} onDismiss={vi.fn()} />)
  expect(screen.getByText('2分01秒')).toBeTruthy()

  performanceNow.mockReturnValue(3_000)
  view.rerender(<AgentGoalBar goal={{ ...goal, activeTimeMs: '0', phase: 'awaiting_input', serverTime: '2026-09-27T00:02:10.000Z' }} busy={false} onEdit={vi.fn()} onPause={vi.fn()} onResume={vi.fn()} onCancel={vi.fn()} onExpand={vi.fn()} onDismiss={vi.fn()} />)
  expect(screen.getByText('2分10秒')).toBeTruthy()
})

it('keeps an edited draft when the save returns a conflict error', () => {
  const onSave = vi.fn()
  const view = render(<GoalEditorDialog open goal={goal} busy={false} onClose={vi.fn()} onSave={onSave} />)
  const editor = screen.getByRole('textbox', { name: '目标' })
  fireEvent.change(editor, { target: { value: '保留这份本地修改' } })
  fireEvent.click(screen.getByRole('button', { name: '保存目标' }))
  expect(onSave).toHaveBeenCalledWith('保留这份本地修改', expect.objectContaining({ revision: 1, stateVersion: 2 }))
  view.rerender(<GoalEditorDialog open goal={{ ...goal, objective: '另一窗口已保存的内容', revision: 2, stateVersion: 4 }} busy={false} error="目标已在另一处更新。" onClose={vi.fn()} onSave={onSave} />)
  expect((screen.getByRole('textbox', { name: '目标' }) as HTMLTextAreaElement).value).toBe('保留这份本地修改')
  expect(screen.getByRole('alert').textContent).toContain('目标已在另一处更新。')
  fireEvent.click(screen.getByRole('button', { name: '保存目标' }))
  expect(onSave).toHaveBeenLastCalledWith('保留这份本地修改', expect.objectContaining({ revision: 1, stateVersion: 2 }))
  fireEvent.click(screen.getByRole('button', { name: '读取新版并重新编辑' }))
  expect((screen.getByRole('textbox', { name: '目标' }) as HTMLTextAreaElement).value).toBe('另一窗口已保存的内容')
  fireEvent.change(screen.getByRole('textbox', { name: '目标' }), { target: { value: '基于新版重新修改' } })
  fireEvent.click(screen.getByRole('button', { name: '保存目标' }))
  expect(onSave).toHaveBeenLastCalledWith('基于新版重新修改', expect.objectContaining({ revision: 2, stateVersion: 4 }))
})

it('validates Unicode code points without truncating the draft', () => {
  const onSave = vi.fn()
  render(<GoalEditorDialog open goal={goal} busy={false} onClose={vi.fn()} onSave={onSave} />)
  const editor = screen.getByRole('textbox', { name: '目标' }) as HTMLTextAreaElement
  expect(editor.hasAttribute('maxlength')).toBe(false)
  const valid = '𠀀'.repeat(12_000)
  fireEvent.change(editor, { target: { value: valid } })
  fireEvent.click(screen.getByRole('button', { name: '保存目标' }))
  expect(onSave).toHaveBeenCalledWith(valid, expect.objectContaining({ id: goal.id }))
  onSave.mockClear()
  const oversized = `${valid}🌟`
  fireEvent.change(editor, { target: { value: oversized } })
  fireEvent.click(screen.getByRole('button', { name: '保存目标' }))
  expect(onSave).not.toHaveBeenCalled()
  expect(editor.value).toBe(oversized)
  expect(screen.getByRole('alert').textContent).toContain('12,000')
})

it('waits for a pending revision before accepting another edit', () => {
  const onSave = vi.fn()
  const view = render(<GoalEditorDialog open goal={goal} busy={false} onClose={vi.fn()} onSave={onSave} />)
  fireEvent.change(screen.getByRole('textbox', { name: '目标' }), { target: { value: '本地草稿' } })
  const pending = { ...goal, objective: '远端更新', status: 'updating' as const, pendingRevision: 2, stateVersion: 3 }
  view.rerender(<GoalEditorDialog open goal={pending} busy={false} onClose={vi.fn()} onSave={onSave} />)
  expect((screen.getByRole('button', { name: '保存目标' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '读取新版并重新编辑' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('textbox', { name: '目标' }) as HTMLTextAreaElement).value).toBe('本地草稿')
  view.rerender(<GoalEditorDialog open goal={{ ...pending, status: 'paused', pendingRevision: null, revision: 2, stateVersion: 4 }} busy={false} onClose={vi.fn()} onSave={onSave} />)
  fireEvent.click(screen.getByRole('button', { name: '读取新版并重新编辑' }))
  fireEvent.click(screen.getByRole('button', { name: '保存目标' }))
  expect(onSave).toHaveBeenCalledWith('远端更新', expect.objectContaining({ revision: 2, stateVersion: 4 }))
})

it('starts from the current snapshot after closing or switching goals', () => {
  const props = { busy: false, onClose: vi.fn(), onSave: vi.fn() }
  const view = render(<GoalEditorDialog open goal={goal} {...props} />)
  fireEvent.change(screen.getByRole('textbox', { name: '目标' }), { target: { value: '未保存草稿' } })
  view.rerender(<GoalEditorDialog open={false} goal={goal} {...props} />)
  const updated = { ...goal, objective: '最新目标', revision: 2, stateVersion: 3 }
  view.rerender(<GoalEditorDialog open goal={updated} {...props} />)
  expect((screen.getByRole('textbox', { name: '目标' }) as HTMLTextAreaElement).value).toBe('最新目标')
  fireEvent.click(screen.getByRole('button', { name: '保存目标' }))
  expect(props.onSave).toHaveBeenLastCalledWith('最新目标', expect.objectContaining({ revision: 2, stateVersion: 3 }))
  view.rerender(<GoalEditorDialog open goal={{ ...goal, id: 'other-goal', sessionId: 'other-session', objective: '另一任务' }} {...props} />)
  expect((screen.getByRole('textbox', { name: '目标' }) as HTMLTextAreaElement).value).toBe('另一任务')
})

it('shows usage, evidence and revision history in goal details', () => {
  const detail: AgentGoalDetail = {
    goal,
    revisions: [{ revision: 1, objective: goal.objective, createdAt: goal.createdAt }],
    evidence: [{ criterionId: 'author-objective', description: '前三章已完成', kind: 'objective', targetId: null, status: 'verified', receipt: {}, verifiedAt: goal.updatedAt }],
    nextRevisionCursor: null,
    nextEvidenceCursor: null,
    completion: { progressHash: 'a'.repeat(64), canConfirm: false, needsAuthorVerification: false, blockers: [] },
  }
  render(<GoalEditorDialog open goal={goal} detail={detail} busy={false} onClose={vi.fn()} onSave={vi.fn()} />)
  expect(screen.getByText('1200/50000')).toBeTruthy()
  expect(screen.getByText('0.003')).toBeTruthy()
  expect(screen.getByText('版本历史')).toBeTruthy()
  expect(screen.getByText('前三章已完成')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '确认目标完成' })).toBeNull()
})

it('refreshes goal details and traps focus until the editor closes', () => {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const onLoadDetail = vi.fn()
  const view = render(<GoalEditorDialog open goal={goal} detail={null} busy={false} onLoadDetail={onLoadDetail} onClose={vi.fn()} onSave={vi.fn()} />)
  const dialog = screen.getByRole('dialog')
  expect(dialog.contains(document.activeElement)).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '刷新目标详情' }))
  expect(onLoadDetail).toHaveBeenCalledOnce()

  const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'))
  const first = focusables[0]
  const last = focusables.at(-1)!
  first.focus()
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(last)
  last.focus()
  fireEvent.keyDown(last, { key: 'Tab' })
  expect(document.activeElement).toBe(first)

  view.rerender(<GoalEditorDialog open={false} goal={goal} busy={false} onLoadDetail={onLoadDetail} onClose={vi.fn()} onSave={vi.fn()} />)
  expect(document.activeElement).toBe(trigger)
  trigger.remove()
})

it('formats credit micros exactly and keeps implementation reason codes out of the UI', () => {
  expect(formatCreditsMicros('1000000')).toBe('1')
  expect(formatCreditsMicros('1234567')).toBe('1.234567')
  expect(formatCreditsMicros('3000')).toBe('0.003')
  expect(formatGoalReason('GOAL_SCOPE_DECISION_REQUIRED')).toBe('请明确目标范围')
  expect(formatGoalReason('GOAL_UNKNOWN')).toBe('等待处理')
})

it('shows author confirmation only for a confirmable completion review', () => {
  const onConfirmCompletion = vi.fn()
  const detail: AgentGoalDetail = {
    goal,
    revisions: [],
    evidence: [],
    nextRevisionCursor: null,
    nextEvidenceCursor: null,
    completion: { progressHash: 'b'.repeat(64), canConfirm: true, needsAuthorVerification: true, blockers: [] },
  }
  render(<GoalEditorDialog open goal={goal} detail={detail} busy={false} onClose={vi.fn()} onSave={vi.fn()} onConfirmCompletion={onConfirmCompletion} />)
  fireEvent.click(screen.getByRole('button', { name: '确认目标完成' }))
  expect(onConfirmCompletion).toHaveBeenCalledOnce()
})

it('uses the current effective model when a goal resumes', () => {
  expect(buildGoalResumeModel('basic', 'stale-byok', 'low')).toEqual({ modelTier: 'speed', reasoningEffort: 'low' })
  expect(buildGoalResumeModel('custom', 'byok-current', 'xhigh')).toEqual({ modelTier: 'custom', customModelId: 'byok-current', reasoningEffort: 'xhigh' })
  expect(buildGoalResumeModel('speed', 'stale-byok', 'high')).toEqual({ modelTier: 'speed', reasoningEffort: 'high' })
})

it('keeps goal draft mode in the task scope during local-window promotion', () => {
  activateComposerDraft('goal-draft-a')
  useAgentStore.setState({ composerDraft: '持续完成这一组结果', goalMode: true })
  activateComposerDraft('goal-draft-b')
  expect(useAgentStore.getState().goalMode).toBe(false)
  promoteComposerDraft('goal-draft-a', 'goal-session-a')
  activateComposerDraft('goal-session-a')
  expect(useAgentStore.getState().goalMode).toBe(true)
  expect(useAgentStore.getState().composerDraft).toBe('持续完成这一组结果')
})

it('accepts the first snapshot after switching sessions while rejecting the old stream', () => {
  const store = useAgentStore.getState()
  store.setGoalSnapshot(goal, 'session-1', 5)
  store.setGoalSnapshot(null, 'session-2')
  store.setGoalSnapshot({ ...goal, id: 'goal-2', sessionId: 'session-2', stateVersion: 1 }, 'session-2', 1)
  expect(useAgentStore.getState().goal?.sessionId).toBe('session-2')
  expect(useAgentStore.getState().goalEventSequence).toBe(1)
  store.setGoalSnapshot(null, 'session-2', 0)
  expect(useAgentStore.getState().goal?.sessionId).toBe('session-2')
  store.setGoalSnapshot(goal, 'session-1', 6)
  expect(useAgentStore.getState().goal?.sessionId).toBe('session-2')
  store.setGoalSnapshot(null, 'session-1')
  store.setGoalSnapshot(goal, 'session-1', 7)
  store.setGoalSnapshot({ ...goal, id: 'goal-3', stateVersion: 1 }, 'session-1', 8)
  expect(useAgentStore.getState().goal?.id).toBe('goal-3')
  const newer = { ...goal, id: 'goal-4', stateVersion: 1, createdAt: '2026-09-28T00:00:00.000Z' }
  store.setGoalSnapshot(newer, 'session-1', 9)
  store.setGoalSnapshot(goal, 'session-1', 0)
  store.setGoalSnapshot({ ...goal, id: 'goal-3' }, 'session-1', 10)
  expect(useAgentStore.getState().goal?.id).toBe('goal-4')
  store.setGoalSnapshot({ ...newer, id: 'duplicate-event' }, 'session-1', 9)
  expect(useAgentStore.getState().goal?.id).toBe('goal-4')
  useAgentStore.setState({ goal: null, goalSessionId: null, goalEventSequence: 0 })
})
