// @vitest-environment jsdom
import { StrictMode, useState, type ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import StudioWorkspaceSidebar from '../../src/features/studio/components/StudioWorkspaceSidebar'
import { selectInitialTask } from '../../src/features/studio/lib/initial-task-selection'

const remote = vi.hoisted(() => ({ items: [] as Array<{id: string; novelId: string; title: string; updatedAt: string}> }))
vi.mock('@tanstack/react-query', () => ({ useQuery: ({queryKey}: {queryKey: string[]}) => ({ data: queryKey[2] === 'workspace-sidebar' ? remote : undefined }), useQueryClient: () => ({ invalidateQueries: vi.fn() }) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
const noop = () => undefined
function Fixture(overrides: Partial<ComponentProps<typeof StudioWorkspaceSidebar>> = {}) {
  const [open, setOpen] = useState(true)
  return <StudioWorkspaceSidebar open={open} onOpenChange={setOpen} perspective="work" perspectiveSwitchEnabled onPerspectiveChange={noop} currentNovelId="preview" currentTasksNovelId="preview" currentNovelTitle="预览" novels={[]} currentTasks={[]} activeTaskId={null} taskSwitchLocked={false} onSelectNovel={noop} onCreateNovel={noop} onCreateTask={noop} onSelectTask={noop} onRenameTask={noop} onCreateTaskInNovel={noop} onTaskDeleted={noop} onTaskForked={noop} onNovelDeleted={noop} autoFollow={false} onAutoFollowChange={noop} onOpenStudioSettings={noop} {...overrides} />
}
beforeEach(() => {
  localStorage.clear()
  remote.items = []
  vi.stubGlobal('PointerEvent', class extends MouseEvent { pointerId = 1 })
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => true })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete document.documentElement.dataset.studioResizing })
it('keeps the outer capture element alive through collapse and reverse expansion', () => {
  const view = render(<Fixture />)
  const sidebar = view.container.querySelector('[data-workspace-sidebar]')!
  fireEvent.pointerDown(screen.getByRole('separator', { name: '调整左侧栏宽度' }), { button: 0, clientX: 280 })
  fireEvent.pointerMove(sidebar, { clientX: 150 })
  expect(sidebar.getAttribute('data-workspace-sidebar')).toBe('collapsed')
  expect(view.container.querySelector('[data-workspace-sidebar]')).toBe(sidebar)
  fireEvent.pointerMove(sidebar, { clientX: 330 })
  expect(sidebar.getAttribute('data-workspace-sidebar')).toBe('open')
  expect((sidebar as HTMLElement).style.width).toBe('330px')
  fireEvent.pointerUp(sidebar)
  expect(document.documentElement.dataset.studioResizing).toBeUndefined()
  expect(localStorage.getItem('chevoink:studio-sidebar-width')).toBe('330')
})

it('keeps task rows in their owning novel throughout route-first A/B/A hydration', () => {
  remote.items = [
    {id:'a1', novelId:'a', title:'任务A', updatedAt:'2026-09-10'},
    {id:'b1', novelId:'b', title:'任务B', updatedAt:'2026-09-10'},
  ]
  const novels = [{id:'a',title:'作品A',status:'draft',updatedAt:'2026-09-10'}, {id:'b',title:'作品B',status:'draft',updatedAt:'2026-09-09'}] as ComponentProps<typeof StudioWorkspaceSidebar>['novels']
  const aTasks = [{id:'a1',title:'任务A',updatedAt:'2026-09-10',temporary:false,prompt:'',artifactsCount:0}]
  const bTasks = [{id:'b1',title:'任务B',updatedAt:'2026-09-10',temporary:false,prompt:'',artifactsCount:0}]
  const view = render(<Fixture novels={novels} currentNovelId="a" currentTasksNovelId="a" currentTasks={aTasks} activeTaskId="a1" />, {wrapper:StrictMode})
  const a = screen.getByRole('button',{name:'任务A'}), b = screen.getByRole('button',{name:'任务B'})
  const list = view.container.querySelector('.overflow-y-auto') as HTMLElement
  list.scrollTop = 210; fireEvent.scroll(list)
  for (const [novel,owner,tasks,active] of [['b','a',aTasks,'b1'],['b','b',bTasks,'b1'],['a','b',bTasks,'a1'],['a','a',aTasks,'a1']] as const) {
    view.rerender(<Fixture novels={novels} currentNovelId={novel} currentTasksNovelId={owner} currentTasks={tasks} activeTaskId={active} />)
    expect(screen.getAllByRole('button',{name:'任务A'})).toEqual([a])
    expect(screen.getAllByRole('button',{name:'任务B'})).toEqual([b])
    expect((active === 'a1' ? a : b).getAttribute('aria-current')).toBe('page')
    expect(list.scrollTop).toBe(210)
  }
})

it('prioritizes the clicked session over the remembered active task, including missing/loading targets', () => {
  const tasks = [{id:'old',sessionId:'old'}, {id:'target',sessionId:'target-session'}]
  expect(selectInitialTask(tasks,'old','target-session')).toBe(tasks[1])
  expect(selectInitialTask(tasks,'old','not-loaded')).toBeNull()
  expect(selectInitialTask(tasks,'old',null)).toBe(tasks[0])
  expect(selectInitialTask(tasks,'old','new')).toBeNull()
})


it('keeps a newly created local task and its novel visible after switching before navigation refetch sees it', () => {
  const novels = [{id:'a',title:'新作品A',status:'draft',updatedAt:'2026-09-10'}, {id:'b',title:'作品B',status:'draft',updatedAt:'2026-09-09'}] as ComponentProps<typeof StudioWorkspaceSidebar>['novels']
  const aTasks = [{id:'local-a',title:'新任务A',updatedAt:'2026-09-10',temporary:true,prompt:'合成请求',artifactsCount:0}]
  const onSelectTask = vi.fn()
  const view = render(<Fixture novels={novels} currentNovelId="a" currentTasksNovelId="a" currentTasks={aTasks} activeTaskId="local-a" onSelectTask={onSelectTask} />)
  expect(screen.getByRole('button', { name: '新任务A' })).toBeTruthy()
  view.rerender(<Fixture novels={[novels[1]]} currentNovelId="b" currentTasksNovelId="b" currentTasks={[]} activeTaskId={null} onSelectTask={onSelectTask} />)
  expect(screen.getByRole('button', { name: /^新作品A/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '新任务A' }))
  expect(onSelectTask).toHaveBeenCalledWith('local-a', 'a')
})
