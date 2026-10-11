import { taskSpecSchema, type TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError } from '../prisma.js'
import { runtimeJson } from './runtime-common.js'

type Locator = { kind: 'quote'; text: string } | { kind: 'paragraph'; position: number | 'last' } | { kind: 'unknown' }
const edit = /(?:修改|改写|重写|润色|优化|调整|修复|修正|替换|改成|改为|扩写|缩写|精简|删掉|删去|删除|补充|补|增加|插入|改(?!名|价|变|卷)|revise|rewrite|edit|modify|polish|replace|fix|change|expand|shorten|delete|remove|insert|add)/iu
const negative = /(?:不要|无需|不用|不必|禁止|不得|不能|(?<!分)别|不改|do not|don't|must not|never)/iu
const local = /(?:局部|片段|句子|这句话|这句|一句|几句|这段|这一段|那段|该段|某段|段落|对白|对话|开头|结尾|首段|末段|最后一段|第\s*[一二两三四五六七八九十百0-9]+\s*段|first paragraph|last paragraph|paragraph\s*\d+|passage|sentence)/iu
const whole = /(?:整章|整段正文|整篇|全文|全章|whole chapter|entire chapter)/iu
const quotePattern = /“([^”]+)”|「([^」]+)」|『([^』]+)』|"([^"\n]+)"/gu
const quoteEditPrefix = '(?:修改|改写|润色|替换|优化|调整|修复|修正|扩写|缩写|精简|删掉|删去|删除|改)(?:第\\s*[一二两三四五六七八九十百0-9]+\\s*章(?:的)?)?(?:这句|句子|片段)?\\s*'
const exclusiveLocal = /(?:只|仅|局部|先|only)|^\s*first\s+(?:edit|revise|polish|rewrite)/iu

/** Asking whether a revision is needed is evidence for assessment, not a
 * grant to perform it. Consumers apply this only to fresh marked contracts. */
export function hasReadOnlyRevisionAssessment(prompt: string | null): boolean {
  return (prompt ?? '').replace(quotePattern, '【引文】').split(/[。！？!?；;\n，,]+/u)
    .some(clause => edit.test(clause) && /(?:是否|有没有必要|有无必要|需不需要|要不要)|\bwhether\b|\bif\b.{0,40}\b(?:should|need(?:s|ed)?|necessary)\b/iu.test(clause))
}

/** Only actionable author wording counts. Quoted instructions, examples,
 * questions and readonly recommendations cannot authorize a local mutation. */
export function requestedLocalEdit(prompt: string): Locator | null {
  const unquoted = prompt.replace(quotePattern, '【引文】')
  if (hasReadOnlyRevisionAssessment(prompt) && local.test(unquoted)) return { kind: 'unknown' }
  const clauses = unquoted.split(/[。！？!?；;\n，,]+/u)
  const positive = clauses.filter(clause => !negative.test(clause)
    && !/^\s*(?:请)?(?:如何|怎么|是否|例如|举例|引用|参考|[他她]说过|how to|example)/iu.test(clause)
    && !/^\s*(?:请)?(?:给出|提供|列出|说明|输出|提出).*(?:建议|方案|思路|报告)/iu.test(clause))
  const actionable = positive.filter(clause => edit.test(clause))
  // A clear whole-chapter grant with a quality emphasis is still whole-chapter
  // work. An exclusive local limit or ordered local-then-whole ask is different.
  const wholeGrant = actionable.some(clause => whole.test(clause) && !local.test(clause))
  const localActions = actionable.filter(clause => local.test(clause))
  const createsChapter = /(?:写|创作|起草|续写).{0,12}(?:第\s*[一二两三四五六七八九十百0-9]+\s*章|下一章|首章)|(?:write|draft)\s+(?:the\s+)?(?:next\s+chapter|chapter\s*\d+)/iu.test(positive[0] ?? '')
  if (createsChapter && localActions.length && localActions.every(clause => !exclusiveLocal.test(clause))) return null
  if (wholeGrant && localActions.length && localActions.every(clause => /(?:重点|尤其|特别注意|着重|focus|especially)/iu.test(clause)
    && !exclusiveLocal.test(clause))) return null
  const explicitQuote = new RegExp(`(?:把|将)\\s*【引文】.{0,12}(?:改成|改为|替换|修改|改写|润色)|${quoteEditPrefix}【引文】`, 'u').test(actionable.join('，'))
  const constrained = actionable.some(clause => local.test(clause)
    && (!whole.test(clause) || /(?:只|仅|局部|的|中|only)/iu.test(clause))) || explicitQuote
  if (!constrained) return null
  if (/(?:以外|之外|除了|上下文|except|outside)/iu.test(actionable.join('，'))) return { kind: 'unknown' }
  // Conflicting/mixed scope is not an invitation to guess a broad grant.
  if (positive.some(clause => whole.test(clause) && /(?:写|创作|完成|write|draft)/iu.test(clause))
    || actionable.some(clause => whole.test(clause))
    || clauses.some(clause => negative.test(clause) && (local.test(clause) || /正文|任何修改|prose|any edits?/iu.test(clause)))) return { kind: 'unknown' }
  if (explicitQuote) {
    const sourceQuotes = [...prompt.matchAll(new RegExp(`(?:(?:把|将)\\s*|${quoteEditPrefix})(?:“([^”]+)”|「([^」]+)」|『([^』]+)』|"([^"\\n]+)")`, 'gu'))]
    return sourceQuotes.length === 1 ? { kind: 'quote', text: sourceQuotes[0][1] ?? sourceQuotes[0][2] ?? sourceQuotes[0][3] ?? sourceQuotes[0][4] } : { kind: 'unknown' }
  }
  const text = actionable.join('，')
  const paragraphs = [...text.matchAll(/首段|末段|最后一段|第\s*([一二两三四五六七八九十百0-9]+)\s*段|first paragraph|last paragraph|paragraph\s*(\d+)/giu)]
  if (paragraphs.length !== 1) return { kind: 'unknown' }
  if (local.test(text.replace(paragraphs[0][0], ''))) return { kind: 'unknown' }
  const qualifier = text.slice(paragraphs[0].index! + paragraphs[0][0].length).trim()
  // A paragraph number is not evidence for a narrower phrase/character span.
  // Only an explicit chapter suffix may follow the complete paragraph object.
  if (qualifier && !/^(?:of\s+chapter\s*\d+)$/iu.test(qualifier)) return { kind: 'unknown' }
  const match = paragraphs[0]
  if (/末段|最后一段|last paragraph/iu.test(match[0])) return { kind: 'paragraph', position: 'last' }
  if (/首段|first paragraph/iu.test(match[0])) return { kind: 'paragraph', position: 1 }
  const number = match[1] ?? match[2]
  const named: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const position = named[number] ?? Number(number)
  return Number.isSafeInteger(position) && position > 0 ? { kind: 'paragraph', position } : { kind: 'unknown' }
}

export function freezeLocalEditBoundary(prompt: string, writing: TaskSpec['scope']['writing'],
  chapters: Array<{ id: string; revision: number; content: string }>): NonNullable<TaskSpec['scope']['localEditBoundary']> | undefined {
  const locator = requestedLocalEdit(prompt)
  if (!locator) return undefined
  const denied = { version: 1 as const, kind: 'needs_input' as const, regions: [] }
  if (locator.kind === 'unknown' || writing?.kind !== 'bounded' || !writing.targets.length) return denied
  const regions: NonNullable<TaskSpec['scope']['localEditBoundary']>['regions'] = []
  for (const target of writing.targets) {
    const chapter = chapters.find(item => item.id === target.chapterId)
    if (!chapter) return denied
    let start: number, end: number
    if (locator.kind === 'quote') {
      start = chapter.content.indexOf(locator.text)
      if (start < 0 || chapter.content.indexOf(locator.text, start + 1) >= 0) return denied
      end = start + locator.text.length
    } else {
      // A paragraph is a nonblank saved line; CRLF and separators remain outside.
      const paragraphs = [...chapter.content.matchAll(/[^\r\n]+/gu)].filter(match => match[0].trim())
      const paragraph = paragraphs[locator.position === 'last' ? paragraphs.length - 1 : locator.position - 1]
      if (!paragraph) return denied
      start = paragraph.index!; end = start + paragraph[0].length
    }
    // Local prose must never be a disguised full-body replacement.
    if (start === 0 && end === chapter.content.length) return denied
    regions.push({ chapterId: chapter.id, revision: chapter.revision, contentHash: runtimeJson({ content: chapter.content }).hash,
      start, end, prefix: chapter.content.slice(0, start), suffix: chapter.content.slice(end) })
  }
  return { version: 1, kind: 'bounded', regions }
}

export function originalLocalEditBoundary(value: unknown) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  const scope = raw?.scope && typeof raw.scope === 'object' && !Array.isArray(raw.scope) ? raw.scope as Record<string, unknown> : null
  if (scope?.localEditProtocol === undefined) return null
  const parsed = taskSpecSchema.safeParse(value)
  const boundary = parsed.success ? parsed.data.scope.localEditBoundary : undefined
  // A marker on a nonlocal fresh contract has no boundary. A malformed stored
  // field must never degrade to a whole-chapter grant.
  if (!parsed.success || scope.localEditBoundary !== undefined && !boundary
    || boundary && (boundary.kind === 'bounded' ? !boundary.regions.length : boundary.regions.length > 0)
    || boundary && (new Set(boundary.regions.map(region => region.chapterId)).size !== boundary.regions.length
      || boundary.regions.some(region => region.end <= region.start || region.prefix.length !== region.start
        || !region.prefix.length && !region.suffix.length))) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原局部编辑授权快照损坏，不能扩大正文范围。')
  }
  return boundary ?? null
}

export function assertLocalEditArguments(spec: unknown, args: { patches?: Array<{ oldText?: string; start?: number; end?: number }>;
  oldText?: string; start?: number; end?: number }) {
  if (!originalLocalEditBoundary(spec)) return
  if ((args.patches ?? [args]).some(patch => !patch.oldText || patch.start !== undefined || patch.end !== undefined)) {
    throw new DataAccessError(409, 'AUTHOR_LOCAL_SCOPE', '局部编辑必须使用当前正文中逐字唯一的 oldText，不能猜坐标或绕过片段定位。')
  }
}

export function localEditGuidance(spec: unknown): string | null {
  const boundary = originalLocalEditBoundary(spec)
  if (!boundary) return null
  const intersection = taskSpecSchema.parse(spec).scope.selectionBoundary ? '同时保留编辑器冻结选区约束，仅可修改两个范围的交集。' : ''
  return (boundary.kind === 'needs_input'
    ? '原局部请求尚无可证明的精确范围，正文未获写入授权。请通过既有反馈入口请作者补充准确原文片段或编辑器选区，并重新发起任务；模型摘要、继续或子任务不能补授权。'
    : '原任务只授权冻结的局部正文范围。读取当前正文，用 chapter_edit_range 的逐字唯一 oldText 连续修改，每批最多8处，保留冻结范围外原文。不得整章覆盖、坐标猜定位、追加、改名、创建、变更集或自动 critic 修订。最后修改后完成当前版本必要报告；报告与子任务不能扩大范围。') + intersection
}

/** A frozen local body fence already enforces these exact outside exclusions.
 * Keep all other prohibitions for the ordinary authorization guard. */
export function localRevisionAuthorityText(text: string | null, spec: unknown): string | null {
  if (!text || originalLocalEditBoundary(spec)?.kind !== 'bounded') return text
  return text.split(/[。！？!?；;\n，,]+/u).filter(clause => !(negative.test(clause)
    && /(?:其余|其他(?:的)?(?:段|文字|内容|章节)|范围外|整章|全文|whole chapter|outside)/iu.test(clause)
    && !local.test(clause))).join('，')
}
