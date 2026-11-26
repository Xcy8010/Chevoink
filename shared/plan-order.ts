import type { PlanLinkFields } from './contracts/novel-plans.js'

type PlanOrderItem = Pick<Partial<PlanLinkFields>, 'planKind' | 'parentPlanId' | 'target'> & {
  id: string
  orderIndex?: number | null
  createdAt: string
}

/** Keep manual positions and unrelated files in place. Sort only the numbered
 * detail slots of each parent, including chapter links whose position changed. */
export function orderPlanFiles<T extends PlanOrderItem>(plans: T[], chapters: readonly { id: string; orderIndex: number }[], byChapter = true): T[] {
  const ordered = [...plans].sort((left, right) =>
    (left.orderIndex ?? Number.MAX_SAFE_INTEGER) - (right.orderIndex ?? Number.MAX_SAFE_INTEGER)
    || Date.parse(left.createdAt) - Date.parse(right.createdAt) || (byChapter ? left.id.localeCompare(right.id) : 0))
  if (!byChapter) return ordered
  const chapterNumbers = new Map(chapters.map(chapter => [chapter.id, chapter.orderIndex]))
  const groups = new Map<string | null, { slot: number; number: number; plan: T }[]>()
  ordered.forEach((plan, slot) => {
    if (plan.orderIndex != null || plan.planKind !== 'detail' || !plan.target) return
    const number = plan.target.kind === 'future' ? plan.target.targetOrderIndex : chapterNumbers.get(plan.target.chapterId)
    if (number === undefined) return
    const parent = plan.parentPlanId ?? null
    const group = groups.get(parent) ?? []
    group.push({ slot, number, plan })
    groups.set(parent, group)
  })
  for (const group of groups.values()) {
    const byChapter = [...group].sort((left, right) => left.number - right.number)
    group.forEach(({ slot }, index) => { ordered[slot] = byChapter[index].plan })
  }
  return ordered
}
