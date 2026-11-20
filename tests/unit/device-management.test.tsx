// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { ApiClientError, requestJson } from '../../src/app/api-client'
import DeviceManagement from '../../src/app/routes/settings/DeviceManagement'

vi.mock('../../src/app/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/app/api-client')>(), requestJson: vi.fn(),
}))
vi.mock('../../src/features/account/VerificationCodeField', () => ({
  AccountDialog: ({ title, children }: { title: string; children: ReactNode }) => <section role="dialog" aria-label={title}>{children}</section>,
}))

const login = '2026-01-09T12:00:00Z'
const devices = [
  { id: 'this', deviceName: 'Android', location: '香港', current: true, createdAt: login, lastActiveAt: login },
  { id: 'desktop', deviceName: 'Windows', location: null, current: false, createdAt: login, lastActiveAt: login },
]
function mount(hasPassword: boolean) {
  const onSetPassword = vi.fn()
  const client = new QueryClient()
  render(<QueryClientProvider client={client}><DeviceManagement userId="u" hasPassword={hasPassword} onClose={vi.fn()} onSetPassword={onSetPassword} /></QueryClientProvider>)
  return onSetPassword
}
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('lists login and activity per device and requires a password to sign out a different device', async () => {
  vi.mocked(requestJson).mockResolvedValueOnce({ devices }).mockRejectedValueOnce(new ApiClientError('密码错误', 403)).mockResolvedValueOnce({ revoked: true })
  mount(true)
  await screen.findByText('Android')
  expect(screen.queryByRole('button', { name: '退出 Android' })).toBeNull()
  expect(screen.getAllByText('最近活动')).toHaveLength(2)
  expect(screen.getByText('地点未知')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '退出 Windows' }))
  const confirm = screen.getByRole('button', { name: '确认退出' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  const password = screen.getByLabelText('登录密码')
  fireEvent.change(password, { target: { value: 'incorrect' } })
  fireEvent.click(confirm)
  await screen.findByText('密码错误')
  fireEvent.change(password, { target: { value: 'verified-password' } })
  fireEvent.click(confirm)
  await screen.findByText('Windows 已退出登录。')
  expect(requestJson).toHaveBeenLastCalledWith('/api/auth/devices/desktop/revoke', { method: 'POST', body: JSON.stringify({ password: 'verified-password' }) })
  expect(screen.queryByText('Windows')).toBeNull()
  expect(screen.getByText('Android')).toBeTruthy()
})

it('allows viewing devices without a password and directs management to password setup', async () => {
  vi.mocked(requestJson).mockRejectedValueOnce(new Error()).mockResolvedValueOnce({ devices })
  const setup = mount(false)
  fireEvent.click(await screen.findByText('重试'))
  await screen.findByText('Android')
  expect(screen.queryByRole('button', { name: '退出 Windows' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '设置登录密码' }))
  await waitFor(() => expect(setup).toHaveBeenCalledOnce())
})
