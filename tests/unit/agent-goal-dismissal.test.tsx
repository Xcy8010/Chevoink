// @vitest-environment jsdom
import { StrictMode, useState } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentGoalSnapshot } from '../../shared/contracts/agent-goal.js'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'
import { AgentGoalBar } from '../../src/features/studio/agent/components/AgentGoalBar'
import { AgentComposer } from '../../src/features/studio/agent/components/AgentComposer'
import { GoalEditorDialog } from '../../src/features/studio/agent/components/GoalEditorDialog'
import { openGoalEntry } from '../../src/features/studio/agent/goal-entry'
import { selectAgentActivityRunActive, selectAgentGoalView, selectAgentPanelPhase } from '../../src/features/studio/agent/goal-selectors'
import { useGoalBarVisibility } from '../../src/features/studio/agent/useGoalBarVisibility'

vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ info: vi.fn() }) }))
vi.mock('../../src/features/studio/agent/hooks/useVoiceInput', () => ({ useVoiceInput: () => ({ state: 'idle', disabled: false, modelReady: true, start: vi.fn(), cancel: vi.fn(), removeModel: vi.fn() }) }))
vi.mock('../../src/features/studio/agent/agentApi', () => ({ fetchAgentSubtasks: vi.fn().mockResolvedValue({ items: [] }), uploadAgentAttachment: vi.fn() }))

const completed: AgentGoalSnapshot = {
  id: 'goal-1', sessionId: 'session-a', novelId: 'novel-1', objective: '完成前三章', revision: 1, pendingRevision: null,
  status: 'completed', phase: 'idle', stateVersion: 3, currentRunId: 'run-1', reasonCode: null,
  tokenLimit: '50000', tokensUsed: '1200', tokensReserved: '0', creditsUsedMicros: '3000', activeTimeMs: '120000', activeTimeLimitMs: '3600000',
  activeSince: null, serverTime: '2026-10-05T00:02:00.000Z', createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:02:00.000Z', finishedAt: '2026-10-05T00:02:00.000Z',
}
const cancel = vi.fn()
const submit = vi.fn().mockResolvedValue(undefined)
const send = vi.fn()
const noop = () => {}

/** The panel's real store, scoped selectors, visibility hook and goal actions. */
function Fixture({ userId = 'account-a', sessionId = 'session-a', composer = false }: { userId?: string; sessionId?: string; composer?: boolean }) {
  const goal = useAgentStore(state => state.goal)
  const goalSessionId = useAgentStore(state => state.goalSessionId)
  const view = selectAgentGoalView({ goal, goalSessionId, sessionId, runId: 'run-1', phase: 'running', runGoalId: 'goal-1' })
  const bar = useGoalBarVisibility(userId, sessionId, view.goal)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const openEntry = (source: 'menu' | 'command' = 'menu') => openGoalEntry(goal, !bar.visible, source, () => setDetailsOpen(true), () => useAgentStore.getState().setGoalMode(true))
  return <>
    {view.goal && bar.visible ? <AgentGoalBar goal={view.goal} busy={false} onEdit={noop} onPause={noop} onResume={noop} onCancel={cancel} onExpand={() => setDetailsOpen(true)} onDismiss={bar.dismiss} /> : null}
    <output aria-label="运行阶段">{selectAgentPanelPhase(view, 'running')}</output>
    <output aria-label="活动状态">{String(selectAgentActivityRunActive(view, 'running'))}</output>
    {composer ? <AgentComposer novelId="novel-1" voiceScopeKey="dismissal-entry" running={false} onSend={send} onStop={noop} creativeFreedom="balanced" onCreativeFreedomChange={noop} qualityMode="premium" modelTier="speed" modelOptions={[]} onModelTierChange={noop} customModels={[]} customModelId={null} onCustomModelChange={noop} reasoningSelections={{}} onReasoningEffortChange={noop} onOpenModelSettings={noop} referenceOptions={[]} goalCreationEnabled goalActive={Boolean(view.goal && !view.terminal)} onGoalOpen={openEntry} onGoalCommand={action => { if (action === 'edit') openEntry('command') }} onGoalSubmit={submit} /> : null}
    <GoalEditorDialog open={detailsOpen} goal={goal} busy={false} onClose={() => setDetailsOpen(false)} onSave={noop} />
  </>
}

function restoreGoal(goal = completed, sequence = 0) {
  act(() => useAgentStore.getState().setGoalSnapshot(goal, goal.sessionId, sequence))
}

beforeEach(() => {
  window.localStorage.clear()
  cancel.mockClear()
  submit.mockClear()
  send.mockClear()
  useAgentStore.setState({ goal: null, goalSessionId: null, goalEventSequence: 0, goalMode: false, composerDraft: '', composerReferences: [], composerAttachments: [], composerUploading: 0, composerSkillIds: [], composerSubagent: null })
  restoreGoal()
})
afterEach(() => {
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })))
  cleanup()
  vi.restoreAllMocks()
  useAgentStore.setState({ goal: null, goalSessionId: null, goalEventSequence: 0, goalMode: false })
})

function enterDraft(text: string) {
  const editor = screen.getByRole('textbox', { name: 'Agent 提示词' })
  editor.textContent = text
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
  fireEvent.input(editor)
  return editor
}

function chooseGoalMenu() {
  fireEvent.click(screen.getByLabelText('添加内容'))
  fireEvent.click(within(screen.getByLabelText('添加内容').parentElement!).getByRole('button', { name: '目标', hidden: true }))
}

it('starts a new goal from the real composer menu after X while retaining the completed snapshot and ownership', async () => {
  render(<Fixture composer />)
  fireEvent.click(screen.getByRole('button', { name: '收起已完成目标' }))
  chooseGoalMenu()
  expect(useAgentStore.getState().goalMode).toBe(true)
  expect(screen.getByRole('button', { name: '退出目标模式' })).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: '编辑目标' })).toBeNull()
  expect(useAgentStore.getState().goal).toEqual(completed)
  expect(screen.getByLabelText('运行阶段').textContent).toBe('succeeded')
  expect(screen.getByLabelText('活动状态').textContent).toBe('false')
  fireEvent.keyDown(enterDraft('完成新的第四章'), { key: 'Enter' })
  await waitFor(() => expect(submit).toHaveBeenCalledWith('完成新的第四章', [], 'balanced', 'premium', []))
  expect(send).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
  expect(useAgentStore.getState().goal).toEqual(completed)
})

it('keeps a visible completed goal menu and the bar expansion pointed at its details', () => {
  render(<Fixture composer />)
  chooseGoalMenu()
  expect(screen.getByRole('dialog', { name: '编辑目标' })).toBeTruthy()
  expect((screen.getByRole('textbox', { name: '目标' }) as HTMLTextAreaElement).disabled).toBe(true)
  expect(useAgentStore.getState().goalMode).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '关闭目标编辑' }))
  fireEvent.click(screen.getByRole('button', { name: '展开目标详情' }))
  expect(screen.getByRole('dialog', { name: '编辑目标' })).toBeTruthy()
  expect(useAgentStore.getState().goal).toEqual(completed)
})

it('preserves /goal edit details after X rather than enabling a new draft', async () => {
  render(<Fixture composer />)
  fireEvent.click(screen.getByRole('button', { name: '收起已完成目标' }))
  fireEvent.keyDown(enterDraft('/goal edit'), { key: 'Enter' })
  expect(await screen.findByRole('dialog', { name: '编辑目标' })).toBeTruthy()
  expect((screen.getByRole('textbox', { name: '目标' }) as HTMLTextAreaElement).disabled).toBe(true)
  expect(useAgentStore.getState().goalMode).toBe(false)
  expect(submit).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
  expect(useAgentStore.getState().goal).toEqual(completed)
})

it('persists X dismissal through refresh/remount and replay without clearing the snapshot or terminal ownership', () => {
  const view = render(<Fixture />, { wrapper: StrictMode })
  fireEvent.click(screen.getByRole('button', { name: '收起已完成目标' }))
  expect(screen.queryByRole('region', { name: '目标条' })).toBeNull()
  expect(useAgentStore.getState().goal).toEqual(completed)
  expect(useAgentStore.getState().goalSessionId).toBe('session-a')
  expect(cancel).not.toHaveBeenCalled()
  expect(screen.getByLabelText('运行阶段').textContent).toBe('succeeded')
  expect(screen.getByLabelText('活动状态').textContent).toBe('false')

  const savedKey = Object.keys(window.localStorage).find(key => key.startsWith('chevoink:completed-goal-dismissed:'))!
  expect(JSON.parse(savedKey.slice(savedKey.indexOf('[')))).toEqual(['account-a', 'session-a', 'goal-1', 1])
  expect(window.localStorage.getItem(savedKey)).toBe('1')
  restoreGoal({ ...completed }, 1)
  restoreGoal({ ...completed, stateVersion: 4 }, 2)
  restoreGoal(completed) // Late fetch must not revive or replace the newer snapshot.
  view.rerender(<Fixture />)
  expect(screen.queryByRole('region', { name: '目标条' })).toBeNull()
  expect(useAgentStore.getState().goal?.stateVersion).toBe(4)

  view.unmount()
  useAgentStore.setState({ goal: null, goalSessionId: null, goalEventSequence: 0 })
  restoreGoal() // A fresh page restores the authoritative goal independently.
  render(<Fixture />, { wrapper: StrictMode })
  expect(screen.queryByRole('region', { name: '目标条' })).toBeNull()
  expect(useAgentStore.getState().goal).toEqual(completed)
  expect(screen.getByLabelText('活动状态').textContent).toBe('false')
})

it('restores A after session and account switches without persisting the previous dismissal into B', () => {
  const view = render(<Fixture />)
  fireEvent.click(screen.getByRole('button', { name: '收起已完成目标' }))
  view.rerender(<Fixture sessionId="session-b" />)
  expect(screen.queryByRole('region', { name: '目标条' })).toBeNull() // A snapshot is still in flight.
  act(() => useAgentStore.getState().setGoalSnapshot(null, 'session-b'))
  restoreGoal({ ...completed, sessionId: 'session-b' })
  expect(screen.getByRole('region', { name: '目标条' })).toBeTruthy()
  view.rerender(<Fixture />)
  act(() => useAgentStore.getState().setGoalSnapshot(null, 'session-a'))
  restoreGoal()
  expect(screen.queryByRole('region', { name: '目标条' })).toBeNull()
  view.rerender(<Fixture userId="account-b" />)
  expect(screen.getByRole('region', { name: '目标条' })).toBeTruthy()
  view.rerender(<Fixture />)
  expect(screen.queryByRole('region', { name: '目标条' })).toBeNull()
  expect(Object.keys(window.localStorage).filter(key => key.startsWith('chevoink:completed-goal-dismissed:'))).toHaveLength(1)
})

it('shows a new revision and a new goal while preserving the old completed dismissal', () => {
  render(<Fixture />)
  fireEvent.click(screen.getByRole('button', { name: '收起已完成目标' }))
  restoreGoal({ ...completed, revision: 2, stateVersion: 4 }, 1)
  expect(screen.getByRole('region', { name: '目标条' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '收起已完成目标' }))
  restoreGoal({ ...completed, id: 'goal-2', revision: 1, stateVersion: 1, createdAt: '2026-10-05T00:03:00.000Z' }, 2)
  expect(screen.getByRole('region', { name: '目标条' })).toBeTruthy()
  expect(useAgentStore.getState().goal?.id).toBe('goal-2')
  expect(cancel).not.toHaveBeenCalled()
})

it.each(['active', 'paused', 'blocked', 'updating', 'cancelled'] as const)('cannot dismiss a %s snapshot even when its completed revision was hidden', status => {
  const hidden = renderHook(() => useGoalBarVisibility('account-a', 'session-a', completed))
  act(() => hidden.result.current.dismiss())
  hidden.unmount()
  const goal = { ...completed, status }
  const hook = renderHook(() => useGoalBarVisibility('account-a', 'session-a', goal))
  expect(hook.result.current.visible).toBe(true)
  act(() => hook.result.current.dismiss())
  expect(hook.result.current.visible).toBe(true)
})

it('does not store a shared anonymous dismissal while authentication is unavailable', () => {
  const hook = renderHook(() => useGoalBarVisibility(undefined, 'session-a', completed))
  act(() => hook.result.current.dismiss())
  expect(hook.result.current.visible).toBe(true)
  expect(Object.keys(window.localStorage).filter(key => key.startsWith('chevoink:completed-goal-dismissed:'))).toHaveLength(0)
})

it.each(['read', 'write', 'both'])('retains a storage %s failure dismissal across remounts and isolates other accounts', failure => {
  if (failure !== 'write') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable') })
  if (failure !== 'read') vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
  const view = render(<Fixture userId="fallback-account" />)
  fireEvent.click(screen.getByRole('button', { name: '收起已完成目标' }))
  expect(screen.queryByRole('region', { name: '目标条' })).toBeNull()
  view.unmount()
  const restored = render(<Fixture userId="fallback-account" />)
  expect(screen.queryByRole('region', { name: '目标条' })).toBeNull()
  restored.rerender(<Fixture userId="other-fallback-account" />)
  expect(screen.getByRole('region', { name: '目标条' })).toBeTruthy()
  restored.rerender(<Fixture userId="fallback-account" />)
  expect(screen.queryByRole('region', { name: '目标条' })).toBeNull()
  expect(useAgentStore.getState().goal).toEqual(completed)
  expect(cancel).not.toHaveBeenCalled()
})

it('updates mounted goal bars when another window changes their exact preference', () => {
  render(<Fixture />)
  const key = 'chevoink:completed-goal-dismissed:v1:' + JSON.stringify(['account-a', 'session-a', 'goal-1', 1])
  act(() => {
    window.localStorage.setItem(key, '1')
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: '1' }))
  })
  expect(screen.queryByRole('region', { name: '目标条' })).toBeNull()
  act(() => {
    window.localStorage.removeItem(key)
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: null }))
  })
  expect(screen.getByRole('region', { name: '目标条' })).toBeTruthy()
})
