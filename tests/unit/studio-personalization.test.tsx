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
  type AgentPersonalizationRule,
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
const rulesUrl = settingsUrl + '/rules'
const operations = [
  { toolName: 'read_profile', title: '查看本人资料' },
  { toolName: 'edit_body', title: '修改章节正文' },
]
const focusUser: User = {
  id: 'author', nickname: '作者', avatarUrl: null, email: null, phone: null, passwordConfigured: true,
  followerCount: 0, followingCount: 0, novelCount: 0, postCount: 0, unreadMessageCount: 0,
  unreadNotificationCount: 0, createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z',
}
const day = '2026-11-14T02:30:00Z'
const recovery = '2026-12-14T02:30:00Z'
const originalMemory: AgentPersonalizationMemory = {
  id: 'item-1', text: '对话记忆', source: 'conversation', revision: 1, createdAt: day, updatedAt: day,
  pinned: false, recoveryUntil: null, lastChange: 'saved',
}
const archivedMemory: AgentPersonalizationMemory = {
  ...originalMemory, id: 'archived-1', revision: 2, text: '自动移出的记忆', recoveryUntil: recovery, lastChange: 'capacity',
}
const dialogPrototype = HTMLDialogElement.prototype
const originalShow = Object.getOwnPropertyDescriptor(dialogPrototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(dialogPrototype, 'close')
let settings: AgentPersonalizationPayload
let list: AgentPersonalizationMemoriesPayload
let client: QueryClient

function respond(path: string, init?: RequestInit) {
  const url = new URL(path, 'https://example.test')
  const method = init?.method ?? 'GET'
  const revision = Number(url.searchParams.get('expectedRevision'))
  if (url.pathname === settingsUrl) {
    if (method === 'GET') return settings
    const { expectedRevision, ...patch } = JSON.parse(String(init?.body)) as PatchAgentPersonalization
    if (expectedRevision !== settings.revision) throw new ApiClientError('设置已更改。', 409)
    settings = { ...settings, settings: { ...settings.settings, ...patch }, revision: settings.revision + 1 }
    return settings
  }
  if (url.pathname === settingsUrl + '/rule-operations') return operations
  if (url.pathname === rulesUrl) {
    const { expectedRevision, ...rule } = JSON.parse(String(init?.body)) as AgentPersonalizationRule & { expectedRevision: number }
    if (expectedRevision !== settings.revision) throw new ApiClientError('设置已更改。', 409)
    settings = { ...settings, rules: [...settings.rules.filter(item => item.toolName !== rule.toolName), rule], revision: settings.revision + 1 }
    return settings
  }
  if (url.pathname.startsWith(rulesUrl + '/')) {
    if (revision !== settings.revision) throw new ApiClientError('设置已更改。', 409)
    const toolName = url.pathname.split('/').at(-1)
    settings = { ...settings, rules: settings.rules.filter(item => item.toolName !== toolName), revision: settings.revision + 1 }
    return settings
  }
  if (url.pathname === memoriesUrl) {
    if (method === 'GET') return list
    if (method === 'POST') {
      const { text, pinned } = JSON.parse(String(init?.body)) as { text: string; pinned: boolean }
      if (list.memories.length >= 50) throw new ApiClientError('生效记忆已满。', 409)
      const created = { ...originalMemory, id: 'item-2', text, pinned, source: 'manual' as const }
      list = { ...list, memories: [created, ...list.memories], revision: list.revision + 1 }
      return created
    }
    if (revision !== list.revision) throw new ApiClientError('记忆列表已更改。', 409)
    list = { memories: [], archived: [], revision: list.revision + 1 }
    return { revision: list.revision }
  }
  const [, id, action] = url.pathname.slice(memoriesUrl.length).split('/')
  const existing = [...list.memories, ...list.archived].find(item => item.id === id)
  if (!existing) throw new ApiClientError('记忆已删除。', 404)
  if (method === 'DELETE') {
    if (revision !== existing.revision) throw new ApiClientError('记忆已更改。', 409)
    list = { memories: list.memories.filter(item => item.id !== id), archived: list.archived.filter(item => item.id !== id), revision: list.revision + 1 }
    return { revision: list.revision }
  }
  const { expectedRevision, ...changes } = JSON.parse(String(init?.body)) as { text?: string; pinned?: boolean; expectedRevision: number }
  if (expectedRevision !== existing.revision) throw new ApiClientError('记忆已更改。', 409)
  if (action === 'restore') {
    if (list.memories.length >= 50) throw new ApiClientError('生效记忆已满。', 409)
    const restored = { ...existing, revision: existing.revision + 1, lastChange: 'restored' as const, recoveryUntil: null }
    list = { memories: [restored, ...list.memories], archived: list.archived.filter(item => item.id !== id), revision: list.revision + 1 }
    return restored
  }
  const updated = { ...existing, ...changes, revision: existing.revision + 1 }
  list = { ...list, memories: list.memories.map(item => item.id === id ? updated : item), revision: list.revision + 1 }
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

async function openMemories() {
  const trigger = await screen.findByRole('button', { name: '管理已保存的记忆' })
  trigger.focus()
  fireEvent.click(trigger)
  return screen.getByRole('dialog', { name: '已保存的记忆' })
}

function cancelDialog(dialog: HTMLElement) {
  return fireEvent(dialog, new Event('cancel', { cancelable: true }))
}

beforeEach(() => {
  Object.defineProperty(dialogPrototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(dialogPrototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } })
  useShellStore.setState({ authStatus: 'authenticated', sessionUser: focusUser })
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  settings = { settings: { ...DEFAULT_AGENT_PERSONALIZATION_SETTINGS }, revision: 0, rules: [] }
  list = { memories: [originalMemory], archived: [], revision: 1 }
  vi.mocked(requestJson).mockImplementation(async <T,>(path: string, init?: RequestInit) => respond(path, init) as T)
})

afterEach(() => {
  cleanup()
  client.clear()
  useShellStore.setState({ authStatus: 'checking', sessionUser: null })
  if (originalShow) Object.defineProperty(dialogPrototype, 'showModal', originalShow)
  else Reflect.deleteProperty(dialogPrototype, 'showModal')
  if (originalClose) Object.defineProperty(dialogPrototype, 'close', originalClose)
  else Reflect.deleteProperty(dialogPrototype, 'close')
  vi.resetAllMocks()
})

it('exposes compact settings from both navigation layouts and saves tone immediately', async () => {
  renderSettings('general')
  const [desktop, mobile] = screen.getAllByRole('navigation', { name: '设置导航' })
  expect(within(desktop).getByRole('button', { name: /个性化/ })).toBeTruthy()
  fireEvent.click(within(mobile).getByRole('button', { name: '个性化' }))
  const style = await screen.findByRole<HTMLSelectElement>('combobox', { name: '基础风格和语气' })
  expect(screen.queryByText('关于你')).toBeNull()
  expect(screen.queryByText('风格预览')).toBeNull()
  expect(within(screen.getByRole('main')).queryByRole('textbox')).toBeNull()
  fireEvent.change(style, { target: { value: 'direct' } })
  await screen.findByText('已保存个性化设置。')
  expect(style.value).toBe('direct')
  expect(settings.settings.style).toBe('direct')
  expect(vi.mocked(requestJson).mock.calls.find(([url, init]) => url === settingsUrl && init?.method === 'PATCH')?.[1]?.body)
    .toBe(JSON.stringify({ expectedRevision: 0, style: 'direct' }))
})

it('keeps a reply draft on conflict and restores focus when the native dialog closes', async () => {
  const onClose = renderSettings()
  const open = await screen.findByRole('button', { name: /^回答偏好/ })
  fireEvent.click(open)
  const replyDialog = screen.getByRole('dialog', { name: '回答偏好' })
  const instructions = within(replyDialog).getByRole<HTMLTextAreaElement>('textbox', { name: '自定义指令' })
  expect(document.activeElement).toBe(instructions)
  fireEvent.change(instructions, { target: { value: '改写前先给出建议。' } })
  settings = { ...settings, settings: { ...settings.settings, customInstructions: '用最新版本。' }, revision: 1 }
  fireEvent.click(within(replyDialog).getByRole('button', { name: '保存' }))
  expect(await within(replyDialog).findByRole('alert')).toHaveProperty('textContent', '回答偏好已更新。已保留草稿，请核对最新内容后重试。')
  expect(instructions.value).toBe('改写前先给出建议。')
  expect(within(replyDialog).getByText('用最新版本。')).toBeTruthy()
  expect(within(replyDialog).getByRole('button', { name: '保存' })).toHaveProperty('disabled', true)
  fireEvent.click(within(replyDialog).getByRole('button', { name: '已核对，继续编辑' }))
  fireEvent.click(within(replyDialog).getByRole('button', { name: '保存' }))
  await screen.findByText('已保存回答偏好。')
  expect(settings.settings.customInstructions).toBe('改写前先给出建议。')
  expect(document.activeElement).toBe(open)
  fireEvent.click(open)
  cancelDialog(screen.getByRole('dialog', { name: '回答偏好' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(open)
  expect(onClose).not.toHaveBeenCalled()
})

it('manages one rule per registered operation and requires review when the revision changes', async () => {
  settings = { ...settings, rules: [{ toolName: 'edit_body', permission: 'ask' }] }
  renderSettings()
  fireEvent.click(await screen.findByRole('button', { name: /^自定义规则/ }))
  const manager = screen.getByRole('dialog', { name: '自定义规则' })
  const add = await within(manager).findByRole('button', { name: '添加规则' })
  expect(within(manager).getByText(/平台要求的确认仍然适用/)).toBeTruthy()
  await within(manager).findByText('修改章节正文')
  fireEvent.click(add)
  const addDialog = screen.getByRole('dialog', { name: '添加规则' })
  const operation = within(addDialog).getByRole('combobox', { name: '操作' })
  expect(within(operation).getAllByRole('option').map(option => option.textContent)).toEqual(['请选择操作', '查看本人资料'])
  expect(within(addDialog).getByRole('button', { name: '保存' })).toHaveProperty('disabled', true)
  fireEvent.change(operation, { target: { value: 'read_profile' } })
  fireEvent.change(within(addDialog).getByRole('combobox', { name: '执行方式' }), { target: { value: 'deny' } })
  fireEvent.click(within(addDialog).getByRole('button', { name: '保存' }))
  await within(manager).findByText('已保存自定义规则。')
  expect(settings.rules).toContainEqual({ toolName: 'read_profile', permission: 'deny' })
  await waitFor(() => expect(add).toHaveProperty('disabled', true))

  fireEvent.click(within(manager).getByRole('button', { name: '编辑规则：修改章节正文' }))
  const editor = screen.getByRole('dialog', { name: '编辑规则' })
  const mode = within(editor).getByRole<HTMLSelectElement>('combobox', { name: '执行方式' })
  fireEvent.change(mode, { target: { value: 'deny' } })
  settings = { ...settings, rules: settings.rules.map(rule => rule.toolName === 'edit_body' ? { ...rule, permission: 'allow' } : rule), revision: 2 }
  fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
  const review = await within(editor).findByRole('button', { name: '已核对，继续编辑' })
  expect(mode.value).toBe('deny')
  expect(within(editor).getByText(/当前的执行方式为「无需询问」/)).toBeTruthy()
  expect(within(editor).getByRole('button', { name: '保存' })).toHaveProperty('disabled', true)
  fireEvent.click(review)
  fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑规则' })).toBeNull())
  expect(settings.rules).toContainEqual({ toolName: 'edit_body', permission: 'deny' })

  const remove = within(manager).getByRole('button', { name: '删除规则：修改章节正文' })
  fireEvent.click(remove)
  const confirmation = screen.getByRole('dialog', { name: '删除这条规则？' })
  expect(document.activeElement).toBe(within(confirmation).getByRole('button', { name: '取消' }))
  cancelDialog(confirmation)
  expect(document.activeElement).toBe(remove)
  expect(settings.rules).toHaveLength(2)
  fireEvent.click(remove)
  fireEvent.click(within(screen.getByRole('dialog', { name: '删除这条规则？' })).getByRole('button', { name: '删除规则' }))
  await within(manager).findByText('已删除自定义规则。')
  expect(settings.rules).toEqual([{ toolName: 'read_profile', permission: 'deny' }])
})

it('can manage, pin, edit, restore and permanently delete memories while automatic memory is off', async () => {
  list = { ...list, archived: [archivedMemory, { ...archivedMemory, id: 'archived-2', text: '另一条可恢复记忆' }] }
  renderSettings()
  const memorySwitch = screen.getByRole('switch', { name: '全局记忆' })
  await waitFor(() => expect(memorySwitch.getAttribute('aria-checked')).toBe('true'))
  fireEvent.click(memorySwitch)
  await waitFor(() => expect(memorySwitch.getAttribute('aria-checked')).toBe('false'))
  const manager = await openMemories()
  expect(await within(manager).findByText('1 / 50 条生效记忆')).toBeTruthy()
  expect((await within(within(manager).getByRole('list', { name: '生效记忆' })).findByText(/来自对话/)).querySelector('time')?.dateTime).toBe(day)
  fireEvent.click(within(manager).getByRole('button', { name: '添加记忆' }))
  const addDialog = screen.getByRole('dialog', { name: '添加记忆' })
  fireEvent.change(within(addDialog).getByRole('textbox', { name: '新记忆' }), { target: { value: '手动记忆' } })
  fireEvent.click(within(addDialog).getByRole('checkbox', { name: '固定这条记忆' }))
  fireEvent.click(within(addDialog).getByRole('button', { name: '保存记忆' }))
  const active = within(manager).getByRole('list', { name: '生效记忆' })
  const manual = (await within(active).findByText('手动记忆')).closest('li')!
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '添加记忆' })).toBeNull())
  expect(within(manual).getByText(/已固定 · 手动添加/)).toBeTruthy()
  fireEvent.click(within(manual).getByRole('button', { name: '取消固定' }))
  await within(manual).findByRole('button', { name: '固定' })
  expect(list.memories[0].pinned).toBe(false)
  await waitFor(() => expect(within(manual).getByRole('button', { name: '编辑' })).toHaveProperty('disabled', false))
  fireEvent.click(within(manual).getByRole('button', { name: '编辑' }))
  const editDialog = screen.getByRole('dialog', { name: '编辑记忆' })
  const draft = within(editDialog).getByRole<HTMLTextAreaElement>('textbox', { name: '记忆内容' })
  fireEvent.change(draft, { target: { value: '手动记忆修改后' } })
  list = { ...list, memories: list.memories.map(item => item.id === 'item-2' ? { ...item, text: '服务器新内容', revision: item.revision + 1 } : item), revision: list.revision + 1 }
  fireEvent.click(within(editDialog).getByRole('button', { name: '保存记忆' }))
  const review = await within(editDialog).findByRole('button', { name: '已核对，继续编辑' })
  expect(draft.value).toBe('手动记忆修改后')
  expect(within(editDialog).getByText('服务器新内容')).toBeTruthy()
  fireEvent.click(review)
  fireEvent.click(within(editDialog).getByRole('button', { name: '保存记忆' }))
  await within(active).findByText('手动记忆修改后')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑记忆' })).toBeNull())
  fireEvent.click(within(manual).getByRole('button', { name: '删除' }))
  const deleteDialog = screen.getByRole('dialog', { name: '删除这条记忆？' })
  expect(within(deleteDialog).getByText('手动记忆修改后')).toBeTruthy()
  fireEvent.click(within(deleteDialog).getByRole('button', { name: '删除记忆' }))
  await waitFor(() => expect(within(active).queryByText('手动记忆修改后')).toBeNull())
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '删除这条记忆？' })).toBeNull())

  const archive = within(manager).getByText(/最近整理/).closest('details')!
  archive.open = true
  const archived = within(archive).getByRole('list', { name: '可恢复记忆' })
  const recoverable = within(archived).getByText('自动移出的记忆').closest('li')!
  expect(within(recoverable).getByText('可恢复至', { exact: false }).querySelector('time')?.dateTime).toBe(recovery)
  fireEvent.click(within(recoverable).getByRole('button', { name: '恢复' }))
  await within(manager).findByText('已恢复记忆。')
  expect(list.memories).toContainEqual(expect.objectContaining({ id: 'archived-1', lastChange: 'restored', recoveryUntil: null }))

  const clear = within(manager).getByRole('button', { name: '清空全部记忆' })
  fireEvent.click(clear)
  const clearDialog = screen.getByRole('dialog', { name: '清空全局记忆？' })
  expect(within(clearDialog).getByText(/所有生效和可恢复的记忆/)).toBeTruthy()
  cancelDialog(clearDialog)
  expect(document.activeElement).toBe(clear)
  expect(list.memories).toHaveLength(2)
  fireEvent.click(clear)
  fireEvent.click(within(screen.getByRole('dialog', { name: '清空全局记忆？' })).getByRole('button', { name: '确认清空' }))
  await within(manager).findByText('已清空全部记忆。')
  expect(list.memories).toEqual([])
  expect(list.archived).toEqual([])
})

it('requires fresh delete confirmation when the memory list changes', async () => {
  renderSettings()
  const manager = await openMemories()
  const clear = within(manager).getByRole('button', { name: '清空全部记忆' })
  await waitFor(() => expect(clear).toHaveProperty('disabled', false))
  fireEvent.click(clear)
  list = { ...list, memories: [...list.memories, { ...originalMemory, id: 'item-2', text: '刚保存的记忆' }], revision: 2 }
  await act(async () => { await client.invalidateQueries({ queryKey: agentPersonalizationQueryKey }) })
  fireEvent.click(within(screen.getByRole('dialog', { name: '清空全局记忆？' })).getByRole('button', { name: '确认清空' }))
  expect(await within(manager).findByText('记忆列表已更改。')).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: '清空全局记忆？' })).toBeNull()
  expect(within(manager).getByText('刚保存的记忆')).toBeTruthy()
  expect(list.memories).toHaveLength(2)
})

it('shows the hard cap and preserves an unsaved memory when the server rejects it', async () => {
  list = { ...list, memories: Array.from({ length: 50 }, (_, index) => ({ ...originalMemory, id: String(index) })) }
  renderSettings()
  const manager = await openMemories()
  expect(await within(manager).findByText('50 / 50 条生效记忆')).toBeTruthy()
  fireEvent.click(within(manager).getByRole('button', { name: '添加记忆' }))
  const dialog = screen.getByRole('dialog', { name: '添加记忆' })
  const draft = within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: '新记忆' })
  fireEvent.change(draft, { target: { value: '待添加的记忆' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存记忆' }))
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', '生效记忆已满。')
  expect(draft.value).toBe('待添加的记忆')
  expect(list.memories).toHaveLength(50)
})

it('ignores a stale account response and never shows its draft to the next account', async () => {
  renderSettings()
  const open = await screen.findByRole('button', { name: /^回答偏好/ })
  fireEvent.click(open)
  const replyDialog = screen.getByRole('dialog', { name: '回答偏好' })
  fireEvent.change(within(replyDialog).getByRole('textbox'), { target: { value: '第一个账号的草稿' } })
  let resolve!: (value: AgentPersonalizationPayload) => void
  const pending = new Promise<AgentPersonalizationPayload>(done => { resolve = done })
  vi.mocked(requestJson).mockImplementation(async <T,>(path: string, init?: RequestInit) =>
    (path === settingsUrl && init?.method === 'PATCH' ? await pending : respond(path, init)) as T)
  fireEvent.click(within(replyDialog).getByRole('button', { name: '保存' }))
  await waitFor(() => expect(requestJson).toHaveBeenCalledWith(settingsUrl, expect.objectContaining({ method: 'PATCH' })))
  act(() => useShellStore.setState({ sessionUser: { ...focusUser, id: 'another-author' } }))
  await act(async () => { resolve({ ...settings, settings: { ...settings.settings, customInstructions: '第一个账号的草稿' }, revision: 1 }) })
  fireEvent.click(await screen.findByRole('button', { name: /^回答偏好/ }))
  expect(within(screen.getByRole('dialog', { name: '回答偏好' })).getByRole('textbox')).toHaveProperty('value', '')
  expect(screen.queryByText('第一个账号的草稿')).toBeNull()
})
