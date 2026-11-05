import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { taskSpecSchema, type TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { authorEffectRange, authorOperationRange, parseAuthorWritingRequest, type AuthorWritingRequest } from './author-writing-request.js'
import type { RequestedWritingRange } from './writing-target-range.js'
import { ownedAuthorAdmission } from './writing-request-context.js'
import { assertFrozenWritingContract } from './writing-contract.js'
import { readHumanAdmission } from './goal-activation-authority.js'
import { originalTaskRunIds, readOriginalTaskRequest } from './original-request.js'
import { readWritingClarification } from './writing-clarification.js'

type Target = NonNullable<TaskSpec['scope']['writing']>['targets'][number]
type Chapter = { id: string; revision: number; orderIndex: number; orderInVolume: number; volumeId: string; volume: { orderIndex: number } }
type Source = NonNullable<NonNullable<TaskSpec['scope']['writingActions']>['operations'][number]['source']>
type Boundary = NonNullable<TaskSpec['scope']['localEditBoundary']>
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** All selectors use the same locked admission directory, never model plans. */
export function resolveActionTargets(range: RequestedWritingRange | null, chapters: Chapter[], editorId: string | null,
  volumes: Array<{ id: string; orderIndex: number }>): Target[] {
  if (!range || range.kind === 'unbounded') return []
  if (range.kind === 'existing') return chapters.filter(chapter => (!range.volume || chapter.volume.orderIndex === range.volume)
    && (range.volume ? chapter.orderInVolume : chapter.orderIndex) >= (range.start ?? 1)).map(chapter => ({ orderIndex: chapter.orderIndex, chapterId: chapter.id }))
  const editor = chapters.find(chapter => chapter.id === editorId)
  const start = range.start ?? (range.anchor === 'editor' ? editor ? editor.orderIndex + 1 : null : (chapters.at(-1)?.orderIndex ?? 0) + 1)
  const positions = range.kind === 'list' ? range.positions ?? [] : start === null ? [] : Array.from({ length: range.count ?? 1 }, (_, index) => start + index)
  const volume = range.volume ? volumes.find(item => item.orderIndex === range.volume) : null
  if (range.volume && !volume) return []
  return positions.map(position => {
    const chapter = chapters.find(item => volume ? item.volumeId === volume.id && item.orderInVolume === position : item.orderIndex === position)
    return { orderIndex: chapter?.orderIndex ?? (volume ? chapters.filter(item => item.volume.orderIndex < range.volume!).length + position : position),
      chapterId: chapter?.id ?? null, ...(volume ? { volumeId: volume.id, positionInVolume: position } : {}) }
  })
}

async function recentHumanObject(tx: Prisma.TransactionClient, subject: { userId: string; novelId: string; runId: string },
  chapters: Chapter[], kind: 'write' | 'revise', prompt: string, volumes: Array<{ id: string; orderIndex: number }>, collective: boolean): Promise<{ targets: Target[]; source: Source; boundary?: Boundary } | null | undefined> {
  const current = await tx.agentRun.findFirstOrThrow({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  if (!readHumanAdmission(current.startRequest)) return null
  const currentHuman = await ownedAuthorAdmission(tx, subject, current.id, current.sessionId)
  if (!currentHuman || currentHuman.creativePrompt !== prompt) return null
  const candidates = await tx.agentRun.findMany({ where: { userId: subject.userId, novelId: subject.novelId, sessionId: current.sessionId,
    id: { not: current.id }, createdAt: { lte: current.createdAt } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 16, select: { id: true, incomingChildGrant: { select: { id: true } } } })
  for (const candidate of candidates) {
    if (candidate.incomingChildGrant) return null
    const human = await ownedAuthorAdmission(tx, subject, candidate.id, current.sessionId)
    if (!human || human.run.createdAt > current.createdAt) continue
    const parsed = taskSpecSchema.safeParse(human.run.taskSpec), requestHash = createHash('sha256').update(human.creativePrompt).digest('hex')
    if (!parsed.success || parsed.data.scope.novelId !== subject.novelId || parsed.data.scope.authorEffects?.requestHash !== requestHash) return null
    // Invalid historical evidence is not an invitation to search further back.
    try { assertFrozenWritingContract(parsed.data) } catch { return null }
    let spec = parsed.data
    const original = await readOriginalTaskRequest(tx, { ...subject, runId: human.run.id })
    if (original.parentRunId || original.sourceRunId !== human.run.id || original.taskId !== spec.id || original.prompt !== human.creativePrompt) return null
    const clarification = await readWritingClarification(tx, { ...subject, runId: human.run.id }, original, human.run, spec)
    if (clarification) spec = clarification.spec
    const writing = spec.scope.writing
    const runIds = await originalTaskRunIds(tx, { ...subject, runId: human.run.id }, original)
    const source: Source = { runId: human.run.id, messageId: human.message.id, requestHash,
      ...(spec.scope.writingInterpretation ? { scopeHash: spec.scope.writingInterpretation.scopeHash } : {}) }
    let targets = writing?.kind === 'bounded' ? writing.targets.map(target => ({ ...target })) : []
    // A noun-only human clarification can identify an object, but adds no verb
    // to the current request. Quoted/reference/negative predicates stay inert.
    if (!targets.length) {
      const named = parseAuthorWritingRequest(human.creativePrompt)
      if (named.ambiguous || named.evidence.quoted.length || /换个话题|聊聊别的|只读|不要.{0,8}(?:改|写)|不修改/u.test(human.creativePrompt) || named.evidence.operations.some(operation =>
        !['read', 'review'].includes(operation.kind) || operation.polarity !== 'affirmative'
        || !['reference', 'author_operation'].includes(operation.reason))) return null
      const ranges = named.evidence.targets.filter(target => target.range && !target.contextual)
      if (ranges.length === 1) targets = resolveActionTargets(ranges[0].range, chapters, human.run.chapterId, volumes)
      else if (!ranges.length && kind === 'revise' && spec.intent === 'review') {
        const reports = await tx.chapterQualityReport.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
          runId: { in: runIds }, status: { in: ['needs_repair', 'passed', 'repaired'] }, checkedAt: { not: null } },
          select: { id: true, chapterId: true, chapterRevision: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1001 })
        const currentReports = reports.filter(report => chapters.some(chapter => chapter.id === report.chapterId && chapter.revision === report.chapterRevision))
        const ids = new Set(currentReports.map(report => report.chapterId))
        if (reports.length > 1000 || !ids.size || ids.size > 1 && !collective) return null
        targets = chapters.filter(chapter => ids.has(chapter.id)).map(chapter => ({ chapterId: chapter.id, orderIndex: chapter.orderIndex }))
        source.resultIds = currentReports.map(report => report.id)
      } else if (!named.evidence.targets.length && !named.hasAction && !spec.scope.authorEffects?.structure && !spec.scope.authorEffects?.artifact) continue
      else return null
    }
    if (!targets.length) return null
    const bindings = object(human.run.writingBindings)
    if (bindings && (bindings.taskId !== spec.id || !Array.isArray(bindings.targets))) return null
    targets = targets.map(target => {
      const binding = Array.isArray(bindings?.targets) ? bindings.targets.map(object).find(item => item?.orderIndex === target.orderIndex) : null
      return { ...target, chapterId: target.chapterId ?? (typeof binding?.chapterId === 'string' ? binding.chapterId : null) }
    })
    if (targets.some(target => target.chapterId && !chapters.some(chapter => chapter.id === target.chapterId && chapter.orderIndex === target.orderIndex))) return null
    if (kind === 'revise' && targets.some(target => target.chapterId === null)) return null
    if (kind === 'write' && writing) {
      // Continuation restores unfinished original work. Completed work cannot
      // silently grow a new ordinal; an explicit next selector is handled above.
      const completed = await Promise.all(targets.map(async target => {
        const chapter = chapters.find(item => item.id === target.chapterId)
        if (!chapter) return false
        const terminal = await tx.storyCompilation.findFirst({ where: { userId: subject.userId, novelId: subject.novelId,
          runId: { in: runIds }, chapterId: chapter.id, status: 'completed', stage: 'commit',
          bridge: { toChapterId: chapter.id, targetRevision: chapter.revision, committedAt: { not: null } } }, select: { id: true } })
        return !!terminal
      }))
      targets = targets.filter((_, index) => !completed[index])
      if (!targets.length) return null
    }
    // Any current phrase is checked by the parser. It is never concatenated
    // with historical prose to manufacture an operation or chapter number.
    const selection = spec.scope.selectionBoundary, local = spec.scope.localEditBoundary
    // A historical object can be smaller than a chapter. Keep its exact fence;
    // source-specific quote/review policies require a new precise human answer.
    const boundary: Boundary | undefined = selection ? { version: 1, kind: 'bounded', regions: [{ chapterId: selection.chapterId,
      revision: selection.revision, contentHash: selection.contentHash, start: selection.start, end: selection.end, prefix: selection.prefix, suffix: selection.suffix }] }
      : local?.version === 1 || local?.version === 4 ? local : local ? { version: 1, kind: 'needs_input', regions: [] } : undefined
    return { targets, source, ...(boundary ? { boundary } : {}) }
  }
  return undefined
}

export async function freezeWritingActions(tx: Prisma.TransactionClient, subject: { userId: string; novelId: string; runId: string },
  request: AuthorWritingRequest, prompt: string, chapters: Chapter[], editorId: string | null): Promise<TaskSpec['scope']['writingActions']> {
  const operations = request.evidence.operations.filter(operation => operation.accepted && operation.polarity === 'affirmative'
    && (operation.kind === 'write' || operation.kind === 'revise'))
  if (!operations.length || request.range?.kind === 'unbounded') return undefined
  const volumeOrders = [...new Set(request.evidence.targets.flatMap(target => target.range?.volume ? [target.range.volume] : []))]
  const volumes = (await Promise.all(volumeOrders.map(orderIndex => tx.volume.findFirst({ where: { novelId: subject.novelId, archivedAt: null, orderIndex }, select: { id: true, orderIndex: true } })))).filter(item => item !== null)
  const directory = { chapters, volumes }
  const conflictingEffect = (['write', 'revise'] as const).some(kind => {
    const effect = authorEffectRange(request, kind, directory)
    return effect.hasRanges && !effect.range
  })
  const result: NonNullable<TaskSpec['scope']['writingActions']>['operations'] = []
  for (const operation of operations) {
    const kind = operation.kind as 'write' | 'revise'
    const ranges = operation.targetIndices.filter(index => request.evidence.targets[index].range)
    const range = authorOperationRange(request, operation, directory)
    let targets = resolveActionTargets(range, chapters, editorId, volumes), source: Source | undefined, boundary: Boundary | undefined
    const invalid = conflictingEffect || request.reasons.some(reason => !['conflicting_targets'].includes(reason))
    const predicate = prompt.slice(operation.span.start, operation.span.end)
    const persistence = /^(?:保存|存入|导出|发布|save|export|publish)$/iu.test(predicate)
    const explicitEditor = operation.targetIndices.some(index => request.evidence.targets[index].kind === 'same_target'
      && /当前|正在编辑|\bcurrent\b/iu.test(prompt.slice(request.evidence.targets[index].span.start, request.evidence.targets[index].span.end)))
    const clause = request.evidence.clauses.find(clause => clause.start === operation.clauseSpan.start)
    const necessaryRepair = kind === 'revise' && /(?:必要时|如有必要|如需|按(?:照)?(?:需要|必要性|需)|视需要|if\s+(?:needed|necessary)|as\s+needed)\s*$/iu
      .test(clause?.masked.slice(0, operation.span.start - clause.start) ?? '')
    if (invalid) targets = []
    else if (!ranges.length && !explicitEditor && (persistence || necessaryRepair || operation.targetIndices.some(index =>
      ['prose', 'local', 'same_target'].includes(request.evidence.targets[index].kind)))) {
      const prior = result.filter(action => action.resolution === 'bound')
      const domains = [...new Map(prior.map(action => [JSON.stringify(action.targets), action.targets])).values()]
      if (domains.length === 1) targets = domains[0].map(target => ({ ...target }))
    }
    if (!invalid && !ranges.length && !targets.length && editorId && operation.targetIndices.some(index => request.evidence.targets[index].kind === 'local'
      || request.evidence.targets[index].kind === 'prose'
      || request.evidence.targets[index].kind === 'same_target' && explicitEditor)) {
      const chapter = chapters.find(item => item.id === editorId)
      if (chapter) targets = [{ orderIndex: chapter.orderIndex, chapterId: chapter.id }]
    }
    let historicalBlocked = false
    if (!invalid && chapters.length && !ranges.length && !targets.length && !request.reasons.length) {
      const collective = /全部|所有|\ball\b/iu.test(clause?.masked ?? '')
      const historical = await recentHumanObject(tx, subject, chapters, kind, prompt, volumes, collective)
      if (historical) { targets = historical.targets; source = historical.source; boundary = historical.boundary }
      else historicalBlocked = historical === null
    }
    if (!invalid && !historicalBlocked && !ranges.length && !targets.length && editorId && !request.reasons.length
      && /整章|全部|(?:按(?:照)?|照)(?:此|建议|方案)/u.test(clause?.masked ?? '')) {
      const chapter = chapters.find(item => item.id === editorId)
      if (chapter) targets = [{ orderIndex: chapter.orderIndex, chapterId: chapter.id }]
    }
    if (kind === 'revise' && targets.some(target => target.chapterId === null && !result.some(action => action.kind === 'write'
      && action.resolution === 'bound' && action.targets.some(item => item.chapterId === null && item.orderIndex === target.orderIndex)))) targets = []
    result.push({ start: operation.span.start, end: operation.span.end, kind, resolution: targets.length ? 'bound' : 'needs_input', targets,
      ...(source ? { source } : {}), ...(boundary ? { boundary } : {}) })
  }
  return { version: 1, requestHash: createHash('sha256').update(prompt).digest('hex'), operations: result }
}

export function actionTargetMatches(target: Target, chapterId: string, bindings?: { targets: Array<{ orderIndex: number; chapterId: string }> } | null) {
  return (target.chapterId ?? bindings?.targets.find(binding => binding.orderIndex === target.orderIndex)?.chapterId) === chapterId
}
