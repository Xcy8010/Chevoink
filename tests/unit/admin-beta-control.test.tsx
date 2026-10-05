// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
const mocks = vi.hoisted(() => ({ credits: vi.fn(), beta: vi.fn(), captcha: vi.fn(), pause: vi.fn(), reset: vi.fn() }))
vi.mock('../../src/features/admin/api', () => ({ getAdminCreditsManagement: mocks.credits, setAdminPublicBeta: mocks.beta, getAdminCaptcha: mocks.captcha,
  resetAdminUserCredits: mocks.reset, resetAllAdminCredits: mocks.reset, resetSelectedAdminCredits: mocks.reset,
  setAdminCreditsPaused: mocks.pause, setAdminUserCreditsPaused: mocks.pause, setSelectedAdminCreditsPaused: mocks.pause }))
vi.mock('../../src/features/admin/components/AdminAnalytics', () => ({ default: () => null }))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
import AdminCreditsManagementPage from '../../src/features/admin/pages/AdminCreditsManagementPage'
beforeEach(() => { vi.clearAllMocks(); mocks.credits.mockResolvedValue({ summary: { publicBetaEnabled: true, publicBetaRevision: 4, globallyPaused: false, users: 0, dailyAllowance: 0, dailyUsed: 0, bonusBalance: 0, exhaustedUsers: 0 }, users: [] }); mocks.captcha.mockResolvedValue({ captchaId: 'fixture-captcha', imageBase64: 'data:image/png;base64,AA==', expiresInSeconds: 120 }); mocks.beta.mockResolvedValue({ publicBetaEnabled: false, publicBetaRevision: 5 }) })
afterEach(cleanup)
it('labels a stopped aggregate allowance as base quota rather than current availability', async () => {
  mocks.credits.mockResolvedValue({ summary: { publicBetaEnabled: false, publicBetaRevision: 5, globallyPaused: false, users: 1, dailyAllowance: 450, dailyUsed: 450, bonusBalance: 0, exhaustedUsers: 1 }, users: [] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><MemoryRouter><AdminCreditsManagementPage /></MemoryRouter></QueryClientProvider>)
  expect(await screen.findByText('基础总额度')).toBeTruthy()
  expect(screen.queryByText('可用额度')).toBeNull()
})
it('requires separate STOP_BETA captcha/confirmation and sends the displayed CAS revision without pausing calls or resetting accounts', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter><AdminCreditsManagementPage /></MemoryRouter></QueryClientProvider>)
  const stop = await screen.findByRole('button', { name: '停止公测' })
  expect(stop.className).toContain('bg-rose-700')
  fireEvent.click(stop)
  await screen.findByAltText('人机验证码')
  expect(mocks.beta).not.toHaveBeenCalled()
  fireEvent.change(screen.getByPlaceholderText('输入图中字符'), { target: { value: 'abcd' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  const confirm = screen.getByRole('button', { name: '确认执行' })
  expect(confirm.hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByPlaceholderText('STOP_BETA'), { target: { value: 'PAUSE_ALL' } })
  expect(confirm.hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByPlaceholderText('STOP_BETA'), { target: { value: 'STOP_BETA' } })
  fireEvent.click(confirm)
  await waitFor(() => expect(mocks.beta).toHaveBeenCalledWith({ enabled: false, expectedRevision: 4, captchaId: 'fixture-captcha', captchaAnswer: 'abcd', confirmation: 'STOP_BETA' }))
  expect(mocks.pause).not.toHaveBeenCalled(); expect(mocks.reset).not.toHaveBeenCalled()
})
