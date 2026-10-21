import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError } from '../prisma.js'
import { activeChapterScope, activeVolumeWhere } from '../data/internal.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { hasOriginalRepairAuthority, readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { runtimeJson } from './runtime-common.js'
import { assertRunGoalFence } from './goal-fence.js'
import { readWritingPresentation } from './writing-request-context.js'
import { freezeLocalEditBoundary, originalLocalEditBoundary, requestedLocalEdit } from './local-edit-scope.js'
import { eligibleEmptyWritingClarification, readWritingClarification } from './writing-clarification.js'
import { parseAuthorWritingRequest, parseAuthorWritingExclusion, resolveAuthorWritingRequest } from './author-writing-request.js'
import { currentIssueQuoteRegions } from './local-edit-citations.js'
import { assertFrozenWritingContract, frozenWritingScopeHash } from './writing-contract.js'

import { chapterNumber, numeric, rangeDash, negativeScopeClause, writingScopeClauses, legacyWritingRange } from './writing-target-range.js'
import { parseWritingTargets, writingExclusionRange } from './writing-target-admission.js'
export { chapterNumber } from './writing-target-range.js'
export { requestedWritingRange } from './writing-target-admission.js'

type Subject = { userId: string; novelId: string; runId: string }
type Writing = NonNullable<TaskSpec['scope']['writing']>

export async function freezeWritingScope(tx: Prisma.TransactionClient, subject: Subject, spec: TaskSpec, prompt: string, targetProtocol?: 1 | 2): Promise<TaskSpec> {
  await lockNovelActiveScope(tx, subject.novelId)
  const original = await readOriginalTaskRequest(tx, subject)
  if (original.parentRunId) {
    const parent = taskSpecSchema.parse(original.spec)
    return { ...spec, scope: parent.scope, hardConstraints: parent.hardConstraints }
  }
  // Frozen contracts, including old selected runs, are never reinterpreted on
  // continuation. Only a fresh server-created contract carries this marker.
  if (spec.scope.writing) return spec
  if (spec.scope.manuscriptProtocol === 1 && spec.scope.selection && !spec.scope.selectionBoundary) {
    const selection = spec.scope.selection
    const chapter = await tx.chapter.findFirst({ where: { id: selection.chapterId, authorId: subject.userId,
      ...activeChapterScope(subject.novelId) }, select: { content: true, revision: true } })
    const source = await tx.agentRun.findFirstOrThrow({ where: { id: original.sourceRunId, userId: subject.userId, novelId: subject.novelId }, select: { startRequest: true } })
    const request = source.startRequest && typeof source.startRequest === 'object' && !Array.isArray(source.startRequest) ? source.startRequest : null
    const supplied = request?.selection && typeof request.selection === 'object' && !Array.isArray(request.selection) ? request.selection : null
    // textarea indices are UTF-16 body offsets. Coordinate-only clients bind
    // the current server snapshot; supplied text must match that snapshot.
    if (!chapter || !Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end)
      || selection.start < 0 || selection.end <= selection.start || selection.end > chapter.content.length
      || supplied && (supplied.start !== selection.start || supplied.end !== selection.end
        || typeof supplied.text !== 'string' || supplied.text !== chapter.content.slice(selection.start, selection.end))) {
      throw new DataAccessError(409, 'AUTHOR_SELECTION_STALE', '选区坐标或原文与当前已保存正文不一致，请重新选择已保存正文后发起任务。')
    }
    spec = { ...spec, scope: { ...spec.scope, selectionBoundary: { version: 1, chapterId: selection.chapterId,
      revision: chapter.revision, contentHash: runtimeJson({ content: chapter.content }).hash, start: selection.start, end: selection.end,
      prefix: chapter.content.slice(0, selection.start), suffix: chapter.content.slice(selection.end) } } }
  }
  if (spec.scope.authorEffects?.manuscript === false || !['write', 'revise', 'review', 'global_transform'].includes(spec.intent)
    || spec.writingPacing === 'proposal_only' || spec.writingPacing === 'conversation_only') return spec
  const admissionPrompt = original.prompt ?? prompt
  const chapters = await tx.chapter.findMany({ where: { authorId: subject.userId, ...activeChapterScope(subject.novelId) },
    select: { id: true, revision: true, orderIndex: true, orderInVolume: true, volumeId: true, volume: { select: { orderIndex: true } } }, orderBy: { orderIndex: 'asc' } })
  const initial = targetProtocol === 2 ? parseAuthorWritingRequest(admissionPrompt) : null
  const addresses = initial?.evidence.targets.flatMap(target => target.range ? [target.range] : []) ?? []
  const mixedAddresses = addresses.some(range => range.volume !== undefined) && addresses.some(range => range.volume === undefined)
  const volumes = mixedAddresses ? (await Promise.all([...new Set(addresses.flatMap(range => range.volume === undefined ? [] : [range.volume]))]
    .map(orderIndex => tx.volume.findFirst({ where: { novelId: subject.novelId, archivedAt: null, orderIndex }, select: { id: true, orderIndex: true } })))).filter(item => item !== null) : undefined
  const interpretation = volumes ? resolveAuthorWritingRequest(admissionPrompt, { chapters, volumes }) : initial
  // All consumers share the directory-resolved interpretation from this locked
  // fresh admission; later recovery never reparses or upgrades the root scope.
  let localRequest = spec.scope.localEditProtocol === 1 ? requestedLocalEdit(admissionPrompt, targetProtocol === 2 ? 2 : 1, interpretation ?? undefined) : null
  if (spec.scope.localEditProtocol === 1 && interpretation?.conditionalLocalRepair) localRequest ??= { kind: 'unknown' }
  const negativeOperations = interpretation?.evidence.operations.filter(operation => operation.polarity === 'negative' && operation.reason === 'negated') ?? []
  const creationDenied = negativeOperations.some(operation => operation.kind === 'write'
    && !operation.targetIndices.some(index => interpretation!.evidence.targets[index].range)
    && /^(?:新建|创建|建章|续写|create)$/iu.test(admissionPrompt.slice(operation.span.start, operation.span.end)))
  const revisionDenied = interpretation?.evidence.operations.some(operation => operation.polarity === 'negative'
    && ['negated', 'protected'].includes(operation.reason) && operation.kind === 'revise'
    && (operation.targetIndices.some(index => interpretation.evidence.targets[index].kind === 'same_target')
      || operation.reason === 'negated' && !operation.targetIndices.length && !admissionPrompt.slice(operation.span.end, operation.clauseSpan.end).trim()
      || !operation.targetIndices.some(index => interpretation!.evidence.targets[index].range)
        && operation.targetIndices.some(index => interpretation!.evidence.targets[index].kind === 'prose'))) ?? false
  const parsed = interpretation ?? (targetProtocol === 1 ? parseWritingTargets(admissionPrompt) : null)
  const range = parsed ? parsed.range : legacyWritingRange(admissionPrompt)
  // A prompt that names chapters/volumes with numbers but fails to parse must not
  // silently freeze onto the editor's current chapter: that rewrote the author's
  // target ("前 20 章优化" froze to a single chapter). Surface needs_input instead.
  const ambiguousRange = parsed ? parsed.ambiguous : !range && writingScopeClauses(admissionPrompt).some(clause => !negativeScopeClause.test(clause)
    && /(?:第|前|后|余|剩|卷|章)/u.test(clause) && /(?:章|卷|chapter|volume)/iu.test(clause)
    && /[0-9零〇一二两三四五六七八九十百千]/u.test(clause))
    && !(localRequest && !/(?:章|卷|chapter|volume)/iu.test(admissionPrompt))
  // An empty book has no saved body to edit. A new-scene write/finish operation
  // without a chapter target may ask for first-chapter placement; it does not
  // manufacture an old-body window from "finish this passage and stop".
  // Existing chapter/paragraph writes retain their local fence.
  if (interpretation && !chapters.length && !range && !ambiguousRange && spec.intent === 'write'
    && !interpretation.evidence.operations.some(operation => operation.accepted && operation.polarity === 'affirmative' && operation.kind === 'revise')) localRequest = null
  const run = await tx.agentRun.findFirstOrThrow({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId }, select: { chapterId: true, session: { select: { sandboxMode: true, spawnedFromRunId: true } } } })
  const base = { version: 1 as const, titleAndBodyOnly: /(?:只(?:要|输出|给|需)|仅(?:输出|给|需)).{0,16}(?:标题|章名).{0,12}(?:正文|内容)|only.{0,20}title.{0,12}(?:body|text)/iu.test(admissionPrompt),
    repairAuthorized: interpretation ? interpretation.evidence.operations.some(operation => operation.accepted && operation.polarity === 'affirmative' && operation.kind === 'revise') : hasOriginalRepairAuthority(admissionPrompt) }
  let writing: Writing
  if (range?.kind === 'unbounded') writing = { ...base, kind: 'unbounded', targets: [] }
  else if (range?.kind === 'existing') {
    const existing = chapters.filter(item => (!range.volume || item.volume.orderIndex === range.volume)
      && (range.volume ? item.orderInVolume : item.orderIndex) >= (range.start ?? 1))
    writing = { ...base, kind: existing.length ? 'bounded' : 'needs_input', targets: existing.map(item => ({ orderIndex: item.orderIndex, chapterId: item.id,
      ...(range.volume ? { volumeId: item.volumeId, positionInVolume: item.orderInVolume } : {}) })) }
  }
  else if (range) {
    const anchor = run.chapterId ? chapters.find(item => item.id === run.chapterId) : null
    const start = range.start ?? (range.anchor === 'editor' ? anchor ? anchor.orderIndex + 1 : null : (chapters.at(-1)?.orderIndex ?? 0) + 1)
    const targets: Writing['targets'] = []
    const positions = range.kind === 'list' ? range.positions ?? [] : start === null ? [] : Array.from({ length: range.count ?? 1 }, (_, i) => start + i)
    for (const position of positions) {
      if (range.volume) {
        const volume = await tx.volume.findFirst({ where: { novelId: subject.novelId, archivedAt: null, orderIndex: range.volume }, select: { id: true } })
        if (!volume) { targets.length = 0; break }
        const existing = chapters.find(item => item.volumeId === volume.id && item.orderInVolume === position)
        const prior = chapters.filter(item => item.volume.orderIndex < range.volume!).length
        targets.push({ orderIndex: existing?.orderIndex ?? prior + position, chapterId: existing?.id ?? null, volumeId: volume.id, positionInVolume: position })
      } else targets.push({ orderIndex: position, chapterId: chapters.find(item => item.orderIndex === position)?.id ?? null })
    }
    writing = { ...base, kind: targets.length ? 'bounded' : 'needs_input', targets }
  } else if (run.chapterId && !ambiguousRange && (!parsed || parsed.hasAction)) {
    const target = chapters.find(item => item.id === run.chapterId)
    writing = { ...base, kind: target ? 'bounded' : 'needs_input', targets: target ? [{ orderIndex: target.orderIndex, chapterId: target.id }] : [] }
  } else writing = { ...base, kind: 'needs_input', targets: [] }
  if (parsed?.confirmedNextOrderIndex !== undefined && (writing.kind !== 'bounded' || writing.targets.length !== 1
    || writing.targets[0].orderIndex !== parsed.confirmedNextOrderIndex)) {
    writing = { ...base, kind: 'needs_input', targets: [] }
  }
  if (creationDenied && writing.kind === 'bounded' && writing.targets.some(target => target.chapterId === null)
    || revisionDenied && spec.intent === 'revise') writing = { ...base, kind: 'needs_input', targets: [] }
  if (revisionDenied) writing.repairAuthorized = false
  const excludedChapterIds = new Set<string>()
  if (writing.kind === 'bounded') {
    // A broad positive interval cannot erase the author's explicit exceptions.
    // Resolve them against this same admission snapshot, never later rows.
    for (const clause of parsed?.exclusions ?? writingScopeClauses(admissionPrompt).filter(clause => negativeScopeClause.test(clause))) {
      const requestedExclusion = interpretation ? parseAuthorWritingExclusion(clause) : parsed ? writingExclusionRange(clause)
        : legacyWritingRange(clause.replace(/(?:不继续|不批量|不续写|不生成|不要|无需|不用|不必|禁止|不得|不能|别|do not|don't|must not)|不(?=写|改|修改)/giu, ''))
      if (interpretation && requestedExclusion?.anchor === 'editor' && !chapters.some(chapter => chapter.id === run.chapterId)) {
        writing.targets = []
        continue
      }
      const exclusion = interpretation && requestedExclusion && ['next', 'count'].includes(requestedExclusion.kind)
        ? { ...requestedExclusion, kind: 'range' as const, start: requestedExclusion.anchor === 'editor'
          ? chapters.find(chapter => chapter.id === run.chapterId)!.orderIndex + 1
          : (chapters.at(-1)?.orderIndex ?? 0) + 1 } : requestedExclusion
      if (!exclusion) {
        if (/(?:任何|所有|全部|已有)章节|全书|正文/u.test(clause) || /(?:第|章|卷)/u.test(clause) && new RegExp(numeric, 'u').test(clause)) writing.targets = []
        continue
      }
      if (exclusion.kind !== 'existing' && exclusion.kind !== 'list' && exclusion.kind !== 'range' && exclusion.kind !== 'first') continue
      const excludesPosition = (position: number) => exclusion.kind === 'existing' ? position >= (exclusion.start ?? 1)
        : exclusion.kind === 'list' ? !!exclusion.positions?.includes(position)
        : position >= (exclusion.start ?? 1) && position < (exclusion.start ?? 1) + (exclusion.count ?? 1)
      for (const chapter of chapters) if ((!exclusion.volume || chapter.volume.orderIndex === exclusion.volume)
        && excludesPosition(exclusion.volume ? chapter.orderInVolume : chapter.orderIndex)) excludedChapterIds.add(chapter.id)
      writing.targets = writing.targets.filter(target => {
        const chapter = chapters.find(item => item.id === target.chapterId)
        if (exclusion.volume && ((chapter?.volume.orderIndex ?? (target.volumeId ? range?.volume : null)) !== exclusion.volume)) return true
        const position = exclusion.volume ? chapter?.orderInVolume ?? target.positionInVolume : target.orderIndex
        if (position == null) return true
        return !excludesPosition(position)
      })
    }
    if (!writing.targets.length) writing.kind = 'needs_input'
  }
  const last = chapters.at(-1)
  if (spec.intent === 'write' && writing.kind === 'bounded' && writing.targets.length === 1
    && !writing.titleAndBodyOnly && !spec.scope.selection && !spec.scope.volumeIds?.length
    // buildTaskSpec carries the editor chapter as context, not as a protection grant.
    && (!spec.scope.chapterIds?.length || spec.scope.chapterIds.length === 1 && spec.scope.chapterIds[0] === run.chapterId)
    && !spec.postconditions.some(item => item.code === 'EARLIER_CONTENT_UNCHANGED')
    && run.session.sandboxMode !== 'read_only' && !run.session.spawnedFromRunId
    && !spec.authorization && last && writing.targets[0].chapterId === null
    && writing.targets[0].orderIndex === last.orderIndex + 1 && !writing.targets[0].volumeId
    && writing.targets[0].positionInVolume === undefined && !range?.volume
    && !/(?:只读|不(?:要|得|能|许|必)?(?:新建|建|改|调整|分)卷|(?:不要|不得|禁止|不能).{0,12}(?:结构|分卷)|read.only|do not.{0,20}(?:volume|structure))/iu.test(admissionPrompt + spec.hardConstraints.map(item => item.text).join('；'))) {
    writing.tailVolume = { version: 1, targetOrderIndex: writing.targets[0].orderIndex, previousChapterId: last.id, previousRevision: last.revision }
  }
  const localEditBoundary = localRequest
    ? freezeLocalEditBoundary(admissionPrompt, writing, await tx.chapter.findMany({ where: { authorId: subject.userId,
      ...activeChapterScope(subject.novelId), id: { in: writing.targets.flatMap(target => target.chapterId ? [target.chapterId] : []) } },
      select: { id: true, revision: true, content: true } }), targetProtocol === 2 ? 2 : 1, interpretation ?? undefined) : undefined
  // Finding-conditioned repair is a distinct phase, not a broad repair grant.
  if (localEditBoundary?.version === 3) writing.repairAuthorized = false
  const clarification = !chapters.length && !range && !ambiguousRange && !localRequest
    && run.session.sandboxMode !== 'read_only' && !run.session.spawnedFromRunId
    && eligibleEmptyWritingClarification({ ...spec, scope: { ...spec.scope, writing } }, admissionPrompt)
  const frozen: TaskSpec = { ...spec, ambiguity: interpretation && (writing.kind === 'needs_input' || localEditBoundary?.kind === 'needs_input') ? 'must_ask' : spec.ambiguity,
    scope: { ...spec.scope, writing, ...(targetProtocol ? { writingTargetProtocol: targetProtocol } : {}),
      ...(interpretation ? { writingInterpretation: { version: 2 as const, requestHash: createHash('sha256').update(admissionPrompt).digest('hex'), scopeHash: '0'.repeat(64),
        intent: interpretation.intent, revisionDenied, creationDenied, reasons: [...new Set([...interpretation.reasons,
          ...(revisionDenied ? ['BODY_REVISION_DENIED'] : []), ...(creationDenied ? ['CHAPTER_CREATION_DENIED'] : []),
          ...(writing.kind === 'needs_input' ? ['TARGET_UNRESOLVED'] : []), ...(localEditBoundary?.kind === 'needs_input' ? ['LOCAL_ANCHOR_UNRESOLVED'] : [])])],
        operations: interpretation.evidence.operations.filter(operation => ['write', 'revise', 'review'].includes(operation.kind)
          && (operation.accepted || operation.polarity === 'negative')).map(operation => ({ start: operation.span.start, end: operation.span.end,
            kind: operation.kind as 'write' | 'revise' | 'review', polarity: operation.polarity })), excludedChapterIds: [...excludedChapterIds] } } : {}),
      ...(clarification ? { writingClarificationProtocol: 1 as const } : {}),
    ...(localEditBoundary ? { localEditBoundary } : {}) } }
  if (frozen.scope.writingInterpretation) frozen.scope.writingInterpretation.scopeHash = frozenWritingScopeHash(frozen.scope)
  return frozen
}

const bindingSchema = z.object({ version: z.literal(1), taskId: z.string(), targets: z.array(z.object({ orderIndex: z.number().int().positive(), chapterId: z.string() }).strict()) }).strict()
const newDraftRevisionSchema = z.object({ version: z.literal(1), taskId: z.string().min(1), chapterId: z.string().min(1),
  compilationId: z.string().min(1), checkedRevision: z.number().int().positive(),
  beforeHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(), afterHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  retainedFindings: z.array(z.object({ source: z.enum(['continuity', 'quality']), reportId: z.string().min(1),
    findingId: z.string().min(1), reason: z.string().trim().min(1).max(1000) }).strict()).max(40).optional() }).strict()

/** Separate from paid repair reservations: consumed only by a successful body CAS. */
export function readNewDraftRevision(validation: unknown) {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation) || !('newDraftRevision' in validation)) return null
  const parsed = newDraftRevisionSchema.safeParse(validation.newDraftRevision)
  if (!parsed.success) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '新稿整体修订凭证损坏，不能重置修订次数。')
  return parsed.data
}

export function prohibitsNewDraftRevision(prompt: string | null): boolean {
  return !!prompt?.split(/[。！？!?；;\n，,]+/u).some(clause =>
    /(?:不要|无需|不用|不必|禁止|不得|不能|只读|不改|do not|don't|must not|read.only)/iu.test(clause)
    && /(?:改|修复|修正|纠正|纠错|润色|重写|repair|revis|rewrit|polish|fix\b|edit|modify|chang)/iu.test(clause)
    && (!/(?:前文|前章|已有|先前|previous|earlier|existing)/iu.test(clause)
      || /(?:本章|新章|新稿|初稿|全文|全书|this chapter|new chapter|draft)/iu.test(clause)))
}

/** A fresh frozen target must not inherit a different chapter's prohibition.
 * This only removes a provably disjoint numbered exclusion. Global, relative,
 * volume-relative or unresolvable prohibitions retain the old guard behavior. */
export function chapterRevisionAuthorityText(text: string | null, value: unknown, chapterId: string): string | null {
  if (!text) return text
  const parsed = taskSpecSchema.safeParse(value)
  if (!parsed.success || parsed.data.scope.writingTargetProtocol !== 1 || parsed.data.scope.writing?.kind !== 'bounded') return text
  const target = parsed.data.scope.writing.targets.find(item => item.chapterId === chapterId)
  if (!target || target.volumeId) return text
  const numberedOnly = new RegExp(`^\\s*(?:请|在)?(?:不(?:要|得|能|许)?|禁止|无需|不用|别)(?:修改|修订|修正|修复|改写|重写|写|改|动|润色|优化)(?:已经保存的|已保存的|既有的|已有的)?\\s*(?:前\\s*${numeric}\\s*章|首章|第?\\s*${numeric}\\s*(?:章)?(?:\\s*(?:、|及|与|和|至|到|${rangeDash})\\s*第?\\s*${numeric}\\s*(?:章)?)*\\s*章)(?:的(?:正文|内容))?(?:的前提下)?\\s*$`, 'u')
  return writingScopeClauses(text).filter(clause => {
    // Do not erase a simultaneous global/relative prohibition such as
    // "不改第1章或当前章" or "不改第1章和任何正文".
    if (!numberedOnly.test(clause)) return true
    const exclusions = parseWritingTargets(clause).exclusions
    if (exclusions.length !== 1) return true
    const exclusion = writingExclusionRange(exclusions[0])
    if (!exclusion || exclusion.volume || !['first', 'range', 'list'].includes(exclusion.kind)) return true
    // The admission already froze exclusions against the same chapter IDs.
    // A contradictory target remains forbidden rather than being repaired here.
    return exclusion.kind === 'list' ? !!exclusion.positions?.includes(target.orderIndex)
      : target.orderIndex >= (exclusion.start ?? 1) && target.orderIndex < (exclusion.start ?? 1) + (exclusion.count ?? 1)
  }).join('，')
}

/** A canonical binding is minted atomically by chapter_create. Legacy inferred
 * targets, timestamps, child briefs and current directory positions cannot mint
 * this allowance: require the original frozen null slot and its exact binding. */
export async function readNewDraftWritingAuthority(tx: Prisma.TransactionClient, subject: Subject, chapter: { id: string; orderIndex: number }) {
  const original = await readOriginalTaskRequest(tx, subject)
  const parsed = taskSpecSchema.safeParse(original.spec)
  if (!parsed.success || parsed.data.intent !== 'write' || parsed.data.scope.novelId !== subject.novelId
    || parsed.data.scope.selection || ['proposal_only', 'conversation_only'].includes(parsed.data.writingPacing ?? '')
    || parsed.data.scope.writingTargetProtocol !== 2 && (prohibitsNewDraftRevision(original.prompt)
      || parsed.data.hardConstraints.some(item => prohibitsNewDraftRevision(item.text)))) return null
  const frozen = parsed.data.scope.writing
  if (frozen?.kind !== 'bounded' && !(frozen?.kind === 'needs_input' && parsed.data.scope.writingClarificationProtocol === 1)) return null
  const scope = await readWritingScope(tx, subject)
  const writing = scope.writing
  if (writing?.kind !== 'bounded') return null
  if (!writing.targets.some(target => target.chapterId === null && target.orderIndex === chapter.orderIndex
    && scope.bindings?.targets.some(binding => binding.orderIndex === target.orderIndex && binding.chapterId === chapter.id))) return null
  return { taskId: scope.taskId }
}
export async function readWritingScope(tx: Prisma.TransactionClient, subject: Subject) {
  const original = await readOriginalTaskRequest(tx, subject)
  const spec = taskSpecSchema.safeParse(original.spec)
  const raw = original.spec && typeof original.spec === 'object' && !Array.isArray(original.spec) ? original.spec as Record<string, unknown> : null
  const rawScope = raw?.scope && typeof raw.scope === 'object' && !Array.isArray(raw.scope) ? raw.scope as Record<string, unknown> : null
  if (rawScope && 'authorEffects' in rawScope && (!spec.success || !original.prompt || !spec.data.scope.authorEffects
    || spec.data.scope.authorEffects.requestHash !== createHash('sha256').update(original.prompt).digest('hex'))) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原作者请求的章节解释凭证缺失或不匹配，不能重新解析补授权。')
  }
  if (rawScope?.writingTargetProtocol === 2 && (!spec.success || !spec.data.scope.writingInterpretation || !original.prompt
    || spec.data.scope.writingInterpretation.requestHash !== createHash('sha256').update(original.prompt).digest('hex')
    || spec.data.scope.writingInterpretation.operations.some(operation => operation.end <= operation.start || operation.end > original.prompt!.length)
    || spec.data.scope.localEditBoundary?.version === 2 && spec.data.scope.localEditBoundary.regions.some(region =>
      region.source.issueEnd > original.prompt!.length || original.prompt!.slice(region.source.quoteStart + 1, region.source.quoteEnd - 1) !== region.text)
    || spec.data.scope.localEditBoundary?.version === 3 && [...spec.data.scope.localEditBoundary.source.reviews,
      ...spec.data.scope.localEditBoundary.source.repairs.flatMap(repair => [repair, repair.condition])].some(span => span.end > original.prompt!.length))) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原作者请求的章节解释凭证缺失或不匹配，不能重新解析补授权。')
  }
  if (spec.success) assertFrozenWritingContract(spec.data)
  if (spec.success && spec.data.scope.authorEffects?.manuscript === false) {
    return { ...original, writing: undefined, bindings: null, clarification: null }
  }
  if (spec.success && spec.data.scope.authorEffects?.manuscript && !spec.data.scope.writing) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原作者请求的章节解释凭证缺失或不匹配，不能重新解析补授权。')
  }
  let writing = spec.success ? spec.data.scope.writing : undefined
  const source = await tx.agentRun.findFirstOrThrow({ where: { id: original.sourceRunId, userId: subject.userId, novelId: subject.novelId } })
  const clarification = spec.success ? await readWritingClarification(tx, subject, original, source, spec.data) : null
  if (clarification) writing = clarification.writing
  if (!writing && original.prompt) {
    const range = legacyWritingRange(original.prompt)
    // No historical directory snapshot proves a list or an existing-book
    // interval. Resume cannot reconstruct it from the current editor or rows.
    if (range?.kind === 'list' || range?.kind === 'existing') writing = { version: 1, kind: 'needs_input', targets: [], titleAndBodyOnly: false, repairAuthorized: hasOriginalRepairAuthority(original.prompt) }
    if (range?.kind === 'unbounded') writing = { version: 1, kind: 'unbounded', targets: [], titleAndBodyOnly: false, repairAuthorized: hasOriginalRepairAuthority(original.prompt) }
    // An old next request has no directory snapshot. Current positions cannot
    // mint a fresh create allowance. Restore only a uniquely proven binding.
    const existingRevision = spec.success && ['revise', 'review'].includes(spec.data.intent) && source.chapterId && range?.kind !== 'next'
    if (!existingRevision && (range?.kind === 'next' || range?.kind === 'first' || range?.kind === 'range')) {
      const runIds = source.taskRootId ? (await tx.agentRun.findMany({ where: { taskRootId: source.taskRootId, userId: subject.userId, novelId: subject.novelId }, select: { id: true } })).map(item => item.id)
        : await (await import('./task-lineage.js')).getTaskRunIds(source.sessionId, source.id, tx)
      const messages = await tx.agentMessage.findMany({ where: { runId: { in: runIds }, role: 'assistant' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { parts: true } })
      const created: string[] = []
      for (const message of messages) for (const part of Array.isArray(message.parts) ? message.parts : []) {
        if (!part || typeof part !== 'object' || Array.isArray(part) || part.type !== 'tool-call' || part.status !== 'success') continue
        const display = part.display
        if (part.toolName === 'chapter_create' && display && typeof display === 'object' && !Array.isArray(display) && typeof display.chapterId === 'string') created.push(display.chapterId)
      }
      const candidates = await tx.storyCompilation.findMany({ where: { userId: subject.userId, novelId: subject.novelId, runId: { in: runIds }, chapterId: { in: created } },
        include: { bridge: true, chapter: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      const first = candidates.find(item => item.chapter && item.chapterId === created[0] && (range.kind !== 'next' ? item.targetOrderIndex === (range.start ?? 1)
        : !!source.chapterId && item.bridge?.fromChapterId === source.chapterId && item.bridge?.sourceRevision !== null))
      writing = { version: 1, kind: first?.chapterId ? 'bounded' : 'needs_input', targets: first?.chapterId ? [{ orderIndex: first.targetOrderIndex, chapterId: first.chapterId }] : [],
        titleAndBodyOnly: /(?:只要|仅输出|只输出).{0,16}(?:标题|章名).{0,12}正文/u.test(original.prompt), repairAuthorized: hasOriginalRepairAuthority(original.prompt) }
    }
  }
  if (!writing && (!original.prompt || !spec.success || ['write', 'revise', 'review'].includes(spec.data.intent))) {
    const ids = original.prompt && spec.success && !spec.data.postconditions.some(item => item.code === 'EARLIER_CONTENT_UNCHANGED')
      ? source.chapterId ? [source.chapterId] : spec.data.scope.chapterIds ?? [] : []
    const targets = ids.length ? await tx.chapter.findMany({ where: { id: { in: ids }, authorId: subject.userId, ...activeChapterScope(subject.novelId) }, select: { id: true, orderIndex: true } }) : []
    writing = { version: 1, kind: targets.length === ids.length && targets.length ? 'bounded' : 'needs_input',
      targets: targets.map(item => ({ orderIndex: item.orderIndex, chapterId: item.id })), titleAndBodyOnly: false, repairAuthorized: hasOriginalRepairAuthority(original.prompt) }
  }
  const bindings = source.writingBindings == null ? null : bindingSchema.parse(source.writingBindings)
  if (bindings && (bindings.taskId !== original.taskId || new Set(bindings.targets.map(item => item.orderIndex)).size !== bindings.targets.length
    || bindings.targets.some(item => !writing?.targets.some(target => target.orderIndex === item.orderIndex && (!target.chapterId || target.chapterId === item.chapterId))))) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '章节写入绑定损坏，不能扩大授权范围。')
  }
  return { ...original, writing, bindings, clarification: clarification?.evidence ?? null }
}

/** A read projection for workflow observers; the frozen spec/hash is untouched. */
export async function effectiveWritingTaskSpec(tx: Prisma.TransactionClient, subject: Subject, spec: TaskSpec): Promise<TaskSpec> {
  if (spec.scope.writingClarificationProtocol !== 1) return spec
  const scope = await readWritingScope(tx, subject)
  if (!scope.clarification || scope.taskId !== spec.id) return spec
  const projection = { ...spec, scope: { ...spec.scope, writing: scope.writing,
    ...(spec.scope.writingInterpretation ? { writingInterpretation: { ...spec.scope.writingInterpretation } } : {}) } }
  // This authenticated observer projection is never persisted as the root.
  if (projection.scope.writingInterpretation) projection.scope.writingInterpretation.scopeHash = frozenWritingScopeHash(projection.scope)
  return projection
}

/** Read only the authenticated original contract. Never mint on an old run. */
export function originalSelectionBoundary(value: unknown) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  const scope = raw?.scope && typeof raw.scope === 'object' && !Array.isArray(raw.scope) ? raw.scope as Record<string, unknown> : null
  if (scope?.manuscriptProtocol === undefined) return null
  const parsed = taskSpecSchema.safeParse(value)
  if (!parsed.success || parsed.data.scope.selection && !parsed.data.scope.selectionBoundary) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原选区授权快照缺失或损坏，不能扩大正文范围。')
  }
  const boundary = parsed.data.scope.selectionBoundary
  const selection = parsed.data.scope.selection
  if (boundary && (!selection || boundary.chapterId !== selection.chapterId || boundary.start !== selection.start
    || boundary.end !== selection.end || boundary.end <= boundary.start || boundary.prefix.length !== boundary.start)) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原选区授权绑定损坏。')
  }
  return boundary ?? null
}

/** Final in-transaction body check shared by ordinary and automatic writers.
 * Exact outside text defines the current interval after variable-length edits;
 * no search for repeated selection text can shift or expand its identity. */
export async function assertSelectionBodyEffect(tx: Prisma.TransactionClient, subject: Subject,
  chapter: { id: string; revision: number }, options: { mutation?: 'range' | 'replace' | 'append'; after?: string;
    editRanges?: Array<{ start: number; end: number; newText: string }> }, automatic = false) {
  const spec = (await readOriginalTaskRequest(tx, subject)).spec
  const conditional = await assertLocalBodyEffect(tx, subject, chapter, options, automatic, spec)
  const boundary = originalSelectionBoundary(spec)
  if (!boundary) return conditional
  if (chapter.id !== boundary.chapterId || automatic || options.mutation && options.mutation !== 'range') {
    throw new DataAccessError(409, 'AUTHOR_SELECTION_SCOPE', '原选区只授权精确片段工具；整章写入、追加或自动整章修订不能扩大范围。')
  }
  // A probe is read-only. Automatic whole-body repair is rejected above before
  // its provider operation is admitted, while ordinary guidance remains open.
  if (!options.mutation) return
  const current = await tx.chapter.findFirst({ where: { id: chapter.id, revision: chapter.revision, authorId: subject.userId,
    ...activeChapterScope(subject.novelId) }, select: { content: true } })
  if (!current) throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '当前正文版本已变化，选区替换未执行。')
  const before = current.content, end = before.length - boundary.suffix.length
  if (chapter.revision < boundary.revision || end < boundary.start || !before.startsWith(boundary.prefix) || !before.endsWith(boundary.suffix)
    || chapter.revision === boundary.revision && runtimeJson({ content: before }).hash !== boundary.contentHash) {
    throw new DataAccessError(409, 'AUTHOR_SELECTION_STALE', '选区外正文或原绑定版本已变化，不能重定位旧选区；请重新发起任务。')
  }
  const ranges = options.editRanges
  let composed = before
  if (!ranges?.length || options.after === undefined || ranges.some(range => !Number.isSafeInteger(range.start)
    || !Number.isSafeInteger(range.end) || range.start < boundary.start || range.end < range.start || range.end > end)) {
    throw new DataAccessError(409, 'AUTHOR_SELECTION_SCOPE', '本批补丁超出原作者选区，全部正文变更未执行。')
  }
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) composed = composed.slice(0, range.start) + range.newText + composed.slice(range.end)
  if (composed !== options.after || !options.after.startsWith(boundary.prefix) || !options.after.endsWith(boundary.suffix)
    || options.after.length < boundary.prefix.length + boundary.suffix.length) {
    throw new DataAccessError(409, 'AUTHOR_SELECTION_SCOPE', '补丁与实际正文效果不一致，全部正文变更未执行。')
  }
  return conditional
}

async function assertLocalBodyEffect(tx: Prisma.TransactionClient, subject: Subject, chapter: { id: string; revision: number },
  options: { mutation?: 'range' | 'replace' | 'append'; after?: string; editRanges?: Array<{ start: number; end: number; newText: string }> },
  automatic: boolean, spec: unknown) {
  const local = originalLocalEditBoundary(spec)
  if (!local) return
  if (local.version === 3) {
    // Automatic whole-body repair is withheld before dispatch/reservation. The
    // ordinary exact-range tool will obtain current persisted finding proof.
    if (automatic) throw new DataAccessError(409, 'REPAIR_NOT_AUTHORIZED', '条件修订先完成检查，再对当前报告的确证问题作精确局部修订；未调用自动改文。')
    if (!options.mutation) return
    const { assertReviewBoundEdit } = await import('./review-bound-edit.js')
    await assertReviewBoundEdit(tx, subject, chapter, local, options)
    return true as const
  }
  if (!options.mutation && !automatic) return // readonly report/guidance remains possible
  const boundary = local.regions.find(region => region.chapterId === chapter.id)
  if (local.kind === 'needs_input' || !boundary || automatic || options.mutation !== 'range') {
    throw new DataAccessError(409, 'AUTHOR_LOCAL_SCOPE', '原局部请求只允许冻结范围内精确片段替换；定位不明须补准确原文或选区后重新发起任务。')
  }
  const current = await tx.chapter.findFirst({ where: { id: chapter.id, revision: chapter.revision, authorId: subject.userId,
    ...activeChapterScope(subject.novelId) }, select: { content: true } })
  if (!current) throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '当前正文版本已变化，局部替换未执行。')
  if (local.version === 2) {
    const spans = currentIssueQuoteRegions(local, chapter.id, chapter.revision, current.content)
    const ranges = options.editRanges
    const ordered = [...ranges ?? []].sort((a, b) => a.start - b.start)
    if (!spans || !ranges?.length || ranges.length > 8 || options.after === undefined || ranges.some(range =>
      !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.end < range.start
      || !spans.some(span => range.start >= span.start && range.end <= span.end))
      || ordered.some((range, index) => index > 0 && range.start < ordered[index - 1].end)) {
      throw new DataAccessError(409, 'AUTHOR_LOCAL_SCOPE', '补丁超出作者问题引文的独立范围，或原文间隔已变化；全部正文变更未执行。')
    }
    let composed = current.content
    for (const range of [...ranges].sort((a, b) => b.start - a.start)) composed = composed.slice(0, range.start) + range.newText + composed.slice(range.end)
    if (composed !== options.after || !currentIssueQuoteRegions(local, chapter.id, chapter.revision + 1, options.after)) {
      throw new DataAccessError(409, 'AUTHOR_LOCAL_SCOPE', '局部补丁组合、保护间隔或冻结长度边界不一致，全部变更未执行。')
    }
    return
  }
  const before = current.content, end = before.length - boundary.suffix.length
  if (chapter.revision < boundary.revision || end < boundary.start || !before.startsWith(boundary.prefix) || !before.endsWith(boundary.suffix)
    || chapter.revision === boundary.revision && runtimeJson({ content: before }).hash !== boundary.contentHash) {
    throw new DataAccessError(409, 'AUTHOR_LOCAL_STALE', '冻结范围外正文或原版本已变化，请重新发起局部任务，不能重定位旧授权。')
  }
  const ranges = options.editRanges
  if (!ranges?.length || options.after === undefined || ranges.some(range => !Number.isSafeInteger(range.start)
    || !Number.isSafeInteger(range.end) || range.start < boundary.start || range.end < range.start || range.end > end
    || range.start === 0 && range.end === before.length)) {
    throw new DataAccessError(409, 'AUTHOR_LOCAL_SCOPE', '本批补丁超出冻结局部范围或整体覆盖正文，全部变更未执行。')
  }
  let after = before
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) after = after.slice(0, range.start) + range.newText + after.slice(range.end)
  if (after !== options.after || !after.startsWith(boundary.prefix) || !after.endsWith(boundary.suffix)
    || after.length < boundary.prefix.length + boundary.suffix.length) {
    throw new DataAccessError(409, 'AUTHOR_LOCAL_SCOPE', '局部补丁与实际正文效果不一致，全部变更未执行。')
  }
}

export async function lockWritingRunLineage(tx: Prisma.TransactionClient, subject: Subject) {
  await lockNovelActiveScope(tx, subject.novelId)
  const original = await readOriginalTaskRequest(tx, subject)
  await assertRunGoalFence(tx, subject.userId, subject.runId)
  if (original.parentRunId) await assertRunGoalFence(tx, subject.userId, original.parentRunId)
  // Canonical admission, current parent, then child. Do not acquire a parent
  // row after a child; lease/cancellation paths use the same lineage order.
  for (const id of new Set([original.sourceRunId, ...(original.parentRunId ? [original.parentRunId] : [])])) {
    await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${id} AND user_id = ${subject.userId} AND novel_id = ${subject.novelId} FOR UPDATE`
  }
  await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${subject.runId} AND user_id = ${subject.userId} AND novel_id = ${subject.novelId} FOR UPDATE`
}

export async function assertWritingTarget(tx: Prisma.TransactionClient, subject: Subject, target: { chapterId?: string; orderIndex?: number;
  effect?: 'range' | 'replace' | 'append' | 'metadata' | 'changeset' | 'create' }) {
  await lockWritingRunLineage(tx, subject)
  if (!await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId, status: { in: ['queued', 'running', 'awaiting_approval'] } }, select: { id: true } })) {
    throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '当前执行已暂停或结束，不能再写入章节。')
  }
  const scope = await readWritingScope(tx, subject)
  if (taskSpecSchema.safeParse(scope.spec).data?.scope.authorEffects?.manuscript === false) {
    throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '原始请求未授权该章节，不能通过工具、待办或子任务扩大范围。')
  }
  const boundary = originalSelectionBoundary(scope.spec)
  if (boundary && (target.chapterId !== boundary.chapterId || target.effect && target.effect !== 'range')) {
    throw new DataAccessError(409, 'AUTHOR_SELECTION_SCOPE', '原任务只授权选区内片段替换，不能整体覆盖、追加、改名、创建或通过其他工具改动正文。')
  }
  const local = originalLocalEditBoundary(scope.spec)
  if (taskSpecSchema.safeParse(scope.spec).data?.scope.writingTargetProtocol === 2 && local?.kind === 'needs_input') {
    throw new DataAccessError(409, 'AUTHOR_LOCAL_SCOPE', '目标章节已确认，但局部原文范围尚未唯一定位；本次未执行写作准备或正文变更。')
  }
  if (local && target.effect && (local.kind === 'needs_input' || !local.regions.some(region => region.chapterId === target.chapterId)
    || target.effect !== 'range')) {
    throw new DataAccessError(409, 'AUTHOR_LOCAL_SCOPE', '原局部请求不能整体覆盖、追加、改名、创建或借其他工具改动正文；定位不明须补准确原文或选区后重新发起任务。')
  }
  if (scope.parentRunId && !await tx.agentRun.findFirst({ where: { id: scope.parentRunId, userId: subject.userId, novelId: subject.novelId,
    status: { in: ['queued', 'running', 'awaiting_approval'] } }, select: { id: true } })) throw new DataAccessError(409, 'RUNTIME_PARENT_LEASE_LOST', '父任务已暂停或结束，子任务不能写入。')
  if (!scope.writing || scope.writing.kind === 'unbounded') return scope
  if (scope.writing.kind === 'needs_input') throw new DataAccessError(409, 'SCOPE_NEEDS_INPUT', '原任务缺少可证明的章节目标，请明确目标章节；保留已保存正文。')
  const allowed = scope.writing.targets.some(item => target.chapterId
    ? (item.chapterId ?? scope.bindings?.targets.find(binding => binding.orderIndex === item.orderIndex)?.chapterId) === target.chapterId
    : item.orderIndex === target.orderIndex)
  if (!allowed) throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '原始请求未授权该章节，不能通过工具、待办或子任务扩大范围。')
  return scope
}

/** Resolve explicit placement before any create or replay. An unmatched volume
 * position is never equivalent to omitting the requested target. */
export async function resolveWritingCreateTarget(tx: Prisma.TransactionClient, subject: Subject,
  args: { position?: number; volumeId?: string; volumeOrder?: number; positionInVolume?: number }, existingChapterId?: string) {
  await lockWritingRunLineage(tx, subject)
  const scope = await readWritingScope(tx, subject)
  const explicitVolume = args.volumeId !== undefined || args.volumeOrder !== undefined
  const volume = explicitVolume ? await tx.volume.findFirst({ where: { novelId: subject.novelId, ...activeVolumeWhere,
    ...(args.volumeId !== undefined ? { id: args.volumeId } : { orderIndex: args.volumeOrder }) } }) : null
  if (explicitVolume && !volume) throw new DataAccessError(400, 'VOLUME_NOT_FOUND', '目标卷不存在或不属于当前作品。')
  const chapters = await tx.chapter.findMany({ where: { authorId: subject.userId, ...activeChapterScope(subject.novelId) },
    select: { id: true, orderIndex: true, orderInVolume: true, volumeId: true, volume: { select: { orderIndex: true } } }, orderBy: { orderIndex: 'asc' } })
  const existing = existingChapterId ? chapters.find(chapter => chapter.id === existingChapterId) : null
  if (existingChapterId && !existing) throw new DataAccessError(409, 'AUTHOR_SCOPE_PROTECTED', '原创建结果已归档或不存在，不能创建替代身份。')
  const matchesPlacement = (chapter: NonNullable<typeof existing>) => (args.position === undefined || args.position === chapter.orderIndex)
    && (!volume || chapter.volumeId === volume.id)
    && (args.positionInVolume === undefined || args.positionInVolume === chapter.orderInVolume)
  if (existing && !matchesPlacement(existing)) throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '显式创建位置与已绑定章节不一致，本次未创建或复用其他章节。')
  const bounded = scope.writing?.kind === 'bounded' ? scope.writing : null
  const slot = bounded?.targets.find(target => {
    const boundId = target.chapterId ?? scope.bindings?.targets.find(binding => binding.orderIndex === target.orderIndex)?.chapterId
    if (existingChapterId && boundId !== existingChapterId) return false
    if (args.position !== undefined && target.orderIndex !== args.position) return false
    const chapter = boundId ? chapters.find(item => item.id === boundId) : chapters.find(item => item.orderIndex === target.orderIndex)
    if (boundId && chapter && !matchesPlacement(chapter)) return false
    if (!volume) return true
    if (target.volumeId && target.volumeId !== volume.id) return false
    if (target.positionInVolume !== undefined && (args.positionInVolume !== undefined && args.positionInVolume !== target.positionInVolume
      || chapter && chapter.orderInVolume !== target.positionInVolume)) return false
    if (chapter) return matchesPlacement(chapter)
    const count = chapters.filter(item => item.volumeId === volume.id).length
    const position = args.positionInVolume ?? target.positionInVolume ?? count + 1
    return position <= count + 1 && (target.positionInVolume === undefined || position === target.positionInVolume)
      && target.orderIndex === chapters.filter(item => item.volume.orderIndex < volume.orderIndex).length + position
  })
  if (bounded && !slot) throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '显式创建目标不匹配原始请求的冻结章节范围，本次未创建或复用其他章节。')
  await assertWritingTarget(tx, subject, existing ? { chapterId: existing.id, effect: 'create' } : { orderIndex: slot?.orderIndex ?? args.position, effect: 'create' })
  return { slot, volumeId: volume?.id, chapters }
}

/** Novel lock serializes all parent/child create attempts; the claim commits
 * atomically with the new chapter and can only bind a frozen admission slot. */
export async function bindWritingChapter(tx: Prisma.TransactionClient, subject: Subject, orderIndex: number, chapterId: string) {
  const scope = await assertWritingTarget(tx, subject, { orderIndex })
  if (!scope.writing || scope.writing.kind !== 'bounded') return
  const old = scope.bindings?.targets.find(item => item.orderIndex === orderIndex)
  const admission = scope.writing.targets.find(item => item.orderIndex === orderIndex)!
  if ((old && old.chapterId !== chapterId) || (admission.chapterId && admission.chapterId !== chapterId)) throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '本任务目标已绑定原章节，不能重复创建。')
  await tx.agentRun.update({ where: { id: scope.sourceRunId }, data: { writingBindings: runtimeJson({ version: 1, taskId: scope.taskId,
    targets: [...(scope.bindings?.targets.filter(item => item.orderIndex !== orderIndex) ?? []), { orderIndex, chapterId }].sort((a, b) => a.orderIndex - b.orderIndex) }).value } })
}

export async function assertWritingStructureAuthority(tx: Prisma.TransactionClient, subject: Subject, effect: 'structure' | 'metadata' = 'structure') {
  const scope = await readWritingScope(tx, subject)
  if (effect !== 'metadata' && taskSpecSchema.safeParse(scope.spec).data?.scope.authorEffects?.structure === false) {
    throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '原请求仅授权指定章节正文，未授权拆分、合并或重排作品结构。')
  }
  if (originalSelectionBoundary(scope.spec)) throw new DataAccessError(409, 'AUTHOR_SELECTION_SCOPE', '选区授权不允许改变章节结构。')
  if (originalLocalEditBoundary(scope.spec)) throw new DataAccessError(409, 'AUTHOR_LOCAL_SCOPE', '局部正文授权不允许改变章节结构。')
  if (scope.writing && scope.writing.kind !== 'unbounded') throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '原请求仅授权指定章节正文，未授权拆分、合并或重排作品结构。')
}

export function questionExpandsWritingScope(question: string, options: Array<{ label: string; detail?: string }>, writing: Writing | undefined, original: string | null): boolean {
  if (!writing || writing.kind === 'unbounded') return false
  const texts = [question, ...options.flatMap(option => [option.label, option.detail ?? ''])]
  // Only cover wording still counts as a scope expansion here. Blocking chapter
  // wording severed the model's only channel to the author and stranded runs;
  // every actual write target remains enforced by assertWritingTarget.
  return texts.some(text => /封面|cover/iu.test(text)
    && !(original ?? '').split(/[。！？!?；;\n，,]+/u).some(clause => !/(?:不要|无需|不用|不必|禁止|不得|不能|do not|don't)/iu.test(clause) && /封面|cover/iu.test(clause)))
}

/** Auto-delivery is limited to a chapter artifact request. Explicit additional
 * human-requested work keeps the ordinary completion checks in control. */
export function allowsChapterOnlyCompletion(prompt: string | null, requireExclusiveFormat = true): boolean {
  if (!prompt || !legacyWritingRange(prompt) || (requireExclusiveFormat && !/(?:只(?:要|输出|给|需)|仅(?:输出|给|需)).{0,16}(?:标题|章名).{0,12}(?:正文|内容)|only.{0,20}title.{0,12}(?:body|text)/iu.test(prompt))) return false
  const positive = prompt.split(/[。！？!?；;\n，,]+/u).filter(clause => !/(?:不要|无需|不用|不必|禁止|不得|不能|do not|don't)/iu.test(clause))
  if (!positive.some(clause => /(?:写|完成|修改|润色|起草|write|draft|revise)/iu.test(clause))) return false
  // A second independent action makes the output contract non-exclusive; do
  // not guess an exhaustive list of artifact nouns such as poems or diagrams.
  if (positive.some(clause => /(?:另|另外|此外|同时|顺便|再|还|也|并|而且).{0,12}(?:写|作|生成|给|提供|做|绘|设计|制作|保存|导出|发布)|(?:also|additionally|besides).{0,20}(?:write|create|produce|generate|export|publish)/iu.test(clause))) return false
  return !positive.some(clause => /(?:生成|制作|设计|绘制|保存|导出|发布|提供|给出|列出|需要|要做|produce|create|generate|export|publish).{0,24}(?:封面|大纲|计划|报告|设定集|人物表|插图|文件|cover|outline|report|illustration|file)|(?:检查|审阅|评估|分析|review|analy[sz]e).{0,16}(?:章节|正文|质量|连续性|chapter|quality|continuity)/iu.test(clause))
}

export async function assertQuestionWritingScope(tx: Prisma.TransactionClient, subject: Subject, question: string, options: Array<{ label: string; detail?: string }>) {
  const scope = await readWritingScope(tx, subject)
  if (questionExpandsWritingScope(question, options, scope.writing, scope.prompt)) throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '该问题或选项把原任务范围扩大到封面产物；继续已授权章节，不诱导封面。')
}

/** Completion is a read of the authorized persisted artifact at its current
 * revision, never a model summary, generated todo, or an unrelated old bridge. */
export async function readCompletedWritingDelivery(tx: Prisma.TransactionClient, subject: Subject) {
  return readChapterDelivery(tx, subject, 'auto')
}

/** Presentation only, called AFTER the ordinary completion gate has passed.
 * It never substitutes for completion evidence or makes a task finish early. */
export async function readSavedWritingPresentation(tx: Prisma.TransactionClient, subject: Subject) {
  return readChapterDelivery(tx, subject, 'completed_saved_only')
}

/** Ordinary completion has already been decided by the loop. Its presentation
 * still needs the current persisted commit, even for a short model summary. */
export async function readCompletedWritingPresentation(tx: Prisma.TransactionClient, subject: Subject) {
  return readChapterDelivery(tx, subject, 'completed_wrap_up')
}

export function requiresCompletedWritingPresentation(spec: TaskSpec): boolean {
  return ['write', 'revise'].includes(spec.intent) && spec.scope.writing?.kind === 'bounded'
    && !['proposal_only', 'conversation_only'].includes(spec.writingPacing ?? '')
    // Legacy intent defaults may say write for a plain summary or observation.
    // They do not create a manuscript completion obligation by themselves.
    && (spec.scope.writingTargetProtocol === 2 ? !!spec.scope.writingInterpretation?.operations.some(operation =>
      operation.polarity === 'affirmative' && ['write', 'revise'].includes(operation.kind))
      : spec.scope.writing.repairAuthorized || parseWritingTargets(spec.goals.join('\n')).hasAction
      && /写|修订|修改|改写|重写|润色|优化|完善|补写|\b(?:write|revise|rewrite|edit|polish|draft)\b/iu.test(spec.goals.join('\n')))
}

/** Fresh consumers use the same frozen operation/target projection as tools.
 * Legacy text vetoes remain isolated; this helper never mints a chapter ID. */
export function frozenWritingRevisionAuthority(value: unknown, chapterId: string, provenNewDraft = false): boolean | undefined {
  const parsed = taskSpecSchema.safeParse(value)
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  const scope = raw?.scope && typeof raw.scope === 'object' && !Array.isArray(raw.scope) ? raw.scope as Record<string, unknown> : null
  if (!parsed.success && scope?.writingTargetProtocol === 2) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原作者章节操作解释损坏，不能回退文本猜测权限。')
  }
  if (!parsed.success || parsed.data.scope.writingTargetProtocol !== 2) return undefined
  const spec = parsed.data, interpretation = spec.scope.writingInterpretation, writing = spec.scope.writing
  assertFrozenWritingContract(spec)
  if (!interpretation || !writing || interpretation.revisionDenied || spec.scope.localEditBoundary?.kind === 'needs_input'
    || spec.scope.localEditBoundary?.version === 3
    || interpretation.excludedChapterIds.includes(chapterId)) return false
  if (writing.kind === 'needs_input') return provenNewDraft && spec.scope.writingClarificationProtocol === 1 && spec.intent === 'write'
  const action = interpretation.operations.some(operation => operation.polarity === 'affirmative'
    && (operation.kind === 'revise' || spec.intent === 'write' && operation.kind === 'write'))
  return action && (writing.kind === 'unbounded' || writing.targets.some(target => target.chapterId === chapterId)
    || provenNewDraft && writing.targets.some(target => target.chapterId === null))
}

type PresentationDelivery = NonNullable<Awaited<ReturnType<typeof readCompletedWritingPresentation>>>
type PresentationChapter = PresentationDelivery['chapters'][number]
type WritingQuotation = { start: number; end: number; value: string; closed: boolean }
const writingQuotePairs: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』', '《': '》', '"': '"', "'": "'", '`': '`' }

function writingQuotations(text: string): WritingQuotation[] {
  const result: WritingQuotation[] = [], stack: Array<{ start: number; close: string }> = []
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if ((char === '"' || char === "'" || char === '`') && text[index - 1] === '\\') continue
    if (char === stack.at(-1)?.close) {
      const quote = stack.pop()!
      result.push({ start: quote.start, end: index + 1, value: text.slice(quote.start + 1, index), closed: true })
    } else if (writingQuotePairs[char] && !(char === "'" && /[a-z0-9]/iu.test(text[index - 1] ?? '') && /[a-z0-9]/iu.test(text[index + 1] ?? ''))) {
      stack.push({ start: index, close: writingQuotePairs[char] })
    }
  }
  for (const quote of stack) result.push({ start: quote.start, end: text.length, value: text.slice(quote.start + 1), closed: false })
  return result.sort((a, b) => a.start - b.start || b.end - a.end)
}

function summarySentences(text: string): string[] {
  const quotes = writingQuotations(text), result: string[] = []
  let start = 0, quoteIndex = 0
  for (let index = 0; index < text.length; index++) {
    while (quotes[quoteIndex]?.end <= index) quoteIndex++
    if (quotes[quoteIndex]?.start <= index) { index = quotes[quoteIndex].end - 1; continue }
    if (/[。！？!?\n]/u.test(text[index])) {
      result.push(text.slice(start, index + 1))
      start = index + 1
    }
  }
  if (start < text.length) result.push(text.slice(start))
  return result
}

function writingChapterMentions(sentence: string, quotes: WritingQuotation[], chapters: PresentationChapter[]) {
  const mentions: Array<{ start: number; end: number; chapters: PresentationChapter[] }> = []
  const numbered = new RegExp(`第\\s*(${numeric}(?:\\s*[、,，和及]\\s*第?\\s*${numeric})*)\\s*章`, 'gu')
  for (const match of sentence.matchAll(numbered)) {
    if (quotes.some(quote => match.index! > quote.start && match.index! < quote.end)) continue
    const positions = match[1].split(/\s*[、,，和及]\s*第?\s*/u).map(chapterNumber)
    const selected = chapters.filter(chapter => positions.includes(chapter.orderIndex))
    mentions.push({ start: match.index!, end: match.index! + match[0].length,
      chapters: selected.length === positions.length ? selected : [] })
  }
  for (const quote of quotes) {
    const selected = chapters.filter(chapter => quote.value === chapter.title || quote.value === chapter.id)
    if (selected.length) mentions.push({ start: quote.start, end: quote.end, chapters: selected })
  }
  return mentions.sort((a, b) => a.start - b.start)
}

function writingSentenceScope(sentence: string, position: number, mentions: ReturnType<typeof writingChapterMentions>, fallback: PresentationChapter[]) {
  const breaks = [...sentence.matchAll(/[,，;；。！？!?\n]/gu)].map(match => match.index!)
  const start = breaks.filter(index => index < position).at(-1) ?? -1
  const end = breaks.find(index => index > position) ?? sentence.length
  const local = mentions.filter(mention => mention.end > start && mention.start < end)
  const preceding = local.filter(mention => mention.end <= position).at(-1)
  if (preceding) return preceding.chapters
  if (local.length === 1) return local[0].chapters
  if (local.length > 1) return []
  return mentions.filter(mention => mention.end <= position).at(-1)?.chapters ?? fallback
}

function writingStyleLabel(sentence: string, quote: WritingQuotation): boolean {
  const before = sentence.slice(0, quote.start).replace(/[*_]/gu, '')
  if (!/(?:风格|节奏|叙事|氛围|审美)标签\s*(?:是|为|[:：])\s*$/u.test(before)) return false
  const labels = new Set(['留白', '悬念', '收束', '克制', '紧凑', '轻快', '冷峻', '舒缓', '张力', '简洁', '凝练', '细腻', '明快', '沉静', '朴实', '含蓄', '节制', '抒情', '写实', '幽默', '温暖'])
  return quote.value.split(/\s*(?:与|和|、|\/|\+)\s*/u).every(label => labels.has(label))
}

/** All substantive quotations need a current source. Only an explicitly named
 * style-label grammar is commentary; short words are never a citation waiver. */
function currentWritingSummarySentence(sentence: string, delivery: PresentationDelivery, inherited: PresentationChapter[]): boolean {
  const quotes = writingQuotations(sentence), mentions = writingChapterMentions(sentence, quotes, delivery.chapters)
  const scope = (position: number) => writingSentenceScope(sentence, position, mentions, inherited)
  const revisions = [...sentence.matchAll(/\br(?:evision)?\s*(\d+)\b|(?:修订版本|当前版本)\s*[:：]?\s*(\d+)/giu)]
    .filter(match => !quotes.some(quote => quote.start < match.index! && match.index! < quote.end
      && !/^r(?:evision)?\s*\d+$/iu.test(quote.value)))
  if (revisions.some(match => !scope(match.index!).length || !scope(match.index!).every(chapter => chapter.revision === Number(match[1] ?? match[2])))) return false
  if (/(?:通过|零错误|0\s*错误|0\s*条意见)/u.test(sentence) && /(?:检查|连续性|人类感|写作质量)/u.test(sentence)) {
    const continuity = /连续性/u.test(sentence), quality = /人类感|写作质量/u.test(sentence)
    if (inherited.some(({ completion }) => (!quality || continuity) && (completion.continuity !== 'complete' || completion.continuityErrors > 0)
      || (!continuity || quality) && (completion.quality !== 'complete' || completion.qualityErrors > 0)
      || /0\s*条意见/u.test(sentence) && completion.openFindings !== 0)) return false
  }
  if (/^\s*>/u.test(sentence)) return scope(0).some(chapter => chapter.content.normalize('NFC').includes(sentence.replace(/^\s*>\s?/gmu, '').trim().normalize('NFC')))
  for (const quote of quotes) {
    if (!quote.value.trim()) continue
    if (!quote.closed) return false
    const chapters = scope(quote.start)
    if (chapters.some(chapter => quote.value.trim() === chapter.content.trim())) return false
    const references = new Set(chapters.flatMap(chapter => [chapter.title, chapter.id, `r${chapter.revision}`, chapter.completion.compilationId,
      ...(chapter.completion.qualityReportId ? [chapter.completion.qualityReportId] : [])]))
    if (references.has(quote.value) || chapters.some(chapter => chapter.content.normalize('NFC').includes(quote.value.normalize('NFC')))) continue
    if (!writingStyleLabel(sentence, quote)) return false
  }
  return true
}

/** A model-declared manuscript block is replaced by the saved body below, never
 * appended as an unchecked second draft. Explicit summary sections survive. */
function withoutModelManuscriptBlocks(text: string): string {
  const lines: string[] = []
  let manuscript = false
  const introduction = /^(?:(?:以下|下面)(?:是|为)?|这是|附上|展示)?\s*(?:(?:修改|修订|改写|调整|编辑|完善|补写)(?:后(?:的)?)?|已(?:保存|提交)(?:的)?|当前|最新|最终|新版)?\s*(?:正文|原文|章节正文|正文全文|全文|修订稿|成稿)(?:如下|是|为|内容)?\s*(?:[:：]|$)/u
  const commentary = /^(?:修改总结|修订总结|改动总结|修改说明|修订说明|改动说明|完成情况|检查结果|核验结果|总结|说明|备注)\s*(?:[:：]|$)/u
  for (const line of text.split('\n')) {
    const heading = line.replace(/^\s*(?:#{1,6}\s*)?/u, '').replace(/\*\*|__/gu, '').trim()
    const introductionMatch = introduction.exec(heading)
    // Inline literal quotations are checked as quotations, including their
    // line breaks; they must not swallow a later independent summary.
    if (introductionMatch && !writingQuotePairs[heading.slice(introductionMatch[0].length).trim()[0]]) { manuscript = true; continue }
    if (manuscript && commentary.test(heading)) manuscript = false
    if (!manuscript) lines.push(line)
  }
  return lines.join('\n')
}

/** Only final presentation changes here. The manuscript, original request and
 * review findings remain untouched, and supported natural summaries survive. */
export function completedWritingPresentationText(delivery: PresentationDelivery, candidateText: string): string {
  const receipt = `${delivery.chapters.map(chapter => `已保存《${chapter.title}》（r${chapter.revision}）`).join('；')}，章节终态已提交。`
  const showFullText = delivery.presentation?.mode === 'full_text'
    || !delivery.presentation && delivery.titleAndBodyOnly
  let summary = withoutModelManuscriptBlocks(candidateText.split(receipt).join('')).trim()
  for (const chapter of delivery.chapters) {
    summary = summary.split(`${chapter.title}\n\n${chapter.content}`).join('')
    if (summary.trim() === chapter.content.trim()) summary = ''
  }
  let inherited = delivery.chapters
  summary = summarySentences(summary).filter(sentence => {
    const mentions = writingChapterMentions(sentence, writingQuotations(sentence), delivery.chapters)
    const supported = currentWritingSummarySentence(sentence, delivery, inherited)
    if (mentions.length) inherited = mentions.at(-1)!.chapters
    return supported
  }).join('').trim()
  if (showFullText && delivery.titleAndBodyOnly) return delivery.text
  return [showFullText ? delivery.text : '', summary, receipt].filter(Boolean).join('\n\n')
}

/** A no-repeat preference withdraws chapter prose, not the author's wrap-up. */
export function shouldUseSavedWritingPresentation(delivery: Awaited<ReturnType<typeof readSavedWritingPresentation>>, candidateText: string): boolean {
  return Boolean(delivery && (!candidateText.trim() || delivery.chapters.some(chapter => candidateText.includes(chapter.content))))
}

export const savedChapterPresentationSchema = z.object({ version: z.literal(1), targetRunId: z.string().min(1),
  sourceRunId: z.string().min(1), sourceMessageId: z.string().min(1),
  chapters: z.array(z.object({ id: z.string().min(1), title: z.string(), revision: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1), text: z.string().min(1) }).strict()
  .refine(value => value.text === `已保存${value.chapters.map(chapter => `《${chapter.title}》`).join('、')}。`)

export function savedChapterPresentationProof(subject: Subject, delivery: NonNullable<Awaited<ReturnType<typeof readSavedWritingPresentation>>>) {
  if (delivery.presentationKind !== 'completed_saved_only' || delivery.presentation?.mode !== 'saved_only') throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '章节展示证明缺少真实保存偏好。')
  return savedChapterPresentationSchema.parse({ version: 1, targetRunId: subject.runId,
    sourceRunId: delivery.presentation.sourceRunId, sourceMessageId: delivery.presentation.sourceMessageId,
    chapters: delivery.chapters.map(({ id, title, revision, contentHash }) => ({ id, title, revision, contentHash })), text: delivery.text })
}

async function readChapterDelivery(tx: Prisma.TransactionClient, subject: Subject, presentationKind: 'auto' | 'completed_saved_only' | 'completed_wrap_up') {
  await lockNovelActiveScope(tx, subject.novelId)
  const scope = await readWritingScope(tx, subject)
  if (scope.writing?.kind !== 'bounded' || !scope.writing.targets.length
    || (presentationKind === 'auto' && !scope.writing.titleAndBodyOnly)
    || (presentationKind !== 'completed_wrap_up' && !allowsChapterOnlyCompletion(scope.prompt, presentationKind === 'auto'))) return null
  const targets = scope.writing.targets.map(target => ({ ...target, chapterId: target.chapterId ?? scope.bindings?.targets.find(item => item.orderIndex === target.orderIndex)?.chapterId }))
  const presentation = await readWritingPresentation(tx, subject, targets)
  if (presentationKind === 'completed_saved_only' && presentation?.mode !== 'saved_only') return null
  const runIds = await originalTaskRunIds(tx, subject, scope)
  const chapters = []
  const length = scope.prompt?.match(new RegExp(`(\\d{2,6})\\s*(?:${rangeDash}|至|到)\\s*(\\d{2,6})\\s*字`, 'u'))
  for (const target of scope.writing.targets) {
    const id = target.chapterId ?? scope.bindings?.targets.find(item => item.orderIndex === target.orderIndex)?.chapterId
    if (!id) return null
    await tx.$queryRaw`SELECT id FROM chapters WHERE id = ${id} FOR SHARE`
    const chapter = await tx.chapter.findFirst({ where: { id, authorId: subject.userId, ...activeChapterScope(subject.novelId) }, select: { id: true, title: true, content: true, revision: true, orderIndex: true } })
    const terminal = await tx.storyCompilation.findFirst({ where: { userId: subject.userId, novelId: subject.novelId, runId: { in: runIds }, chapterId: id,
      status: { not: 'abandoned' } }, include: { bridge: true, sceneTasks: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    if (!chapter?.content.trim() || terminal?.status !== 'completed' || terminal.stage !== 'commit'
      || terminal.bridge?.toChapterId !== id || !terminal.bridge.committedAt || terminal.bridge.targetRevision !== chapter.revision) return null
    const context = terminal.preparedContext && typeof terminal.preparedContext === 'object' && !Array.isArray(terminal.preparedContext) ? terminal.preparedContext : null
    if (context?.terminalContentHash !== runtimeJson({ content: chapter.content }).hash) return null
    let source: { id: string; revision: number; content: string } | null = null
    if (terminal.bridge.fromChapterId) {
      await tx.$queryRaw`SELECT id FROM chapters WHERE id = ${terminal.bridge.fromChapterId} FOR SHARE`
      source = await tx.chapter.findFirst({ where: { id: terminal.bridge.fromChapterId, ...activeChapterScope(subject.novelId) }, select: { id: true, revision: true, content: true } })
      if (source?.revision !== terminal.bridge.sourceRevision) return null
    }
    const { readChapterReviewReadiness, hasPendingChapterReviewDecision } = await import('./chapter-review-guard.js')
    const readiness = await readChapterReviewReadiness(tx, subject, terminal.id)
    if (!readiness?.ready) return null
    if (hasPendingChapterReviewDecision(readiness)) return null
    if (length && (chapter.content.trim().length < Number(length[1]) || chapter.content.trim().length > Number(length[2]))) return null
    chapters.push({ ...chapter, contentHash: runtimeJson({ content: chapter.content }).hash,
      completion: { compilationId: terminal.id, qualityReportId: readiness.qualityReportId,
        commitHash: runtimeJson(JSON.parse(JSON.stringify(terminal))).hash, reviewHash: runtimeJson(readiness).hash,
        continuity: readiness.continuity, quality: readiness.quality, continuityErrors: readiness.continuityErrorCount,
        qualityErrors: readiness.qualityErrorCount, openFindings: readiness.reviewCycleFindings?.length ?? null } })
  }
  const showFullText = presentation ? presentation.mode === 'full_text' : scope.writing.titleAndBodyOnly
  return { chapters, titleAndBodyOnly: scope.writing.titleAndBodyOnly, presentation, presentationKind,
    text: showFullText ? chapters.map(chapter => `${chapter.title}\n\n${chapter.content}`).join('\n\n')
      : `已保存${chapters.map(chapter => `《${chapter.title}》`).join('、')}。` }
}

/** Final persistence must revalidate the exact capture while holding the same
 * manuscript/canonical/current ownership locks, rather than trusting an earlier
 * read that the author may have changed or cancelled. */
export async function assertCompletedWritingDelivery(tx: Prisma.TransactionClient, subject: Subject, expected: NonNullable<Awaited<ReturnType<typeof readCompletedWritingDelivery>>>) {
  await lockWritingRunLineage(tx, subject)
  await (await import('./manuscript-scope.js')).assertAgentManuscriptCurrent(tx, subject)
  const scope = await readWritingScope(tx, subject)
  if (scope.parentRunId && !await tx.agentRun.findFirst({ where: { id: scope.parentRunId, userId: subject.userId, novelId: subject.novelId, status: { in: ['running', 'queued', 'awaiting_approval'] } }, select: { id: true } })) throw new DataAccessError(409, 'WRITING_DELIVERY_STALE', '父任务已停止，子任务不再交付。')
  if (!await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId, status: { in: ['running', 'queued', 'awaiting_approval'] } }, select: { id: true } })) throw new DataAccessError(409, 'WRITING_DELIVERY_STALE', '任务或当前章节交付已变化。')
  const current = await readChapterDelivery(tx, subject, expected.presentationKind)
  if (!current || runtimeJson(current).hash !== runtimeJson(expected).hash) throw new DataAccessError(409, 'WRITING_DELIVERY_STALE', '正文在交付前已变化，保留最新正文重新核对。')
}
