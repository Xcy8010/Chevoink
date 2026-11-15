// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import ChapterSidebar from '../../src/features/studio/components/ChapterSidebar'

type SidebarProps = ComponentProps<typeof ChapterSidebar>
const noOp = () => {}
const props: SidebarProps = {
  chapters: [],
  volumes: [{ id: 'v1', title: '初遇', orderIndex: 1 }, { id: 'v2', title: '远行', orderIndex: 2 }] as SidebarProps['volumes'],
  savedPlans: [
    { id: 'outline-file', backendArtifactId: 'saved-outline', artifactId: 'outline-artifact', title: '全书大纲', planKind: 'outline', content: '', createdAt: '' },
    { id: 'detail-file', parentPlanId: 'saved-outline', artifactId: 'detail-artifact', title: '开篇细纲', planKind: 'detail', content: '', createdAt: '' },
  ],
  selectedChapterId: null,
  selectedTreeItemId: null,
  catalogPreview: { title: '目录', content: '', description: '' },
  novelWordCountLabel: '',
  chapterCountLabel: '',
  novelTitle: '合成作品',
  activeCoverLabel: '',
  onSelectChapter: noOp,
  onSelectPlan: noOp,
  onSelectCatalog: noOp,
  onCreateChapter: noOp,
  onCreatePlan: noOp,
  onOpenChapterSettings: noOp,
  onOpenPlanSettings: noOp,
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('preserves the existing left IDE tree actions without adding folder menus', () => {
  render(<ChapterSidebar {...props} showExtendedMenus={false} onRequestDeletePlan={noOp} />)
  expect(screen.queryByRole('button', { name: /的更多操作/ })).toBeNull()
  fireEvent.contextMenu(screen.getByRole('button', { name: '合成作品' }))
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /^计划/ }))
  fireEvent.contextMenu(screen.getByRole('button', { name: /^开篇细纲/ }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['打开', '重命名', '设置', '删除'])
})

it('flips the hovered submenu near the viewport edge and creates the chosen plan kind', () => {
  vi.stubGlobal('innerWidth', 400)
  vi.stubGlobal('innerHeight', 300)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(80)
  const onCreatePlanKind = vi.fn()
  render(<ChapterSidebar {...props} onCreatePlanKind={onCreatePlanKind} />)
  fireEvent.contextMenu(screen.getByRole('button', { name: '合成作品' }), { clientX: 395, clientY: 290 })
  const menu = screen.getByRole('menu', { name: '合成作品的操作' })
  expect(menu.style.left).toBe('232px')
  expect(menu.style.top).toBe('212px')
  fireEvent.mouseEnter(within(menu).getByRole('menuitem', { name: '新建计划' }))
  const submenu = screen.getByRole('menu', { name: '新建计划' })
  expect(submenu.style.left).toBe('72px')
  fireEvent.click(within(submenu).getByRole('menuitem', { name: '细纲' }))
  expect(onCreatePlanKind).toHaveBeenCalledExactlyOnceWith('detail')
  expect(screen.queryByRole('menu')).toBeNull()
})

it('navigates the submenu by keyboard and restores focus when dismissed', async () => {
  const user = userEvent.setup()
  render(<ChapterSidebar {...props} onCreatePlanKind={vi.fn()} />)
  const trigger = screen.getByRole('button', { name: '合成作品的更多操作' })
  trigger.focus()
  await user.keyboard('{Enter}')
  const branch = screen.getByRole('menuitem', { name: '新建计划' })
  expect(document.activeElement).toBe(branch)
  await user.keyboard('{ArrowRight}')
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '大纲' }))
  await user.keyboard('{ArrowDown}')
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '细纲' }))
  await user.keyboard('{Escape}')
  expect(document.activeElement).toBe(branch)
  expect(screen.queryByRole('menu', { name: '新建计划' })).toBeNull()
  await user.keyboard('{Escape}')
  expect(document.activeElement).toBe(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

it('routes volume creation, rename and deletion to the selected volume', () => {
  const onCreateChapter = vi.fn()
  const onCreateChapterInVolume = vi.fn()
  const onRenameVolumeTitle = vi.fn()
  const onRequestDeleteVolume = vi.fn()
  render(<ChapterSidebar {...props} {...{ onCreateChapter, onCreateChapterInVolume, onRenameVolumeTitle, onRequestDeleteVolume }} />)
  const trigger = screen.getByRole('button', { name: '远行的更多操作' })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: '在此卷新建章节' }))
  expect(onCreateChapterInVolume).toHaveBeenCalledExactlyOnceWith('v2')
  expect(onCreateChapter).not.toHaveBeenCalled()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
  const dialog = screen.getByRole('dialog', { name: '重命名卷' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: '名称' }), { target: { value: '  重启  ' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
  expect(onRenameVolumeTitle).toHaveBeenCalledExactlyOnceWith('v2', '重启')
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
  expect(onRequestDeleteVolume).toHaveBeenCalledExactlyOnceWith('v2')
})

it('creates a kind-specific plan and uses the persisted parent identity for plan links', () => {
  const onCreatePlanKind = vi.fn()
  const onSelectPlan = vi.fn()
  render(<ChapterSidebar {...props} onCreatePlanKind={onCreatePlanKind} onSelectPlan={onSelectPlan} />)
  fireEvent.click(screen.getByRole('button', { name: '计划共2个' }))
  fireEvent.contextMenu(screen.getByRole('button', { name: '大纲共1个' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '新建大纲' }))
  expect(onCreatePlanKind).toHaveBeenNthCalledWith(1, 'outline')
  fireEvent.click(screen.getByRole('button', { name: '全书大纲的更多操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '新建关联细纲' }))
  expect(onCreatePlanKind).toHaveBeenNthCalledWith(2, 'detail', 'saved-outline')
  fireEvent.click(screen.getByRole('button', { name: '开篇细纲的更多操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '查看父大纲' }))
  expect(onSelectPlan).toHaveBeenCalledExactlyOnceWith('outline-file')
})

it('keeps chapter folder creation and chapter settings and deletion reachable', () => {
  const chapters = [{ id: 'c1', title: '启航', volumeId: 'v2', orderIndex: 1, orderInVolume: 1 }] as SidebarProps['chapters']
  const onCreateChapter = vi.fn()
  const onOpenChapterSettings = vi.fn()
  const onRequestDeleteChapter = vi.fn()
  render(<ChapterSidebar {...props} {...{ chapters, onCreateChapter, onOpenChapterSettings, onRequestDeleteChapter }} />)
  fireEvent.contextMenu(screen.getByRole('button', { name: '全部章节共2卷1章' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '新建章节' }))
  expect(onCreateChapter).toHaveBeenCalledTimes(1)
  const chapter = screen.getByRole('button', { name: '第 1 章 · 启航' })
  fireEvent.contextMenu(chapter)
  fireEvent.click(screen.getByRole('menuitem', { name: '设置' }))
  expect(onOpenChapterSettings).toHaveBeenCalledExactlyOnceWith('c1')
  fireEvent.contextMenu(chapter)
  fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
  expect(onRequestDeleteChapter).toHaveBeenCalledExactlyOnceWith('c1')
})

it('expands and collapses descendants together and leaves unavailable volume actions absent', () => {
  const onOpenVolumeSettings = vi.fn()
  render(<ChapterSidebar {...props} onOpenVolumeSettings={onOpenVolumeSettings} />)
  const trigger = screen.getByRole('button', { name: '合成作品的更多操作' })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: '全部折叠' }))
  expect(screen.queryByRole('button', { name: '计划共2个' })).toBeNull()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: '全部展开' }))
  expect(screen.getByRole('button', { name: '计划共2个' }).getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('button', { name: '第 1 卷 · 初遇' }).getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '初遇的更多操作' }))
  expect(screen.queryByRole('menuitem', { name: '在此卷新建章节' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: '删除' })).toBeNull()
  fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
  expect(onOpenVolumeSettings).toHaveBeenCalledExactlyOnceWith('v1')
})
