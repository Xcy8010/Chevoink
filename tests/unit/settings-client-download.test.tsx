// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SettingsPage from '../../src/app/routes/SettingsPage'
import { ANDROID_APK_URL } from '../../src/app/routes/settings/client-os'

const mocks = vi.hoisted(() => ({ download: vi.fn(), external: vi.fn(), error: vi.fn(), info: vi.fn(), invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../../src/lib/windows-download', async (original) => ({
  ...await original<typeof import('../../src/lib/windows-download')>(), getWindowsDownload: mocks.download,
}))
vi.mock('../../src/lib/native-app', () => ({
  isNativeApp: () => navigator.userAgent.includes('ChevoinkApp/'), getNativeAppVersion: () => '1.0.6', openExternalUrl: mocks.external,
}))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ error: mocks.error, info: mocks.info }) }))
vi.mock('../../src/features/account/CustomModelSettingsDialog', () => ({ default: () => null }))
vi.mock('../../src/store/useShellStore', () => ({ useShellStore: (select: (state: Record<string, unknown>) => unknown) => select({
  theme: 'light', fullscreenEnabled: false, authStatus: 'guest', sessionUser: null, unreadMessageCount: 0, unreadNotificationCount: 0,
  setTheme: () => {}, setFullscreenEnabled: () => {},
}) }))

beforeEach(() => {
  mocks.invoke.mockResolvedValue({ version: '1.0.4', settingsActions: 1 })
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Windows NT 10.0')
  mocks.download.mockResolvedValue({ version: '1.0.0', url: 'https://chevoink.chevolink.com/download/windows/1.0.0/Chevoink_1.0.0_x64-setup.exe', signature: 'fixture' })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks() })
async function show() { await act(async () => { render(<MemoryRouter><SettingsPage /></MemoryRouter>) }) }

function PolicyRouteProbe() {
  const { search } = useLocation()
  return <output>{new URLSearchParams(search).get('kind')}</output>
}

it.each([['用户协议', 'terms'], ['隐私政策', 'privacy']])('opens %s from settings without a signed-in session', async (label, kind) => {
  await act(async () => {
    render(<MemoryRouter initialEntries={['/settings']}><Routes>
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/legal" element={<PolicyRouteProbe />} />
    </Routes></MemoryRouter>)
  })
  fireEvent.click(screen.getByRole('button', { name: label }))
  expect(screen.getByText(kind)).toBeTruthy()
})

it('offers narrow native actions only in Windows settings', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 ChevoinkDesktop/1.0.4')
  await show()
  expect(screen.getByText('Windows x64 · 1.0.4')).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByText('在浏览器打开官网')) })
  expect(mocks.invoke).toHaveBeenCalledWith('desktop_settings_action', { action: 'browser' })
  await act(async () => { fireEvent.click(screen.getByText('检查客户端更新')) })
  expect(mocks.invoke).toHaveBeenCalledWith('desktop_settings_action', { action: 'update' })
})

it('retains compatibility with older Windows hosts without the new command', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 ChevoinkDesktop/1.0.3')
  mocks.invoke.mockResolvedValue({ version: '1.0.3' })
  await show()
  await act(async () => { fireEvent.click(screen.getByText('检查客户端更新')) })
  expect(mocks.info).toHaveBeenCalled()
  expect(mocks.invoke).toHaveBeenCalledTimes(1)
})

it.each(['Windows NT 10.0', 'Android ChevoinkApp/1.0.7'])('hides Windows-only controls in %s', async (agent) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(agent)
  await show()
  expect(screen.queryByText('Windows 客户端')).toBeNull()
  expect(screen.queryByText('在浏览器打开官网')).toBeNull()
  expect(mocks.invoke).not.toHaveBeenCalled()
})

it('labels unsigned manual downloads before the user downloads', async () => {
  mocks.download.mockResolvedValue({ version: '1.0.3', channel: 'preview', signed: false, sha256: 'a'.repeat(64), url: 'https://chevoink.chevolink.com/download/windows/1.0.3/Chevoink_1.0.3_x64-setup.exe' })
  await show()
  fireEvent.click(screen.getByText('下载客户端'))
  expect(within(screen.getByRole('dialog')).getByText(/未签名测试版，暂不支持自动更新/)).toBeTruthy()
})

it('offers only Windows on a narrow desktop, and clears selection when reopened', async () => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(375)
  await show()
  fireEvent.click(screen.getByText('下载客户端'))
  let dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('适用于 Windows x64')).toBeTruthy()
  expect(within(dialog).queryByText('安卓')).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Windows' }))
  expect(within(dialog).getByRole('button', { name: '下载 Windows 客户端' })).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
  fireEvent.click(screen.getByText('下载客户端'))
  dialog = screen.getByRole('dialog')
  expect(within(dialog).queryByRole('button', { name: '下载 Windows 客户端' })).toBeNull()
})

it('preserves mobile choices and the existing Android download URL', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Android')
  await show()
  expect(mocks.download).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('安装启创墨域客户端'))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).queryByText('Windows')).toBeNull()
  expect(within(dialog).getByText('苹果')).toBeTruthy()
  expect(within(dialog).getByText('鸿蒙')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '安卓' }))
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '立即下载安卓端' })) })
  expect(mocks.external).toHaveBeenCalledExactlyOnceWith(ANDROID_APK_URL)
})

it.each(['Windows NT 10.0 ChevoinkDesktop/1.0.0', 'Android ChevoinkApp/1.0.6'])('does not offer a redundant client download inside %s', async (agent) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(agent)
  await show()
  expect(mocks.download).not.toHaveBeenCalled()
  expect(screen.queryByText('下载客户端')).toBeNull()
  expect(screen.queryByText('安装启创墨域客户端')).toBeNull()
})

it('does not advertise a stable package when discovery fails', async () => {
  mocks.download.mockRejectedValueOnce(new Error('404'))
  await show()
  expect(screen.queryByText('下载客户端')).toBeNull()
  expect(mocks.download).toHaveBeenCalledOnce()
})

it('keeps keyboard focus in the download dialog and restores it on Escape', async () => {
  await show()
  const trigger = screen.getByText('下载客户端').closest('button')!
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog')
  const close = within(dialog).getByRole('button', { name: '关闭' })
  expect(document.activeElement).toBe(close)
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
  const backup = within(dialog).getByRole('link', { name: '查看发布说明与备用下载' })
  expect(document.activeElement).toBe(backup)
  fireEvent.keyDown(backup, { key: 'Tab' })
  expect(document.activeElement).toBe(close)
  fireEvent.keyDown(close, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('keeps the dialog and backup release link when a selected download becomes unavailable', async () => {
  await show()
  fireEvent.click(screen.getByText('下载客户端'))
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Windows' }))
  mocks.download.mockRejectedValueOnce(new Error('offline'))
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '下载 Windows 客户端' })) })
  expect(mocks.error).toHaveBeenCalledOnce()
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(within(dialog).getByRole('link', { name: '查看发布说明与备用下载' }).getAttribute('href')).toBe('https://github.com/Xcy8010/chevoink/releases')
})
