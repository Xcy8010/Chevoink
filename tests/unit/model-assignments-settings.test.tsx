// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelAssignmentsPayload, PatchModelAssignments } from '../../shared/contracts/agent-model-assignments.js'
import { ApiClientError } from '../../src/app/api-client'
import ModelAssignmentsSettings from '../../src/features/studio/components/ModelAssignmentsSettings'

const api = vi.hoisted(() => ({ request: vi.fn(), summary: vi.fn(), custom: vi.fn() }))
vi.mock('../../src/app/api-client', async importOriginal => ({ ...await importOriginal<typeof import('../../src/app/api-client')>(), requestJson: api.request }))
vi.mock('../../src/features/account/credits-api', () => ({ fetchCreditSummary: api.summary, fetchCustomModels: api.custom }))
const payload = (novel = true): ModelAssignmentsPayload => ({ version: 1,
  global: { revision: 2, assignments: { chapter_writing: { modelTier: 'custom', customModelId: 'custom-a', reasoningEffort: 'low' } } },
  novel: novel ? { revision: 3, assignments: {} } : null,
  effective: { chapter_writing: { selection: { modelTier: 'custom', customModelId: 'custom-a', reasoningEffort: 'low' }, source: 'global' } },
})
let savedRows: Map<string, ModelAssignmentsPayload>
function mount(novelId = 'novel-a', novelTitle = '作品 A') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { ...render(<ModelAssignmentsSettings novelId={novelId} novelTitle={novelTitle} />, { wrapper }), client }
}
beforeEach(() => {
  vi.clearAllMocks()
  savedRows = new Map()
  api.summary.mockResolvedValue({ models: [{ tier: 'speed', label: '极速', available: true, reasoningEfforts: ['low', 'medium', 'high'], visionEnabled: false }, { tier: 'basic', label: '基础', available: true, reasoningEfforts: ['high'], visionEnabled: false }] })
  api.custom.mockResolvedValue({ models: [{ id: 'custom-a', displayName: '我的文本模型', enabled: true, reasoningEfforts: ['low', 'high'], visionEnabled: false }, { id: 'custom-v', displayName: '我的图片模型', enabled: true, reasoningEfforts: ['medium', 'high'], visionEnabled: true }] })
  api.request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const patch = JSON.parse(init.body as string) as PatchModelAssignments
      const result = payload(patch.scope === 'novel')
      const row = patch.scope === 'novel' ? result.novel! : result.global
      row.revision = patch.expectedRevision + 1
      for (const [task, choice] of Object.entries(patch.assignments)) {
        if (choice) Object.assign(row.assignments, { [task]: { ...choice, reasoningEffort: choice.reasoningEffort ?? 'high' } })
        else delete row.assignments[task as keyof typeof row.assignments]
      }
      savedRows.set(patch.scope === 'global' ? 'global' : patch.novelId!, result)
      return result
    }
    const novelId = new URL(path, 'https://fixture.test').searchParams.get('novelId')
    const result = structuredClone(savedRows.get(novelId ?? 'global') ?? payload(Boolean(novelId)))
    if (savedRows.has('global')) result.global = structuredClone(savedRows.get('global')!.global)
    return result
  })
})
afterEach(cleanup)

describe('model assignment settings', () => {
  it('inherits global choices without sending an override and saves only changed work with the novel revision', async () => {
    mount()
    const writing = await screen.findByRole('combobox', { name: '正文写作模型' })
    await waitFor(() => expect((writing as HTMLSelectElement).disabled).toBe(false))
    expect(screen.getByRole('option', { name: '跟随全局 · 我的文本模型' })).toBeTruthy()
    expect((writing as HTMLSelectElement).value).toBe('')
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(writing, { target: { value: 'custom:custom-a' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.request.mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(true))
    const patch = JSON.parse(api.request.mock.calls.find(call => call[1]?.method === 'PATCH')![1].body)
    expect(patch).toEqual({ scope: 'novel', novelId: 'novel-a', expectedRevision: 3, assignments: { chapter_writing: { modelTier: 'custom', customModelId: 'custom-a' } } })
    await waitFor(() => expect((screen.getByRole('combobox', { name: '正文写作推理强度' }) as HTMLSelectElement).value).toBe('high'))
  })
  it('uses a global scope without a novel id and allows removing a saved override', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: '全局' }))
    await waitFor(() => expect((screen.getByRole('combobox', { name: '正文写作模型' }) as HTMLSelectElement).value).toBe('custom:custom-a'))
    fireEvent.change(screen.getByRole('combobox', { name: '正文写作模型' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.request.mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(true))
    expect(JSON.parse(api.request.mock.calls.find(call => call[1]?.method === 'PATCH')![1].body)).toEqual({ scope: 'global', expectedRevision: 2, assignments: { chapter_writing: null } })
  })
  it('lists capable image models and omits internal models and unsupported custom models', async () => {
    mount()
    fireEvent.click(screen.getByText('其它工具'))
    const vision = screen.getByRole('combobox', { name: '图片理解模型' })
    await waitFor(() => expect((vision as HTMLSelectElement).disabled).toBe(false))
    expect(Array.from((vision as HTMLSelectElement).options).map(option => option.text)).toEqual(['跟随默认模型', '我的图片模型 · BYOK'])
    expect(screen.queryByRole('option', { name: '基础' })).toBeNull()
  })
  it('does not apply a late save from work A to work B', async () => {
    const view = mount()
    expect(screen.getByRole('button', { name: '当前作品（作品 A）' }).title).toBe('当前作品（作品 A）')
    await waitFor(() => expect((screen.getByRole('combobox', { name: '主 Agent模型' }) as HTMLSelectElement).disabled).toBe(false))
    let resolveSave!: (value: ModelAssignmentsPayload) => void
    api.request.mockImplementation((path: string, init?: RequestInit) => init?.method === 'PATCH' ? new Promise<ModelAssignmentsPayload>(resolve => { resolveSave = resolve }) : Promise.resolve(payload(path.includes('novelId='))))
    fireEvent.change(screen.getByRole('combobox', { name: '主 Agent模型' }), { target: { value: 'speed' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(resolveSave).toBeTypeOf('function'))
    view.rerender(<ModelAssignmentsSettings novelId="novel-b" novelTitle="  作品 B  " />)
    expect(screen.getByRole('button', { name: '当前作品（作品 B）' }).getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(api.request.mock.calls.some(call => call[0].includes('novelId=novel-b'))).toBe(true))
    await act(async () => resolveSave({ ...payload(), novel: { revision: 4, assignments: { main: { modelTier: 'speed', reasoningEffort: 'medium' } } } }))
    await waitFor(() => expect((screen.getByRole('combobox', { name: '主 Agent模型' }) as HTMLSelectElement).disabled).toBe(false))
    expect((screen.getByRole('combobox', { name: '主 Agent模型' }) as HTMLSelectElement).value).toBe('')
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('keeps the scoped draft when switching global/work tabs and updating the work label', async () => {
    const view = mount()
    await waitFor(() => expect((screen.getByRole('combobox', { name: '主 Agent模型' }) as HTMLSelectElement).disabled).toBe(false))
    fireEvent.change(screen.getByRole('combobox', { name: '主 Agent模型' }), { target: { value: 'speed' } })
    fireEvent.click(screen.getByRole('button', { name: '全局' }))
    view.rerender(<ModelAssignmentsSettings novelId="novel-a" novelTitle="   " />)
    fireEvent.click(screen.getByRole('button', { name: '当前作品（未命名作品）' }))
    expect((screen.getByRole('combobox', { name: '主 Agent模型' }) as HTMLSelectElement).value).toBe('speed')
    view.rerender(<ModelAssignmentsSettings novelId="novel-a" novelTitle="新作品名称" />)
    expect(screen.getByRole('button', { name: '当前作品（新作品名称）' }).title).toBe('当前作品（新作品名称）')
    expect((screen.getByRole('combobox', { name: '主 Agent模型' }) as HTMLSelectElement).value).toBe('speed')
    expect(api.request.mock.calls.filter(call => call[1]?.method === 'PATCH')).toHaveLength(0)
  })
  it('retains the draft after a revision conflict and requires another explicit save', async () => {
    mount()
    await waitFor(() => expect((screen.getByRole('combobox', { name: '主 Agent模型' }) as HTMLSelectElement).disabled).toBe(false))
    const original = api.request.getMockImplementation()!
    api.request.mockImplementation((path: string, init?: RequestInit) => init?.method === 'PATCH' ? Promise.reject(new ApiClientError('设置已更新，请核对后重试。', 409)) : original(path, init))
    fireEvent.change(screen.getByRole('combobox', { name: '主 Agent模型' }), { target: { value: 'speed' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '设置已更新，请核对后重试。')
    await waitFor(() => expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getByRole('combobox', { name: '主 Agent模型' }) as HTMLSelectElement).value).toBe('speed')
    expect(api.request.mock.calls.filter(call => call[1]?.method === 'PATCH')).toHaveLength(1)
  })
})
