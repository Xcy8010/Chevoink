import { taskSpecSchema, type TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { createHash } from 'node:crypto'
import { DataAccessError } from '../prisma.js'
import { runtimeJson } from './runtime-common.js'
import { parseAuthorWritingRequest, type AuthorWritingRequest } from './author-writing-request.js'
import { freezeIssueQuoteBoundary, localEditProtectionRanges, validIssueQuoteBoundary } from './local-edit-citations.js'
import { assertFrozenWritingContract } from './writing-contract.js'

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
export function requestedLocalEdit(prompt: string, protocol: 1 | 2 = 1, resolved?: AuthorWritingRequest): Locator | null {
  const unquoted = prompt.replace(quotePattern, '【引文】')
  const interpretation = protocol === 2 ? resolved ?? parseAuthorWritingRequest(prompt) : null
  if (interpretation?.reasons.some(reason => ['unclosed_source_quote', 'unresolved_source_quote'].includes(reason))) return { kind: 'unknown' }
  // A fresh assessment has no body effect to locate. Its frozen review intent
  // denies mutation; an unknown edit window must not block the requested read.
  if (interpretation?.intent === 'review' && !interpretation.evidence.operations.some(operation =>
    operation.accepted && operation.polarity === 'affirmative' && ['revise', 'write'].includes(operation.kind))) return null
  if (hasReadOnlyRevisionAssessment(prompt) && local.test(unquoted)
    && (!interpretation || !interpretation.evidence.operations.some(operation => operation.accepted && operation.polarity === 'affirmative' && operation.kind === 'revise'))) return { kind: 'unknown' }
  const clauses = interpretation ? interpretation.evidence.clauses.map(clause => clause.text.replace(quotePattern, '【引文】'))
    : unquoted.split(/[。！？!?；;\n，,]+/u)
  const positive = clauses.filter(clause => !negative.test(clause)
    && !/^\s*(?:请)?(?:如何|怎么|是否|例如|举例|引用|参考|[他她]说过|how to|example)/iu.test(clause)
    && !/^\s*(?:请)?(?:给出|提供|列出|说明|输出|提出).*(?:建议|方案|思路|报告)/iu.test(clause))
  const actionable = interpretation ? interpretation.evidence.clauses.filter(clause => interpretation.evidence.operations.some(operation =>
    operation.accepted && operation.polarity === 'affirmative' && ['revise', 'write'].includes(operation.kind)
    && operation.clauseSpan.start === clause.start && operation.clauseSpan.end === clause.end))
    .map(clause => clause.text.replace(quotePattern, '【引文】')) : positive.filter(clause => edit.test(clause))
  // A clear whole-chapter grant with a quality emphasis is still whole-chapter
  // work. An exclusive local limit or ordered local-then-whole ask is different.
  const wholeGrant = actionable.some(clause => whole.test(clause) && !local.test(clause))
  const localActions = actionable.filter(clause => local.test(clause))
  const createsChapter = /(?:写|创作|起草|续写).{0,12}(?:第\s*[一二两三四五六七八九十百0-9]+\s*章|下一章|首章)|(?:write|draft)\s+(?:the\s+)?(?:next\s+chapter|chapter\s*\d+)/iu.test(positive[0] ?? '')
  if (createsChapter && localActions.length && localActions.every(clause => !exclusiveLocal.test(clause))) return null
  if (wholeGrant && localActions.length && localActions.every(clause => /(?:重点|尤其|特别注意|着重|focus|especially)/iu.test(clause)
    && !exclusiveLocal.test(clause))) return null
  const directQuotes = interpretation?.evidence.quoted.filter(quote => quote.kind === 'quotation'
    && interpretation.evidence.operations.some(operation => operation.accepted && operation.kind === 'revise'
      && operation.polarity === 'affirmative' && operation.targetIndices.some(index => {
        const target = interpretation.evidence.targets[index]
        return target.kind === 'local' && target.span.start === quote.start && target.span.end === quote.end
      }))) ?? []
  const explicitQuote = directQuotes.length > 0 || new RegExp(`(?:把|将)\\s*【引文】.{0,12}(?:改成|改为|替换|修改|改写|润色)|${quoteEditPrefix}【引文】`, 'u').test(actionable.join('，'))
  const constrained = actionable.some(clause => local.test(clause)
    && (!whole.test(clause) || /(?:只|仅|局部|的|中|only)/iu.test(clause))) || explicitQuote
  if (!constrained) return interpretation && interpretation.evidence.operations.some(operation => operation.accepted
    && ['write', 'revise'].includes(operation.kind)) && interpretation.evidence.operations.some(operation => operation.polarity === 'negative'
    && ['negated', 'protected'].includes(operation.reason) && operation.targetIndices.some(index => interpretation.evidence.targets[index].kind === 'local'))
    ? { kind: 'unknown' } : null
  if (/(?:以外|之外|除了|上下文|except|outside)/iu.test(actionable.join('，'))) return { kind: 'unknown' }
  // Conflicting/mixed scope is not an invitation to guess a broad grant.
  if (positive.some(clause => whole.test(clause) && /(?:写|创作|完成|write|draft)/iu.test(clause))
    || actionable.some(clause => whole.test(clause))
    || clauses.some(clause => negative.test(clause) && (local.test(clause) || /正文|任何修改|prose|any edits?/iu.test(clause)))) return { kind: 'unknown' }
  if (explicitQuote) {
    const sourceQuotes = interpretation ? [] : [...prompt.matchAll(new RegExp(`(?:(?:把|将)\\s*|${quoteEditPrefix})(?:“([^”]+)”|「([^」]+)」|『([^』]+)』|"([^"\\n]+)")`, 'gu'))]
    const sources = [...new Set([...sourceQuotes.map(match => match[1] ?? match[2] ?? match[3] ?? match[4]),
      ...directQuotes.filter(quote => quote.closed).map(quote => prompt.slice(quote.contentStart, quote.contentEnd))])]
    return sources.length === 1 ? { kind: 'quote', text: sources[0] } : { kind: 'unknown' }
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
  chapters: Array<{ id: string; revision: number; content: string }>, protocol: 1 | 2 = 1, resolved?: AuthorWritingRequest): NonNullable<TaskSpec['scope']['localEditBoundary']> | undefined {
  const parsed = protocol === 2 ? resolved ?? parseAuthorWritingRequest(prompt) : null
  const phase = parsed?.conditionalLocalRepair
  if (phase && writing?.kind === 'bounded' && !parsed.ambiguous) {
    const regions = []
    for (const target of writing.targets) {
      const chapter = chapters.find(item => item.id === target.chapterId)
      const protections = chapter && localEditProtectionRanges(prompt, chapter.content, parsed)
      if (!chapter?.content.trim() || !protections) return { version: 1, kind: 'needs_input', regions: [] }
      regions.push({ chapterId: chapter.id, revision: chapter.revision, contentHash: runtimeJson({ content: chapter.content }).hash,
        start: 0, end: chapter.content.length, prefix: '', suffix: '',
        protectedText: protections.map(span => chapter.content.slice(span.start, span.end)),
        maxBodyLength: chapter.content.length + Math.max(32, Math.min(1024, chapter.content.length)) })
    }
    if (!regions.length) return { version: 1, kind: 'needs_input', regions: [] }
    return { version: 3, kind: 'review_bound', regions, source: { requestHash: createHash('sha256').update(prompt).digest('hex'),
      reviews: phase.reviewOperationIndices.map(index => parsed.evidence.operations[index].span),
      repairs: phase.repairs.map(repair => ({ ...parsed.evidence.operations[repair.operationIndex].span,
        condition: { kind: repair.condition.kind, ...repair.condition.span } })) } }
  }
  const locator = requestedLocalEdit(prompt, protocol, parsed ?? undefined)
  if (!locator) return undefined
  const denied = { version: 1 as const, kind: 'needs_input' as const, regions: [] }
  if (locator.kind === 'unknown') return protocol === 2 ? freezeIssueQuoteBoundary(prompt, writing, chapters) ?? denied : denied
  if (writing?.kind !== 'bounded' || !writing.targets.length) return denied
  const regions: Extract<NonNullable<TaskSpec['scope']['localEditBoundary']>, { version: 1 }>['regions'] = []
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
    if (protocol === 2) {
      const protections = localEditProtectionRanges(prompt, chapter.content)
      if (!protections || protections.some(region => start < region.end && region.start < end)) return denied
    }
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
    || boundary && (boundary.kind !== 'needs_input' ? !boundary.regions.length : boundary.regions.length > 0)
    || boundary && boundary.version !== 3 && (boundary.version === 2 ? !validIssueQuoteBoundary(boundary)
      : new Set(boundary.regions.map(region => region.chapterId)).size !== boundary.regions.length
      || boundary.regions.some(region => region.end <= region.start || region.prefix.length !== region.start
        || !region.prefix.length && !region.suffix.length))) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原局部编辑授权快照损坏，不能扩大正文范围。')
  }
  assertFrozenWritingContract(parsed.data)
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
    : boundary.version === 3 ? '目标章节已经确认。先准备并读取本章，完成当前正文的必要连续性与人类感检查；没有确证问题时无需改文，直接按真实报告提交。只有当前任务、当前版本完整检查中逐字定位的真实问题才允许 chapter_edit_range 局部修订，每批最多8处；使用逐字唯一 oldText，保留其他正文。整章覆盖、追加、改名、新建和自动 critic 改文不获授权。修改后重新检查并提交，报告、重新准备和子任务不能扩大范围或重置原长度上限。'
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
