// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn(), reorder: vi.fn(), update: vi.fn() }))
vi.mock('../../src/features/admin/api', () => ({ getAdminModelManagement: mocks.get, createAdminModel: mocks.create, reorderAdminModels: mocks.reorder, updateAdminModel: mocks.update }))
import AdminModelsPage from '../../src/features/admin/pages/AdminModelsPage'
import { WeightedRoutesEditor } from '../../src/features/admin/components/WeightedRoutesEditor'
const row = (id: string, tier: 'speed' | 'builtin_0123456789abcdef', displayName: string) => ({ id, tier, displayName, sortOrder: 0, modelKind: 'text', provider: 'openai', modelName: 'fixture', baseUrl: 'https://fixture.invalid/v1', multiplier: 1,
  enabled: true, selectable: true, isDefault: id === 'a', apiKeyConfigured: true, requestCount: 0, requestTokens: 0, responseTokens: 0,
  reasoningEfforts: ['high'], defaultReasoningEffort: 'high', visionEnabled: false, contextWindowTokens: 128000, configurationReady: true, updatedAt: '' })
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } }); return render(<QueryClientProvider client={client}><AdminModelsPage /></QueryClientProvider>) }
beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue({ models: [row('a', 'speed', '极速'), row('b', 'builtin_0123456789abcdef', '动态模型')], trend: [] }); mocks.create.mockResolvedValue({ id: 'new', tier: 'builtin_fedcba9876543210' }); mocks.reorder.mockResolvedValue({ ok: true }); mocks.update.mockResolvedValue({ ok: true }) })
afterEach(cleanup)
it('restores and saves builtin protocol declarations without replacing unknown capabilities with guesses', async () => {
  mocks.get.mockResolvedValue({ models: [{ ...row('a', 'speed', '极速'), reasoningParameterMode: 'native', outputTokenParameter: 'max_completion_tokens', thinkingEnabled: false }], trend: [] })
  mount(); await screen.findByText('极速')
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  expect((screen.getByRole('combobox', { name: '推理参数协议' }) as HTMLSelectElement).value).toBe('native')
  expect((screen.getByRole('combobox', { name: '输出上限参数' }) as HTMLSelectElement).value).toBe('max_completion_tokens')
  expect((screen.getByRole('combobox', { name: 'thinking 参数' }) as HTMLSelectElement).value).toBe('disabled')
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('a', expect.objectContaining({ reasoningParameterMode: 'native', outputTokenParameter: 'max_completion_tokens', thinkingEnabled: false })))
})
it('edits Fetch as an independent tool and submits its dedicated endpoint without changing the text catalog', async () => {
  mocks.get.mockResolvedValue({ models: [{ ...row('fetch', 'speed', 'Fetch tool'), tier: 'tool_fetch', modelKind: 'web_fetch',
    provider: 'deepseek', modelName: 'deepseek-fetch', baseUrl: 'https://api.deepseek.com', selectable: false, isDefault: false }], trend: [] })
  mount()
  const title = await screen.findByText('Fetch tool')
  expect(screen.getByText('网页抓取')).toBeTruthy()
  expect(screen.getByText(/2 Credits \/ 成功请求/)).toBeTruthy()
  fireEvent.click(title.closest('section')!.querySelector('button')!)
  expect(screen.getByText(/Search 与 Fetch 独立配置/)).toBeTruthy()
  fireEvent.change(document.querySelector('[name="model-multiplier-fetch"]')!, { target: { value: '1.25' } })
  expect(screen.getByText(/保存后费用：2.5 Credits/)).toBeTruthy()
  fireEvent.change(document.querySelector('[name="model-endpoint-fetch"]')!, { target: { value: 'https://api.deepseek.com/v1/tools/fetch' } })
  fireEvent.click(document.querySelector('section.fixed button') ?? screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('fetch', expect.objectContaining({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1/tools/fetch', apiKey: undefined, multiplier: 1.25 })))
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.reorder).not.toHaveBeenCalled()
})
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
it('edits image quality on a free-form relay alias, saves custom values and restores them after refresh', async () => {
  let image = { ...row('image', 'speed', '图片生成模型'), modelKind: 'image_generation', tier: 'tool_image', provider: 'relay-provider',
    modelName: 'free-image-alias', imageQuality: { supportedValues: ['auto', 'high', 'proxy-old'], defaultValue: 'proxy-old' as string | null } }
  mocks.get.mockImplementation(async () => ({ models: [image], trend: [] }))
  mocks.update.mockImplementation(async (_id: string, payload: Record<string, unknown>) => { image = { ...image, ...payload }; return { ok: true } })
  mount(); await screen.findByText('图片生成模型')
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  expect(screen.queryByRole('combobox', { name: '推理参数协议' })).toBeNull()
  expect(screen.getByText('较高质量通常增加耗时和费用，具体取决于上游。')).toBeTruthy()
  expect((screen.getByRole('combobox', { name: '默认图片质量' }) as HTMLSelectElement).value).toBe('proxy-old')
  for (const name of ['自动 (auto)', '低 (low)', '中 (medium)', '高 (high)', '超高 (xhigh)', '最高 (max)']) expect(screen.getByRole('checkbox', { name })).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: '模型 ID' }), { target: { value: 'renamed-unlisted-relay' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '最高 (max)' }))
  fireEvent.change(screen.getByRole('textbox', { name: '自定义质量值（逗号分隔）' }), { target: { value: 'proxy-ultra-v2, other-quality' } })
  fireEvent.change(screen.getByRole('combobox', { name: '默认图片质量' }), { target: { value: 'proxy-ultra-v2' } })
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('image', expect.objectContaining({ modelName: 'renamed-unlisted-relay',
    imageQuality: { supportedValues: ['auto', 'high', 'max', 'proxy-ultra-v2', 'other-quality'], defaultValue: 'proxy-ultra-v2' } })))
  expect(mocks.update.mock.calls[0][1]).not.toHaveProperty('imageQualityCustomValues')
  await waitFor(() => expect(screen.queryByRole('button', { name: '保存配置' })).toBeNull())
  await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(1))
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  expect((screen.getByRole('combobox', { name: '默认图片质量' }) as HTMLSelectElement).value).toBe('proxy-ultra-v2')
  expect((screen.getByRole('textbox', { name: '自定义质量值（逗号分隔）' }) as HTMLInputElement).value).toBe('proxy-ultra-v2, other-quality')
  expect((screen.getByRole('checkbox', { name: '最高 (max)' }) as HTMLInputElement).checked).toBe(true)
  fireEvent.change(screen.getByRole('combobox', { name: '默认图片质量' }), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith('image', expect.objectContaining({ imageQuality: {
    supportedValues: ['auto', 'high', 'max', 'proxy-ultra-v2', 'other-quality'], defaultValue: null,
  } })))
})
it('keeps legacy image quality undeclared when its existing model is saved without changing quality', async () => {
  mocks.get.mockResolvedValue({ models: [{ ...row('legacy-image', 'speed', '旧图片模型'), tier: 'tool_image', modelKind: 'image_generation' }], trend: [] })
  mount(); await screen.findByText('旧图片模型')
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  expect((screen.getByRole('combobox', { name: '默认图片质量' }) as HTMLSelectElement).value).toBe('')
  expect(screen.getByRole('option', { name: '不传此参数' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce())
  expect(JSON.parse(JSON.stringify(mocks.update.mock.calls[0][1]))).not.toHaveProperty('imageQuality')
})

it('edits independent weighted candidates and restores server IDs after refresh without changing legacy routes or protocols', async () => {
  const oldRoute = { id: '11111111-1111-4111-8111-111111111111', label: '原线路', provider: 'old-relay', modelName: 'old-alias', baseUrl: 'https://old.invalid', enabled: true, apiKeyConfigured: true }
  let model = { ...row('a', 'speed', '权重测试'), routes: [oldRoute], weightedRoutes: { primaryWeight: 100, candidates: [] as Array<Record<string, unknown>> } }
  mocks.get.mockImplementation(async () => ({ models: [model], trend: [] }))
  mocks.update.mockImplementation(async (_id: string, payload: Record<string, unknown>) => {
    const config = payload.weightedRoutes as { primaryWeight: number; candidates: Array<Record<string, unknown>> }
    model = { ...model, weightedRoutes: { primaryWeight: config.primaryWeight,
      candidates: config.candidates.map(({ apiKey: _secret, ...route }) => ({ ...route, id: 'server-stable-id', apiKeyConfigured: true })) } }
    return { ok: true }
  })
  mount(); await screen.findByText('权重测试'); fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  expect(screen.getByRole('spinbutton', { name: '主配置及原线路的入口概率 (%)' }).getAttribute('value')).toBe('100')
  expect(screen.queryByRole('textbox', { name: '权重线路名称' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '添加权重线路' }))
  fireEvent.change(screen.getByRole('spinbutton', { name: '主配置及原线路的入口概率 (%)' }), { target: { value: '40' } })
  fireEvent.change(screen.getByRole('spinbutton', { name: '线路入口概率 (%)' }), { target: { value: '60' } })
  fireEvent.change(screen.getByRole('textbox', { name: '权重线路供应商' }), { target: { value: 'custom-provider' } })
  fireEvent.change(screen.getByRole('textbox', { name: '权重线路模型 ID' }), { target: { value: 'free-form/model-alias' } })
  fireEvent.change(screen.getByRole('textbox', { name: '权重线路 Base URL' }), { target: { value: 'https://free.invalid/custom' } })
  fireEvent.change(screen.getByLabelText('权重线路 API Key'), { target: { value: 'offline-weighted-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('a', expect.objectContaining({ weightedRoutes: { primaryWeight: 40, candidates: [expect.objectContaining({
    weight: 60, provider: 'custom-provider', modelName: 'free-form/model-alias', apiKey: 'offline-weighted-secret', baseUrl: 'https://free.invalid/custom',
  })] }, routes: [expect.objectContaining({ id: oldRoute.id, enabled: true, provider: oldRoute.provider })] })))
  await waitFor(() => expect(screen.queryByRole('button', { name: '保存配置' })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  expect(screen.getByRole('spinbutton', { name: '主配置及原线路的入口概率 (%)' }).getAttribute('value')).toBe('40')
  expect(screen.getByLabelText('权重线路 API Key').getAttribute('value')).toBe('')
  fireEvent.change(screen.getByRole('textbox', { name: '权重线路名称' }), { target: { value: '编辑后线路' } })
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith('a', expect.objectContaining({ weightedRoutes: { primaryWeight: 40, candidates: [expect.objectContaining({ id: 'server-stable-id', label: '编辑后线路' })] } })))
  await waitFor(() => expect(screen.queryByRole('button', { name: '保存配置' })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: '编辑' })); fireEvent.click(screen.getByRole('button', { name: '移除权重线路' }))
  expect(screen.getByRole('spinbutton', { name: '主配置及原线路的入口概率 (%)' }).getAttribute('value')).toBe('100')
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith('a', expect.objectContaining({ weightedRoutes: { primaryWeight: 100, candidates: [] } })))
})

it('displays the same exact decimal total used by weighted input validation', () => {
  const defaults = { provider: 'custom', modelName: 'alias', baseUrl: 'https://fixture.invalid' }
  render(<WeightedRoutesEditor defaults={defaults} onChange={vi.fn()} value={{ primaryWeight: 0.01,
    candidates: [0.01, 99.98].map(weight => ({ ...defaults, label: '线路', weight })) }} />)
  expect(screen.getByText('合计 100%')).toBeTruthy()
})
