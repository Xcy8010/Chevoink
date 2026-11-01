// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ request: vi.fn(), tokens: vi.fn(), feedback: vi.fn(), logs: vi.fn() }))
vi.mock('../../src/app/api-client', () => ({ requestJson: mocks.request }))
vi.mock('../../src/features/admin/api', () => ({ getAdminTokenManagement: mocks.tokens, listAdminFeedbacks: mocks.feedback, listAdminAuditLogs: mocks.logs, adminLogout: vi.fn() }))
vi.mock('../../src/features/admin/admin-shared', () => ({ formatTokens: (value: number) => String(value), formatDateTime: (value: string) => value, describeAdminAction: (value: string) => value, useAdminSession: () => ({ admin: { id: 'admin-synthetic', nickname: '测试管理员' } }) }))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
import AdminDashboardPage from '../../src/features/admin/pages/AdminDashboardPage'
import AdminTokenManagementPage from '../../src/features/admin/pages/AdminTokenManagementPage'
import AdminLogsPage from '../../src/features/admin/pages/AdminLogsPage'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.tokens.mockResolvedValue({ summary: { totalTokens: 0, requestTokens: 0, responseTokens: 0, cacheHitTokens: null, cacheMissTokens: null, cacheObservedTokens: 0, users: 0, webSearchCalls: 0, imageCalls: 0 }, models: [], runs: [], runTurns: [], users: [], actions: [], trend: [] })
  mocks.request.mockImplementation(async (url: string) => url.includes('/integrations/status') ? {resources:[]} : url.includes('/operations/health') ? { source:'provider_attempts',coverage:[],snapshotAt:'2026-11-01T10:00:00Z',window:{from:'2026-11-01T00:00:00Z',to:'2026-11-02T00:00:00Z',timeZone:'UTC+8',boundary:'created_at'},observation:'no_samples',counts:{total:0,success:0,failure:0,pending:0,cancelled:0,unknown:0},lastSampleAt:null } : url.includes('supplier-balances') ? [] : { labels: [], metrics: [{ key: 'failed', label: '失败执行', total: 2, values: [] }], tools: [], cost: { knownCalls: 0, unknownCalls: 4, models: [] }, to: '2026-11-01T10:00:00Z' })
  mocks.feedback.mockResolvedValue({ counts: { pending: 3 }, items: [] })
})
afterEach(cleanup)
function mount(element: React.ReactNode, entry = '/admin') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry]}>{element}</MemoryRouter></QueryClientProvider>)
}

it('puts real attention counts before trends and labels unavailable health without inventing success', async () => {
  mount(<AdminDashboardPage />)
  expect(await screen.findByText('3 条')).toBeTruthy()
  expect(await screen.findByText('2 次')).toBeTruthy()
  expect(await screen.findByText('4 次缺价格或用量')).toBeTruthy()
  const attention = screen.getByRole('region', { name: '待办与异常' })
  expect(within(attention).getByText('未接入')).toBeTruthy()
  expect(within(attention).getByRole('link', { name: '查看待处理反馈' }).getAttribute('href')).toBe('/admin/feedback?status=pending')
  expect(attention.compareDocumentPosition(screen.getByRole('heading', { name: '平台趋势' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('keeps one period across usage tabs and fetches balances only after opening cost', async () => {
  mount(<AdminTokenManagementPage />, '/admin/tokens?period=month')
  await waitFor(() => expect(mocks.tokens).toHaveBeenCalledWith('month'))
  expect(mocks.request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '健康', exact: true }))
  expect(await screen.findByText('该范围无样本')).toBeTruthy()
  expect(mocks.request).toHaveBeenCalledWith(expect.stringContaining('/api/admin/operations/health?period=month'))
  fireEvent.click(screen.getByRole('button', { name: '成本与余额' }))
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('/api/admin/analytics?period=month&scope=cost'))
  expect(screen.getAllByRole('button', { name: '本月', exact: true })).toHaveLength(1)
  expect(screen.getByText(/未接入对账/)).toBeTruthy()
  expect(screen.queryByRole('heading', { name: '用量排行' })).toBeNull()
})

it('shows structured audit metadata, hides sensitive fields and sends complete filters to the server', async () => {
  mocks.logs.mockResolvedValue({ items: [{ id: 'log-synthetic', adminId: 'admin-a', adminNickname: '测试管理甲', action: 'model.update', targetType: 'model', targetId: 'model-a', createdAt: '2026-11-01T10:00:00Z', ip: null, detail: { revision: 2, nested: { enabled: true }, password: 'sensitive-synthetic-value' } }], pagination: { total: 1, page: 1, pageSize: 10, totalPages: 1 } })
  mount(<AdminLogsPage />, '/admin/logs?targetType=model&action=model.update')
  expect(await screen.findByText('测试管理甲')).toBeTruthy()
  fireEvent.click(screen.getByText('查看审计详情'))
  expect(screen.getByText('版本')).toBeTruthy()
  expect(screen.getByText('启用')).toBeTruthy()
  expect(screen.queryByText('sensitive-synthetic-value')).toBeNull()
  expect(screen.queryByText('[object Object]')).toBeNull()
  fireEvent.click(screen.getByText('更多筛选'))
  expect(screen.getByText(/全部筛选由服务端执行/)).toBeTruthy()
  fireEvent.change(screen.getByPlaceholderText('管理员昵称 / ID'), { target: { value: '另一位管理员' } })
  await waitFor(() => expect(mocks.logs).toHaveBeenLastCalledWith(expect.objectContaining({ targetType: 'model', action: 'model.update',operator:'另一位管理员',page:1,pageSize:10 })))
})
