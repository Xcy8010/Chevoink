// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const request = vi.hoisted(() => vi.fn())
vi.mock('../../src/app/api-client', () => ({ requestJson: request }))
import { AdminCallRecords, AdminLocalHealth, AdminRunRecords } from '../../src/features/admin/components/AdminOperationsLists'
const context = { source: 'usage', snapshotAt: '2026-11-01T01:00:00Z', window: { from: '2026-10-31T16:00:00Z', to: '2026-11-01T01:00:00Z', timeZone: 'UTC+8', boundary: 'created_at' }, coverage: ['本地账务状态不是模型能力结果。'] }
function Location() { return <output aria-label="当前 URL">{useLocation().search}</output> }
function mount(element: React.ReactNode, entry = '/admin/tokens?period=month') {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}><MemoryRouter initialEntries={[entry]}>{element}<Location /></MemoryRouter></QueryClientProvider>)
}
beforeEach(() => { request.mockReset() })
afterEach(cleanup)

it('keeps billing state and unknown tokens explicit, pages on the server and preserves the shared period', async () => {
  request.mockResolvedValue({ ...context, pagination: { page: 1, pageSize: 20, total: 40, hasMore: true }, items: [{ id: 'usage-a', source: 'usage', createdAt: context.snapshotAt, action: 'workspaceAgent', model: 'synthetic-model', provider: 'synthetic-channel', runId: 'run-a', taskId: 'root-a', operationId: null, status: 'settled', outcome: 'unknown', errorCategory: null, billingStatus: 'settled', usageSource: 'unknown', requestTokens: null, responseTokens: null, cacheHitTokens: null, cacheMissTokens: null, durationMs: 42, chargedCreditsMilli: null }] })
  mount(<AdminCallRecords />, '/admin/tokens?tab=calls&period=month&source=usage')
  expect(await screen.findByText('能力结果未知')).toBeTruthy()
  expect(screen.getByText('输入 / 输出：未知 / 未知')).toBeTruthy()
  expect(screen.getByText('账务状态：已结算')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await waitFor(() => { const url = request.mock.lastCall![0]; expect(url).toContain('period=month'); expect(url).toContain('page=2') })
  expect(screen.getByLabelText('当前 URL').textContent).toContain('tab=calls')
})

it('applies identifier/model filters in the API URL, and clears unsupported model mapping on web-tool source change', async () => {
  request.mockResolvedValue({ ...context, items: [], pagination: { page: 1, pageSize: 20, total: 0, hasMore: false } })
  mount(<AdminCallRecords />)
  await waitFor(() => expect(request).toHaveBeenCalled())
  fireEvent.click(screen.getByText('更多筛选'))
  fireEvent.change(screen.getByLabelText('模型 / 档位'), { target: { value: 'model + synthetic' } })
  fireEvent.change(screen.getByLabelText('Run ID'), { target: { value: 'run-synthetic' } })
  fireEvent.click(screen.getByRole('button', { name: '应用筛选' }))
  await waitFor(() => { const url = new URL(request.mock.lastCall![0], 'https://fixture.example.com'); expect(url.searchParams.get('model')).toBe('model + synthetic'); expect(url.searchParams.get('runId')).toBe('run-synthetic') })
  fireEvent.change(screen.getByLabelText('记录来源'), { target: { value: 'web_tools' } })
  await waitFor(() => { const url = new URL(request.mock.lastCall![0], 'https://fixture.example.com'); expect(url.searchParams.get('source')).toBe('web_tools'); expect(url.searchParams.has('model')).toBe(false); expect(url.searchParams.get('runId')).toBe('run-synthetic') })
})

it('shows no-sample local observation without inventing online health, TTFT or percentiles', async () => {
  request.mockResolvedValue({ ...context, source: 'provider_attempts', observation: 'no_samples', counts: { total: 0, success: 0, failure: 0, pending: 0, cancelled: 0, unknown: 0 }, lastSampleAt: null, firstTextMs: null, p50Ms: null, p95Ms: null, tokensPerSecond: null })
  mount(<AdminLocalHealth />)
  expect(await screen.findByText('该范围无样本')).toBeTruthy()
  expect(screen.getByText(/首字响应、P50\/P95 与输出速度：未采集可靠样本/)).toBeTruthy()
  expect(screen.queryByText(/100%|在线健康|运行正常/)).toBeNull()
})

it('rejects malformed date deep-links without crashing or making a request', () => {
  mount(<AdminCallRecords />, '/admin/tokens?opsFrom=not-a-date&opsTo=2026-11-01')
  expect(screen.getByRole('alert').textContent).toContain('有效的起止日期')
  expect(request).not.toHaveBeenCalled()
})

it('shows task/run state before detail links and does not read author transcripts', async () => {
  request.mockResolvedValue({ ...context, source: 'agent_runs', pagination: { page: 1, pageSize: 20, total: 1, hasMore: false }, items: [{ id: 'run-a', taskId: 'root-a', status: 'failed', action: 'workspaceAgent', modelTier: 'speed', customModelId: null, createdAt: context.snapshotAt, startedAt: null, finishedAt: null, user: { id: 'author-a', nickname: '合成作者' }, session: { id: 'session-a', title: '合成会话' } }] })
  mount(<AdminRunRecords />, '/admin/creation-records?runId=run-a')
  const title = await screen.findByRole('heading', { name: '合成会话' })
  expect(title.closest('li')?.textContent).toContain('失败')
  fireEvent.click(screen.getByText('执行时间与详情入口'))
  expect(screen.getByRole('link', { name: '主动查看此作者的创作记录' }).getAttribute('href')).toBe('/admin/users/author-a/creation-records')
  expect(request).toHaveBeenCalledTimes(1)
  expect(request.mock.lastCall![0]).toContain('/api/admin/operations/runs?')
})
