export type SidebarTask = {
  id: string
  novelId: string
  title: string
  updatedAt: string
  pinnedAt: string | null
  temporary: boolean
  isBranch: boolean
  lastActiveAt: string
  createdAt: string | null
  preview?: string
}

const dayNumber = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000

export function groupTimelineTasks(tasks: SidebarTask[], today = new Date()) {
  const priority: SidebarTask[] = []
  const dates = new Map<string, SidebarTask[]>()
  const currentDay = dayNumber(today)
  const sorted = [...tasks].sort((a, b) =>
    (Date.parse(b.lastActiveAt) || 0) - (Date.parse(a.lastActiveAt) || 0) || a.id.localeCompare(b.id))
  for (const task of sorted) {
    if (task.pinnedAt) {
      priority.push(task)
      continue
    }
    const date = new Date(task.lastActiveAt)
    const age = currentDay - dayNumber(date)
    let label = '更早'
    if (age === 0) label = '今天'
    else if (age === 1) label = '昨天'
    else if (age >= 2 && age < 7) label = date.toLocaleDateString('zh-CN', { weekday: 'long' })
    else if (Number.isFinite(age)) label = date.toLocaleDateString('zh-CN', {
      year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric',
    })
    const group = dates.get(label)
    if (group) group.push(task)
    else dates.set(label, [task])
  }
  return [...(priority.length ? [{ title: '优先事项', tasks: priority }] : []),
    ...Array.from(dates, ([title, items]) => ({ title, tasks: items }))]
}
