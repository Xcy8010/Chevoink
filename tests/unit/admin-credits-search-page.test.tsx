// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
const mocks = vi.hoisted(() => ({ credits: vi.fn(), reset: vi.fn(), pause: vi.fn(), batch: vi.fn(), captcha: vi.fn() }))
vi.mock('../../src/features/admin/api', () => ({ getAdminCreditsManagement: mocks.credits, resetAdminUserCredits: mocks.reset,
  setAdminUserCreditsPaused: mocks.pause, resetSelectedAdminCredits: mocks.batch, setSelectedAdminCreditsPaused: mocks.batch,
  resetAllAdminCredits: vi.fn(), setAdminCreditsPaused: vi.fn(), setAdminPublicBeta: vi.fn(), getAdminCaptcha: mocks.captcha }))
vi.mock('../../src/features/admin/components/AdminAnalytics', () => ({ default: () => null }))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
import AdminCreditsManagementPage from '../../src/features/admin/pages/AdminCreditsManagementPage'

const row = (id: string, nickname: string, suspended = false) => ({ user: { id, nickname, avatarUrl: null }, planLabel: '公测版',
  dailyAllowance: 450, dailyUsed: 10, dailyRemaining: 440, bonusBalance: 1, totalRemaining: 441, usedPercent: 2.2,
  resetsAt: '2026-11-01T00:00:00Z', suspended })
const first = row('first-page-user', '首页作者'), target = row('outside-user-id', '目标作者')
const summary = { publicBetaEnabled: true, publicBetaRevision: 1, globallyPaused: false, users: 35, dailyAllowance: 15750, dailyUsed: 350, bonusBalance: 35, exhaustedUsers: 0 }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.credits.mockImplementation(async (search?: string) => ({ summary, users: search === 'missing' ? [] : search ? [target] : [first, target] }))
  mocks.captcha.mockResolvedValue({ captchaId: 'synthetic-captcha', imageBase64: 'data:image/png;base64,AA==', expiresInSeconds: 120 })
  mocks.reset.mockResolvedValue({ stoppedRuns: 0 }); mocks.pause.mockResolvedValue({ users: 1, stoppedRuns: 0 }); mocks.batch.mockResolvedValue({ users: 1, stoppedRuns: 0 })
})
afterEach(cleanup)
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><AdminCreditsManagementPage /></MemoryRouter></QueryClientProvider>)
}
function search(value: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索用户' }), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: '搜索', exact: true }))
}
async function confirm(word: string) {
  await screen.findByAltText('人机验证码')
  fireEvent.change(screen.getByPlaceholderText('输入图中字符'), { target: { value: 'abcd' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.change(screen.getByPlaceholderText(word), { target: { value: word } })
  fireEvent.click(screen.getByRole('button', { name: '确认执行' }))
}
it.each(['outside-user-id', '目标作者', 'MAIL+tag@example.invalid'])('requests server search by ID/name/email and clear restores the list: %s', async keyword => {
  mount(); await screen.findByRole('link', { name: '首页作者' })
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 首页作者' }))
  expect(screen.getByText('已选 1 位')).toBeTruthy()
  search('  ' + keyword + '  ')
  await waitFor(() => expect(mocks.credits).toHaveBeenLastCalledWith(keyword))
  const match = await screen.findByRole('link', { name: '目标作者' })
  expect(match.getAttribute('href')).toBe('/admin/users/outside-user-id')
  expect(screen.queryByRole('link', { name: '首页作者' })).toBeNull()
  expect(screen.queryByText('已选 1 位')).toBeNull()
  expect(screen.getByText('15,750')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '清空' }))
  await screen.findByRole('link', { name: '首页作者' })
  expect(screen.getByRole('searchbox', { name: '搜索用户' }).getAttribute('value')).toBe('')
})
it('shows a no-result state while preserving global totals and clears back to all users', async () => {
  mount(); await screen.findByRole('link', { name: '首页作者' }); search('missing')
  expect(await screen.findByText('未找到匹配的用户')).toBeTruthy()
  expect(screen.getByText('15,750')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '重置', exact: true })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '清空' }))
  await screen.findByRole('link', { name: '首页作者' })
})
it.each([{ label: '重置', word: 'RESET_USER', suspended: false }, { label: '暂停', word: 'PAUSE_USER', suspended: false }, { label: '恢复', word: 'RESUME_USER', suspended: true }])('keeps the searched userId bound to $label through the existing confirmation flow', async ({ label, word, suspended }) => {
  mocks.credits.mockResolvedValue({ summary, users: [row(target.user.id, target.user.nickname, suspended)] })
  mount(); await screen.findByRole('link', { name: '目标作者' }); search('outside-user-id')
  await waitFor(() => expect(mocks.credits).toHaveBeenLastCalledWith('outside-user-id'))
  const link = await screen.findByRole('link', { name: '目标作者' })
  fireEvent.click(within(link.closest('tr')!).getByRole('button', { name: label, exact: true }))
  expect(mocks.reset).not.toHaveBeenCalled(); expect(mocks.pause).not.toHaveBeenCalled()
  await confirm(word)
  await waitFor(() => expect(label === '重置' ? mocks.reset : mocks.pause).toHaveBeenCalledWith('outside-user-id', expect.objectContaining({
    captchaId: 'synthetic-captcha', captchaAnswer: 'abcd', confirmation: word, ...(label === '重置' ? { requestKey: expect.any(String) } : { paused: label === '暂停' }),
  })))
})
it('selects only the visible search result for the existing batch pause operation', async () => {
  mount(); await screen.findByRole('link', { name: '首页作者' }); search('outside-user-id')
  await waitFor(() => expect(screen.queryByRole('link', { name: '首页作者' })).toBeNull())
  fireEvent.click(await screen.findByRole('checkbox', { name: '选择全部用户' }))
  fireEvent.click(screen.getByRole('button', { name: '批量暂停' }))
  await confirm('PAUSE_SELECTED')
  await waitFor(() => expect(mocks.batch).toHaveBeenCalledWith({ userIds: ['outside-user-id'], paused: true,
    captchaId: 'synthetic-captcha', captchaAnswer: 'abcd', confirmation: 'PAUSE_SELECTED' }))
})
