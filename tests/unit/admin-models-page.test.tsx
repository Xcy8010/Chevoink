// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn(), reorder: vi.fn(), update: vi.fn() }))
vi.mock('../../src/features/admin/api', () => ({ getAdminModelManagement: mocks.get, createAdminModel: mocks.create, reorderAdminModels: mocks.reorder, updateAdminModel: mocks.update }))
import AdminModelsPage from '../../src/features/admin/pages/AdminModelsPage'
const row = (id: string, tier: 'speed' | 'builtin_0123456789abcdef', displayName: string) => ({ id, tier, displayName, sortOrder: 0, modelKind: 'text', provider: 'openai', modelName: 'fixture', baseUrl: 'https://fixture.invalid/v1', multiplier: 1,
  enabled: true, selectable: true, isDefault: id === 'a', apiKeyConfigured: true, requestCount: 0, requestTokens: 0, responseTokens: 0,
  reasoningEfforts: ['high'], defaultReasoningEffort: 'high', visionEnabled: false, contextWindowTokens: 128000, configurationReady: true, updatedAt: '' })
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } }); return render(<QueryClientProvider client={client}><AdminModelsPage /></QueryClientProvider>) }
beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue({ models: [row('a', 'speed', '极速'), row('b', 'builtin_0123456789abcdef', '动态模型')], trend: [] }); mocks.create.mockResolvedValue({ id: 'new', tier: 'builtin_fedcba9876543210' }); mocks.reorder.mockResolvedValue({ ok: true }); mocks.update.mockResolvedValue({ ok: true }) })
afterEach(cleanup)
it('reuses the editor for creation with a complete expected catalog order and no UI-only form fields', async () => {
  mount(); await screen.findByText('动态模型')
  fireEvent.click(screen.getByRole('button', { name: '添加内置模型' }))
  fireEvent.change(screen.getByRole('textbox', { name: '显示名称' }), { target: { value: '新模型' } })
  fireEvent.change(screen.getByRole('textbox', { name: '模型 ID' }), { target: { value: 'new-fixture' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Base URL' }), { target: { value: 'https://fixture.invalid/v1' } })
  fireEvent.change(screen.getByPlaceholderText('必须填写后才能开放该档位'), { target: { value: 'test-key' } })
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
  expect(mocks.create.mock.calls[0][0]).toMatchObject({ displayName: '新模型', modelName: 'new-fixture', isDefault: false, expectedOrder: ['a', 'b'] })
  expect(mocks.create.mock.calls[0][0]).not.toHaveProperty('limitedFree')
  expect(mocks.update).not.toHaveBeenCalled()
})
it('keeps accessible ordering bounds, surfaces a stale-order failure and refreshes the catalog', async () => {
  mocks.reorder.mockRejectedValue(new Error('模型列表已变化'))
  mount(); await screen.findByText('动态模型')
  expect(screen.getByRole('button', { name: '上移 极速' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: '下移 动态模型' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '上移 动态模型' }))
  await screen.findByRole('alert')
  expect(mocks.reorder).toHaveBeenCalledWith(['b', 'a'], ['a', 'b'])
  expect(screen.getByRole('alert').textContent).toContain('模型列表已变化')
  await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(1))
})
it('fences another editor while a save response is pending', async () => {
  let finish!: (value: { ok: true }) => void
  mocks.update.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  mount(); await screen.findByText('动态模型')
  fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0])
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce())
  expect(screen.getAllByRole('button', { name: '编辑' }).every(button => button.hasAttribute('disabled'))).toBe(true)
  expect(screen.getByRole('button', { name: '取消' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { finish({ ok: true }) })
  await waitFor(() => expect(screen.queryByRole('button', { name: '保存配置' })).toBeNull())
})
