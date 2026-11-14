// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'

import { ApiClientError, requestJson } from '@/app/api-client'
import StudioSettingsDialog, { type StudioSettingsSection } from '@/features/studio/components/StudioSettingsDialog'
import { agentPersonalizationQueryKey } from '@/features/studio/personalization-api'
import { useShellStore } from '@/store/useShellStore'
import type { User } from '../../shared/contracts'
import {
  DEFAULT_AGENT_PERSONALIZATION_SETTINGS,
  type AgentPersonalizationMemory,
  type AgentPersonalizationMemoriesPayload,
  type AgentPersonalizationPayload,
  type PatchAgentPersonalization,
} from '../../shared/contracts/agent-personalization'

vi.mock('@/app/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('@/app/api-client')>(),
  requestJson: vi.fn(),
}))
vi.mock('@/features/studio/agent/components/AgentOperationsCenter', () => ({ default: () => null }))
vi.mock('@/features/account/CustomModelSettingsDialog', () => ({ CustomModelSettingsContent: () => null }))

const settingsUrl = '/api/agent/personalization'
const memoriesUrl = settingsUrl + '/memories'
const focusUser: User = {
  id: 'author', nickname: '作者', avatarUrl: null, email: null, phone: null, passwordConfigured: true,
  followerCount: 0, followingCount: 0, novelCount: 0, postCount: 0, unreadMessageCount: 0,
  unreadNotificationCount: 0, createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z',
}
const day = '2026-11-14T02:30:00Z'
const originalMemory: AgentPersonalizationMemory = {
  id: 'item-1', text: '对话记忆', source: 'conversation', revision: 1, createdAt: day, updatedAt: day,
}
let settings: AgentPersonalizationPayload
let list: AgentPersonalizationMemoriesPayload
let client: QueryClient

function respond(path: string, init?: RequestInit) {
  const url = new URL(path, 'https://example.test')
  const method = init?.method ?? 'GET'
  const revision = url.searchParams.get('expectedRevision')
  if (url.pathname === settingsUrl) {
    if (method === 'GET') return settings
    const { expectedRevision, ...patch } = JSON.parse(String(init?.body)) as PatchAgentPersonalization
    if (expectedRevision !== settings.revision) throw new ApiClientError('设置已更改。', 409)
    settings = { settings: { ...settings.settings, ...patch }, revision: settings.revision + 1 }
    return settings
  }
  if (url.pathname === memoriesUrl) {
    if (method === 'GET') return list
    if (method === 'POST') {
      const { text } = JSON.parse(String(init?.body)) as { text: string }
      const created = { ...originalMemory, id: 'item-2', text, source: 'manual' as const }
      list = { memories: [created, ...list.memories], revision: list.revision + 1 }
      return created
    }
    if (revision !== String(list.revision)) throw new ApiClientError('记忆列表已更改。', 409)
    list = { memories: [], revision: list.revision + 1 }
    return { revision: list.revision }
  }
  const id = url.pathname.split('/').at(-1)
  const existing = list.memories.find(item => item.id === id)
  if (!existing) throw new ApiClientError('记忆已删除。', 404)
  if (method === 'DELETE') {
    if (revision !== String(existing.revision)) throw new ApiClientError('记忆已更改。', 409)
    list = { memories: list.memories.filter(item => item.id !== id), revision: list.revision + 1 }
    return { revision: list.revision }
  }
  const { text, expectedRevision } = JSON.parse(String(init?.body)) as { text: string; expectedRevision: number }
  if (expectedRevision !== existing.revision) throw new ApiClientError('记忆已更改。', 409)
  const updated = { ...existing, text, revision: existing.revision + 1 }
  list = { memories: list.memories.map(item => item.id === id ? updated : item), revision: list.revision + 1 }
  return updated
}

function renderSettings(initialSection: StudioSettingsSection = 'personalization') {
  const onClose = vi.fn()
  function Harness() {
    const [section, setSection] = useState(initialSection)
    return <StudioSettingsDialog open section={section} onSectionChange={setSection} onClose={onClose}
      perspective="work" onPerspectiveChange={vi.fn()} autoFollow={false} onAutoFollowChange={vi.fn()}
      novelId="novel" novels={[]} sessionId={null} />
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  return onClose
}

beforeEach(() => {
  useShellStore.setState({ authStatus: 'authenticated', sessionUser: focusUser })
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  settings = { settings: { ...DEFAULT_AGENT_PERSONALIZATION_SETTINGS }, revision: 0 }
  list = { memories: [originalMemory], revision: 1 }
  vi.mocked(requestJson).mockImplementation(async <T,>(path: string, init?: RequestInit) => respond(path, init) as T)
})

afterEach(() => {
  cleanup()
  client.clear()
  useShellStore.setState({ authStatus: 'checking', sessionUser: null })
  vi.resetAllMocks()
})

it('exposes personalization on desktop and mobile and refreshes untouched fields without dropping the draft', async () => {
  renderSettings('general')
  const [desktop, mobile] = screen.getAllByRole('navigation', { name: '设置导航' })
  expect(within(desktop).getByRole('button', { name: /个性化/ })).toBeTruthy()
  fireEvent.click(within(mobile).getByRole('button', { name: '个性化' }))
  const name = await screen.findByRole<HTMLInputElement>('textbox', { name: '希望 Agent 如何称呼你' })
  const style = screen.getByRole<HTMLSelectElement>('combobox', { name: '基础风格' })
  const memorySwitch = screen.getByRole('switch', { name: '全局记忆' })
  expect(memorySwitch.getAttribute('aria-checked')).toBe('true')
  fireEvent.change(name, { target: { value: '北海' } })
  fireEvent.change(style, { target: { value: 'direct' } })
  expect(screen.getByText(/把门后的声响放到开头/)).toBeTruthy()
  settings = { settings: { ...settings.settings, aboutMe: '正在写悬疑小说' }, revision: 1 }
  await act(async () => { await client.invalidateQueries({ queryKey: agentPersonalizationQueryKey }) })
  await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '希望 Agent 了解的创作背景' }).value).toBe('正在写悬疑小说'))
  expect(name.value).toBe('北海')
  expect(style.value).toBe('direct')
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '已刷新最新设置，请核对后重试。')
  expect(name.value).toBe('北海')
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  expect(await screen.findByText('已保存个性化设置。')).toBeTruthy()
  expect(settings.settings).toMatchObject({ preferredName: '北海', style: 'direct', aboutMe: '正在写悬疑小说' })
})

it('toggles memory independently and manages items while memory is off, with confirmation for removals', async () => {
  const onClose = renderSettings()
  const instructions = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '自定义指令' })
  fireEvent.change(instructions, { target: { value: '改写前先给出建议。' } })
  const memorySwitch = screen.getByRole('switch', { name: '全局记忆' })
  fireEvent.click(memorySwitch)
  await waitFor(() => expect(memorySwitch.getAttribute('aria-checked')).toBe('false'))
  expect(settings.settings.customInstructions).toBe('')
  expect(instructions.value).toBe('改写前先给出建议。')
  expect((await screen.findByText('来自对话', { exact: false })).querySelector('time')?.dateTime).toBe(day)

  fireEvent.click(screen.getByRole('button', { name: '添加记忆' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新记忆' }), { target: { value: '手动记忆' } })
  fireEvent.click(screen.getByRole('button', { name: '保存记忆' }))
  const savedMemories = screen.getByRole('list', { name: '已保存的记忆' })
  const manual = (await within(savedMemories).findByText('手动记忆')).closest('li')!
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '新记忆' })).toBeNull())
  expect(within(manual).getByText('手动添加', { exact: false })).toBeTruthy()
  fireEvent.click(within(manual).getByRole('button', { name: '编辑' }))
  fireEvent.change(screen.getByRole('textbox', { name: '编辑记忆' }), { target: { value: '手动记忆修改后' } })
  fireEvent.click(screen.getByRole('button', { name: '保存记忆' }))
  await within(savedMemories).findByText('手动记忆修改后')
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑记忆' })).toBeNull())
  fireEvent.click(within(manual).getByRole('button', { name: '删除' }))
  const deleteDialog = screen.getByRole('dialog', { name: '删除这条记忆？' })
  fireEvent.click(within(deleteDialog).getByRole('button', { name: '删除记忆' }))
  await waitFor(() => expect(screen.queryByText('手动记忆修改后')).toBeNull())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  const clear = screen.getByRole('button', { name: '清空记忆' })
  fireEvent.click(clear)
  const clearDialog = screen.getByRole('dialog', { name: '清空全局记忆？' })
  expect(clearDialog.className).toContain('z-[210]')
  fireEvent.keyDown(within(clearDialog).getByRole('button', { name: '取消' }), { key: 'Escape' })
  expect(onClose).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(clear)
  expect(list.memories).toHaveLength(1)
  fireEvent.click(clear)
  fireEvent.click(within(screen.getByRole('dialog', { name: '清空全局记忆？' })).getByRole('button', { name: '确认清空' }))
  await screen.findByText('还没有保存的记忆。')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(list.memories).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  await screen.findByText('已保存个性化设置。')
  expect(settings.settings).toMatchObject({ customInstructions: '改写前先给出建议。', memoryEnabled: false })
})

it('requires a fresh confirmation if a memory arrives while clear-all is open', async () => {
  renderSettings()
  fireEvent.click(await screen.findByRole('button', { name: '清空记忆' }))
  list = { memories: [...list.memories, { ...originalMemory, id: 'item-2', text: '刚保存的记忆' }], revision: 2 }
  await act(async () => { await client.invalidateQueries({ queryKey: agentPersonalizationQueryKey }) })
  fireEvent.click(within(screen.getByRole('dialog', { name: '清空全局记忆？' })).getByRole('button', { name: '确认清空' }))
  expect(await screen.findByText('记忆列表已更改。')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(await screen.findByText('刚保存的记忆')).toBeTruthy()
  expect(list.memories).toHaveLength(2)
})
