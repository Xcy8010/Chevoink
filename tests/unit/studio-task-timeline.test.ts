import { expect, it } from 'vitest'
import { groupTimelineTasks, type SidebarTask } from '../../src/features/studio/components/studio-task-timeline'

const today = new Date(2026, 0, 2, 0, 10)
function task(id: string, date: Date, pinned = false): SidebarTask {
  const at = date.toISOString()
  return { id, novelId: 'novel', title: id, lastActiveAt: at, updatedAt: at, createdAt: at,
    pinnedAt: pinned ? at : null, temporary: false, isBranch: false }
}

it('groups by local calendar day across years, shows pinned tasks only once and sorts by recent activity', () => {
  const entries = [
    task('yesterday-evening', new Date(2026, 0, 1, 23, 55)), task('today', today),
    task('yesterday-morning', new Date(2026, 0, 1, 9)), task('priority', new Date(2025, 11, 12), true),
    task('wednesday', new Date(2025, 11, 31)), task('older', new Date(2025, 11, 11)),
  ]
  expect(groupTimelineTasks(entries, today).map(({title,tasks}) => [title, tasks.map(item => item.id)])).toEqual([
    ['优先事项', ['priority']], ['今天', ['today']], ['昨天', ['yesterday-evening', 'yesterday-morning']],
    ['星期三', ['wednesday']], ['2025年12月11日', ['older']],
  ])
  expect(groupTimelineTasks([], today)).toEqual([])
})
