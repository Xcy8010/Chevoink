// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import StudioSidebarHeader, { StudioPerspectiveMenu } from '@/features/studio/components/StudioSidebarHeader'

afterEach(cleanup)

it.each([['work', 'Studio'], ['ide', 'Editor']] as const)('uses the display name for the saved %s value and shows both descriptions', async (perspective, name) => {
  const user = userEvent.setup()
  const change = vi.fn()
  render(<StudioPerspectiveMenu perspective={perspective} enabled onChange={change} />)
  const trigger = screen.getByRole('button', { name })
  expect(trigger.firstChild?.nodeType).toBe(Node.TEXT_NODE)
  expect(trigger.querySelectorAll('svg')).toHaveLength(1)
  await user.tab()
  await user.keyboard('{Enter}')
  const group = within(screen.getByRole('group', { name: '工作模式' }))
  const studio = group.getByRole('button', { name: 'Studio 对话、任务与创作' })
  const editor = group.getByRole('button', { name: 'Editor 结构、正文与预览' })
  expect(studio.getAttribute('aria-pressed')).toBe(String(perspective === 'work'))
  expect(editor.getAttribute('aria-pressed')).toBe(String(perspective === 'ide'))
  expect(group.getAllByRole('button').filter(button => button.querySelector('svg'))).toEqual([perspective === 'work' ? studio : editor])
  await user.tab()
  await user.keyboard('{Escape}')
  expect(document.activeElement).toBe(trigger)
  expect(screen.queryByRole('group')).toBeNull()
  await user.keyboard('{Enter}')
  await user.click(screen.getByRole('button', { name: perspective === 'work' ? 'Editor 结构、正文与预览' : 'Studio 对话、任务与创作' }))
  expect(change).toHaveBeenCalledWith(perspective === 'work' ? 'ide' : 'work')
})

it('places the optional view action just to the left of search and retains the feature gate', () => {
  const search = vi.fn()
  render(<StudioSidebarHeader perspective="work" enabled={false} onChange={vi.fn()} onSearch={search} actions={<button>视图</button>} />)
  const action = screen.getByRole('button', { name: '视图' })
  const find = screen.getByRole('button', { name: '搜索作品与任务' })
  expect(action.nextElementSibling).toBe(find)
  fireEvent.click(find)
  expect(search).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Studio' }))
  const options = within(screen.getByRole('group', { name: '工作模式' })).getAllByRole('button') as HTMLButtonElement[]
  expect(options.every(button => button.disabled)).toBe(true)
})
