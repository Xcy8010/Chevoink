import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import type { TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { taskSpecSchema, taskScopeSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { activeChapterScope } from '../data/internal.js'
import { DataAccessError } from '../prisma.js'
import { runtimeJson } from './runtime-common.js'
import { readOriginalTaskRequest } from './original-request.js'
import { lexAuthorWritingRequest, parseAuthorWritingRequest, parseAuthorWritingExclusion } from './author-writing-request.js'
import { freezeLocalEditBoundary, requestedLocalEdit } from './local-edit-scope.js'
import { localEditProtectionRanges } from './local-edit-citations.js'
import { frozenWritingScopeHash } from './writing-contract.js'

type Subject = { userId: string; novelId: string; runId: string }
type Original = Awaited<ReturnType<typeof readOriginalTaskRequest>>
type Writing = NonNullable<TaskSpec['scope']['writing']>
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const clarificationBase = z.object({ writingScopeClarification: z.literal(true), taskId: z.string(), userId: z.string(), novelId: z.string(),
  sourceRunId: z.string(), questionRunId: z.string(), originHash: digest, manuscriptRevision: z.number().int().nonnegative(),
  callId: z.string().min(1), question: z.string().min(1).max(500), options: z.array(z.object({ label: z.string(), detail: z.string().optional() }).strict()),
  answer: z.string().min(1).max(4000), source: z.enum(['legacy_question', 'durable_question']), requestId: z.string().optional(),
  contentHash: digest }).strict()
const clarificationSchema = z.discriminatedUnion('version', [
  clarificationBase.extend({ version: z.literal(1), targetOrderIndex: z.literal(1) }),
  clarificationBase.extend({ version: z.literal(2), projection: taskScopeSchema.pick({ writing: true, localEditBoundary: true }) }),
])
export type WritingClarification = z.infer<typeof clarificationSchema>

/** This capability fills one missing target; it cannot replace a known grant. */
export function eligibleEmptyWritingClarification(spec: TaskSpec, prompt: string | null) {
  return spec.intent === 'write' && spec.scope.reviewProtocol === 1 && spec.scope.localEditProtocol === 1 && spec.scope.writing?.kind === 'needs_input'
    && !spec.scope.writing.targets.length && !spec.scope.chapterIds?.length && !spec.scope.volumeIds?.length
    && !spec.scope.selection && !spec.scope.selectionBoundary && !spec.scope.localEditBoundary && !spec.authorization
    && !['proposal_only', 'conversation_only'].includes(spec.writingPacing ?? '')
    && !/(?:不要|不得|禁止|不许).{0,12}(?:写入|落盘|保存|创建章节)|只(?:讨论|展示|在对话)|read.only|do not.{0,20}(?:save|write|create)/iu
      .test([prompt ?? '', ...spec.hardConstraints.map(item => item.text)].join('\n'))
}

/** This fills an unresolved chapter/quote, never replaces a known grant. */
export function eligibleWritingClarification(spec: TaskSpec) {
  const interpretation = spec.scope.writingInterpretation
  return spec.scope.writingTargetProtocol === 2 && !!interpretation && ['write', 'revise'].includes(spec.intent)
    && !!spec.scope.writing && (spec.scope.writing.kind === 'needs_input' || spec.scope.localEditBoundary?.kind === 'needs_input')
    && !spec.scope.selection && !spec.scope.selectionBoundary && !spec.authorization
    && !['proposal_only', 'conversation_only'].includes(spec.writingPacing ?? '')
    && !interpretation.revisionDenied && interpretation.operations.some(item => item.polarity === 'affirmative' && item.kind === spec.intent)
}

type ClarificationChapter = { id: string; revision: number; orderIndex: number; orderInVolume: number; volumeId: string; content: string; volume: { orderIndex: number } }
export function clarifyWritingProjection(spec: TaskSpec, prompt: string, answer: string, chapters: ClarificationChapter[]) {
  if (!eligibleWritingClarification(spec) || /[?？]/u.test(lexAuthorWritingRequest(answer).masked)) return null
  if (!chapters.length && !spec.scope.localEditBoundary && eligibleEmptyWritingClarification(spec, prompt)
    && explicitFirstChapterAnswer(answer)) return { writing: effectiveWriting(spec.scope.writing!) }
  const original = parseAuthorWritingRequest(prompt), raw = parseAuthorWritingRequest(answer)
  const masked = lexAuthorWritingRequest(answer).masked
  if (/(?:不要|不是|并非|别(?:选|改|写)|do not|don't|not\s+(?:chapter|the))/iu.test(masked)) return null
  if (/(?:暂不|尚未|还没|不太|未能).{0,8}(?:确定|确认|决定)|也许|可能|大概|应该.{0,6}(?:吧|可以)|是否|会不会|能否|可否|好不好|合不合适|取消|撤回/u.test(masked)) return null
  if (!raw.hasAction) {
    // A noun-only answer supplies the missing argument, not an invented verb
    // over a rejected target. Unknown prose cannot become affirmative authority.
    const spans = [...raw.evidence.targets.map(item => item.span), ...raw.evidence.quoted]
    const remainder = masked.split('')
    for (const span of spans) for (let at = span.start; at < span.end; at++) remainder[at] = ' '
    if (!/^(?:(?:就是|就选|选择|确认|原文|原句|这句|这一句|内容|是|为|的|就|选)|[\s，,。.!！:：])*$/u.test(remainder.join(''))) return null
  }
  // Resolve only an actual human's missing argument with the original action.
  // The question/options are presentation, never input to this resolver.
  const verb = spec.intent === 'write' ? '写入' : '修改'
  let parsed = raw.hasAction ? raw : parseAuthorWritingRequest(`${verb}${answer}`)
  const sourceQuotes = raw.evidence.quoted.filter(item => item.kind === 'quotation' && item.closed)
  if (!parsed.hasAction && !raw.evidence.operations.length && sourceQuotes.length === 1) {
    const quote = sourceQuotes[0]
    if (/^(?:(?:原文|原句|这句|这一句)(?:是|为)?|就是)?[:：]?\s*$/u.test(answer.slice(0, quote.start).trim())
      && /^[。．.!！\s]*$/u.test(answer.slice(quote.end))) parsed = parseAuthorWritingRequest(`${verb}${answer.slice(quote.start, quote.end)}`)
  }
  const addressed = parsed.evidence.targets.filter(item => item.range)
  // The generic lexer cannot locate a quoted sentence in saved body. Here the
  // exact quote is independently frozen below, so retain its one explicit chapter.
  if (parsed.ambiguous && parsed.reasons.length > 0 && parsed.reasons.every(reason => reason === 'unresolved_source_quote')
    && sourceQuotes.length === 1 && addressed.length === 1) parsed = { ...parsed, ambiguous: false, range: addressed[0].range }
  if (original.ambiguous || parsed.ambiguous || !parsed.hasAction || parsed.intent !== spec.intent
    || [...raw.evidence.operations, ...parsed.evidence.operations].some(item => item.polarity === 'negative' || item.accepted && ![spec.intent, 'placement'].includes(item.kind))
    || parsed.evidence.quoted.some(item => !item.closed)) return null
  const base = spec.scope.writing!
  let targets = base.targets
  if (parsed.range) {
    const range = parsed.range
    if (!['first', 'range'].includes(range.kind) || (range.count ?? 1) !== 1 || !range.start) return null
    const chapter = chapters.find(item => (range.volume ? item.volume.orderIndex === range.volume && item.orderInVolume === range.start : item.orderIndex === range.start))
    if (!chapter && (spec.intent !== 'write' || range.volume || spec.scope.writingInterpretation!.creationDenied
      || range.start !== (chapters.at(-1)?.orderIndex ?? 0) + 1 || spec.scope.localEditBoundary)) return null
    const target = { orderIndex: chapter?.orderIndex ?? range.start, chapterId: chapter?.id ?? null }
    if (base.kind === 'bounded' && (base.targets.length !== 1 || !base.targets.some(item => item.chapterId === target.chapterId && item.orderIndex === target.orderIndex))) return null
    targets = [target]
  }
  if (targets.length !== 1 || targets[0].chapterId && spec.scope.writingInterpretation!.excludedChapterIds.includes(targets[0].chapterId)) return null
  const chapter = chapters.find(item => item.id === targets[0].chapterId)
  if (spec.scope.volumeIds?.length && (!chapter || !spec.scope.volumeIds.includes(chapter.volumeId))) return null
  for (const clause of original.exclusions) {
    const range = parseAuthorWritingExclusion(clause)
    if (!range) continue
    if (range.volume && chapter?.volume.orderIndex !== range.volume) continue
    const position = range.volume ? chapter?.orderInVolume : targets[0].orderIndex
    if (position === undefined || range.kind === 'unbounded' || range.kind === 'existing' && position >= (range.start ?? 1)
      || range.kind === 'list' && range.positions?.includes(position)
      || ['first', 'range'].includes(range.kind) && position >= (range.start ?? 1) && position < (range.start ?? 1) + (range.count ?? 1)) return null
  }
  const writing: Writing = { ...base, kind: 'bounded', targets }
  let localEditBoundary = spec.scope.localEditBoundary
  if (localEditBoundary?.kind === 'needs_input' || !localEditBoundary && requestedLocalEdit(answer, 2, parsed)) {
    const quotes = raw.evidence.quoted.filter(item => item.kind === 'quotation' && item.closed)
    if (!chapter || quotes.length !== 1) return null
    localEditBoundary = freezeLocalEditBoundary(`只修改${answer.slice(quotes[0].start, quotes[0].end)}`, writing, [chapter])
    const protections = localEditProtectionRanges(prompt, chapter.content)
    if (!localEditBoundary || localEditBoundary.kind !== 'bounded' || !protections || localEditBoundary.regions.some(region =>
      protections.some(protectedRegion => region.start < protectedRegion.end && protectedRegion.start < region.end))) return null
  }
  return { writing, ...(localEditBoundary ? { localEditBoundary } : {}) }
}

export function projectWritingClarification(spec: TaskSpec, evidence: WritingClarification): TaskSpec {
  if (evidence.version === 1) return { ...spec, scope: { ...spec.scope, writing: effectiveWriting(spec.scope.writing!) } }
  const projection = { ...spec, scope: { ...spec.scope, ...evidence.projection,
    ...(spec.scope.writingInterpretation ? { writingInterpretation: { ...spec.scope.writingInterpretation } } : {}) } }
  if (projection.scope.writingInterpretation) projection.scope.writingInterpretation.scopeHash = frozenWritingScopeHash(projection.scope)
  return projection
}

export function explicitFirstChapterAnswer(answer: string) {
  const value = answer.trim()
  const affirmative = value.match(/^(?:(?:就)?(?:作为|按)?(?:第\s*[一1]\s*章|首章)(?:写入|保存|落盘)|(?:写入|保存为)(?:第\s*[一1]\s*章|首章)|(?:write|save)\s+as\s+(?:the\s+)?first chapter)/iu)
  if (!affirmative) return false
  // This deliberately small grammar accepts a target, optional title and stop
  // constraints. Unknown trailing clauses (including questions, retractions,
  // other targets and new permissions) never become affirmative authority.
  const remainder = value.slice(affirmative[0].length)
    .replace(/(?:章名|标题)\s*《[^《》\r\n]{1,100}》/gu, '')
    .replace(/只写(?:这一段|该段|这一小段)|写完即停|完成(?:该段|这一段)?后停止|写完后停止/gu, '')
    .replace(/[（()），,。；;\s]/gu, '')
  return remainder.length === 0
}

const originHash = (original: Original) => runtimeJson({ prompt: original.prompt, spec: original.spec }).hash
function effectiveWriting(writing: Writing): Writing {
  return { ...writing, kind: 'bounded', targets: [{ orderIndex: 1, chapterId: null }] }
}

/** Artifacts are server-created answer receipts, scoped to the immutable origin. */
export async function readWritingClarification(tx: Prisma.TransactionClient, subject: Subject, original: Original,
  source: { manuscriptRevision: number }, spec: TaskSpec) {
  const protocol = spec.scope.writingClarificationProtocol
  if (!(protocol === 1 ? eligibleEmptyWritingClarification(spec, original.prompt) : protocol === 2 && eligibleWritingClarification(spec)) || original.parentRunId) return null
  const artifacts = await tx.agentArtifact.findMany({ where: { runId: original.sourceRunId, artifactType: 'continuityReview',
    metadata: { path: ['writingScopeClarification'], equals: true },
    run: { userId: subject.userId, novelId: subject.novelId } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 2 })
  if (!artifacts.length) return null
  const parsed = clarificationSchema.safeParse(artifacts[0].metadata)
  if (artifacts.length !== 1 || !parsed.success) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '章节澄清凭据损坏，未扩展写作范围。')
  const { contentHash, ...payload } = parsed.data
  if (runtimeJson(payload).hash !== contentHash || payload.originHash !== originHash(original) || payload.taskId !== original.taskId
    || payload.userId !== subject.userId || payload.novelId !== subject.novelId || payload.sourceRunId !== original.sourceRunId
    || payload.manuscriptRevision !== source.manuscriptRevision || payload.version !== protocol
    || payload.version === 1 && !explicitFirstChapterAnswer(payload.answer)
    || payload.version === 2 && (!payload.projection.writing || payload.projection.writing.kind !== 'bounded')) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '章节澄清与原任务或稿件版本不一致，未扩展写作范围。')
  }
  const projection = projectWritingClarification(spec, parsed.data)
  return { evidence: parsed.data, writing: projection.scope.writing!, spec: projection }
}

/** Invoke only after an actual authenticated pending-question answer, never a
 * proposed option, generated summary, timeout or fallback/default response. */
export async function recordWritingClarification(tx: Prisma.TransactionClient, subject: Subject,
  answer: { callId: string; question: string; options: Array<{ label: string; detail?: string }>; answer: string;
    source: 'legacy_question' | 'durable_question'; requestId?: string }) {
  const original = await readOriginalTaskRequest(tx, subject), parsed = taskSpecSchema.safeParse(original.spec)
  if (!parsed.success || original.parentRunId) return null
  const protocol = parsed.data.scope.writingClarificationProtocol
  if (!(protocol === 1 ? eligibleEmptyWritingClarification(parsed.data, original.prompt) && explicitFirstChapterAnswer(answer.answer)
    : protocol === 2 && eligibleWritingClarification(parsed.data))) return null
  const { lockWritingRunLineage } = await import('./writing-scope.js')
  await lockWritingRunLineage(tx, subject)
  await (await import('./manuscript-scope.js')).assertAgentManuscriptCurrent(tx, subject)
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId,
    status: { in: ['queued', 'running', 'awaiting_approval'] } }, include: { session: true } })
  if (!run || run.session.sandboxMode === 'read_only' || run.session.spawnedFromRunId) {
    throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '当前执行不可接收章节澄清，未扩展写作范围。')
  }
  const source = await tx.agentRun.findFirstOrThrow({ where: { id: original.sourceRunId, userId: subject.userId, novelId: subject.novelId } })
  const existing = await readWritingClarification(tx, subject, original, source, parsed.data)
  let evidence = existing?.evidence
  if (evidence && (evidence.callId !== answer.callId || evidence.answer !== answer.answer.trim())) return null
  if (!evidence) {
    const projection = protocol === 2 ? clarifyWritingProjection(parsed.data, original.prompt ?? '', answer.answer.trim(),
      await tx.chapter.findMany({ where: { authorId: subject.userId, ...activeChapterScope(subject.novelId) },
        select: { id: true, revision: true, content: true, orderIndex: true, orderInVolume: true, volumeId: true, volume: { select: { orderIndex: true } } }, orderBy: { orderIndex: 'asc' } })) : null
    if (protocol === 1 ? await tx.chapter.count({ where: { authorId: subject.userId, ...activeChapterScope(subject.novelId) } }) : !projection) return null
    const payload = { writingScopeClarification: true as const, taskId: original.taskId, userId: subject.userId, novelId: subject.novelId,
      sourceRunId: original.sourceRunId, questionRunId: subject.runId, originHash: originHash(original), manuscriptRevision: source.manuscriptRevision,
      ...answer, answer: answer.answer.trim(), ...(protocol === 1 ? { version: 1 as const, targetOrderIndex: 1 as const } : { version: 2 as const, projection: projection! }) }
    evidence = clarificationSchema.parse({ ...payload, contentHash: runtimeJson(payload).hash })
    await tx.agentArtifact.create({ data: { runId: original.sourceRunId, artifactType: 'continuityReview',
      title: protocol === 1 ? '作者确认第一章目标' : '作者确认写作范围',
      content: protocol === 1 ? '仅补全原写作请求缺少的第一章目标；原请求、权限和预算保持原值。' : '仅补全原写作请求缺少的目标或原文范围；原请求、权限和预算保持原值。', metadata: runtimeJson(evidence).value } })
  }
  return { targetId: `writing-scope:${original.taskId}`, beforeHash: runtimeJson(parsed.data.scope.writing).hash,
    afterHash: runtimeJson(evidence.version === 1 ? effectiveWriting(parsed.data.scope.writing!) : evidence.projection).hash }
}
