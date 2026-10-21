import { chapterNumber, numeric, type RequestedWritingRange } from './writing-target-range.js'

export type AuthorSpan = { start: number; end: number }
export type AuthorWritingDirectory = {
  chapters: Array<{ id: string; orderIndex: number; orderInVolume: number; volumeId: string }>
  volumes: Array<{ id: string; orderIndex: number }>
}
export type AuthorClause = AuthorSpan & { text: string; masked: string; sentence: number }
export type AuthorQuotedSpan = AuthorSpan & { kind: 'quotation' | 'title' | 'code'; role: 'unknown';
  closed: boolean; contentStart: number; contentEnd: number }
export type AuthorWritingTarget = { span: AuthorSpan; clauseSpan: AuthorSpan;
  kind: 'ordinal' | 'count' | 'relative' | 'same_target' | 'global' | 'local' | 'prose' | 'book' | 'artifact' | 'metadata' | 'structure'; range: RequestedWritingRange | null;
  invalid?: boolean; contextual?: boolean }
export type AuthorWritingOperation = { span: AuthorSpan; clauseSpan: AuthorSpan;
  kind: 'write' | 'revise' | 'review' | 'read' | 'placement' | 'artifact' | 'structure'; polarity: 'affirmative' | 'negative';
  accepted: boolean; reason: string; targetIndices: number[] }
export type AuthorConditionalLocalRepair = { targetIndices: number[]; reviewOperationIndices: number[];
  repairs: Array<{ operationIndex: number; condition: { kind: 'review_findings' | 'necessity'; span: AuthorSpan } }> }
export type AuthorWritingRequest = { protocol: 2; range: RequestedWritingRange | null; ambiguous: boolean; hasAction: boolean;
  exclusions: string[]; confirmedNextOrderIndex?: number; intent: 'write' | 'revise' | 'review' | null;
  conditionalLocalRepair?: AuthorConditionalLocalRepair;
  evidence: { clauses: AuthorClause[]; quoted: AuthorQuotedSpan[]; operations: AuthorWritingOperation[]; targets: AuthorWritingTarget[] };
  reasons: string[] }

const spanOf = (clause: AuthorClause): AuthorSpan => ({ start: clause.start, end: clause.end })
// Ordinals identify existing directory rows. The quantity ceiling limits work,
// never the author's ability to name a high chapter or volume ordinal.
const ordinalNumber = (text: string) => { const value = chapterNumber(text); return value && Number.isSafeInteger(value) ? value : null }
const quantityNumber = (text: string) => { const value = ordinalNumber(text); return value && value <= 1000 ? value : null }
const numberPattern = `(?:${numeric})`
const join = '(?:、|及|与|和|至|到|[-–—−~～〜－])'
const chapterPattern = `(?:第\\s*)?${numberPattern}\\s*(?:章)?(?:\\s*${join}\\s*(?:第\\s*)?${numberPattern}\\s*(?:章)?)*\\s*章`
const numbered = new RegExp(`^(?:第\\s*)?(${numberPattern})\\s*章$`, 'u')
const revisionWords = '修订|修正|修改|改写|重写|扩写|缩写|修复|纠正|纠错|润色|优化|调整|替换|改名|重命名|改为|改成|插入|删除|删掉|删去|精简|补充|增加|整改|补足|解决|不动|改(?!价|变|卷)'
const preservationWords = '保持不变|保持原样|保留原样|保留|保持|不变'
const writeWords = '续写|继续(?!\\s*(?:写|创作|起草))|创作|起草|补写|补完|补齐|写完|完成|写入|落稿|新建|创建|新增|建章|保存|存入|导出|生成|发布|制定|拟定|编写|撰写|设计|构思|策划|整理|写(?!作)'
const structureWords = '移动|重排|排序|拆分|合并'
const reviewWords = '检查|审查|审阅|核对|核实|评估|分析|判断|检视|看看|复检|复核|校验'
const readWords = '读取|阅读|读完|参考|参照|根据|对照|呼应|回顾|借鉴|比照|通读|引用|搜索|检索|查找|查阅|研究|读'
const operationPattern = new RegExp(`${structureWords}|${revisionWords}|${preservationWords}|${writeWords}|${reviewWords}|${readWords}|\\b(?:write|draft|finish|complete|continue|revise|edit|repair|rewrite|polish|fix|replace|insert|delete|shorten|expand|check|review|assess|evaluate|read|consult|reference|save|export|generate|publish|move|reorder|split|merge)\\b`, 'iu')
const persistencePredicate = /^(?:保存|存入|导出|发布|save|export|publish)$/iu
const operationsIn = (text: string) => [...text.matchAll(new RegExp(operationPattern.source, 'giu'))].filter(match =>
  // A saved-body modifier belongs to its object. It must not split a negative
  // predicate from the chapter list on its right.
  !(persistencePredicate.test(match[0]) && /(?:已经|早已|曾经|已)\s*$/u.test(text.slice(0, match.index!))))
const hasPlacement = (text: string) => /(?:作为|as\s+(?:the\s+)?)(?:全书)?第/iu.test(text) && /写入|保存|落稿/u.test(text)
const revisionPattern = new RegExp(`^(?:${revisionWords}|revise|edit|repair|rewrite|polish|fix|replace|insert|delete|shorten|expand)$`, 'iu')
const preservationPattern = new RegExp(`^(?:${preservationWords})$`, 'u')
const readPattern = new RegExp(`^(?:${readWords}|read|consult|reference)$`, 'iu')
const reviewPattern = new RegExp(`^(?:${reviewWords}|check|review|assess|evaluate)$`, 'iu')
const structurePattern = new RegExp(`^(?:${structureWords}|move|reorder|split|merge)$`, 'iu')
const coordinatedPredicates = /^\s*(?:或(?:者)?|和|及|以及|与|并(?:且)?|、|and|or|nor)\s*$/iu
const factBefore = /提到|写道|写着|记载|描述|讲述|表示|说过|却|例如|举例|原文[:：]|(?:主角|角色|人物).{0,8}(?:尝试|打算|决定)|\b(?:said|says|mentions?|describes?)\b/iu
const advice = /如何|怎样|怎么|建议|方案|思路|方法|说明|讲解|\b(?:how|advice|suggestions?)\b/iu
const connective = /并且|然后|接着|同时|但是|不过|而且|并|但|且|再|\b(?:and|then|but)\b/iu
const conditionalRevisionModifier = /(?:按(?:照)?(?:需要|必要性|需)|视(?:需要|情况)|必要时|如有必要|如需|if\s+(?:needed|necessary)|as\s+needed)\s*$/iu
const editorAfterRelation = /(?:当前(?:这)?(?:章|章节)|正在编辑(?:的)?(?:这章|章节|章))(?:之|以)?后|\bafter\s+(?:the\s+)?(?:current|currently edited)\s+chapter\b/giu

/** UTF-16 coordinates stay identical to the author's input. A quotation never
 * becomes a whitespace join that can synthesize a new number or operation. */
export function lexAuthorWritingRequest(prompt: string): { masked: string; clauses: AuthorClause[]; quoted: AuthorQuotedSpan[] } {
  const quoted: AuthorQuotedSpan[] = [], chars = prompt.split('')
  const pairs: Record<string, string> = { '“': '”', '「': '」', '『': '』', '‘': '’', '《': '》', '"': '"', "'": "'", '`': '`' }
  for (let index = 0; index < prompt.length; index++) {
    const opener = prompt.startsWith('```', index) ? '```' : prompt[index]
    const closer = opener === '```' ? opener : pairs[opener]
    if (!closer || opener === "'" && /[a-z0-9]/iu.test(prompt[index - 1] ?? '')) continue
    let end = prompt.length, contentEnd = prompt.length, closed = false, escaped = false
    const stack = [{ opener, closer }]
    for (let at = index + opener.length; at < prompt.length; at++) {
      // Escaped ASCII delimiters and nested paired quotes remain inert data.
      if (escaped) { escaped = false; continue }
      if (prompt[at] === '\\') { escaped = true; continue }
      const current = stack.at(-1)!
      if (prompt.startsWith(current.closer, at)) {
        stack.pop()
        if (!stack.length) { closed = true; contentEnd = at; end = at + current.closer.length; break }
        at += current.closer.length - 1
      } else if (!current.opener.includes('`')) {
        const nested = prompt.startsWith('```', at) ? '```' : prompt[at]
        const nestedCloser = nested === '```' ? nested : pairs[nested]
        if (nestedCloser && !(nested === "'" && /[a-z0-9]/iu.test(prompt[at - 1] ?? ''))) {
          stack.push({ opener: nested, closer: nestedCloser }); at += nested.length - 1
        }
      }
    }
    quoted.push({ start: index, end, kind: opener.includes('`') ? 'code' : opener === '《' ? 'title' : 'quotation', role: 'unknown',
      closed, contentStart: index + opener.length, contentEnd })
    for (let at = index; at < end; at++) chars[at] = ' '
    index = end - 1
  }
  const masked = chars.join(''), clauses: AuthorClause[] = []
  let start = 0, sentence = 0
  const append = (end: number) => {
    if (masked.slice(start, end).trim() || quoted.some(quote => quote.start >= start && quote.end <= end)) {
      clauses.push({ start, end, text: prompt.slice(start, end), masked: masked.slice(start, end), sentence })
    }
  }
  for (const match of masked.matchAll(/[，,。.！？!?；;\r\n]+/gu)) {
    const at = match.index!, delimiter = match[0]
    if (delimiter === '.' && /[0-9]/u.test(masked[at - 1] ?? '') && /[0-9]/u.test(masked[at + 1] ?? '')) continue
    // A bare numbered list tail inherits the same operation and polarity.
    if (/^[，,]$/u.test(delimiter)
      && new RegExp(`${numberPattern}\\s*(?:章)?\\s*$`, 'u').test(masked.slice(start, at))
      && new RegExp(`^\\s*(?:第\\s*)?${numberPattern}\\s*(?:章|[、，,及与和])`, 'u').test(masked.slice(at + 1))) continue
    append(at); start = at + delimiter.length
    if (/[。.！？!?；;\r\n]/u.test(delimiter)) sentence++
  }
  append(masked.length)
  return { masked, clauses, quoted }
}

function extractTargets(clause: AuthorClause): AuthorWritingTarget[] {
  const candidates: AuthorWritingTarget[] = []
  const add = (pattern: RegExp, kind: AuthorWritingTarget['kind'], parse: (text: string, before: string) => RequestedWritingRange | null) => {
    for (const match of clause.masked.matchAll(pattern)) {
      const text = match[0], start = clause.start + match.index!, end = start + text.length
      const range = parse(text, clause.masked.slice(0, match.index))
      candidates.push({ span: { start, end }, clauseSpan: spanOf(clause), kind, range,
        ...(['ordinal', 'count', 'relative', 'global'].includes(kind) && !range ? { invalid: true } : {}),
        ...(/^\s*(?:提到|却|写道|写着|记载|已经|已完成|已修订)/u.test(clause.masked.slice(match.index! + text.length)) ? { contextual: true } : {}) })
    }
  }
  const chapterRange = (text: string): RequestedWritingRange | null => {
    const volumeMatch = text.match(new RegExp(`第\\s*(${numberPattern})\\s*卷`, 'u'))
    const volume = volumeMatch ? ordinalNumber(volumeMatch[1]) : undefined
    if (volumeMatch && !volume) return null
    const body = volumeMatch ? text.slice(volumeMatch[0].length).trim() : text.trim()
    if (volumeMatch && !body) return { kind: 'existing', start: 1, volume: volume! }
    const values = [...body.matchAll(new RegExp(numberPattern, 'gu'))].map(match => ordinalNumber(match[0]))
    if (!values.length || values.some(value => value === null)) return null
    const positions = values as number[], scope = volume ? { volume } : {}
    if (/(?:至|到|[-–—−~～〜－])/u.test(body)) return positions.length === 2 && positions[1] >= positions[0]
      && positions[1] - positions[0] < 1000 ? { kind: 'range', start: positions[0], count: positions[1] - positions[0] + 1, ...scope } : null
    if (positions.length > 1) return new Set(positions).size <= 1000 ? { kind: 'list', positions: [...new Set(positions)], ...scope } : null
    return { kind: 'range', start: positions[0], count: 1, ...scope }
  }
  add(new RegExp(`第\\s*${numberPattern}\\s*卷\\s*(?:${chapterPattern})?`, 'gu'), 'ordinal', chapterRange)
  add(new RegExp(`(?:从|自)\\s*(?:首章|第\\s*${numberPattern}\\s*章).{0,12}?(?:到|至)\\s*(?:目前|现有|当前)?\\s*(?:最后(?:一)?章|末章)`, 'gu'), 'global', text => {
    const start = text.includes('首章') ? 1 : ordinalNumber(text.match(new RegExp(numberPattern, 'u'))?.[0] ?? '')
    return start ? { kind: 'existing', start } : null
  })
  add(new RegExp(`前\\s*${numberPattern}\\s*章`, 'gu'), 'count', text => {
    const count = quantityNumber(text.match(new RegExp(numberPattern, 'u'))?.[0] ?? '')
    return count ? { kind: 'range', start: 1, count } : null
  })
  add(new RegExp(chapterPattern, 'gu'), 'ordinal', (text, before) => {
    const result = chapterRange(text)
    if (!result || !numbered.test(text.trim()) || /^\s*第/u.test(text) || /(?:、|及|与|和|至|到|[-–—−~～〜－])/u.test(text)) return result
    // Spoken small quantities are counts; a long bare ordinal is only accepted
    // in target-first syntax, never guessed as a quota from trailing digits.
    const raw = text.match(new RegExp(numberPattern, 'u'))![0]
    if (/\d{3,}/u.test(raw)) return /(?:写|创作|完成|起草)\s*$/u.test(before) ? null : result
    return result.start! <= 1000 ? { kind: 'count', count: result.start } : null
  })
  add(/首章|first chapter/giu, 'ordinal', () => ({ kind: 'first', start: 1, count: 1 }))
  add(/(?:(?:当前(?:这)?(?:章|章节)|正在编辑(?:的)?(?:这章|章节|章))(?:之|以)?后(?:的)?\s*)?(?:下\s*[一1]\s*章|next chapter)/giu,
    'relative', text => ({ kind: 'next', count: 1, ...(/之后|以后|章后|章节后/u.test(text) ? { anchor: 'editor' as const } : {}) }))
  add(/当前(?:这)?(?:一)?(?:章|章节)|(?:这|该|本)(?:一)?章|正在编辑(?:的)?章节|current chapter/giu, 'same_target', () => null)
  add(/全书|整本(?:书|小说)|所有(?:已有|现有)?章节|全部(?:已有|现有)?章节|whole book|all chapters/giu,
    'global', () => ({ kind: 'existing', start: 1 }))
  add(new RegExp(`(?:第\\s*${numberPattern}\\s*段|首段|末段|最后一段|开头|结尾|段落|句子|对白|对话|那句话|这句话|这句|一句|几句|这段|这一段|那段|某段|该段|片段|局部|选区|paragraph\\s*\\d+|sentence|passage|opening|beginning|ending|dialogue)`, 'giu'), 'local', () => null)
  add(/正文|草稿|稿件|prose|chapter\s*\d+/giu, 'prose', text => {
    const value = text.match(/chapter\s*(\d+)/iu)
    return value ? chapterRange(`第${value[1]}章`) : null
  })
  add(/小说|故事|novel|book/giu, 'book', () => null)
  add(/(?:作品|小说)?(?:简介|标签|书名|章名|卷名|标题|摘要)|(?:book|chapter|volume)\s+(?:title|summary)|tags/giu, 'metadata', () => null)
  add(/(?:(?:章节|正文|连续性|质量|分析|研究|拆书)(?:检查|分析|评估)?)?报告|计划(?:文件)?|大纲|规划|封面|设定集|人物表|文件|report|plan|outline|cover|file/giu, 'artifact', () => null)
  add(/章节顺序|卷章顺序|章节结构|卷章结构|顺序|结构|卷(?!内)|chapter order|structure|volume/giu, 'structure', () => null)
  // Longest object wins before operation binding; a title placeholder cannot
  // manufacture a volume/ordinal adjacency because its UTF-16 space remains.
  const selected: AuthorWritingTarget[] = []
  for (const candidate of candidates.sort((a, b) => (b.span.end - b.span.start) - (a.span.end - a.span.start) || a.span.start - b.span.start)) {
    if (!selected.some(item => candidate.span.start < item.span.end && item.span.start < candidate.span.end)) selected.push(candidate)
  }
  return selected.sort((a, b) => a.span.start - b.span.start)
}

function mergeRanges(ranges: RequestedWritingRange[], directory?: AuthorWritingDirectory): RequestedWritingRange | null {
  if (!ranges.length) return null
  const first = ranges[0]
  // A volume address and a book address are constraints on an entity, not
  // independent chapters merely because their textual forms differ. Only the
  // fresh admission directory may prove their identity; keep the volume fence.
  if (directory && ranges.every(range => rangeKey(range, directory) === rangeKey(first, directory))) {
    return ranges.find(range => range.volume !== undefined) ?? first
  }
  if (ranges.every(range => JSON.stringify(range) === JSON.stringify(first))) return first
  if (ranges.some(range => range.volume !== first.volume || !['first', 'range', 'list'].includes(range.kind))) return null
  const positions = [...new Set(ranges.flatMap(range => range.kind === 'list' ? range.positions ?? []
    : Array.from({ length: range.count ?? 1 }, (_, index) => (range.start ?? 1) + index)))]
  return positions.length <= 1000 ? { kind: 'list', positions, ...(first.volume ? { volume: first.volume } : {}) } : null
}

/** A question is a complement of its review governor, never an instruction to
 * execute the predicate being evaluated. Scope ends at a new author directive
 * or a sequential predicate; unrelated questions elsewhere cannot veto work. */
function assessmentPredicates(text: string, matches: RegExpMatchArray[]): Map<number, number | null> {
  const result = new Map<number, number | null>()
  const markers = [...text.matchAll(/是否|需不需要|有没有(?:必要)?|有无(?:必要)?|要不要|应不应该|该不该|能不能|可不可以|可否|能否|是不是|需要|必要性|\bwhether\b|\bif\b|\bneeds?\b|\bnecess(?:ity|ary)\b/giu)]
  const reviewGovernors = matches.flatMap((candidate, at) => reviewPattern.test(candidate[0]) ? [{ candidate, at }] : [])
  const hasDirectiveBoundary = (between: string) => /然后|随后|接着|\b(?:and\s+then|then)\b|(?:并且?|而且|再|\band\b)\s*(?:仅|只|请|明确|务必|\b(?:explicitly|only|please)\b)/iu.test(between)
  for (const [index, operation] of matches.entries()) {
    if (!revisionPattern.test(operation[0]) && !preservationPattern.test(operation[0]) && (readPattern.test(operation[0]) || reviewPattern.test(operation[0]))) continue
    for (const marker of markers) {
      const markerStart = marker.index!, operationStart = operation.index!
      let low = 0, high = reviewGovernors.length
      while (low < high) { const middle = (low + high) >>> 1
        if (reviewGovernors[middle].candidate.index! < Math.min(markerStart, operationStart)) low = middle + 1
        else high = middle
      }
      const governor = reviewGovernors[low - 1]
      // An interrogative explicitly asks a question even with an implicit
      // governor. A plain "需要/need" is only assessment under a review verb.
      const interrogative = /是否|需不需要|有没有|有无|要不要|应不应该|该不该|能不能|可不可以|可否|能否|是不是|\bwhether\b/iu.test(marker[0])
      if (!governor && !interrogative) continue
      // "按必要性修订" is a condition on execution. A review may still
      // govern an outer whether-question about that condition, but the bare
      // necessity noun is not itself an assessment complement.
      if (!interrogative && conditionalRevisionModifier.test(text.slice(0, operationStart))) continue
      if (markerStart > operationStart && matches[index + 1]?.index !== undefined && matches[index + 1].index! < markerStart) continue
      const between = text.slice(Math.min(markerStart + marker[0].length, operationStart + operation[0].length), Math.max(markerStart, operationStart))
      if (hasDirectiveBoundary(between)) continue
      if (markerStart < operationStart && governor
        && hasDirectiveBoundary(text.slice(governor.candidate.index! + governor.candidate[0].length, markerStart))) continue
      result.set(index, governor?.at ?? null)
      break
    }
  }
  return result
}

const singleton = (range: RequestedWritingRange) => ['first', 'range', 'next'].includes(range.kind) && range.count === 1
  || range.kind === 'list' && range.positions?.length === 1
function directoryRangeKey(range: RequestedWritingRange, directory?: AuthorWritingDirectory): string | undefined {
  if (!directory || !['first', 'range', 'list'].includes(range.kind)) return undefined
  const positions = range.kind === 'list' ? range.positions ?? []
    : Array.from({ length: range.count ?? 1 }, (_, index) => (range.start ?? 1) + index)
  if (!positions.length) return undefined
  const { chapters, volumes } = directory
  if (new Set(chapters.map(chapter => chapter.id)).size !== chapters.length
    || new Set(chapters.map(chapter => chapter.orderIndex)).size !== chapters.length
    || new Set(volumes.map(volume => volume.orderIndex)).size !== volumes.length) return undefined
  const volume = range.volume === undefined ? undefined : volumes.find(item => item.orderIndex === range.volume)
  if (range.volume !== undefined && !volume) return undefined
  const contiguousBook = chapters.every((chapter, index) => chapter.orderIndex === index + 1)
  const tail = chapters.at(-1)
  const keys: string[] = []
  for (const position of positions) {
    const matches = chapters.filter(chapter => volume
      ? chapter.volumeId === volume.id && chapter.orderInVolume === position : chapter.orderIndex === position)
    if (matches.length > 1) return undefined
    if (matches.length === 1) { keys.push(`chapter:${matches[0].id}`); continue }
    // A missing row is not a chapter identity. Prove one contiguous next slot,
    // including its actual volume, instead of guessing an offset or future row.
    if (!contiguousBook) return undefined
    const next = (tail?.orderIndex ?? 0) + 1
    if (!volume) {
      if (position !== next) return undefined
    } else {
      const within = chapters.filter(chapter => chapter.volumeId === volume.id)
      if (!within.every((chapter, index) => chapter.orderInVolume === index + 1)
        || (tail ? tail.volumeId !== volume.id || position !== tail.orderInVolume + 1
          : volume.orderIndex !== 1 || position !== 1)) return undefined
    }
    keys.push(`new:${next}`)
  }
  return JSON.stringify([...new Set(keys)].sort())
}
const rangeKey = (range: RequestedWritingRange, directory?: AuthorWritingDirectory) => directoryRangeKey(range, directory) ?? JSON.stringify(range.kind === 'list' && range.positions?.length === 1
  ? { kind: 'range', start: range.positions[0], count: 1, ...(range.volume ? { volume: range.volume } : {}) }
  : range.kind === 'first' ? { kind: 'range', start: 1, count: 1, ...(range.volume ? { volume: range.volume } : {}) } : range)

/** A read object is an address, never a mutation. A primary author scope takes
 * precedence over earlier reads, but a later non-reference read can introduce
 * a conflicting domain. Reference material and instruction-shaped data stay inert. */
function bindSameTargetObjects(masked: string, operations: AuthorWritingOperation[], targets: AuthorWritingTarget[], reasons: Set<string>, directory?: AuthorWritingDirectory) {
  const ranged = (operation: AuthorWritingOperation) => operation.targetIndices.filter(index => targets[index].range && !targets[index].contextual && !targets[index].invalid)
  const readable = (operation: AuthorWritingOperation) => {
    if (operation.kind !== 'read' || operation.polarity !== 'affirmative' || operation.reason !== 'reference'
      || !/^(?:读取|阅读|读完|通读|读|read)$/iu.test(masked.slice(operation.span.start, operation.span.end))) return false
    const before = masked.slice(operation.clauseSpan.start, operation.span.start)
    const object = masked.slice(operation.span.end, operation.clauseSpan.end)
    return !factBefore.test(before) && !advice.test(before) && !/(?:只|仅)\s*$|read.only/iu.test(before)
      && !/(?:这句|这段|原文|文字|提示|示例|引文|文本)\s*[:：]|作(?:为)?参考|用作参考|供参考|for\s+reference|as\s+(?:a\s+)?reference/iu.test(object)
  }
  for (const [operationIndex, operation] of operations.entries()) {
    if (!(operation.accepted || operation.polarity === 'negative' && operation.reason === 'negated')
      || !['write', 'revise', 'review'].includes(operation.kind)
      || !operation.targetIndices.some(index => targets[index].kind === 'same_target') || ranged(operation).length) continue
    const prior = operations.slice(0, operationIndex)
    const mutations = prior.filter(item => item.accepted && ['write', 'revise'].includes(item.kind) && ranged(item).length)
    const primary = mutations.length ? mutations : prior.filter(item => item.accepted && item.kind === 'review' && ranged(item).length)
    const latestPrimary = primary.at(-1)
    const primaryTargets = primary.flatMap(ranged)
    const singlePrimary = primaryTargets.length > 0 && new Set(primaryTargets.map(index => rangeKey(targets[index].range!, directory))).size === 1
      && primaryTargets.every(index => singleton(targets[index].range!))
    const supportingCoverage = (item: AuthorWritingOperation) => {
      const scopes = ranged(item)
      if (!singlePrimary || !scopes.length || scopes.some(index => targets[index].kind !== 'count')) return false
      const first = Math.min(...scopes.map(index => targets[index].span.start))
      // Coordinated unnumbered prose + counted background is reading coverage,
      // not a newly named chapter focus. Explicit ordinal objects still conflict.
      return item.targetIndices.some(index => targets[index].kind === 'prose' && !targets[index].range && targets[index].span.end <= first
        && /^(?:\s|、|,|，|和|与|及|以及|and)+$/iu.test(masked.slice(targets[index].span.end, first)))
    }
    const recentReads = prior.filter(item => readable(item) && (!latestPrimary || item.span.start >= latestPrimary.span.end) && !supportingCoverage(item))
    const candidates = [...primary, ...recentReads].flatMap(ranged)
    const unique = [...new Map(candidates.map(index => [rangeKey(targets[index].range!, directory), index])).values()]
    if (unique.length > 1 || unique.some(index => !singleton(targets[index].range!))) {
      reasons.add('ambiguous_target_reference')
    } else if (unique.length === 1) operation.targetIndices.push(unique[0])
  }
}

type RepairCondition = AuthorConditionalLocalRepair['repairs'][number]['condition']
/** Conditions are local grammatical governors, not a prompt-wide keyword flag.
 * Unknown subjects/events do not match this bounded review-result grammar. */
function repairCondition(operation: AuthorWritingOperation, clauses: AuthorClause[], targets: AuthorWritingTarget[]): RepairCondition | null {
  const clauseIndex = clauses.findIndex(clause => clause.start === operation.clauseSpan.start), clause = clauses[clauseIndex]
  if (!clause) return null
  const previous = clauses[clauseIndex - 1]
  const adjacent = previous?.sentence === clause.sentence ? previous : undefined
  const governed = adjacent && /^(?:\s*)(?:如|若|倘若|一旦|当|只有|仅当|等|待|if\b|when\b|unless\b|provided\b)|(?:批准|同意|许可|approval|permission|consent)|(?:后|时|以后)\s*$/iu.test(adjacent.masked)
  const candidates = governed && adjacent ? [adjacent] : [clause, ...(adjacent ? [adjacent] : [])]
  const issue = /(?:如(?:果)?|若|倘若|一旦|if|when)\s*(?:(?:本次|本轮|当前|the|this)\s*)?(?:(?:质量|连续性|独立|完整)\s*)?(?:(?:检查|审查|复检|复核|核对|报告|review|check|assessment)(?:结果|报告)?\s*)?(?:有|发现|查出|检出|存在|确认|证实|finds?|reveals?|identifies?|there\s+(?:is|are))\s*(?:(?:确证|确认|已证实|明确|真实|实际|可验证|confirmed|verified|actual)\s*)?(?:问题|错误|矛盾|冲突|缺陷|issues?|errors?|conflicts?|problems?)(?:时|后|的话)?/iu
  const necessity = /必要时|如有必要|如需|按(?:照)?(?:需要|必要性|需)|视需要|if\s+(?:needed|necessary)|as\s+needed/iu
  const directiveTail = (source: AuthorClause, start: number, end: number) => {
    let tail = source.masked.slice(start - source.start, end - source.start)
    for (const target of targets.filter(target => target.span.start >= start && target.span.end <= end).sort((a, b) => b.span.start - a.span.start)) {
      const offset = target.span.start - start
      tail = tail.slice(0, offset) + ' '.repeat(target.span.end - target.span.start) + tail.slice(offset + target.span.end - target.span.start)
    }
    return /^(?:\s|就|则|才|仅|只|请|对|在|做|进行|的|必要|位置|部分|处|一次|一遍|一轮|only|then|please)*$/iu.test(tail)
  }
  for (const source of candidates) {
    const end = source === clause ? operation.span.start : source.end
    const text = source.masked.slice(0, end - source.start)
    for (const [pattern, kind] of [[issue, 'review_findings'], [necessity, 'necessity']] as const) {
      const match = pattern.exec(text)
      if (!match) continue
      const start = source.start + match.index, conditionEnd = start + match[0].length
      // An if-condition cannot be a fragment of an external subject, another
      // condition, an assessment question, or an instruction-shaped payload.
      if (text.slice(0, match.index).trim()) continue
      if (!directiveTail(source, conditionEnd, end)) continue
      if (source !== clause) {
        const prefix = clause.masked.slice(0, operation.span.start - clause.start), modifier = necessity.exec(prefix)
        const directiveStart = modifier && !prefix.slice(0, modifier.index).trim() ? clause.start + modifier.index + modifier[0].length : clause.start
        if (!directiveTail(clause, directiveStart, operation.span.start)) continue
      }
      return { kind, span: { start, end: conditionEnd } }
    }
  }
  return null
}

/** This projection describes an ordered request, not a writable body range.
 * Consumers still need a fresh chapter identity and persisted finding anchors. */
function conditionalLocalRepair(operations: AuthorWritingOperation[], targets: AuthorWritingTarget[], clauses: AuthorClause[], directory?: AuthorWritingDirectory): AuthorConditionalLocalRepair | undefined {
  const mutations = operations.flatMap((operation, index) => {
    const clause = clauses.find(item => item.start === operation.clauseSpan.start)
    const predicate = clause?.text.slice(operation.span.start - clause.start, operation.span.end - clause.start) ?? ''
    // Persisting the authorized result does not turn a conditional local repair
    // into an unconditional drafting operation. Actual writes still use scope.
    return operation.accepted && ['write', 'revise'].includes(operation.kind)
      && !(operation.kind === 'write' && persistencePredicate.test(predicate)) ? [index] : []
  })
  if (!mutations.length || mutations.some(index => operations[index].kind !== 'revise')) return undefined
  const domain = (operation: AuthorWritingOperation) => {
    const ranged = operation.targetIndices.filter(index => targets[index].range)
    if (ranged.length) {
      const keys = [...new Set(ranged.map(index => rangeKey(targets[index].range!, directory)))]
      return keys.length === 1 && ranged.every(index => singleton(targets[index].range!)) ? { key: keys[0], indices: ranged } : null
    }
    const same = operation.targetIndices.filter(index => targets[index].kind === 'same_target')
    return same.length ? { key: 'same_target', indices: same } : null
  }
  const repairs: AuthorConditionalLocalRepair['repairs'] = [], reviewIndices = new Set<number>(), targetIndices = new Set<number>()
  let key: string | undefined
  for (const operationIndex of mutations) {
    const operation = operations[operationIndex], scope = domain(operation), condition = repairCondition(operation, clauses, targets)
    if (!scope || !condition || key !== undefined && scope.key !== key
      || !operation.targetIndices.some(index => targets[index].kind === 'local')) return undefined
    const reviews = operations.flatMap((review, index) => index < operationIndex && review.accepted && review.kind === 'review'
      && domain(review)?.key === scope.key ? [index] : [])
    if (!reviews.length) return undefined
    key = scope.key
    scope.indices.forEach(index => targetIndices.add(index))
    reviews.forEach(index => reviewIndices.add(index))
    repairs.push({ operationIndex, condition })
  }
  return { targetIndices: [...targetIndices], reviewOperationIndices: [...reviewIndices], repairs }
}

/** Fresh-author protocol 2 only. This interpreter does not read a manuscript,
 * resolve a relative target, mutate an old contract or grant an execution. */
function interpretAuthorWritingRequest(prompt: string, directory?: AuthorWritingDirectory): AuthorWritingRequest {
  const lexical = lexAuthorWritingRequest(prompt)
  // Never truncate a request into a smaller grant, or let oversized audit
  // metadata fail schema validation and fall back to historical authority.
  let operationCount = 0
  for (const clause of lexical.clauses) {
    operationCount += hasPlacement(clause.masked) ? 1 : operationsIn(clause.masked).length
    if (operationCount > 1000) return { protocol: 2, range: null, ambiguous: true, hasAction: false, exclusions: [], intent: null,
      evidence: { clauses: lexical.clauses, quoted: lexical.quoted, operations: [], targets: [] }, reasons: ['operation_limit'] }
  }
  const targets = lexical.clauses.flatMap(extractTargets)
  const operations: AuthorWritingOperation[] = [], reasons = new Set<string>(), exclusions: string[] = []
  const confirmations: Array<{ ordinal: number | null; operation: AuthorWritingOperation }> = []
  for (const [clauseIndex, clause] of lexical.clauses.entries()) {
    const text = clause.masked
    const matches = operationsIn(text)
    const assessed = assessmentPredicates(text, matches), operationBase = operations.length
    const clauseTargets = targets.flatMap((target, index) => target.clauseSpan.start === clause.start ? [index] : [])
    const placement = hasPlacement(text)
    if (placement) {
      const match = text.match(new RegExp(`^\\s*(?:请)?作为(?:全书)?第\\s*(${numberPattern})\\s*章(?:正式)?(?:写入|保存|落稿)\\s*$`, 'u'))
      const denied = /不要|不得|不许|不能|禁止|不必|别/u.test(text)
      const data = /读取|阅读|引用|参考|原文[:：]/u.test(text)
      const operation: AuthorWritingOperation = { span: spanOf(clause), clauseSpan: spanOf(clause), kind: 'placement',
        polarity: denied ? 'negative' : 'affirmative', accepted: !denied && !data, reason: denied ? 'negated' : data ? 'reference_data' : 'placement_constraint', targetIndices: clauseTargets }
      operations.push(operation)
      if (operation.accepted) confirmations.push({ ordinal: match ? ordinalNumber(match[1]) : null, operation })
      continue
    }
    let previous: AuthorWritingOperation | undefined
    for (const [index, match] of matches.entries()) {
      const start = clause.start + match.index!, end = start + match[0].length
      const protecting = preservationPattern.test(match[0])
      let kind: AuthorWritingOperation['kind'] = structurePattern.test(match[0]) ? 'structure'
        : revisionPattern.test(match[0]) || protecting ? 'revise' : reviewPattern.test(match[0]) ? 'review' : readPattern.test(match[0]) ? 'read' : 'write'
      // Past-tense object modifiers ("chapter 3's already saved body") are
      // evidence, not a new directive boundary that severs its chapter address.
      const left = previous?.reason === 'factual_statement' ? clause.start : previous?.span.end ?? clause.start
      const right = clause.start + (matches[index + 1]?.index ?? text.length)
      const before = lexical.masked.slice(clause.start, start), between = lexical.masked.slice(left, start), after = lexical.masked.slice(end, right)
      const conditionalRevision = kind === 'revise' && conditionalRevisionModifier.test(between)
      const negative = /(?:不要|不得|不许|不能|禁止|无需|无须|不用|不必|不应(?:该)?|不可|不再|不准|不允许|严禁|勿|(?<!分)别|never|(?:do|must|should|may|can|will)\s+not|don['’]t|cannot)\s*(?:(?!并|但|然后|接着|随后|而且|\b(?:and|then|but)\b).)*$/iu.exec(between)
      const directNegative = /不\s*$/u.test(between) || match[0] === '不动'
      const inheritedNegative = previous?.polarity === 'negative' && !connective.test(between)
        && /[，,、]/u.test(between) && /^[第零〇一二两三四五六七八九十百千0-9章，,、和及与\s]+$/u.test(between)
      const coordinatedNegative = previous?.polarity === 'negative' && coordinatedPredicates.test(between)
      const polarity = (protecting || negative && !/跳过|省略|略过|伪造/u.test(negative[0]) || directNegative || inheritedNegative || coordinatedNegative) ? 'negative' : 'affirmative'
      let bound = clauseTargets.filter(targetIndex => {
        const target = targets[targetIndex]
        return !target.contextual && target.span.start >= end && target.span.end <= right
      })
      if (!bound.length) bound = clauseTargets.filter(targetIndex => {
        const target = targets[targetIndex]
        return !target.contextual && target.span.start >= left && target.span.end <= start
      })
      if (bound.length && bound.every(targetIndex => !targets[targetIndex].range && ['prose', 'local'].includes(targets[targetIndex].kind))
        && (!previous || assessed.has(index) || previous.kind === 'review' && /并|后|再|and|then/iu.test(between))) {
        bound.push(...clauseTargets.filter(targetIndex => targets[targetIndex].range && !targets[targetIndex].contextual
          && targets[targetIndex].span.start >= left && targets[targetIndex].span.end <= start))
      }
      // Coordinated predicates can share an object on their right. A reading
      // predicate never lends its reference object to a mutation.
      const nextMatch = matches[index + 1]
      if (!bound.length && nextMatch && (reviewPattern.test(nextMatch[0])
        && /^\s*(?:并且?|与|和|然后|and|then)\s*$/iu.test(after)
        || ['write', 'revise', 'artifact', 'structure'].includes(kind) && coordinatedPredicates.test(after))) {
        const objectEnd = clause.start + (matches[index + 2]?.index ?? text.length)
        bound = clauseTargets.filter(targetIndex => targets[targetIndex].span.start >= right + nextMatch[0].length
          && targets[targetIndex].span.end <= objectEnd && !targets[targetIndex].contextual)
      }
      // Scope-first syntax may put arbitrary adverbial modifiers around an
      // operation. The author binds a manuscript object, not a prefix lexicon.
      if (bound.every(targetIndex => targets[targetIndex].kind === 'prose' && !targets[targetIndex].range)
        && previous?.kind === 'review' && previous.accepted && /并|后|再|and|then/iu.test(between)) bound = [...bound, ...previous.targetIndices]
      if (!bound.length && kind === 'review' && previous && ['review_wrapper', 'review_subject'].includes(previous.reason)) bound = [...previous.targetIndices]
      const precedingClause = lexical.clauses[clauseIndex - 1]
      if (!previous && precedingClause?.sentence === clause.sentence && !operationPattern.test(precedingClause.masked)
        && !factBefore.test(precedingClause.masked) && !advice.test(precedingClause.masked)) {
        const prior = targets.flatMap((target, targetIndex) => target.clauseSpan.start === precedingClause.start && !target.contextual ? [targetIndex] : [])
        const objectEnd = precedingClause.start + precedingClause.masked.trimEnd().length
        const namedScope = prior.some(targetIndex => targets[targetIndex].range)
          && prior.some(targetIndex => targets[targetIndex].span.end === objectEnd)
        if (!bound.length || namedScope && bound.every(targetIndex => !targets[targetIndex].range
          && ['local', 'prose'].includes(targets[targetIndex].kind))) bound = [...bound, ...prior]
      }
      if (kind === 'write' && [...text.matchAll(new RegExp(editorAfterRelation.source, 'giu'))].some(relation =>
        clause.start + relation.index! >= left && clause.start + relation.index! + relation[0].length <= right)) {
        for (const targetIndex of bound) if (targets[targetIndex].range?.kind === 'next') {
          targets[targetIndex].range = { ...targets[targetIndex].range!, anchor: 'editor' }
        }
      }
      const replacesSource = /^(?:替换|改为|改成|replace)$/iu.test(match[0]) || /^\s*(?:为|成)/u.test(after)
      const sourceQuotes = kind !== 'revise' ? [] : lexical.quoted.filter(quote => (quote.kind === 'quotation' || !quote.closed)
        && (protecting && precedingClause?.sentence === clause.sentence && !precedingClause.masked.trim()
          && quote.start >= precedingClause.start && quote.end <= precedingClause.end
          || quote.start >= clause.start && quote.end <= clause.end && (protecting && quote.end <= start && /^\s*$/u.test(lexical.masked.slice(quote.end, start))
          || (replacesSource
          ? quote.end <= start && /^\s*$/u.test(lexical.masked.slice(quote.end, start)) && /(?:把|将|replace)\s*$/iu.test(lexical.masked.slice(clause.start, quote.start))
          : quote.start >= end && quote.end <= right && /^\s*(?:(?:这|那|该|此|以下|下列|选中|所选)(?:的)?\s*)?(?:(?:句子?|段落?|文本|文字|正文|原文|内容)(?:的)?\s*)?[:：]?\s*$/u.test(lexical.masked.slice(end, quote.start))))))
      for (const quote of sourceQuotes) {
        let targetIndex = targets.findIndex(target => target.kind === 'local' && target.span.start === quote.start && target.span.end === quote.end)
        if (targetIndex < 0) targetIndex = targets.push({ span: { start: quote.start, end: quote.end },
          clauseSpan: spanOf(lexical.clauses.find(source => quote.start >= source.start && quote.end <= source.end) ?? clause), kind: 'local', range: null }) - 1
        bound.push(targetIndex)
      }
      const quoteEdit = sourceQuotes.length > 0
      const objectKinds = bound.map(targetIndex => targets[targetIndex].kind)
      if (['write', 'revise'].includes(kind) && (objectKinds.includes('metadata')
        || /^(?:改名|重命名|rename)$/iu.test(match[0]) && objectKinds.length > 0)
        && !bound.some(targetIndex => targets[targetIndex].range && targets[targetIndex].range!.volume === undefined)
        && !objectKinds.some(object => ['prose', 'local', 'global'].includes(object))) kind = 'artifact'
      if (['write', 'revise'].includes(kind) && objectKinds.includes('artifact')
        && (objectKinds.every(object => object === 'artifact')
          || /^(?:保存|存入|导出|save|export)$/iu.test(match[0]) && /到|为|成|\b(?:to|as)\b/iu.test(after))) kind = 'artifact'
      if (['write', 'revise'].includes(kind) && objectKinds.includes('structure')
        && !objectKinds.some(object => ['ordinal', 'relative', 'same_target', 'local', 'prose', 'book'].includes(object))) kind = 'structure'
      if (/^(?:新增|新建|创建|删除)$/u.test(match[0]) && bound.some(targetIndex => {
        const target = targets[targetIndex]
        return target.range?.volume !== undefined && /卷\s*$/u.test(prompt.slice(target.span.start, target.span.end))
      })) kind = 'structure'
      const explicitLocal = /修复|修正|纠正|修改|修订|补足|解决|改/u.test(match[0]) && /问题|因果|矛盾/u.test(after)
      // A direct, objectless writing command asks for prose placement; it is
      // not a grant to guess a chapter. Named artifacts retain their own role.
      const implicitWriting = kind === 'write' && !bound.length && /^(?:写|续写|创作|起草|write|draft)$/iu.test(match[0])
        && /^(?:(?:请(?:你)?|帮我|替我|为我|给我|麻烦(?:你)?|现在|直接|先|再|就|只|然后|接着|please|then)\s*)*$/iu.test(before.trim())
      let reason = polarity === 'negative' ? 'negated' : 'author_operation'
      if (kind === 'read') reason = 'reference'
      else if (factBefore.test(before) || /(?:已经|早已|曾经|已)\s*$/u.test(before) || /^\s*过/u.test(after)) reason = 'factual_statement'
      else if (advice.test(before) || /的(?:建议|方案|思路|方法|报告|情况)\s*$/u.test(after)
        || /^(?:的)?(?:手法|技巧|方法|建议|教程|风格)/u.test(after)) reason = 'advice'
      else if (/只读|仅供阅读|read.only/iu.test(before)) reason = 'read_only'
      else if (/[:：]/u.test(before) && operations.some(operation => operation.clauseSpan.start === clause.start
        && (operation.kind === 'read' || operation.kind === 'review'
          && /这句|这段|原文|文字|提示|示例|引文/u.test(lexical.masked.slice(operation.span.end, start))))
        || /引用原文|阅读提示|读取这句|阅读这句/u.test(before)) reason = 'reference_data'
      else if (assessed.has(index)) reason = 'assessment_predicate'
      else if (protecting) reason = 'protected'
      else if (polarity === 'negative') reason = 'negated'
      else if (sourceQuotes.some(quote => !quote.closed)) reason = 'unclosed_source_quote'
      else if (kind === 'write' && /完成|finish|complete/iu.test(match[0]) && matches.slice(index + 1).some(next => reviewPattern.test(next[0]))
        && !/并|然后|后|再/u.test(after)) reason = 'review_wrapper'
      else if ((kind === 'write' || kind === 'revise') && nextMatch && reviewPattern.test(nextMatch[0])
        && !conditionalRevision && !/并|与|和|然后|后|再|\b(?:and|then)\b/iu.test(after)) reason = 'review_subject'
      else if ((kind === 'write' || kind === 'revise') && !bound.length && !quoteEdit && !explicitLocal && !conditionalRevision && !implicitWriting) reason = 'no_manuscript_object'
      else if (kind === 'structure' && !bound.length) reason = 'no_manuscript_object'
      else if (kind === 'revise' && !quoteEdit && bound.length && bound.every(targetIndex => targets[targetIndex].span.end <= start)
        && !/^(?:改名|重命名|rename)$/iu.test(match[0])
        && after.trim() && !clauseTargets.some(targetIndex => ['prose', 'local'].includes(targets[targetIndex].kind))
        && !bound.some(targetIndex => targets[targetIndex].kind === 'global')
        && !/[:：]|正文|草稿|稿件|问题/u.test(before + after)) reason = 'unbound_postposed_operation'
      if (reason === 'negated' && ['write', 'revise'].includes(kind)) exclusions.push(clause.text.trim())
      if (reason === 'unclosed_source_quote') reasons.add(reason)
      const accepted = polarity === 'affirmative' && ['author_operation'].includes(reason)
      const operation: AuthorWritingOperation = { span: { start, end }, clauseSpan: spanOf(clause), kind, polarity, accepted, reason, targetIndices: bound }
      const governorIndex = assessed.get(index)
      if (reason === 'assessment_predicate' && governorIndex !== undefined && governorIndex !== null) {
        const governor = operations[operationBase + governorIndex]
        governor.targetIndices = [...new Set([...governor.targetIndices, ...bound])]
      }
      operations.push(operation); previous = operation
    }
    // In target-first questions a final "please check" governs the preceding
    // assessment across a comma, while a sentence boundary closes that scope.
    const precedingClause = lexical.clauses[clauseIndex - 1]
    if (precedingClause?.sentence === clause.sentence) {
      const prior = operations.filter(operation => operation.clauseSpan.start === precedingClause.start)
      if (prior.length && prior.every(operation => operation.reason === 'assessment_predicate')) {
        for (const operation of operations.slice(operationBase)) if (operation.kind === 'review' && operation.accepted && !operation.targetIndices.length) {
          operation.targetIndices = [...new Set(prior.flatMap(item => item.targetIndices))]
        }
      }
    }
  }
  // Incomplete payloads cannot disappear merely because a chapter selector or
  // an unfinished transformation sits between the verb and quotation. Only a
  // proven read/review object is inert data; unknown roles keep the request
  // ambiguous instead of leaving behind a whole-chapter mutation grant.
  for (const quote of lexical.quoted.filter(quote => !quote.closed)) {
    const clause = lexical.clauses.find(clause => clause.start <= quote.start && quote.end <= clause.end)
    const owners = operations.filter(operation => operation.span.end <= quote.start
      && operation.clauseSpan.start === clause?.start)
    const owner = owners.at(-1)
    const hasMutationPredicate = owners.some(operation => ['revise', 'write'].includes(operation.kind))
    if (owner && !hasMutationPredicate && (owner.kind === 'read' || owner.kind === 'review'
      || ['reference_data', 'factual_statement', 'advice', 'assessment_predicate', 'read_only'].includes(owner.reason))) continue
    if (owner && ['revise', 'write'].includes(owner.kind)) {
      let index = targets.findIndex(target => target.kind === 'local' && target.span.start === quote.start && target.span.end === quote.end)
      if (index < 0) index = targets.push({ span: { start: quote.start, end: quote.end },
        clauseSpan: spanOf(clause!), kind: 'local', range: null }) - 1
      if (!owner.targetIndices.includes(index)) owner.targetIndices.push(index)
      if (owner.polarity === 'negative') { reasons.add('unclosed_source_quote'); continue }
      owner.accepted = false
      owner.reason = 'unclosed_source_quote'
    }
    reasons.add('unclosed_source_quote')
  }
  for (const quote of lexical.quoted.filter(quote => quote.closed && quote.kind === 'quotation')) {
    const clause = lexical.clauses.find(clause => clause.start <= quote.start && quote.end <= clause.end)
    const prior = operations.filter(operation => operation.span.end <= quote.start && operation.clauseSpan.start === clause?.start)
    if (prior.at(-1) && !prior.some(operation => ['revise', 'write'].includes(operation.kind))
      && ['read', 'review'].includes(prior.at(-1)!.kind)) continue
    const mutations = operations.filter(operation => operation.accepted && operation.kind === 'revise'
      && operation.clauseSpan.start === clause?.start)
    if (!mutations.length || operations.some(operation => operation.targetIndices.some(index =>
      targets[index].span.start === quote.start && targets[index].span.end === quote.end))) continue
    const owner = mutations.at(-1)!
    const operator = prompt.slice(owner.span.start, owner.span.end)
    const replacement = quote.start >= owner.span.end && (/^(?:改为|改成)$/iu.test(operator)
      || /^(?:修改|修订|改|替换|edit|revise|replace)$/iu.test(operator) && /^\s*(?:为|成|with)\s*$/iu.test(prompt.slice(owner.span.end, quote.start)))
    if (!replacement) reasons.add('unresolved_source_quote')
  }
  bindSameTargetObjects(lexical.masked, operations, targets, reasons, directory)
  const mutations = operations.filter(operation => operation.accepted && (operation.kind === 'write' || operation.kind === 'revise'))
  const selected = mutations.length ? mutations : operations.filter(operation => operation.accepted && operation.kind === 'review')
  for (const operation of selected) {
    if (operation.targetIndices.some(index => targets[index].invalid)) reasons.add('invalid_target')
    const addresses = operation.targetIndices.filter(index => targets[index].range && targets[index].kind !== 'same_target')
    if (addresses.length > 1 && (!directory || new Set(addresses.map(index => rangeKey(targets[index].range!, directory))).size > 1)) reasons.add('unbound_target_relation')
  }
  const selectedTargets = [...new Set(selected.flatMap(operation => operation.targetIndices))].map(index => targets[index])
  const ranges = selectedTargets.flatMap(target => target.range ? [target.range] : [])
  for (const operation of selected) if (operation.kind === 'write' && /自动|自主|自行|全权|autonomously|automatically/iu.test(lexical.masked.slice(operation.clauseSpan.start, operation.span.start))) {
    for (const index of operation.targetIndices) if (targets[index].kind === 'global' && targets[index].range) {
      const rangeIndex = ranges.indexOf(targets[index].range!)
      if (rangeIndex >= 0) ranges[rangeIndex] = { kind: 'unbounded' }
    }
  }
  const range = mergeRanges(ranges, directory)
  if (ranges.length && !range) reasons.add('conflicting_targets')
  if (selectedTargets.some(target => target.invalid)) reasons.add('invalid_target')
  const reference = selectedTargets.some(target => target.kind === 'same_target')
  if (reference && range && (range.kind === 'existing' || range.kind === 'unbounded' || (range.kind === 'list' ? range.positions?.length : range.count) !== 1)) reasons.add('same_target_multiple')
  let confirmedNextOrderIndex: number | undefined
  if (mutations.length && confirmations.length) {
    const ordinal = confirmations[0].ordinal
    if (!ordinal || confirmations.some(item => item.ordinal !== ordinal)) reasons.add('unsupported_placement')
    else if (range?.kind === 'next') confirmedNextOrderIndex = ordinal
    else if (!range || range.volume || (range.kind === 'list' ? range.positions?.length !== 1 || range.positions[0] !== ordinal
      : !['first', 'range'].includes(range.kind) || range.count !== 1 || range.start !== ordinal)) reasons.add('conflicting_placement')
  }
  const writing = mutations.some(operation => operation.kind === 'write' && operation.targetIndices.some(index => targets[index].range?.kind === 'next'))
  const intent = writing ? 'write' : mutations.some(operation => operation.kind === 'revise') ? 'revise'
    : mutations.length ? 'write' : selected.length ? 'review' : null
  const workflow = reasons.size ? undefined : conditionalLocalRepair(operations, targets, lexical.clauses, directory)
  return { protocol: 2, range: reasons.size ? null : range, ambiguous: reasons.size > 0, hasAction: selected.length > 0,
    exclusions: [...new Set(exclusions)], ...(confirmedNextOrderIndex !== undefined ? { confirmedNextOrderIndex } : {}), intent,
    ...(workflow ? { conditionalLocalRepair: workflow } : {}),
    evidence: { clauses: lexical.clauses, quoted: lexical.quoted, operations, targets }, reasons: [...reasons].slice(0, 32) }
}

export function parseAuthorWritingRequest(prompt: string): AuthorWritingRequest {
  return interpretAuthorWritingRequest(prompt)
}

/** Only fresh admission supplies its locked, complete directory snapshot. */
export function resolveAuthorWritingRequest(prompt: string, directory: AuthorWritingDirectory): AuthorWritingRequest {
  return interpretAuthorWritingRequest(prompt, directory)
}

/** Same lexer and bindings as admission, restricted to actual negative author
 * operations. It cannot reinterpret quoted data or invert a positive target. */
export function parseAuthorWritingExclusion(clause: string): RequestedWritingRange | null {
  const parsed = parseAuthorWritingRequest(clause)
  const negative = parsed.evidence.operations.filter(operation => operation.polarity === 'negative' && operation.reason === 'negated'
    && (operation.kind === 'write' || operation.kind === 'revise'))
  const targets = negative.map(operation => operation.targetIndices.map(index => parsed.evidence.targets[index]))
  if (targets.some(group => group.some(target => target.invalid || target.contextual)
    || group.some(target => !target.range) || group.filter(target => target.range).length > 1)) return null
  return mergeRanges(targets.flat().flatMap(target => target.range ? [target.range] : []))
}
