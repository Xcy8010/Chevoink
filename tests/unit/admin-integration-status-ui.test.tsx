// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import AdminIntegrationStatus from '../../src/features/admin/components/AdminIntegrationStatus'
import type { AdminGatewaySnapshot, AdminIntegrationClient, AdminIntegrationExportRequest, AdminIntegrationResourceStatus, AdminIntegrationStatusPayload } from '../../shared/contracts/admin-integrations.js'

afterEach(cleanup)
const window = { from: '2026-10-31T16:00:00Z', to: '2026-11-01T16:00:00Z' }
function fixture() {
  const resources = (['model_metadata','usage','gateway_charges','gateway_health'] as const).map(resource => ({ resource, state: 'blocked' as AdminIntegrationResourceStatus['state'], canRead: false, blockingReasons: ['未配置只读适配器。','专属来源和请求标识尚未核实。'], lastAttemptAt: null, lastSuccessAt: null, failureReason: null, snapshot: null, retention: 'process_memory' as const })) as AdminIntegrationResourceStatus[]
  const payload: AdminIntegrationStatusPayload = { source: 'yunshu_read_only', observedAt: '2026-11-01T01:00:00Z', resources, mappings: [], system: { applicationName: '启创墨域', releaseVersion: null, releaseVersionSource: 'not_available', checkedAt: '2026-11-01T01:00:00Z', coverage: [] }, deferred: [{ area: 'announcements', state: 'contract_only', reason: '公告缺少持久化契约，未接入。' }] }
  const client: AdminIntegrationClient = { status: vi.fn(async () => payload), read: vi.fn(async request => payload.resources.find(item => item.resource === request.resource)!) }
  return { payload, client }
}
function mount(client: AdminIntegrationClient, onExport?: (request: AdminIntegrationExportRequest) => Promise<void>) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}><AdminIntegrationStatus client={client} window={window} onExport={onExport} /></QueryClientProvider>)
}
function snapshot(resource: 'gateway_charges' | 'gateway_health'): AdminGatewaySnapshot {
  return { resource, window, observedAt: '2026-11-01T01:00:00Z', scope: { kind: resource === 'gateway_health' ? 'gateway_wide' : 'chevoink_exclusive', sourceIdentity: null, group: null, verifiedAt: null }, coverage: 'partial', pricingVersion: null, models: [], aggregates: resource === 'gateway_charges' ? [{ metric: 'gateway_refund', value: null, unit: 'CNY' }] : [{ metric: 'calls', value: '4', unit: 'count' }] }
}
it('loads local status only and explains disabled external reads without implying zero cost or connectivity', async () => {
  const { client } = fixture(); mount(client)
  expect(await screen.findByText('依赖未就绪')).toBeTruthy()
  expect(screen.getByText('未配置只读适配器。')).toBeTruthy()
  expect(screen.getByRole('button', { name: '读取只读快照' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '读取只读快照' }))
  expect(client.read).not.toHaveBeenCalled()
  expect(screen.getByText(/尚无可信外部快照/)).toBeTruthy()
})
it('labels whole-gateway observations and requires an explicit read without relabeling them as local health', async () => {
  const { client, payload } = fixture()
  const health = payload.resources.find(item => item.resource === 'gateway_health')!
  Object.assign(health, { state: 'ready', canRead: true, blockingReasons: [], snapshot: snapshot('gateway_health') })
  mount(client)
  await screen.findByText('依赖未就绪')
  fireEvent.change(screen.getByLabelText('观测来源'), { target: { value: 'gateway_health' } })
  expect(screen.getByText('全网关参考，可能包含其他应用')).toBeTruthy()
  expect(client.read).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '读取只读快照' }))
  await waitFor(() => expect(client.read).toHaveBeenCalledWith({ resource: 'gateway_health', window }))
  expect(screen.queryByText('在线健康')).toBeNull()
})
it('exports no data until aggregate columns are explicitly chosen and keeps unknown values visible', async () => {
  const { client, payload } = fixture()
  const charge = payload.resources.find(item => item.resource === 'gateway_charges')!
  Object.assign(charge, { state: 'stale', canRead: true, blockingReasons: [], snapshot: snapshot('gateway_charges') })
  const exported = vi.fn(async () => {})
  mount(client, exported)
  expect(await screen.findByText('未核定 CNY')).toBeTruthy()
  fireEvent.click(screen.getByText('导出所选安全聚合列'))
  expect(screen.getByRole('button', { name: '导出已选聚合列' }).hasAttribute('disabled')).toBe(true)
  expect(exported).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: 'metric' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'value' }))
  fireEvent.click(screen.getByRole('button', { name: '导出已选聚合列' }))
  await waitFor(() => expect(exported).toHaveBeenCalledWith({ resource: 'gateway_charges', columns: ['metric','value'] }))
})
