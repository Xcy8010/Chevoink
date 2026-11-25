// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Link, MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import DesktopWindowFrame from '../../src/components/layout/DesktopWindowFrame'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../../src/app/route-config', () => ({ appRoutes: [] }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
function mount() {
  return render(<MemoryRouter initialEntries={['/studio']}><DesktopWindowFrame /><Link to="/discover">离开创作区</Link></MemoryRouter>)
}
it('keeps older desktop hosts on their working system frame', async () => {
  invoke.mockResolvedValue({ version: '1.0.4' })
  mount()
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('desktop_get_info'))
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(screen.queryByLabelText('桌面窗口')).toBeNull()
  expect(document.documentElement.dataset.desktopFrame).toBeUndefined()
})
it('uses the native controls and follows workspace navigation without reattaching', async () => {
  invoke.mockImplementation(async (cmd, args) => cmd === 'desktop_get_info' ? { windowCaption: 1 }
    : { maximized: args.action === 'toggleMaximize', fullscreen: false })
  mount()
  const maximize = await screen.findByRole('button', { name: '最大化窗口' })
  expect(document.querySelector('.desktop-window-outline')).toBeTruthy()
  expect(screen.getByTitle('启创墨域首页')).toBeTruthy()
  const toolbar = document.createElement('div')
  toolbar.dataset.studioCommandBar = 'work'
  document.querySelector('.desktop-commands')!.append(toolbar)
  await waitFor(() => expect(screen.queryByTitle('启创墨域首页')).toBeNull())
  fireEvent.click(maximize)
  expect(screen.queryByTitle('启创墨域首页')).toBeNull()
  expect(screen.queryByText('前往')).toBeNull()
  expect(document.querySelector('.desktop-drag')?.textContent).toBe('')
  expect(await screen.findByRole('button', { name: '还原窗口' })).toBeTruthy()
  expect(document.querySelector('.desktop-window-outline')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('desktop_caption', { action: 'close' }))
  toolbar.remove()
  await screen.findByTitle('启创墨域首页')
  fireEvent.click(screen.getByRole('link', { name: '离开创作区' }))
  await waitFor(() => expect(document.documentElement.dataset.desktopFrame).toBe('site'))
  expect(screen.getByTitle('启创墨域首页').querySelector('img')?.getAttribute('src'))
    .toBe(`${import.meta.env.BASE_URL}agent-mark-144.webp`)
  fireEvent.click(screen.getByText('前往'))
  expect(within(screen.getByRole('navigation', { name: '前往页面' })).getByRole('link', { name: '发现' })).toBeTruthy()
  expect(screen.queryByRole('navigation', { name: '桌面工作区导航' })).toBeNull()
  expect(invoke.mock.calls.filter(call => call[1]?.action === 'attach')).toHaveLength(1)
})
it('returns window management to the OS while a dialog makes the web caption inert', async () => {
  invoke.mockImplementation(async cmd => cmd === 'desktop_get_info' ? { windowCaption: 1 }
    : { maximized: false, fullscreen: false })
  mount()
  await screen.findByRole('button', { name: '最小化窗口' })
  const dialog = document.createElement('dialog')
  document.body.append(dialog)
  dialog.open = true
  await waitFor(() => expect(screen.queryByLabelText('桌面窗口')).toBeNull())
  expect(document.querySelector('.desktop-window-outline')).toBeNull()
  expect(invoke).toHaveBeenCalledWith('desktop_caption', { action: 'system' })
  dialog.remove()
  expect(await screen.findByRole('button', { name: '最小化窗口' })).toBeTruthy()
  expect(document.querySelector('.desktop-window-outline')).toBeTruthy()
})

it.each(['/', '/studio'])('keeps the %s toolbar and its open dialog mounted during system caption handover', async path => {
  invoke.mockImplementation(async cmd => cmd === 'desktop_get_info' ? { windowCaption: 1 }
    : { maximized: false, fullscreen: false })
  const bind = vi.fn()
  render(<MemoryRouter initialEntries={[path]}><DesktopWindowFrame onContentHost={bind} /></MemoryRouter>)
  await screen.findByRole('button', { name: '最小化窗口' })
  const host: HTMLElement = bind.mock.lastCall![0]
  const dialog = document.createElement('dialog')
  host.append(dialog)
  dialog.open = true
  await waitFor(() => expect(screen.queryByLabelText('桌面窗口')).toBeNull())
  expect(dialog.isConnected && dialog.open).toBe(true)
  dialog.remove()
  await screen.findByRole('button', { name: '最小化窗口' })
  expect(bind).toHaveBeenCalledTimes(1)
})

it('serializes caption changes when a modal opens during attach and closes during system handover', async () => {
  const native = { maximized: false, fullscreen: false }
  let finish!: () => void
  invoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'desktop_get_info') return { windowCaption: 1 }
    if (args.action === 'system' || invoke.mock.calls.filter(call => call[1]?.action === 'attach').length === 1)
      await new Promise<void>(resolve => { finish = resolve })
    return native
  })
  mount()
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('desktop_caption', { action: 'attach' }))
  const dialog = document.createElement('dialog')
  document.body.append(dialog)
  dialog.open = true
  finish()
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('desktop_caption', { action: 'system' }))
  dialog.remove()
  finish()
  expect(await screen.findByRole('button', { name: '最小化窗口' })).toBeTruthy()
  expect(invoke.mock.calls.filter(call => call[0] === 'desktop_caption').map(call => call[1].action))
    .toEqual(['attach', 'system', 'attach'])
})
