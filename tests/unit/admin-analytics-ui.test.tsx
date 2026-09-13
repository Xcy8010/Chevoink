// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
const request = vi.hoisted(() => vi.fn())
vi.mock('../../src/app/api-client', () => ({ requestJson: request }))
import AdminAnalytics from '../../src/features/admin/components/AdminAnalytics'
afterEach(() => { cleanup(); vi.resetAllMocks() })
describe('admin analytics interaction', () => {
  it('expands accessible detail and requests a new period', async () => {
    request.mockResolvedValue({ labels: ['2026-09-13'], metrics: [{ key: 'users', label: '注册用户', total: 3, values: [3] }], tools: [], to: '2026-09-13T10:00:00Z' })
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AdminAnalytics scope="dashboard" /></QueryClientProvider>)
    const card = await screen.findByRole('button', { name: /注册用户/ })
    fireEvent.click(card)
    expect(card.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('table')).toBeTruthy()
    expect(document.querySelector('svg text')).toBeNull() // Axis labels must not be stretched with the SVG.
    fireEvent.click(screen.getByRole('button', { name: '本月', exact: true }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/admin/analytics?period=month&scope=dashboard'))
  })
  it('does not show 100% for empty success-rate samples', async () => {
    request.mockResolvedValue({ labels: [], metrics: [], tools: [], to: '2026-09-13T10:00:00Z' })
    render(<QueryClientProvider client={new QueryClient()}><AdminAnalytics scope="creation" /></QueryClientProvider>)
    expect(await screen.findAllByText('暂无样本')).toHaveLength(2)
    expect(screen.queryByText('100.0%')).toBeNull()
  })
})
