// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import AdminLayout, { AdminConfirmDialog } from '../../src/features/admin/AdminLayout'
import { adminPages, searchAdminPages } from '../../src/features/admin/admin-navigation'
import { useAdminQueryState } from '../../src/features/admin/admin-query-state'
vi.mock('../../src/features/admin/admin-shared', async original => ({ ...await original<object>(), useAdminSession: () => ({ admin: { id: 'fixture-admin', nickname: '演示管理员', isSuperAdmin: true }, denied: false, isLoading: false }) }))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ error: vi.fn() }) }))
afterEach(cleanup)
it('maps all fifteen existing routes and searches only page/action definitions', () => {
  expect(adminPages).toHaveLength(15)
  expect(new Set(adminPages.map(page => page.to)).size).toBe(15)
  expect(searchAdminPages('协议').map(page => page.to)).toEqual(['/admin/models'])
  expect(searchAdminPages('用户正文')).toEqual([])
})
it('offers direct mobile models, grouped page search, and collapsible business groups', () => {
  render(<MemoryRouter initialEntries={['/admin/users']}><AdminLayout><h1>用户结果</h1></AdminLayout></MemoryRouter>)
  expect(screen.getByRole('navigation', { name: '手机后台导航' }).textContent).toContain('模型')
  expect(screen.getByRole('button', { name: '用户与权益' }).getAttribute('aria-expanded')).toBe('true')
  fireEvent.change(screen.getByRole('textbox', { name: '搜索后台页面及操作' }), { target: { value: '协议' } })
  expect(screen.getByRole('region', { name: '页面搜索结果' }).textContent).toBe('模型中心')
  fireEvent.click(screen.getByRole('button', { name: '全部' }))
  const dialog = screen.getByRole('dialog', { name: '全部管理页面' })
  expect(dialog).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})
function QueryProbe() {
  const [search, setSearch] = useAdminQueryState('q', '')
  const [page, setPage] = useAdminQueryState('page', '1')
  const location = useLocation()
  const navigate = useNavigate()
  return <><output>{location.search}</output><button onClick={() => { setSearch('river'); setPage('1') }}>筛选</button><button onClick={() => navigate('/admin/users?q=other&page=4')}>另一个视图</button><button onClick={() => navigate(-1)}>返回</button><p>{search}/{page}</p></>
}
it('composes filter/page updates without losing unrelated URL state and restores browser-back state', () => {
  render(<MemoryRouter initialEntries={['/admin/users?page=3&type=author']}><QueryProbe /></MemoryRouter>)
  fireEvent.click(screen.getByText('筛选'))
  expect(screen.getByRole('status').textContent).toContain('q=river')
  expect(screen.getByRole('status').textContent).toContain('type=author')
  expect(screen.getByRole('status').textContent).not.toContain('page=3')
  fireEvent.click(screen.getByText('另一个视图'))
  expect(screen.getByText('other/4')).toBeTruthy()
  fireEvent.click(screen.getByText('返回'))
  expect(screen.getByText('river/1')).toBeTruthy()
})
it('names dangerous confirmation, requires exact text and traps keyboard focus', () => {
  const confirm = vi.fn(), cancel = vi.fn()
  render(<AdminConfirmDialog open title="删除演示对象" description="保留历史回执" confirmText="演示对象" onCancel={cancel} onConfirm={confirm} />)
  expect(screen.getByRole('dialog', { name: '删除演示对象' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '确认' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: '输入确认文本' }), { target: { value: '演示对象' } })
  fireEvent.click(screen.getByRole('button', { name: '确认' }))
  expect(confirm).toHaveBeenCalledOnce()
  const last = screen.getByRole('button', { name: '确认' }); last.focus()
  fireEvent.keyDown(document, { key: 'Tab' })
  expect(document.activeElement).toBe(screen.getByRole('textbox'))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(cancel).toHaveBeenCalledOnce()
})

it('closes the mobile navigation and releases its focus trap at the desktop breakpoint', () => {
  let resize: (() => void) | undefined
  const desktop = { matches: false, addEventListener: (_type: string, callback: () => void) => { resize = callback }, removeEventListener: vi.fn() }
  vi.stubGlobal('matchMedia', () => desktop)
  render(<MemoryRouter><AdminLayout><h1>示例</h1></AdminLayout></MemoryRouter>)
  fireEvent.click(screen.getByRole('button', { name: '全部' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  desktop.matches = true
  fireEvent(window, new Event('resize'))
  // matchMedia change is driven explicitly; jsdom has no responsive layout.
  act(() => resize?.())
  expect(screen.queryByRole('dialog')).toBeNull()
  vi.unstubAllGlobals()
})

it('collapses desktop sidebar without leaving invisible navigation focus targets and persists preference', () => {
  localStorage.removeItem('chevoink-admin-sidebar-collapsed')
  render(<MemoryRouter><AdminLayout><h1>示例</h1></AdminLayout></MemoryRouter>)
  fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }))
  expect(screen.getByRole('button', { name: '展开侧栏' }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('navigation', { name: '后台业务导航' })).toBeNull()
  expect(localStorage.getItem('chevoink-admin-sidebar-collapsed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '展开侧栏' }))
  expect(screen.getByRole('navigation', { name: '后台业务导航' })).toBeTruthy()
  localStorage.removeItem('chevoink-admin-sidebar-collapsed')
})
