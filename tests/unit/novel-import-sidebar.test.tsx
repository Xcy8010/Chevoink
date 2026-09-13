// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import StudioWorkspaceSidebar from '../../src/features/studio/components/StudioWorkspaceSidebar'

vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: undefined }), useQueryClient: () => ({ invalidateQueries: vi.fn() }) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

const noop = () => undefined
const novels = [{ id: 'a', title: '作品A', status: 'draft', chapterCount: 1, updatedAt: '2026-09-10' }, { id: 'b', title: '作品B', status: 'draft', chapterCount: 1, updatedAt: '2026-09-09' }] as ComponentProps<typeof StudioWorkspaceSidebar>['novels']
function Fixture(overrides: Partial<ComponentProps<typeof StudioWorkspaceSidebar>>) {
  return <StudioWorkspaceSidebar open onOpenChange={noop} perspective="work" perspectiveSwitchEnabled onPerspectiveChange={noop} currentNovelId="a" currentTasksNovelId="a" currentNovelTitle="作品A" novels={novels} currentTasks={[]} activeTaskId={null} taskSwitchLocked={false} onSelectNovel={noop} onCreateNovel={noop} onCreateTask={noop} onSelectTask={noop} onRenameTask={noop} onCreateTaskInNovel={noop} onTaskDeleted={noop} onTaskForked={noop} onNovelDeleted={noop} autoFollow={false} onAutoFollowChange={noop} onOpenStudioSettings={noop} onExportNovel={noop} onImportNovel={noop} {...overrides} />
}

it('exposes import for the current novel only, without capability gating', () => {
  const onImportNovel = vi.fn()
  render(<Fixture onImportNovel={onImportNovel} />)
  fireEvent.contextMenu(screen.getByRole('button', { name: /^作品A/ }))
  const upload = screen.getByRole('button', { name: '一键导入' })
  expect(upload.nextElementSibling).toBe(screen.getByRole('button', { name: '一键导出' }))
  expect(screen.queryByRole('button', { name: '导入记录与恢复' })).toBeNull()
  fireEvent.contextMenu(screen.getByRole('button', { name: /^作品B/ }))
  expect(screen.queryByRole('button', { name: '一键导入' })).toBeNull()
  expect(onImportNovel).not.toHaveBeenCalled()
})

it('preserves the persistent more-button focus before opening import', () => {
  const onImportNovel = vi.fn()
  render(<Fixture onImportNovel={onImportNovel} />)
  const trigger = screen.getAllByRole('button', { name: '作品更多操作' })[0]
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: '一键导入' }))
  expect(onImportNovel).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(trigger)
  expect(screen.queryByRole('button', { name: '一键导入' })).toBeNull()
})

it('preserves the novel row focus when import is opened from right click', () => {
  const onImportNovel = vi.fn()
  render(<Fixture onImportNovel={onImportNovel} />)
  const trigger = screen.getByRole('button', { name: /^作品A/ })
  fireEvent.contextMenu(trigger)
  fireEvent.click(screen.getByRole('button', { name: '一键导入' }))
  expect(onImportNovel).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(trigger)
})
