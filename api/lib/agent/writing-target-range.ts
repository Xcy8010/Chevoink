/** Legacy lexical interpretation is retained for already admitted tasks. */
export const numeric = '[零〇一二两三四五六七八九十百千0-9]+'
/** Chapter separators in prose: hyphen, en/em dash, minus, tilde and fullwidth variants. */
export const rangeDash = '[-–—−~～〜－]'
/** A spoken chapter count is small; longer digit runs glued to 章 are ordinals ("把189章写完"), not counts. */
const shortCount = '\\d{1,2}|[一二两三四五六七八九十百千]+'
export function chapterNumber(text: string): number | null {
  if (/^\d+$/u.test(text)) { const value = Number(text); return Number.isSafeInteger(value) && value > 0 ? value : null }
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  let sum = 0, pending = 0
  for (const char of text) {
    if (digits[char]) pending = digits[char]
    else if (char === '十' || char === '百' || char === '千') { sum += (pending || 1) * ({ 十: 10, 百: 100, 千: 1000 }[char]); pending = 0 }
    else if (char !== '零' && char !== '〇') return null
  }
  return sum + pending || null
}

/** Pure extraction uses the whole admission request; generated goals are not authority.
 * Spacing around 第/章/至/dashes is prose, not semantics: "前 20 章" must parse
 * exactly like "前20章"; otherwise the freeze silently retargets the run. */
export type RequestedWritingRange = { kind: 'first' | 'next' | 'range' | 'count' | 'unbounded' | 'list' | 'existing'; start?: number; count?: number; positions?: number[]; volume?: number; anchor?: 'editor' }
export const negativeScopeClause = /(?:不继续|不批量|不续写|不生成|不要|无需|不用|不必|禁止|不得|不能|(?<!分)别|不写|不改|不修改|do not|don't|must not)/iu
export function writingScopeClauses(prompt: string) {
  return prompt.replace(new RegExp(`(${numeric}\\s*(?:章)?)\\s*[，,]\\s*(?=第?\\s*${numeric})`, 'gu'), '$1、').split(/[，,。！？!?；;\n]+/u)
}
export function legacyWritingRange(prompt: string): RequestedWritingRange | null {
  // Commas between chapter numbers are list separators, not new clauses. Keep
  // a negated list together so its later numbers cannot become positive scope.
  const positive = writingScopeClauses(prompt).filter(clause => !negativeScopeClause.test(clause)).join('，')
  const volumeMatch = positive.match(new RegExp(`第\\s*(${numeric})\\s*卷`, 'u'))
  const volume = volumeMatch ? chapterNumber(volumeMatch[1]) : null
  // Multiple volumes need a separately explicit mapping; a chapter ordinal is
  // never a global ordinal when a volume was requested.
  if (volumeMatch && (!volume || [...positive.matchAll(new RegExp(`第\\s*(${numeric})\\s*卷`, 'gu'))].length > 1)) return null
  const chapterPrompt = volumeMatch ? positive.slice(positive.indexOf(volumeMatch[0]) + volumeMatch[0].length) : positive
  const volumeScope = volume ? { volume } : {}
  const throughLast = chapterPrompt.match(new RegExp(`(?:从|自)\\s*(?:首章|第\\s*(${numeric})\\s*章)[^。；\\n]{0,24}(?:到|至)(?:\\s*(?:目前|现有|当前))?\\s*(?:最后(?:一)?(?:章|章节)?|末章)`, 'u'))
  const existing = Boolean(throughLast)
    || /(?:全书|整本(?:书|小说)|所有(?:已有|现有)?章节|全部(?:已有|现有)?章节)/u.test(chapterPrompt) && !new RegExp(`第\\s*${numeric}\\s*(?:章|[、，,])`, 'u').test(chapterPrompt)
    || Boolean(volume && !/章/u.test(chapterPrompt))
  // Preserve an explicit serialization grant; an existing-manuscript repair
  // interval still snapshots its rows even when the author says "自动".
  if (existing && !throughLast && !volume && /(?:自动|自主|自行|全权).{0,16}(?:写完|完成全书|创作全书|逐章写)|(?:write|finish).{0,24}(?:autonomously|automatically)/iu.test(positive)) return { kind: 'unbounded' }
  if (existing && /(?:改|优化|修复|修正|润色|审查|审阅|检查|评估|分析)/u.test(positive)) {
    const start = throughLast?.[1] ? chapterNumber(throughLast[1]) : 1
    return start ? { kind: 'existing', start, ...volumeScope } : null
  }
  // An open-ended chapter interval cannot fall through to its first ordinal.
  if (existing) return null
  const list = chapterPrompt.match(new RegExp(`第?\\s*${numeric}\\s*(?:章)?(?:\\s*(?:、|，|,|和|及|与)\\s*第?\\s*${numeric}\\s*(?:章)?)*\\s*(?:、|，|,|和|及|与)\\s*第?\\s*${numeric}\\s*章`, 'u'))
  if (list && /章/u.test(list[0])) {
    const positions = [...new Set([...list[0].matchAll(new RegExp(numeric, 'gu'))].map(item => chapterNumber(item[0])))]
    if (positions.every((position): position is number => position !== null) && positions.length <= 1000) return { kind: 'list', positions, ...volumeScope }
    return null
  }
  const range = chapterPrompt.match(new RegExp(`第?\\s*(${numeric})\\s*(?:章)?\\s*(?:至|到|${rangeDash})\\s*第?\\s*(${numeric})\\s*章`, 'u'))
  if (range) { const start = chapterNumber(range[1]), end = chapterNumber(range[2]); return start && end && end >= start && end - start < 1000 ? { kind: 'range', start, count: end - start + 1, ...volumeScope } : null }
  if (volume) {
    const chapter = chapterPrompt.match(new RegExp(`第\\s*(${numeric})\\s*章`, 'u'))
    const start = chapter ? chapterNumber(chapter[1]) : null
    return start ? { kind: 'range', start, count: 1, volume } : null
  }
  if (/(?:下\s*[一1]\s*章|next chapter)/iu.test(positive)) return { kind: 'next', count: 1,
    ...(/(?:当前(?:这)?(?:章|章节)|正在编辑(?:的)?(?:这章|章节|章))(?:之|以)?后|after\s+(?:the\s+)?(?:current|currently edited)\s+chapter/iu.test(positive) ? { anchor: 'editor' as const } : {}) }
  const firstCount = positive.match(new RegExp(`前\\s*(${numeric})\\s*章`, 'u'))
  if (firstCount) { const count = chapterNumber(firstCount[1]); if (count && count <= 1000) return { kind: 'range', start: 1, count } }
  if (/(?:首章|第\s*[一1]\s*章|first chapter)/iu.test(positive)) return { kind: 'first', start: 1, count: 1 }
  const ordinal = positive.match(new RegExp(`第\\s*(${numeric})\\s*章|chapter\\s*(\\d+)`, 'iu'))
  if (ordinal) { const start = chapterNumber(ordinal[1] ?? ordinal[2]); if (start) return { kind: 'range', start, count: 1 } }
  // (?<!\d) keeps "写189章" from parsing as a count of the trailing digits;
  // long digit runs belong to the bare-ordinal branch below.
  const countMatch = positive.match(new RegExp(`(?:写|创作|完成|起草).{0,6}(?<!\\d)(${shortCount})\\s*章`, 'u'))
  if (countMatch) { const count = chapterNumber(countMatch[1]); if (count && count <= 1000) return { kind: 'count', count } }
  const bareOrdinal = positive.match(new RegExp(`(?<!\\d)(\\d{1,4})\\s*章\\s*(?:都|全部|全|一起)?\\s*(?:写完|写|完成|创作|优化|修改|润色|处理|续写|补齐|改|补)`, 'u'))
  if (bareOrdinal) { const start = chapterNumber(bareOrdinal[1]); if (start) return { kind: 'range', start, count: 1 } }
  if (/(?:自动|自主|自行|全权).{0,16}(?:写完|完成全书|创作全书|逐章写)|(?:write|finish).{0,24}(?:autonomously|automatically)/iu.test(positive)) return { kind: 'unbounded' }
  return null
}
