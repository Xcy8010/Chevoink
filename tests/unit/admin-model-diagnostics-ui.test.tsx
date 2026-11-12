// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import AdminModelDiagnostics from '../../src/features/admin/components/AdminModelDiagnostics'
import { ApiClientError } from '../../src/app/api-client'
import type { AdminModelDiagnosticResult, AdminModelDiagnosticsClient } from '../../shared/contracts/admin-model-diagnostics.js'

afterEach(cleanup)
function result(overrides: Partial<AdminModelDiagnosticResult> = {}): AdminModelDiagnosticResult {
  return { id: 'test-a', requestKey: 'test-request-1', modelConfigId: 'model-a', configRevision: '1', modelName: 'synthetic-model', provider: 'synthetic-channel', modelKind: 'text', mode: 'configuration', status: 'configuration_passed', stale: false, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:00Z', failure: null, checks: [], metrics: { responseHeadersMs: null, firstEventMs: null, firstThinkingMs: null, firstTextMs: null, totalMs: 1, outputTokens: null, tokensPerSecond: null }, fee: { identity: 'admin-diagnostic:synthetic', owner: 'platform', status: 'not_requested', currency: 'CNY', amountMicros: null, maximumMicros: null }, livePolicy: { enabled: false, maximumCostMicros: null, blockedReason: '测试单次费用上限尚未配置，仅开放本地配置检查。' }, ...overrides }
}
function client(): AdminModelDiagnosticsClient { return { start: vi.fn(async (_id, request) => result({ requestKey: request.requestKey })), get: vi.fn(async () => result()), cancel: vi.fn(async () => result({ status: 'cancelled', fee: { ...result().fee, status: 'unknown' } })) } }

it('starts one local check on double click and explains why real requests remain closed', async () => {
  const transport = client()
  render(<AdminModelDiagnostics modelConfigId="model-a" configRevision="1" client={transport} />)
  expect(transport.start).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '检查配置' })); fireEvent.click(screen.getByRole('button', { name: '检查配置' }))
  expect(await screen.findByText('测试单次费用上限尚未配置，仅开放本地配置检查。')).toBeTruthy()
  expect(transport.start).toHaveBeenCalledTimes(1)
  expect(transport.start).toHaveBeenCalledWith('model-a', expect.objectContaining({ mode: 'configuration', expectedRevision: '1', requestKey: expect.any(String) }))
  expect(screen.getByRole('button', { name: '网关访问检查' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: '最小能力请求' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getAllByText('本地配置通过 · 连接未检测')).toHaveLength(2)
  expect(screen.queryByText('本次能力检查通过')).toBeNull()
})

it('reconciles an unknown POST by the original request key and does not resend', async () => {
  const transport = client(); vi.mocked(transport.start).mockRejectedValue(new Error('synthetic-network-error'))
  render(<AdminModelDiagnostics modelConfigId="model-a" configRevision="1" client={transport} />)
  fireEvent.click(screen.getByRole('button', { name: '检查配置' }))
  expect(await screen.findByText(/请求结果尚未确认/)).toBeTruthy()
  expect(screen.getByRole('button', { name: '检查配置' }).hasAttribute('disabled')).toBe(true)
  const requestKey = vi.mocked(transport.start).mock.calls[0][1].requestKey
  vi.mocked(transport.get).mockResolvedValue(result({ requestKey }))
  fireEvent.click(screen.getByRole('button', { name: '刷新结果' }))
  await waitFor(() => expect(transport.get).toHaveBeenCalledWith('model-a', requestKey))
  expect(transport.start).toHaveBeenCalledTimes(1)
})

it('uses the original connection key after the server confirms there is no record', async () => {
  const transport = client()
  vi.mocked(transport.start).mockRejectedValueOnce(new Error('synthetic-offline'))
  vi.mocked(transport.get).mockRejectedValueOnce(new ApiClientError('未找到', 404, undefined, 'MODEL_DIAGNOSTIC_NOT_FOUND'))
  render(<AdminModelDiagnostics modelConfigId="model-a" configRevision="1" client={transport} connection={{ name: '合成模型' }} />)
  const test = screen.getByRole('button', { name: '测试连接 合成模型' })
  fireEvent.click(test)
  expect(await screen.findByText(/请求结果尚未确认/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '刷新结果' }))
  expect(await screen.findByText(/服务器暂无这次测试记录/)).toBeTruthy()
  expect(transport.start).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  fireEvent.click(test)
  await waitFor(() => expect(transport.start).toHaveBeenCalledTimes(2))
  expect(vi.mocked(transport.start).mock.calls[1]).toEqual(vi.mocked(transport.start).mock.calls[0])
})

it('marks historical results stale after configuration revision changes without requesting a new test', () => {
  const transport = client()
  const view = render(<AdminModelDiagnostics modelConfigId="model-a" configRevision="1" client={transport} initialResult={result()} />)
  fireEvent.click(screen.getByRole('button', { name: '本地配置通过 · 连接未检测' }))
  view.rerender(<AdminModelDiagnostics modelConfigId="model-a" configRevision="2" client={transport} initialResult={result()} />)
  expect(screen.getByText(/配置已改变，此结果仅供历史核对/)).toBeTruthy()
  expect(screen.getByRole('button', { name: '检测已过期' })).toBeTruthy()
  expect(transport.start).not.toHaveBeenCalled()
})

it('passes cancellation to the owner-bound record and keeps unknown fees visible', async () => {
  const transport = client()
  render(<AdminModelDiagnostics modelConfigId="model-a" configRevision="1" client={transport} initialResult={result({ mode: 'capability', status: 'running', finishedAt: null })} />)
  fireEvent.click(screen.getByRole('button', { name: '诊断进行中' }))
  fireEvent.click(screen.getByRole('button', { name: '取消诊断' }))
  await waitFor(() => expect(transport.cancel).toHaveBeenCalledWith('model-a', 'test-request-1'))
  fireEvent.click(screen.getByText('测试费用记录'))
  expect(await screen.findByText('费用：未核定，不代表免费')).toBeTruthy()
  expect(transport.start).not.toHaveBeenCalled()
})
