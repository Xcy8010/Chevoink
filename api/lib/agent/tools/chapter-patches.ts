import { DataAccessError } from '../../prisma.js'

export type ChapterPatch = { oldText: string; newText: string }

/** Resolve against one immutable body. Validation finishes before composition,
 * so one bad/ambiguous/overlapping anchor can never apply a partial batch. */
export function composeChapterEdit(before: string, args: {
  patches?: ChapterPatch[]; oldText?: string; newText?: string; start?: number; end?: number
}) {
  const invalid = () => { throw new DataAccessError(409, 'CHAPTER_ANCHOR_CONFLICT', '替换参数无效、原文锚点不唯一或区间重叠，全部正文变更未执行。请重新读取当前正文并重新定位本次修改；相关改动可合并提交。') }
  if (args.patches && ([args.oldText, args.newText, args.start, args.end].some(value => value !== undefined)
    || args.patches.length < 1 || args.patches.length > 8)) invalid()
  const patches = args.patches ?? [{ oldText: args.oldText, newText: args.newText, start: args.start, end: args.end }]
  const ranges = patches.map(patch => {
    let start = 'start' in patch ? patch.start : undefined, end = 'end' in patch ? patch.end : undefined
    if (patch.oldText !== undefined) {
      if (!patch.oldText.length) invalid()
      start = before.indexOf(patch.oldText)
      if (start < 0 || before.indexOf(patch.oldText, start + 1) !== -1) invalid()
      end = start + patch.oldText.length
    }
    if (typeof patch.newText !== 'string' || start === undefined || end === undefined
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > before.length) invalid()
    return { start: start!, end: end!, newText: patch.newText! }
  }).sort((a, b) => a.start - b.start || a.end - b.end)
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index].start < ranges[index - 1].end || ranges[index].start === ranges[index - 1].start) invalid()
  }
  let after = before
  for (const range of [...ranges].reverse()) after = after.slice(0, range.start) + range.newText + after.slice(range.end)
  return { after, ranges }
}
