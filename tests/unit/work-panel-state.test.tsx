// @vitest-environment jsdom
import { StrictMode, useEffect, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readWorkPanelUi, resolveWorkViewer, useWorkPanelState, writeWorkPanelUi, type WorkPanelUiState } from '../../src/features/studio/components/use-work-panel-state'
import { reconcilePlanSelection, stablePlanId } from '../../src/features/studio/components/work-plan-selection'

beforeEach(() => window.localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function useFixture(scope: string | undefined) {
  const [rightOpen, setRightOpen] = useState(false)
  const [viewer, setViewer] = useState<WorkPanelUiState['viewer']>(null)
  const [inspectorTab, setInspectorTab] = useState<WorkPanelUiState['inspectorTab']>('work')
  const [selectedTreeItemId, setSelectedTreeItemId] = useState<string | null>(null)
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null)
  const state = { rightOpen, viewer, inspectorTab, selectedTreeItemId, selectedChapterId }
  const hydratedScope = useWorkPanelState(scope, state, { setRightOpen, setViewer, setInspectorTab, setSelectedTreeItemId, setSelectedChapterId })
  return { state, hydratedScope, setRightOpen, setViewer, setSelectedTreeItemId, setSelectedChapterId }
}

it('keeps same-novel task panels independent and restores them after remount', () => {
  const a = 'user:novel:a', b = 'user:novel:b'
  writeWorkPanelUi(b, { rightOpen: true, viewer: 'chapter', inspectorTab: 'changes', selectedChapterId: 'chapter-b' })
  const hook = renderHook(({ scope }) => useFixture(scope), { initialProps: { scope: a } })
  expect(hook.result.current.state.rightOpen).toBe(false)
  hook.rerender({ scope: b })
  expect(hook.result.current.state).toMatchObject({ rightOpen: true, viewer: 'chapter', selectedChapterId: 'chapter-b' })
  hook.rerender({ scope: a })
  expect(hook.result.current.state).toMatchObject({ rightOpen: false, viewer: null })
  expect(readWorkPanelUi(b)?.rightOpen).toBe(true)
  act(() => { hook.result.current.setRightOpen(true); hook.result.current.setViewer('document') })
  hook.unmount()
  const restored = renderHook(() => useFixture(a))
  expect(restored.result.current.state).toMatchObject({ rightOpen: true, viewer: 'document' })
})

it('does not persist transient unowned state and tolerates unavailable storage', () => {
  const hook = renderHook(() => useFixture(undefined))
  act(() => hook.result.current.setRightOpen(true))
  expect(localStorage.getItem('chevoink:studio-work-panel-ui')).toBeNull()
  localStorage.setItem('chevoink:studio-work-panel-ui', '{broken')
  expect(readWorkPanelUi('missing')).toBeNull()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
  expect(() => writeWorkPanelUi('a', { rightOpen: false, viewer: null, inspectorTab: 'work' })).not.toThrow()
})

it('does not overwrite a saved layout during StrictMode mount replay', () => {
  writeWorkPanelUi('strict', { rightOpen: true, viewer: 'document', inspectorTab: 'changes' })
  const hook = renderHook(() => useFixture('strict'), { wrapper: StrictMode })
  expect(hook.result.current.state).toMatchObject({ rightOpen: true, viewer: 'document', inspectorTab: 'changes' })
  expect(readWorkPanelUi('strict')).toMatchObject({ rightOpen: true, viewer: 'document' })
})

it('uses the restored tree target as Viewer authority without reopening a closed task panel', () => {
  const a = 'user:novel-a:task-a', b = 'user:novel-b:task-b', closed = 'user:novel-a:closed'
  writeWorkPanelUi(a, { rightOpen: true, viewer: 'document', inspectorTab: 'work', selectedTreeItemId: 'chapter:chapter-seven', selectedChapterId: 'chapter-one' })
  writeWorkPanelUi(b, { rightOpen: true, viewer: 'chapter', inspectorTab: 'work', selectedTreeItemId: 'plan:server-nine', selectedChapterId: 'chapter-nine' })
  writeWorkPanelUi(closed, { rightOpen: true, viewer: null, inspectorTab: 'work', selectedTreeItemId: 'chapter:chapter-three' })
  const hook = renderHook(({ scope }) => useFixture(scope), { initialProps: { scope: a }, wrapper: StrictMode })
  const mode = () => {
    const { viewer, selectedTreeItemId, selectedChapterId } = hook.result.current.state
    return resolveWorkViewer(viewer, selectedTreeItemId, selectedChapterId)
  }
  expect(hook.result.current.state.selectedChapterId).toBe('chapter-seven')
  expect(mode()).toBe('chapter')
  hook.rerender({ scope: b })
  expect(mode()).toBe('document')
  hook.rerender({ scope: closed })
  expect(hook.result.current.state.selectedChapterId).toBe('chapter-three')
  expect(mode()).toBeNull()
  hook.rerender({ scope: a })
  expect(mode()).toBe('chapter')
  expect(hook.result.current.state.selectedChapterId).toBe('chapter-seven')
  expect(resolveWorkViewer('document', null, 'legacy-chapter')).toBe('chapter')
})

it('restores A plan after A → unowned loading → B → unowned loading → A, including delayed plans', () => {
  const a = 'user:novel-a:task-a', b = 'user:novel-b:task-b'
  for (const [scope, id] of [[a, 'a'], [b, 'b']]) {
    writeWorkPanelUi(scope, { rightOpen: true, viewer: 'document', inspectorTab: 'work', selectedTreeItemId: `plan:server-${id}`, selectedChapterId: `old-chapter-${id}` })
  }
  const hook = renderHook(({ scope, ready, id }: {scope: string | undefined; ready: boolean; id: string}) => {
    const fixture = useFixture(scope)
    const { state, hydratedScope, setSelectedTreeItemId } = fixture
    const plans = ready ? [{ id: stablePlanId({ id: `history-${id}`, backendArtifactId: id }), artifactId: `history-${id}` }] : []
    useEffect(() => {
      if (scope && hydratedScope === scope && state.selectedTreeItemId) {
        const next = reconcilePlanSelection(state.selectedTreeItemId, plans, ready)
        if (next !== state.selectedTreeItemId) setSelectedTreeItemId(next)
      }
    })
    return { ...fixture, document: plans.find(plan => `plan:${plan.id}` === state.selectedTreeItemId) }
  }, { initialProps: {scope: a as string | undefined, ready: true, id: 'a'}, wrapper: StrictMode })
  for (const [scope, id] of [[b, 'b'], [a, 'a']]) {
    hook.rerender({scope: undefined, ready: false, id})
    act(() => hook.result.current.setSelectedTreeItemId(null))
    hook.rerender({scope, ready: false, id})
    expect(hook.result.current.state).toMatchObject({viewer: 'document', selectedTreeItemId: `plan:server-${id}`})
    expect(readWorkPanelUi(scope)?.selectedTreeItemId).toBe(`plan:server-${id}`)
    hook.rerender({scope, ready: true, id})
    expect(hook.result.current.document?.id).toBe(`server-${id}`)
  }
})

it('resets an unowned hydration epoch even when the same task returns', () => {
  writeWorkPanelUi('a', {rightOpen: true, viewer: 'document', inspectorTab: 'work', selectedTreeItemId: 'plan:a'})
  const hook = renderHook(({scope}: {scope: string | undefined}) => useFixture(scope), {initialProps: {scope: 'a' as string | undefined}})
  hook.rerender({scope: undefined})
  act(() => hook.result.current.setSelectedTreeItemId(null))
  hook.rerender({scope: 'a'})
  expect(readWorkPanelUi('a')?.selectedTreeItemId).toBe('plan:a')
})

it('migrates local aliases, preserves unknown selections, and falls back coherently only after successful loading', () => {
  const plans = [{id: 'server-a', artifactId: 'history-a'}]
  expect(reconcilePlanSelection('plan:history-a', plans, true)).toBe('plan:server-a')
  expect(reconcilePlanSelection('plan:a', [], false)).toBe('plan:a')
  expect(reconcilePlanSelection('plan:deleted', [], true)).toBe('catalog')
})
