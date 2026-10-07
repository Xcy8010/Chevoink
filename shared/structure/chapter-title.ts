const chapterPrefix = /^第\s*([0-9０-９零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+)\s*[章回节集]\s*[:：.．·、—-]?\s*/u

function unwrapTitle(title: string): string {
  const close = title[0] === '《' ? '》' : title[0] === '〈' ? '〉' : null
  if (!close || !title.endsWith(close)) return title
  let depth = 0
  for (let index = 0; index < title.length; index++) {
    if (title[index] === title[0]) depth++
    if (title[index] === close && --depth === 0 && index !== title.length - 1) return title
  }
  return depth === 0 ? title.slice(1, -1).trim() : title
}

/** Prefer plain names; a nonempty literal author name must remain usable. */
export function plainChapterTitle(value: string): string {
  let title = value.trim()
  for (;;) {
    const previous = title
    title = title.replace(chapterPrefix, '').trim()
    title = unwrapTitle(title)
    if (title === previous) return title || value.trim()
  }
}

/** Source ordinal remains identity evidence when imports contain namesakes. */
export function chapterTitleOrdinal(value: string): number | null {
  let source = value.trim()
  for (;;) { const unwrapped = unwrapTitle(source); if (unwrapped === source) break; source = unwrapped }
  const match = chapterPrefix.exec(source)
  if (!match) return null
  const digits = match[1].replace(/[０-９]/gu, char => String(char.charCodeAt(0) - 0xff10))
  if (/^\d+$/u.test(digits)) return Number.isSafeInteger(Number(digits)) ? Number(digits) : null
  const numbers: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 }
  const units: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10000 }
  let result = 0, section = 0, pending = 0
  for (const char of digits) {
    if (char === '万') { result += (section + pending || 1) * 10000; section = 0; pending = 0 }
    else if (units[char]) { section += (pending || 1) * units[char]; pending = 0 }
    else pending = numbers[char]
  }
  return result + section + pending
}
