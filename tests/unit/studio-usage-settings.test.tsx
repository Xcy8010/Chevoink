// @vitest-environment jsdom
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CreditAccountSummary, CreditActivityPayload, CreditLedgerItem } from '../../shared/contracts/credits'
import { fetchCreditActivity, fetchCreditSummary, fetchCreditUsage } from '@/features/account/credits-api'
import StudioSettingsDialog, { type StudioSettingsSection } from '@/features/studio/components/StudioSettingsDialog'
import { useStudioCredits } from '@/features/studio/hooks/useStudioCredits'

vi.mock('@/features/account/credits-api', async importOriginal => ({
  ...await importOriginal<typeof import('@/features/account/credits-api')>(),
  fetchCreditActivity: vi.fn(), fetchCreditSummary: vi.fn(), fetchCreditUsage: vi.fn(),
}))

const account: CreditAccountSummary = {
  plan: 'public_beta', publicBetaEnabled: true, publicBetaRevision: 1, planLabel: '公测版',
  dailyAllowance: 400, dailyUsed: 100, dailyRemaining: 300, bonusRemaining: 50, totalRemaining: 335,
  reserved: 15, balance: 350, usedPercent: 25, periodStartedAt: '2026-11-24T07:00:00Z',
  resetsAt: '2026-11-25T07:00:00Z', resetTimeZone: 'UTC+8', globallyPaused: false, suspended: false, models: [],
}
const activity: CreditActivityPayload = { account, stats: {
  generatedAt: '2026-11-25T03:00:00Z', ledgerStartedAt: null, activityStartedAt: '2025-11-26', activityEndsAt: '2026-11-25',
  cumulativeSpent: 64, cumulativeEarned: 20, peakDailySpent: 35, totalTokens: 400, totalModelCalls: 4, agentRuns: 2, activeDays: 3,
  currentStreakDays: 1, longestStreakDays: 3, cacheHitRate: null, modelUsage: [],
  activity: [
    { date: '2026-11-18', creditsSpent: 35, eventCount: 2 }, { date: '2026-11-19', creditsSpent: 9, eventCount: 1 },
    { date: '2026-11-25', creditsSpent: 20, eventCount: 2 },
  ],
} }
const row: CreditLedgerItem = {
  id: 'search', delta: -2, kind: 'usage', sourceType: 'web_search', referenceId: null, modelTier: null, multiplier: 1,
  requestTokens: null, responseTokens: null, promptCacheHitTokens: null, promptCacheMissTokens: null, createdAt: '2026-11-25T03:00:00Z',
}
let client: QueryClient

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(fetchCreditSummary).mockResolvedValue(account)
  vi.mocked(fetchCreditActivity).mockResolvedValue(activity)
  vi.mocked(fetchCreditUsage).mockResolvedValue({ account, ledger: [row,
    { ...row, id: 'reward', kind: 'bonus', sourceType: 'creator_return', delta: 12 }] })
})
afterEach(() => { cleanup(); client.clear(); vi.resetAllMocks() })

function RailObserver() { useStudioCredits(60_000); return null }
function openSettings(initialSection: StudioSettingsSection, withRail = false) {
  function Workspace() {
    const [section, setSection] = useState(initialSection)
    return <>{withRail && <RailObserver />}
      <StudioSettingsDialog open section={section} onSectionChange={setSection} onClose={vi.fn()}
        perspective="work" onPerspectiveChange={vi.fn()} autoFollow onAutoFollowChange={vi.fn()}
        novelId="novel" novels={[]} sessionId={null} />
    </>
  }
  render(<QueryClientProvider client={client}><Workspace /></QueryClientProvider>)
}

it('shares the rail balance request, shows only the actual allowance denominator, and reads seven recorded days', async () => {
  openSettings('usage', true)
  expect(screen.getByText('正在读取额度余额…')).toBeTruthy()
  const balance = await screen.findByRole('region', { name: '额度余额' })
  expect(balance.textContent).toContain('335 Credits')
  expect(balance.textContent).toContain('账面余额 350 · 待结算预留 15 Credits')
  expect(within(balance).getAllByRole('meter')).toHaveLength(1)
  const meter = within(balance).getByRole('meter', { name: '每日额度剩余' })
  expect([meter.getAttribute('value'), meter.getAttribute('max')]).toEqual(['300', '400'])
  expect(meter.getAttribute('aria-valuetext')).toBe('剩余 75%')
  expect(balance.textContent).toContain('15:00')
  expect(balance.textContent).toContain('奖励额度50 Credits长期有效')
  const chart = await screen.findByRole('group', { name: '每日 Credits 消耗' })
  expect(within(chart).getAllByRole('button')).toHaveLength(7)
  expect(screen.getByText('近 7 天消耗').parentElement?.textContent).toContain('29 Credits')
  fireEvent.click(within(chart).getByRole('button', { name: /2026-11-25/ }))
  expect(screen.getByText('11/25 · 20 Credits · 2 次计费')).toBeTruthy()
  expect(fetchCreditSummary).toHaveBeenCalledTimes(1)
  expect(fetchCreditUsage).not.toHaveBeenCalled()
})

it('searches categories and reads the ledger on demand, preserving positive, negative and empty filters', async () => {
  openSettings('general')
  const [desktop] = screen.getAllByRole('navigation', { name: '设置导航' })
  fireEvent.change(screen.getAllByRole('textbox', { name: '搜索设置' })[0], { target: { value: '流水' } })
  expect(within(desktop).getAllByRole('button')).toHaveLength(1)
  fireEvent.click(within(desktop).getByRole('button', { name: '使用情况' }))
  expect(await screen.findByRole('heading', { level: 1, name: '使用情况' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '额度流水' }))
  const search = await screen.findByText('联网搜索')
  expect(search.closest('li')?.textContent).toContain('−2')
  const select = screen.getByRole('combobox', { name: '流水类型' })
  fireEvent.change(select, { target: { value: 'in' } })
  expect(screen.queryByText('联网搜索')).toBeNull()
  expect(screen.getByText('创作回归奖励').closest('li')?.textContent).toContain('+12')
  fireEvent.change(select, { target: { value: 'out' } })
  expect(screen.queryByText('创作回归奖励')).toBeNull()
  expect(screen.getByRole('link', { name: '账户用量明细' }).getAttribute('href')).toBe('/account/usage')
})

it('keeps failed data distinct from zero, retries each resource, and never shows a reset or meter without a daily quota', async () => {
  vi.mocked(fetchCreditSummary).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
    ...account, plan: 'free', planLabel: '免费版', publicBetaEnabled: false, dailyAllowance: 0, dailyUsed: 0, dailyRemaining: 0,
    bonusRemaining: 10, reserved: 0, balance: 10, totalRemaining: 10,
  })
  vi.mocked(fetchCreditActivity).mockResolvedValueOnce({ account, stats: { ...activity.stats, activity: [] } })
  vi.mocked(fetchCreditUsage).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ account, ledger: [] })
  openSettings('usage')
  const error = await screen.findByRole('alert')
  expect(screen.queryByRole('region', { name: '额度余额' })).toBeNull()
  expect(await screen.findByText('最近 7 天没有消耗记录')).toBeTruthy()
  fireEvent.click(within(error).getByRole('button', { name: '重试' }))
  const balance = await screen.findByRole('region', { name: '额度余额' })
  expect(balance.textContent).toContain('10 Credits')
  expect(balance.textContent).not.toMatch(/重置|NaN|\/ 0 Credits/)
  expect(within(balance).queryByRole('meter')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '额度流水' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '无法更新额度流水重试')
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('暂无额度流水')).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: '流水类型' }), { target: { value: 'in' } })
  expect(screen.getByText('暂无收入记录')).toBeTruthy()
})
