// @vitest-environment jsdom
import { StrictMode, useState, type ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import StudioWorkspaceSidebar from '../../src/features/studio/components/StudioWorkspaceSidebar'
import { selectInitialTask } from '../../src/features/studio/lib/initial-task-selection'

const remote = vi.hoisted(() => ({ items: [] as Array<{id: string; novelId: string; title: string; updatedAt: string; lastRunAt?: string}> }))
vi.mock('@tanstack/react-query', () => ({ useQuery: ({queryKey}: {queryKey: string[]}) => ({ data: queryKey[2] === 'workspace-navigation' ? remote : undefined }), useQueryClient: () => ({ invalidateQueries: vi.fn() }), useMutation: () => ({ mutate: vi.fn() }) }))
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

it('shows five tasks per work, keeps the active task visible, and expands each work independently', () => {
  remote.items = Array.from({ length: 7 }, (_, i) => ({
    id: 'a' + (i + 1), novelId: 'a', title: '任务甲' + (i + 1), updatedAt: '2026-09-0' + (i + 1),
  }))
  remote.items.push({ id: 'b1', novelId: 'b', title: '任务乙', updatedAt: '2026-09-08' })
  const novels = [{id:'a',title:'作品甲',status:'draft',updatedAt:'2026-09-10'}, {id:'b',title:'作品乙',status:'draft',updatedAt:'2026-09-09'}] as ComponentProps<typeof StudioWorkspaceSidebar>['novels']
  const onSelectNovel = vi.fn()
  render(<Fixture novels={novels} currentNovelId="a" currentTasksNovelId="a" activeTaskId="a1" onSelectNovel={onSelectNovel} />)

  const firstWork = screen.getByRole('button', { name: '作品甲' })
  const firstGroup = within(screen.getByRole('group', { name: '作品甲的任务' }))
  expect(firstGroup.getAllByRole('button', { name: /^任务甲/ })).toHaveLength(5)
  expect(firstGroup.getByRole('button', { name: '任务甲1' }).getAttribute('aria-current')).toBe('page')
  fireEvent.click(firstGroup.getByRole('button', { name: /^展开显示/ }))
  expect(firstGroup.getAllByRole('button', { name: /^任务甲/ })).toHaveLength(7)
  fireEvent.click(firstGroup.getByRole('button', { name: '收起多余任务' }))
  expect(firstGroup.getAllByRole('button', { name: /^任务甲/ })).toHaveLength(5)

  fireEvent.click(firstWork)
  expect(firstWork.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('group', { name: '作品甲的任务' })).toBeNull()
  expect(screen.getByRole('group', { name: '作品乙的任务' })).toBeTruthy()
  expect(onSelectNovel).not.toHaveBeenCalled()
  expect(within(screen.getByRole('region', { name: '最近任务' })).getByRole('button', { name: /^任务甲1/ }).getAttribute('aria-current')).toBe('page')
  fireEvent.click(firstWork)
  expect(screen.getByRole('group', { name: '作品甲的任务' })).toBeTruthy()
  expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
})

it('sorts recent tasks by activity, retains their owning works and keeps the transition lock', () => {
  remote.items = [
    { id: 'a1', novelId: 'a', title: '近期改名', updatedAt: '2026-09-15', lastRunAt: '2026-09-09' },
    { id: 'b1', novelId: 'b', title: '最新运行', updatedAt: '2026-09-11', lastRunAt: '2026-09-11' },
    { id: 'c1', novelId: 'c', title: '归档作品的任务', updatedAt: '2026-09-16', lastRunAt: '2026-09-16' },
  ]
  const novels = [
    { id: 'a', title: '作品甲', status: 'draft', updatedAt: '2026-09-15' },
    { id: 'b', title: '作品乙', status: 'draft', updatedAt: '2026-09-11' },
    { id: 'c', title: '已归档', status: 'archived', updatedAt: '2026-09-16' },
  ] as ComponentProps<typeof StudioWorkspaceSidebar>['novels']
  const onSelectTask = vi.fn()
  const view = render(<Fixture novels={novels} currentNovelId="a" currentTasksNovelId="a" onSelectTask={onSelectTask} />)
  const recent = within(screen.getByRole('region', { name: '最近任务' }))
  const [latest, renamed] = recent.getAllByRole('button', { name: /，最近任务$/ })
  expect(latest.getAttribute('aria-label')).toBe('最新运行，作品乙，最近任务')
  expect(renamed.getAttribute('aria-label')).toBe('近期改名，作品甲，最近任务')
  expect(recent.queryByRole('button', { name: /归档作品的任务/ })).toBeNull()
  fireEvent.click(latest)
  expect(onSelectTask).toHaveBeenCalledExactlyOnceWith('b1', 'b')

  view.rerender(<Fixture novels={novels} currentNovelId="a" currentTasksNovelId="a" taskSwitchLocked onSelectTask={onSelectTask} />)
  expect((latest as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(latest)
  expect(onSelectTask).toHaveBeenCalledTimes(1)
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
