// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: undefined }), useQueryClient: () => ({ invalidateQueries: vi.fn() }) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

import StudioWorkspaceSidebar from '../../src/features/studio/components/StudioWorkspaceSidebar'

const noop = () => undefined
const novels = [
  { id: 'a', title: '作品A', status: 'draft', chapterCount: 1, updatedAt: '2026-09-10' },
  { id: 'b', title: '作品B', status: 'draft', chapterCount: 1, updatedAt: '2026-09-09' },
] as ComponentProps<typeof StudioWorkspaceSidebar>['novels']
const tasks = [{ id: 'task-1', title: '写第四章', updatedAt: '2026-09-20T10:00:00.000Z', temporary: false, prompt: '', artifactsCount: 2 }] as ComponentProps<typeof StudioWorkspaceSidebar>['currentTasks']

function Fixture(overrides: Partial<ComponentProps<typeof StudioWorkspaceSidebar>>) {
  return <StudioWorkspaceSidebar open onOpenChange={noop} perspective="work" perspectiveSwitchEnabled onPerspectiveChange={noop} currentNovelId="a" currentTasksNovelId="a" currentNovelTitle="作品A" novels={novels} currentTasks={tasks} activeTaskId={null} taskSwitchLocked={false} onSelectNovel={noop} onCreateNovel={noop} onCreateTask={noop} onSelectTask={noop} onRenameTask={noop} onCreateTaskInNovel={noop} onTaskDeleted={noop} onTaskForked={noop} onNovelDeleted={noop} autoFollow={false} onAutoFollowChange={noop} onOpenStudioSettings={noop} onExportNovel={noop} onImportNovel={noop} {...overrides} />
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updateAgentSessionSettings.mockResolvedValue({ session: {} } as never)
  mocks.updateNovelMeta.mockResolvedValue({} as never)
})

afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear() })

it('confirms archiving the active task, then recycles its window instead of creating a new task', async () => {
  const onTaskDeleted = vi.fn()
  const onCreateTask = vi.fn()
  render(<Fixture activeTaskId="task-1" onTaskDeleted={onTaskDeleted} onCreateTask={onCreateTask} />)

  fireEvent.click(screen.getByRole('button', { name: '归档任务' }))

  // 先弹自定义确认弹窗并说明找回入口，不直接执行归档
  expect(screen.getByRole('heading', { name: '归档任务' })).toBeTruthy()
  expect(screen.getByText(/「更多 → 归档内容」/)).toBeTruthy()
  expect(mocks.updateAgentSessionSettings).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '确认归档' }))

  await waitFor(() => expect(onTaskDeleted).toHaveBeenCalledWith('task-1'))
  expect(mocks.updateAgentSessionSettings).toHaveBeenCalledWith('task-1', { status: 'archived' })
  // 回归：归档当前任务不能再新建任务窗口
  expect(onCreateTask).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.queryByRole('heading', { name: '归档任务' })).toBeNull())
})

it('blocks archiving a task that is still running instead of opening the dialog', () => {
  const onTaskDeleted = vi.fn()
  render(<Fixture activeTaskId="task-1" taskSwitchLocked onTaskDeleted={onTaskDeleted} />)

  fireEvent.click(screen.getByRole('button', { name: '归档任务' }))

  expect(screen.queryByRole('heading', { name: '归档任务' })).toBeNull()
  expect(mocks.updateAgentSessionSettings).not.toHaveBeenCalled()
  expect(onTaskDeleted).not.toHaveBeenCalled()
})

it('confirms before archiving the current novel, then switches to the next novel', async () => {
  const onSelectNovel = vi.fn()
  const onCreateTask = vi.fn()
  render(<Fixture onSelectNovel={onSelectNovel} onCreateTask={onCreateTask} />)

  fireEvent.contextMenu(screen.getByRole('button', { name: /^作品A/ }))
  fireEvent.click(screen.getByRole('button', { name: '归档' }))

  expect(screen.getByRole('heading', { name: '归档作品' })).toBeTruthy()
  expect(screen.getByText(/「更多 → 归档内容」/)).toBeTruthy()
  expect(mocks.updateNovelMeta).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '确认归档' }))

  await waitFor(() => expect(mocks.updateNovelMeta).toHaveBeenCalledWith('a', { status: 'archived' }))
  expect(onSelectNovel).toHaveBeenCalledWith('b')
  expect(onCreateTask).not.toHaveBeenCalled()
})
