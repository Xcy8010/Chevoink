// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiClientError } from '../../src/app/api-client'
import { ToastProvider } from '../../src/components/ui/Toast'
import ReturnRewardPage from '../../src/features/account/ReturnRewardPage'

const mocked = vi.hoisted(() => ({
  requestJson: vi.fn(),
  session: { authStatus: 'authenticated', sessionUser: { id: 'recipient' } },
}))
vi.mock('../../src/app/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/app/api-client')>(),
  requestJson: mocked.requestJson,
}))
vi.mock('../../src/store/useShellStore', () => ({
  useShellStore: (selector: (state: typeof mocked.session) => unknown) => selector(mocked.session),
}))

const token = 'a'.repeat(43)
const href = '/return-reward#' + token

function LoginLocation() {
  const location = useLocation()
  return <p>{location.pathname + location.search + location.hash}</p>
}

function openReward(path = href) {
  const client = new QueryClient()
  return render(<QueryClientProvider client={client}><ToastProvider>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/return-reward" element={<ReturnRewardPage/>}/>
        <Route path="/login" element={<LoginLocation/>}/>
        <Route path="/studio" element={<LoginLocation/>}/>
        <Route path="/studio/novel/:novelId" element={<LoginLocation/>}/>
      </Routes>
    </MemoryRouter>
  </ToastProvider></QueryClientProvider>)
}

beforeEach(() => {
  sessionStorage.clear()
  mocked.session.authStatus = 'authenticated'
  mocked.requestJson.mockReset()
})
afterEach(cleanup)

it('only claims on confirmation, then shows the toast in the configured workspace', async () => {
  mocked.requestJson.mockResolvedValue({ amountMilli: 25000, bonusBalanceMilli: 45000, workspacePath: 'studio/novel/example', alreadyClaimed: false })
  openReward()
  expect(mocked.requestJson).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认领取' }))
  expect(await screen.findByText('/studio/novel/example')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('领取成功，25 Credits 已到账。')
  expect(mocked.requestJson).toHaveBeenCalledExactlyOnceWith('/api/credits/return-reward/claim', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
})

it('keeps the token out of the login URL and restores it for explicit confirmation after login', async () => {
  mocked.session.authStatus = 'guest'
  const invite = openReward()
  fireEvent.click(screen.getByRole('button', { name: '去登录' }))
  expect(await screen.findByText('/login?redirect=%2Freturn-reward')).toBeTruthy()
  expect(mocked.requestJson).not.toHaveBeenCalled()
  invite.unmount()
  mocked.session.authStatus = 'authenticated'
  mocked.requestJson.mockResolvedValue({ amountMilli: 25000, bonusBalanceMilli: 45000, workspacePath: 'studio', alreadyClaimed: true })
  openReward('/return-reward')
  fireEvent.click(screen.getByRole('button', { name: '确认领取' }))
  expect(await screen.findByText('/studio')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('回归奖励已领取。')
  expect(mocked.requestJson.mock.calls[0][1].body).toBe(JSON.stringify({ token }))
  expect(sessionStorage.length).toBe(0)
})

it('stays on the claim screen and reports expiration without showing a success toast', async () => {
  mocked.requestJson.mockRejectedValue(new ApiClientError('这封邮件的奖励已过领取期限。', 410))
  openReward()
  fireEvent.click(screen.getByRole('button', { name: '确认领取' }))
  expect((await screen.findByRole('alert')).textContent).toBe('这封邮件的奖励已过领取期限。')
  expect(screen.getByRole('heading', { name: '领取回归奖励' })).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
})
