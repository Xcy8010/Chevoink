// @vitest-environment jsdom
import { StrictMode, type PropsWithChildren } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import AppProviders from '@/app/AppProviders'
import { completeInteractiveSignIn } from '@/features/account/complete-interactive-sign-in'
import { fetchAgentSessions } from '@/features/studio/agent/agentApi'
import StudioDesktopInvite from '@/features/studio/components/StudioDesktopInvite'
import StudioUsageSettings from '@/features/studio/components/StudioUsageSettings'
import { useStudioCredits } from '@/features/studio/hooks/useStudioCredits'
import { useShellStore } from '@/store/useShellStore'
import type { CreditAccountSummary, User } from '../../shared/contracts'

vi.mock('@/components/layout/DeviceProvider', () => ({ DeviceProvider: ({ children }: PropsWithChildren) => children }))
vi.mock('@/components/ui/UpdateBanner', () => ({ default: () => null }))
vi.mock('@/lib/native-app', () => ({ restoreNativeSystemBarsToTheme: vi.fn(), isNativeApp: () => false }))
vi.mock('@/features/home/reading-sync', () => ({ hydrateReadingSync: async () => false }))

const taskKey = ['agent', 'sessions', 'workspace-navigation'] as const
const timestamp = '2026-11-25T07:00:00Z'
const user = (id: string): User => ({
  id, nickname: id, email: null, phone: null, avatarUrl: null, passwordConfigured: true,
  followerCount: 0, followingCount: 0, novelCount: 0, postCount: 0,
  unreadMessageCount: 0, unreadNotificationCount: 0, createdAt: timestamp, updatedAt: timestamp,
})
const account = (totalRemaining: number): CreditAccountSummary => ({
  plan: 'free', planLabel: '免费版', publicBetaEnabled: false, publicBetaRevision: 1,
  totalRemaining, bonusRemaining: totalRemaining, dailyAllowance: 0, dailyUsed: 0, dailyRemaining: 0,
  usedPercent: 0, periodStartedAt: timestamp, resetsAt: timestamp, resetTimeZone: 'UTC+8',
  globallyPaused: false, suspended: false, models: [],
})
const inviteUrl = (owner: string) => 'https://example.test/register?ref=' + owner
const result = (data: unknown) => Response.json({ success: true, data })
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

let client: QueryClient
function SignedInView() {
  client = useQueryClient()
  const signedIn = useShellStore(state => state.authStatus === 'authenticated')
  return signedIn ? <Workspace /> : null
}

function Workspace() {
  const summary = useStudioCredits()
  const tasks = useQuery({ queryKey: taskKey, queryFn: () => fetchAgentSessions() })
  return <>
    <output aria-label="额度余额">{summary.data?.totalRemaining}</output>
    {tasks.data?.items.map(item => <p key={item.id}>{item.title}</p>)}
    <StudioDesktopInvite onClose={() => {}} />
    <StudioUsageSettings />
  </>
}

afterEach(() => {
  cleanup()
  useShellStore.getState().setGuest()
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  vi.unstubAllGlobals()
})

it.each(['direct sign-in', 'sign-out before sign-in'])('isolates invitation, credits and tasks across accounts (%s)', async mode => {
  const ownerBReady = Promise.withResolvers<void>()
  const lateOwnerATasks = Promise.withResolvers<void>()
  const ownerARefreshStarted = Promise.withResolvers<void>()
  let owner = 'A'
  let taskRequestsA = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(input, window.location.href).pathname
    const requestOwner = owner
    if (path === '/api/users/me') return result({ user: user(requestOwner) })
    if (path === '/api/agent/sessions' && requestOwner === 'A' && ++taskRequestsA === 2) {
      ownerARefreshStarted.resolve()
      await lateOwnerATasks.promise
      return result({ items: [{ id: 'late-a', title: 'task A late' }] })
    }
    if (requestOwner === 'B') await ownerBReady.promise
    const summary = account(requestOwner === 'A' ? 111 : 222)
    switch (path) {
      case '/api/credits/summary': return result(summary)
      case '/api/credits/activity': return result({ account: summary, stats: {
        activityEndsAt: '2026-11-25', activityStartedAt: '2026-11-25',
        activity: [], cumulativeSpent: 0, totalModelCalls: 0, activeDays: 0,
      } })
      case '/api/credits/usage': return result({ account: summary, ledger: [{
        id: requestOwner, kind: 'usage', sourceType: 'model_tokens', modelLabel: 'ledger ' + requestOwner,
        delta: -1, createdAt: timestamp,
      }] })
      case '/api/credits/referral': return result({
        inviteUrl: inviteUrl(requestOwner), inviterReward: 300, inviteeReward: 120,
        successfulInvites: 0, totalEarned: 0, code: requestOwner,
      })
      case '/api/agent/sessions': return result({ items: [{ id: requestOwner, title: 'task ' + requestOwner }] })
      default: throw new Error('Unexpected request ' + path)
    }
  }))
  const writeText = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

  render(<StrictMode><AppProviders><SignedInView /></AppProviders></StrictMode>)
  expect(await screen.findByText('task A')).toBeTruthy()
  expect(await screen.findByText(inviteUrl('A'))).toBeTruthy()
  expect(screen.getByRole('status', { name: '额度余额' }).textContent).toBe('111')
  expect(writeText.mock.calls).toEqual([[inviteUrl('A')]])
  fireEvent.click(screen.getByRole('button', { name: '额度流水' }))
  expect(await screen.findByText('ledger A')).toBeTruthy()
  const clientA = client

  act(() => useShellStore.getState().syncSessionUser({
    user: { ...user('A'), nickname: 'updated A' }, unreadMessageCount: 0, unreadNotificationCount: 0,
  }))
  expect(client).toBe(clientA)
  expect(screen.getByText('ledger A')).toBeTruthy()
  expect(writeText).toHaveBeenCalledTimes(1)
  const refreshingA = clientA.refetchQueries({ queryKey: taskKey, exact: true })
  await ownerARefreshStarted.promise
  writeText.mockClear()

  if (mode === 'sign-out before sign-in') {
    act(() => useShellStore.getState().setGuest())
    expect(screen.queryByText(inviteUrl('A'))).toBeNull()
    expect(client).not.toBe(clientA)
  }
  owner = 'B'
  act(() => completeInteractiveSignIn(client, {
    user: user('B'), tokens: { accessToken: 'b', refreshToken: 'b', expiresInSeconds: 60 },
  }))
  expect(client).not.toBe(clientA)
  expect(clientA.getQueryCache().getAll()).toHaveLength(0)
  expect(screen.queryByText(inviteUrl('A'))).toBeNull()
  expect(screen.getByRole('status', { name: '额度余额' }).textContent).toBe('')
  expect(screen.queryByText('task A')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '额度流水' }))
  expect(screen.queryByText('ledger A')).toBeNull()
  expect(writeText).not.toHaveBeenCalled()

  await act(async () => ownerBReady.resolve())
  expect(await screen.findByText('task B')).toBeTruthy()
  expect(await screen.findByText('ledger B')).toBeTruthy()
  expect(await screen.findByText(inviteUrl('B'))).toBeTruthy()
  expect(screen.getByRole('status', { name: '额度余额' }).textContent).toBe('222')
  await waitFor(() => expect(writeText.mock.calls).toEqual([[inviteUrl('B')]]))

  await act(async () => {
    lateOwnerATasks.resolve()
    await refreshingA
  })
  expect(screen.getByText('task B')).toBeTruthy()
  expect(screen.queryByText('task A late')).toBeNull()
  expect(clientA.getQueryData(taskKey)).toBeUndefined()

  const clientB = client
  owner = 'A'
  act(() => {
    completeInteractiveSignIn(client, {
      user: user('A'), tokens: { accessToken: 'a', refreshToken: 'a', expiresInSeconds: 60 },
    })
    clientA.setQueryData(taskKey, { items: [{ id: 'retired-a', title: 'task A retired client' }] })
  })
  expect(client).not.toBe(clientA)
  expect(client).not.toBe(clientB)
  expect(screen.queryByText('task B')).toBeNull()
  expect(await screen.findByText('task A')).toBeTruthy()
  expect(screen.queryByText('task A retired client')).toBeNull()
})
