// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWorkspaceLayout } from '../../src/features/studio/components/use-workspace-layout'
import type { ResizablePanel, StudioPanelWidths } from '../../src/features/studio/panel-widths'

const capture = vi.hoisted(() => ({ current: null as null | { onCollapse: (panel: ResizablePanel) => void; getMaximum: (panel: ResizablePanel, widths: StudioPanelWidths) => number } }))
vi.mock('../../src/features/studio/panel-widths', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/features/studio/panel-widths')>(),
  useStudioPanelWidths: (options: NonNullable<typeof capture.current>) => { capture.current = options; return { panelWidths: {}, beginPanelResize: vi.fn() } },
}))
beforeEach(() => { window.localStorage.clear(); vi.stubGlobal('innerWidth', 1440) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const widths = { tree: 240, agent: 400, workTask: 232, workInspector: 260, workViewer: 320 }

it('restores the shared left sidebar and keeps work right panels initially closed', () => {
  window.localStorage.setItem('chevoink:workspace-sidebar', 'collapsed')
  window.localStorage.setItem('chevoink:studio-sidebar-width', '320')
  const { result } = renderHook(() => useWorkspaceLayout('novel'))
  expect(result.current.workspaceSidebarOpen).toBe(false)
  expect(result.current.workspaceSidebarWidth).toBe(320)
  expect(result.current.workRightOpen).toBe(false)
  expect(result.current.workViewer).toBeNull()
  act(() => result.current.setWorkspaceSidebarOpen(true))
  expect(window.localStorage.getItem('chevoink:workspace-sidebar')).toBe('open')
})

it('reserves conversation/sidebar widths beside the persistent desktop activity rail', () => {
  const { result } = renderHook(() => useWorkspaceLayout('novel'))
  expect(capture.current!.getMaximum('workViewer', widths)).toBe(1440 - 52 - 280 - 44 - 360 - 46)
  act(() => { result.current.setWorkRightOpen(true); result.current.setWorkViewer('chapter') })
  expect(capture.current!.getMaximum('workTask', widths)).toBe(1440 - 52 - 280 - 44 - 360 - 260 - 320)
  expect(capture.current!.getMaximum('workInspector', widths)).toBe(1440 - 52 - 280 - 44 - 360 - 320)
  act(() => result.current.setWorkspaceSidebarOpen(false))
  expect(capture.current!.getMaximum('workViewer', widths)).toBe(1440 - 52 - 44 - 360 - 260)
  act(() => { capture.current!.onCollapse('workViewer'); capture.current!.onCollapse('workInspector') })
  expect(result.current.workViewer).toBeNull()
  expect(result.current.workRightOpen).toBe(false)
})

it('preserves IDE center space and collapsed rail allowances', () => {
  window.localStorage.setItem('chevoink:perspective:novel', 'ide')
  const { result } = renderHook(() => useWorkspaceLayout('novel'))
  expect(result.current.workspacePerspective).toBe('ide')
  expect(capture.current!.getMaximum('tree', widths)).toBe(1440 - 52 + 46 - 520 - 400)
  expect(capture.current!.getMaximum('agent', widths)).toBe(1440 - 52 + 46 - 520 - 240)
  act(() => { capture.current!.onCollapse('agent'); capture.current!.onCollapse('tree') })
  expect(capture.current!.getMaximum('tree', widths)).toBe(1440 - 52 + 46 - 520 - 46)
  expect(capture.current!.getMaximum('agent', widths)).toBe(1440 - 52 + 46 - 520 - 46)
})
