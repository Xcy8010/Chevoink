// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  updateAgentSessionSettings: vi.fn(),
  deleteAgentSession: vi.fn(),
  fetchAgentSessions: vi.fn(),
  fetchSessionsRunStatus: vi.fn(),
  forkAgentSession: vi.fn(),
  renameAgentSession: vi.fn(),
  updateNovelMeta: vi.fn(),
  deleteNovelWorkspace: vi.fn(),
}))

vi.mock('../../src/features/studio/agent/agentApi', () => ({
  updateAgentSessionSettings: mocks.updateAgentSessionSettings,
  deleteAgentSession: mocks.deleteAgentSession,
  fetchAgentSessions: mocks.fetchAgentSessions,
  fetchSessionsRunStatus: mocks.fetchSessionsRunStatus,
  forkAgentSession: mocks.forkAgentSession,
  renameAgentSession: mocks.renameAgentSession,
}))

vi.mock('../../src/features/studio/api', () => ({
  updateNovelMeta: mocks.updateNovelMeta,
  deleteNovelWorkspace: mocks.deleteNovelWorkspace,
}))

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

import StudioWorkspaceSidebar from '../../src/features/studio/components/StudioWorkspaceSidebar'
import type { AgentSession, Novel, UserMePayload } from '../../shared/contracts/index.js'

const noop = () => undefined
const novels = [
  { id: 'a', title: '作品A', status: 'draft', chapterCount: 1, updatedAt: '2026-09-10' },
  { id: 'b', title: '作品B', status: 'draft', chapterCount: 1, updatedAt: '2026-09-09' },
] as ComponentProps<typeof StudioWorkspaceSidebar>['novels']
const tasks = [{ id: 'task-1', title: '写第四章', updatedAt: '2026-09-20T10:00:00.000Z', temporary: false, prompt: '', artifactsCount: 2 }]

function Fixture(overrides: Partial<ComponentProps<typeof StudioWorkspaceSidebar>>) {
  const [currentTasks, setCurrentTasks] = useState(overrides.currentTasks ?? tasks)
  const [activeTaskId, setActiveTaskId] = useState(overrides.activeTaskId ?? null)
  const { data } = useQuery({ queryKey: ['studio', 'my-novels'], queryFn: () => new Promise<Novel[]>(() => {}) })
  const onTaskDeleted = (id: string) => {
    const remaining = currentTasks.filter(task => task.id !== id)
    setCurrentTasks(remaining)
    if (id === activeTaskId) setActiveTaskId(remaining[0]?.id ?? null)
    overrides.onTaskDeleted?.(id)
  }
  return <StudioWorkspaceSidebar open onOpenChange={noop} perspective="work" perspectiveSwitchEnabled onPerspectiveChange={noop} currentNovelId="a" currentTasksNovelId="a" currentNovelTitle="作品A" novels={data ?? novels} taskSwitchLocked={false} onSelectNovel={noop} onCreateNovel={noop} onCreateTask={noop} onSelectTask={noop} onRenameTask={noop} onCreateTaskInNovel={noop} onTaskForked={noop} onNovelDeleted={noop} autoFollow={false} onAutoFollowChange={noop} onOpenStudioSettings={noop} onExportNovel={noop} onImportNovel={noop} {...overrides} currentTasks={currentTasks} activeTaskId={activeTaskId} onTaskDeleted={onTaskDeleted} />
}

const navigationKey = ['agent', 'sessions', 'workspace-navigation']
const profileKey = ['community', 'me']
const novelsKey = ['studio', 'my-novels']
let client: QueryClient
function renderFixture(overrides: Partial<ComponentProps<typeof StudioWorkspaceSidebar>> = {}) {
  return render(<QueryClientProvider client={client}><Fixture {...overrides} /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  client.setQueryData(novelsKey, novels)
  client.setQueryData(profileKey, { authoredNovels: novels })
  mocks.fetchAgentSessions.mockResolvedValue({ items: [] })
  mocks.fetchSessionsRunStatus.mockResolvedValue({ statuses: {} })
  mocks.updateAgentSessionSettings.mockResolvedValue({ session: {} } as never)
  mocks.updateNovelMeta.mockResolvedValue({ ...novels[0], status: 'archived' })
})

afterEach(() => { cleanup(); client.clear(); vi.clearAllMocks(); localStorage.clear() })

it('confirms archiving the active task, then recycles its window instead of creating a new task', async () => {
  const onTaskDeleted = vi.fn()
  const onCreateTask = vi.fn()
  const savedTask = { ...tasks[0], novelId: 'a', status: 'active', pinnedAt: '2026-09-20' }
  const fallback = { ...tasks[0], id: 'task-2', title: '继续写第三章' }
  client.setQueryData(navigationKey, { items: [savedTask] })
  mocks.fetchAgentSessions.mockImplementationOnce(() => new Promise(() => {}))
  renderFixture({ activeTaskId: 'task-1', currentTasks: [...tasks, fallback], onTaskDeleted, onCreateTask })

  const project = within(screen.getByRole('group', { name: '作品A的任务' }))
  fireEvent.contextMenu(project.getByRole('button', { name: '写第四章' }))
  fireEvent.click(screen.getByRole('button', { name: '归档' }))

  // 先弹自定义确认弹窗并说明找回入口，不直接执行归档
  expect(screen.getByRole('heading', { name: '归档任务' })).toBeTruthy()
  expect(screen.getByText(/「更多 → 归档内容」/)).toBeTruthy()
  expect(mocks.updateAgentSessionSettings).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '确认归档' }))

  await waitFor(() => expect(onTaskDeleted).toHaveBeenCalledWith('task-1'))
  expect(mocks.updateAgentSessionSettings).toHaveBeenCalledWith('task-1', { status: 'archived' })
  await waitFor(() => expect(screen.queryAllByRole('button', { name: /写第四章/ })).toHaveLength(0))
  expect(client.getQueryData<{ items: AgentSession[] }>(navigationKey)?.items).toEqual([])
  expect(project.getByRole('button', { name: fallback.title }).getAttribute('aria-current')).toBe('page')
  // 回归：归档当前任务不能再新建任务窗口
  expect(onCreateTask).not.toHaveBeenCalled()
})

it('blocks archiving a task that is still running instead of opening the dialog', () => {
  const onTaskDeleted = vi.fn()
  renderFixture({ activeTaskId: 'task-1', taskSwitchLocked: true, onTaskDeleted })

  fireEvent.click(screen.getByRole('button', { name: '归档任务' }))

  expect(screen.queryByRole('heading', { name: '归档任务' })).toBeNull()
  expect(mocks.updateAgentSessionSettings).not.toHaveBeenCalled()
  expect(onTaskDeleted).not.toHaveBeenCalled()
})

it('confirms before archiving the current novel, then switches to the next novel', async () => {
  const onSelectNovel = vi.fn()
  const onCreateTask = vi.fn()
  const onNovelArchived = vi.fn()
  renderFixture({ onSelectNovel, onCreateTask, onNovelArchived })

  fireEvent.contextMenu(screen.getByRole('button', { name: /^作品A/ }))
  fireEvent.click(screen.getByRole('button', { name: '归档' }))

  expect(screen.getByRole('heading', { name: '归档作品' })).toBeTruthy()
  expect(screen.getByText(/「更多 → 归档内容」/)).toBeTruthy()
  expect(mocks.updateNovelMeta).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '确认归档' }))

  await waitFor(() => expect(onNovelArchived).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', status: 'archived' })))
  expect(mocks.updateNovelMeta).toHaveBeenCalledWith('a', { status: 'archived' })
  expect(screen.queryByRole('button', { name: /^作品A/ })).toBeNull()
  expect(client.getQueryData<Novel[]>(novelsKey)?.[0].status).toBe('archived')
  expect(client.getQueryData<UserMePayload>(profileKey)?.authoredNovels[0].status).toBe('archived')
  expect(onSelectNovel).toHaveBeenCalledWith('b')
  expect(onCreateTask).not.toHaveBeenCalled()
  // An authoritative profile update after restoring the work re-enables its active entry.
  act(() => { client.setQueryData(novelsKey, novels) })
  expect(await screen.findByRole('button', { name: /^作品A/ })).toBeTruthy()
})

it.each(['task', 'novel'] as const)('keeps the active %s visible when the archive request fails', async kind => {
  const onTaskDeleted = vi.fn(), onNovelArchived = vi.fn(), onSelectNovel = vi.fn()
  const update = kind === 'task' ? mocks.updateAgentSessionSettings : mocks.updateNovelMeta
  update.mockRejectedValueOnce(new Error('归档失败'))
  renderFixture({ activeTaskId: 'task-1', onTaskDeleted, onNovelArchived, onSelectNovel })
  if (kind === 'task') {
    fireEvent.click(screen.getByRole('button', { name: '归档任务' }))
  } else {
    fireEvent.contextMenu(screen.getByRole('button', { name: /^作品A/ }))
    fireEvent.click(screen.getByRole('button', { name: '归档' }))
  }
  fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
  await waitFor(() => expect(screen.queryByRole('heading', { name: /^归档/ })).toBeNull())
  expect(screen.getByRole('button', { name: '写第四章' }).getAttribute('aria-current')).toBe('page')
  expect(screen.getByRole('button', { name: /^作品A/ })).toBeTruthy()
  expect(onTaskDeleted).not.toHaveBeenCalled()
  expect(onNovelArchived).not.toHaveBeenCalled()
  expect(onSelectNovel).not.toHaveBeenCalled()
})
