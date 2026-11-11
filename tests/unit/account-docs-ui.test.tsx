// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'

import AccountDocsPage from '../../src/features/account/AccountDocsPage'

const mocks = vi.hoisted(() => ({ policy: vi.fn() }))
vi.mock('../../src/features/account/credits-api', () => ({ fetchPublicCreditPolicy: mocks.policy }))
vi.mock('../../src/features/account/AccountLayout', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('../../src/features/site-content/public-api', () => ({ usePublicSiteContent: () => ({ data: undefined }) }))

afterEach(cleanup)

it('opens the account security help even if the public Credits policy cannot be read', async () => {
  mocks.policy.mockRejectedValue(new Error('policy unavailable'))
  const scrollIntoView = vi.fn()
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  try {
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/account/docs?doc=faq#doc-security']}>
      <AccountDocsPage />
    </MemoryRouter></QueryClientProvider>)

    await waitFor(() => expect(client.getQueryState(['credits', 'public-policy'])?.status).toBe('error'))
    expect(screen.getByRole('heading', { name: '常见问题' })).toBeTruthy()
    const security = screen.getByRole('heading', { name: '如何验证邮箱、手机号或修改密码' })
    expect(security.id).toBe('doc-security')
    expect(scrollIntoView.mock.instances[0]).toBe(security)
    expect(screen.getByText(/可以验证原地址/)).toBeTruthy()
    expect(screen.queryByText(/等待每日 15:00/)).toBeNull()

    fireEvent.change(screen.getByRole('combobox', { name: '选择文档' }), { target: { value: 'plan' } })
    expect(await screen.findByText('暂时无法读取当前套餐政策。')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '免费版套餐' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '公测版套餐' })).toBeNull()

    act(() => { client.setQueryData(['credits', 'public-policy'], { publicBetaEnabled: true, publicBetaRevision: 2, planLabel: '公测版' }) })
    expect(await screen.findByRole('heading', { name: '公测版套餐' })).toBeTruthy()
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original)
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
})
