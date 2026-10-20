import { DataAccessError } from '../../prisma.js'

export type ChapterPatch = { oldText: string; newText: string }

/** Resolve against one immutable body. Validation finishes before composition,
 * so one bad/ambiguous/overlapping anchor can never apply a partial batch. */
export function composeChapterEdit(before: string, args: {
  patches?: ChapterPatch[]; oldText?: string; newText?: string; start?: number; end?: number
}, protocol: 1 | 2 = 2) {
  const invalid = (detail = '替换参数无效或区间重叠') => { throw new DataAccessError(409, 'CHAPTER_ANCHOR_CONFLICT', `${detail}，全部正文变更未执行。只纠正本批失败片段；使用当前正文中的唯一连续原文，保留段落换行，不重复提交相同失败参数。`) }
  if (args.patches && ([args.oldText, args.newText, args.start, args.end].some(value => value !== undefined)
    || args.patches.length < 1 || args.patches.length > 8)) invalid()
  const patches = args.patches ?? [{ oldText: args.oldText, newText: args.newText, start: args.start, end: args.end }]
  const ranges = patches.map((patch, index) => {
    let start = 'start' in patch ? patch.start : undefined, end = 'end' in patch ? patch.end : undefined
    if (patch.oldText !== undefined) {
      if (!patch.oldText.length) invalid()
      start = before.indexOf(patch.oldText)
      if (start >= 0 && before.indexOf(patch.oldText, start + 1) === -1) end = start + patch.oldText.length
      else if (start < 0 && protocol === 2) {
        // Only CR/LF formatting may differ. Every other UTF-16 code unit must
        // agree; an offset map returns one actual contiguous manuscript range.
        const needle = patch.oldText.replace(/[\r\n]/gu, '')
        const offsets: number[] = []
        let body = ''
        for (let at = 0; at < before.length; at++) if (before[at] !== '\r' && before[at] !== '\n') {
          offsets.push(at); body += before[at]
        }
        const at = needle.trim() ? body.indexOf(needle) : -1
        if (at < 0 || body.indexOf(needle, at + 1) !== -1) invalid(`第 ${index + 1} 处原文锚点${at < 0 ? '未匹配（0处）' : '匹配多处'}`)
        start = offsets[at]; end = offsets[at + needle.length - 1] + 1
      } else invalid(`第 ${index + 1} 处原文锚点${start < 0 ? '未匹配（0处）' : '匹配多处'}`)
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
  // Anchors prove where the request applies; authorization concerns the
  // actual replacement. Copied unchanged quotation marks/context are not
  // writes outside a frozen region. Validate all original anchors/overlaps
  // above before removing their equal edges, in both runtime adapters.
  const effects = ranges.map(range => {
    const oldText = before.slice(range.start, range.end), replacement = range.newText
    // A no-op still authenticates its original target, including its scope.
    if (oldText === replacement) return range
    let prefix = 0, oldEnd = oldText.length, newEnd = replacement.length
    while (prefix < oldEnd && prefix < newEnd && oldText[prefix] === replacement[prefix]) prefix++
    while (oldEnd > prefix && newEnd > prefix && oldText[oldEnd - 1] === replacement[newEnd - 1]) { oldEnd--; newEnd-- }
    return { start: range.start + prefix, end: range.start + oldEnd, newText: replacement.slice(prefix, newEnd) }
  })
  const canonical: typeof effects = []
  for (const effect of effects) {
    const prior = canonical.at(-1)
    // Adjacent original anchors can shrink to the same insertion address,
    // including an insertion immediately before a replacement. Coalesce in
    // original order so every descending-offset consumer reproduces `after`.
    if (prior && prior.start === effect.start && prior.end === prior.start) {
      prior.end = effect.end
      prior.newText += effect.newText
    } else canonical.push(effect)
  }
  return { after, ranges: canonical }
}
