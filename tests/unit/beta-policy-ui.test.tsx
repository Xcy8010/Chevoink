// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
const mocks = vi.hoisted(() => ({ summary: vi.fn(), policy: vi.fn(), referral: vi.fn(), usage: vi.fn() }))
vi.mock('../../src/features/account/credits-api', () => ({ fetchCreditSummary: mocks.summary, fetchPublicCreditPolicy: mocks.policy, fetchReferral: mocks.referral, fetchCreditUsage: mocks.usage, fetchTaskCreditUsage: vi.fn() }))
vi.mock('../../src/features/account/AccountLayout', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
import StudioMoreMenu from '../../src/features/studio/components/StudioMoreMenu'
import StudioMobileAccountCard from '../../src/features/studio/components/StudioMobileAccountCard'
import AccountPlanPage from '../../src/features/account/AccountPlanPage'
import AccountUsagePage from '../../src/features/account/AccountUsagePage'
import CreditQuotaDialog from '../../src/features/account/CreditQuotaDialog'
import { getAccountDocs } from '../../src/features/account/docs-content'
const summary = (enabled: boolean) => ({ publicBetaEnabled: enabled, publicBetaRevision: enabled ? 0 : 1, planLabel: enabled ? '公测版' : '免费版', dailyAllowance: 450, dailyUsed: 2, totalRemaining: 448, bonusRemaining: 0, usedPercent: 0.4, models: [], resetsAt: '2026-10-05T07:00:00Z' })
function mount(element: React.ReactNode, enabled = false, remaining = 448) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const account = { ...summary(enabled), totalRemaining: remaining, dailyUsed: 450 - remaining }
  client.setQueryData(['credits', 'summary'], account)
  client.setQueryData(['credits', 'usage'], { account, ledger: [] })
  client.setQueryData(['credits', 'referral'], { code: 'fixture', successfulInvites: 0, totalEarned: 0 })
  client.setQueryData(['credits', 'public-policy'], { publicBetaEnabled: enabled, publicBetaRevision: enabled ? 0 : 1, planLabel: enabled ? '公测版' : '免费版' })
  const view = render(<QueryClientProvider client={client}><MemoryRouter>{element}</MemoryRouter></QueryClientProvider>)
  return { ...view, client }
}
afterEach(cleanup)
it('IDE balance keeps real credits and hides gifts, percentage and reset promises when beta stops; resume restores them', async () => {
  const { client } = mount(<StudioMoreMenu />)
  fireEvent.click(screen.getByRole('button', { name: '更多' }))
  fireEvent.click(screen.getByRole('button', { name: '剩余用量' }))
  expect(screen.queryByText(/公测期间，每日送/)).toBeNull()
  expect(screen.getByText('448')).toBeTruthy()
  expect(screen.queryByText(/下次重置|%/)).toBeNull()
  expect(screen.getByText(/基础额度/)).toBeTruthy()
  await act(async () => { client.setQueryData(['credits', 'summary'], summary(true)) })
  await waitFor(() => expect(screen.getByText(/公测期间，每日送/)).toBeTruthy())
  expect(screen.getByText(/%/)).toBeTruthy()
})
it('mobile balance freezes allowance wording and hides daily percentage/reset promises', () => {
  mount(<StudioMobileAccountCard />)
  expect(screen.getByText(/剩余 448 Credits/)).toBeTruthy()
  expect(screen.getByText(/基础额度 450 Credits/)).toBeTruthy()
  expect(screen.queryByText(/每日|重置|%/)).toBeNull()
})
it('usage card and header preserve the frozen quota and omit daily reset/percentage promises', () => {
  mount(<AccountUsagePage />)
  expect(screen.getByRole('heading', { name: '基础额度' })).toBeTruthy()
  expect(screen.queryByText(/15:00 重置|下次重置|已使用 .*%/)).toBeNull()
  expect(screen.getByText('当前总可用 448 Credits')).toBeTruthy()
})
it('stopped exhausted accounts distinguish the 450 base allowance from zero current availability', () => {
  mount(<><StudioMoreMenu /><StudioMobileAccountCard /><AccountUsagePage /></>, false, 0)
  fireEvent.click(screen.getByRole('button', { name: '更多' }))
  fireEvent.click(screen.getByRole('button', { name: '剩余用量' }))
  expect(screen.getByText('额度已耗尽，邀请好友领取 300 Credits！')).toBeTruthy()
  expect(screen.getByText('当前总可用 0 Credits')).toBeTruthy()
  expect(screen.getAllByText('基础额度 450 Credits')).toHaveLength(2)
  expect(screen.getByRole('heading', { name: '基础额度' })).toBeTruthy()
  expect(screen.queryByText(/可用额度 450/)).toBeNull()
})
it('anonymous plan is free while stopped and only advertises daily allowance after policy confirms beta', async () => {
  const { client } = mount(<AccountPlanPage />)
  expect(screen.getByRole('heading', { name: '免费版' })).toBeTruthy()
  expect(screen.queryByText('每日公测 Credits 额度，UTC+8 15:00 自动重置')).toBeNull()
  expect(screen.queryByText(/公测结束后/)).toBeNull()
  expect(screen.getByText(/后续计划推出/)).toBeTruthy()
  await act(async () => { client.setQueryData(['credits', 'public-policy'], { publicBetaEnabled: true, publicBetaRevision: 2, planLabel: '公测版' }) })
  await waitFor(() => expect(screen.getByRole('heading', { name: '公测版' })).toBeTruthy())
  expect(screen.getByText('每日公测 Credits 额度，UTC+8 15:00 自动重置')).toBeTruthy()
})
it('conditions runtime docs without rewriting historical beta launch notes', () => {
  const stopped = getAccountDocs(false), active = getAccountDocs(true)
  expect(stopped.find(doc => doc.key === 'credits')?.sections.some(section => section.id === 'reset')).toBe(false)
  expect(active.find(doc => doc.key === 'credits')?.sections.some(section => section.id === 'reset')).toBe(true)
  expect(stopped.find(doc => doc.key === 'plan')?.sections[0].heading).toBe('免费版套餐')
  expect(JSON.stringify(stopped.filter(doc => doc.key !== 'changelog'))).not.toMatch(/公测结束后|等待每日 15:00 的额度重置/)
  expect(stopped.find(doc => doc.key === 'changelog')).toEqual(active.find(doc => doc.key === 'changelog'))
})
it('quota warning avoids reset promises until the current policy confirms beta', () => {
  const props = { open: true, onInvite: vi.fn(), onClose: vi.fn() }
  const view = render(<CreditQuotaDialog {...props} />)
  expect(screen.queryByText(/每日额度会自动恢复|下次重置/)).toBeNull()
  view.rerender(<CreditQuotaDialog {...props} publicBetaEnabled />)
  expect(screen.getByText(/每日额度会自动恢复/)).toBeTruthy()
  expect(screen.getByText(/下次重置/)).toBeTruthy()
})
