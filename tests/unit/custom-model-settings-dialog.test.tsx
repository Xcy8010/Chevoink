// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('../../src/features/account/credits-api', () => ({
  fetchCustomModels: mocks.fetch,
  createCustomModel: mocks.create,
  updateCustomModel: mocks.update,
  deleteCustomModel: mocks.remove,
}))

import { CustomModelSettingsContent } from '../../src/features/account/CustomModelSettingsDialog'

function setup(active = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><CustomModelSettingsContent active={active} /></QueryClientProvider>)
  return { ...view, client }
}

function fillRequiredFields() {
  fireEvent.change(screen.getByRole('textbox', { name: '显示名称' }), { target: { value: '我的模型' } })
  fireEvent.change(screen.getByRole('textbox', { name: '模型 ID' }), { target: { value: 'fixture-model' } })
  fireEvent.change(screen.getByPlaceholderText('填写 API Key'), { target: { value: 'fixture-key' } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetch.mockResolvedValue({ models: [] })
  mocks.create.mockResolvedValue({ id: 'created-model' })
  mocks.update.mockResolvedValue({ ok: true })
  mocks.remove.mockResolvedValue({ ok: true })
})

afterEach(() => cleanup())

it('hides manually configured capabilities and sends only model identity settings', async () => {
  setup()
  fireEvent.click(await screen.findByRole('button', { name: '添加模型' }))

  expect(screen.queryByText('支持的推理强度')).toBeNull()
  expect(screen.queryByText('默认强度')).toBeNull()
  expect(screen.queryByText('模型支持图片输入')).toBeNull()
  expect(screen.queryByText(/保存时自动检测模型能力/)).toBeNull()

  fillRequiredFields()
  fireEvent.click(screen.getByRole('button', { name: '校验并保存' }))
  await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())

  expect(mocks.create).toHaveBeenCalledWith({
    provider: 'deepseek',
    displayName: '我的模型',
    modelName: 'fixture-model',
    baseUrl: 'https://api.deepseek.com',
    contextWindowTokens: 128000,
    enabled: true,
    apiKey: 'fixture-key',
  })
  expect(mocks.create.mock.calls[0][0]).not.toHaveProperty('reasoningEfforts')
  expect(mocks.create.mock.calls[0][0]).not.toHaveProperty('defaultReasoningEffort')
  expect(mocks.create.mock.calls[0][0]).not.toHaveProperty('visionEnabled')
})

it('shows validation progress and fences the editor while saving', async () => {
  let resolveSave!: (value: { id: string }) => void
  mocks.create.mockReturnValue(new Promise((resolve) => { resolveSave = resolve }))
  setup()
  fireEvent.click(await screen.findByRole('button', { name: '添加模型' }))
  fillRequiredFields()
  fireEvent.click(screen.getByRole('button', { name: '校验并保存' }))

  const pendingButton = await screen.findByRole('button', { name: '正在校验…' })
  expect((pendingButton as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('textbox', { name: '模型 ID' }) as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '← 返回模型列表' }) as HTMLButtonElement).disabled).toBe(true)

  await act(async () => { resolveSave({ id: 'created-model' }) })
  await waitFor(() => expect(screen.getByRole('button', { name: '添加模型' })).toBeTruthy())
})
