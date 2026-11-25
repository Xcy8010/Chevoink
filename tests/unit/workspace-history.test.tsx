// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserRouter, Link, useLocation } from 'react-router-dom'
import { DesktopHistory } from '../../src/components/layout/DesktopNavigation'
import { protectWritingTask, readWorkspaceVisit, rememberWorkspaceVisit, type WorkspaceVisit } from '../../src/features/studio/lib/workspace-history'

afterEach(cleanup)

const first: WorkspaceVisit = { owner: 'author', novelId: 'book', taskId: 'a', perspective: 'work', blankTask: false }
const second = { ...first, taskId: 'b' }

function NavigationFixture() {
  const location = useLocation()
  const visit = readWorkspaceVisit(location.state, 'author', 'book')
  return <><DesktopHistory /><output>{visit?.taskId}</output>
    <Link to="/book" replace={false} state={{ workspaceVisit: second }}>任务 B</Link>
    <Link to="/other">其它页面</Link></>
}

it('scopes restored task and perspective to the same user and work', () => {
  const state = { workspaceVisit: { ...first, perspective: 'ide' } }
  expect(readWorkspaceVisit(state, 'author', 'book')?.perspective).toBe('ide')
  expect(readWorkspaceVisit(state, 'other', 'book')).toBeNull()
  expect(readWorkspaceVisit(state, 'author', 'other')).toBeNull()
  expect(readWorkspaceVisit({ workspaceVisit: { ...first, perspective: 'invalid' } }, 'author', 'book')).toBeNull()
})

it('retains the original task on native back and truncates forward after a new route', async () => {
  window.history.replaceState({ idx: 0, key: 'start', usr: { other: 1 } }, '', '/book')
  render(<BrowserRouter><NavigationFixture /></BrowserRouter>)
  const back = screen.getByRole('button', { name: '后退' }) as HTMLButtonElement
  const forward = screen.getByRole('button', { name: '前进' }) as HTMLButtonElement
  const initialLength = window.history.length
  rememberWorkspaceVisit(first)
  expect(window.history.length).toBe(initialLength)
  expect(window.history.state).toMatchObject({ idx: 0, key: 'start', usr: { other: 1, workspaceVisit: first } })
  fireEvent.click(screen.getByText('任务 B'))
  expect(screen.getByRole('status').textContent).toBe('b')
  fireEvent.click(back)
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('a'))
  expect(forward.disabled).toBe(false)
  fireEvent.click(forward)
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('b'))
  window.history.back()
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('a'))
  fireEvent.click(screen.getByText('其它页面'))
  expect(forward.disabled).toBe(true)
  expect(window.location.pathname).toBe('/other')
})

it('restores the native cursor before the router can unmount a writing task', () => {
  window.history.replaceState({ idx: 2 }, '')
  const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
  const route = vi.fn(), blocked = vi.fn()
  window.addEventListener('popstate', route)
  const release = protectWritingTask(blocked)
  try {
    window.dispatchEvent(new PopStateEvent('popstate', { state: { idx: 0 } }))
    expect(go).toHaveBeenCalledWith(2)
    window.dispatchEvent(new PopStateEvent('popstate', { state: { idx: 2 } }))
    expect(blocked).toHaveBeenCalledTimes(1)
    expect(route).not.toHaveBeenCalled()
    release()
    window.dispatchEvent(new PopStateEvent('popstate', { state: { idx: 0 } }))
    expect(route).toHaveBeenCalledTimes(1)
  } finally {
    release()
    window.removeEventListener('popstate', route)
    go.mockRestore()
  }
})
