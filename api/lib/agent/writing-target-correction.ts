import type { Prisma } from '@prisma/client'
import type { TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { activeChapterScope } from '../data/internal.js'
import { lexAuthorWritingRequest, parseAuthorWritingRequest } from './author-writing-request.js'
import { ownedAuthorAdmission } from './writing-request-context.js'
import { frozenWritingScopeHash, assertFrozenWritingContract } from './writing-contract.js'
import { originalTaskRunIds, type readOriginalTaskRequest } from './original-request.js'
import { readHumanAdmission } from './goal-activation-authority.js'
import { chapterNumber } from './writing-target-range.js'

type Subject = { userId: string; novelId: string; runId: string }
type Original = Awaited<ReturnType<typeof readOriginalTaskRequest>>
export type BoundRevisionCorrection = { version: 1; taskId: string; sourceRunId: string; chapterId: string; orderIndex: number; chapterTitle: string; originalScopeHash: string; effectiveScopeHash: string }

/** Legacy question repair only. Unrecognized questions remain unanswered;
 * this is never used to recognize a new user's task or select its workflow. */
function targetQuestionOnly(question: string, options: unknown, prompt: string | null, target: BoundRevisionCorrection) {
  if (!/(?:哪.{0,3}章|目标章节|章节.{0,4}范围|是指|是要)/u.test(question) || !Array.isArray(options)) return false
  const ordinals = [...question.matchAll(/第\s*(\d+|[零〇一二两三四五六七八九十百千]+)\s*章/gu)]
  if (ordinals.some(match => chapterNumber(match[1]) !== target.orderIndex)
    || !ordinals.length && !/(?:当前章节|当前章|正在编辑的?章|本章)/u.test(question)) return false
  const scopeWords = /(?:这次|本次|你说的|您说的|你这次|请问|请|确认|明确|选择|指定|目标|章节|范围|当前|正在编辑|整章|全章|全部|重新写|重写|改写|修改|修订|润色|保存|写入|正文|是指|是要|是否|是不是|需要|想要|的|是|要|把|将|吗|么|呢|只|仅|第|章|前|后|一起|连|也|和|与|及|到|至|一|二|三|四|五|六|七|八|九|十|两|百|千|\d|[\s，,。？！?!:：、（）()—–-])/gu
  const remaining = (text: string, allowOriginalQuote: boolean) => {
    const chars = text.split('')
    for (const quote of lexAuthorWritingRequest(text).quoted) {
      const quoted = text.slice(quote.contentStart, quote.contentEnd)
      if (!quote.closed || !(quote.kind === 'title' && quoted === target.chapterTitle
        || allowOriginalQuote && quote.kind !== 'title' && prompt?.includes(quoted))) continue
      for (let index = quote.start; index < quote.end; index++) chars[index] = ' '
    }
    return chars.join('').replace(scopeWords, '')
  }
  if (remaining(question, true)) return false
  return options.every(option => {
    if (!option || typeof option !== 'object') return false
    const { label, detail } = option as { label?: unknown; detail?: unknown }
    if (typeof label !== 'string' || detail !== undefined && typeof detail !== 'string') return false
    const text = [label, detail ?? ''].join(' ').trim()
    return /^(?:是的?[，,、\s]*(?:按此继续)?|我(?:有|再)?补充|补充说明)[。！!\s]*$/u.test(text) || !remaining(text, false)
  })
}

/** Repair the old action binder's loss of an already admitted chapter identity.
 * This derives a read view; it never changes the immutable request/root or
 * obtains an object from model parameters, current UI state or later history. */
export async function projectBoundRevisionTarget(tx: Prisma.TransactionClient, subject: Subject, original: Original, spec: TaskSpec,
  source: { chapterId: string | null; sessionId: string }) {
  const actions = spec.scope.writingActions, interpretation = spec.scope.writingInterpretation
  if (original.parentRunId || spec.intent !== 'revise' || !spec.scope.authorEffects?.manuscript
    || spec.scope.writingTargetProtocol !== 2 || spec.scope.writing?.kind !== 'needs_input' || spec.scope.writing.targets.length
    || !source.chapterId || spec.scope.chapterIds?.length !== 1 || spec.scope.chapterIds[0] !== source.chapterId
    || spec.scope.selection || spec.scope.selectionBoundary || spec.scope.localEditBoundary || spec.authorization
    || ['proposal_only', 'conversation_only'].includes(spec.writingPacing ?? '') || !original.prompt || !actions?.operations.length
    || !interpretation || interpretation.revisionDenied || interpretation.excludedChapterIds.includes(source.chapterId) || !interpretation.reasons.length
    || interpretation.reasons.some(reason => reason !== 'TARGET_UNRESOLVED')
    || !actions.operations.some(operation => operation.kind === 'revise')
    || actions.operations.some(operation => operation.resolution !== 'needs_input' || operation.targets.length
      || operation.kind !== 'revise' && !/^(?:写入|保存|落盘)$/u.test(original.prompt!.slice(operation.start, operation.end)))) return null
  assertFrozenWritingContract(spec)
  // Parsing is only a veto here: accepted original actions above are the
  // authority. No new action or ordinal can be inferred for an old request.
  const parsed = parseAuthorWritingRequest(original.prompt)
  if (parsed.ambiguous || parsed.range || parsed.exclusions.length
    || parsed.evidence.targets.some(target => target.range || !['prose', 'same_target'].includes(target.kind))
    || /(?:上(?:一)?章|前(?:一)?章|那(?:一)?章|此前|之前|上一轮|previous\s+chapter)/iu.test(original.prompt)) return null
  const human = await ownedAuthorAdmission(tx, subject, original.sourceRunId, source.sessionId)
  if (!human || human.creativePrompt !== original.prompt || human.run.chapterId !== source.chapterId
    || readHumanAdmission(human.run.startRequest)?.request.chapterId !== source.chapterId) return null
  const chapter = await tx.chapter.findFirst({ where: { id: source.chapterId, authorId: subject.userId, ...activeChapterScope(subject.novelId) },
    select: { id: true, orderIndex: true, title: true } })
  if (!chapter) return null
  const target = { chapterId: chapter.id, orderIndex: chapter.orderIndex }
  const writing = { ...spec.scope.writing, kind: 'bounded' as const, targets: [target], repairAuthorized: true }
  const projection: TaskSpec = { ...spec, scope: { ...spec.scope, writing,
    writingActions: { ...actions, operations: actions.operations.map(operation => ({ ...operation, resolution: 'bound', targets: [target] })) },
    writingInterpretation: { ...interpretation } } }
  projection.scope.writingInterpretation!.scopeHash = frozenWritingScopeHash(projection.scope)
  assertFrozenWritingContract(projection)
  return { spec: projection, writing, correction: { version: 1 as const, taskId: original.taskId, sourceRunId: original.sourceRunId,
    chapterId: chapter.id, orderIndex: chapter.orderIndex, chapterTitle: chapter.title, originalScopeHash: frozenWritingScopeHash(spec.scope), effectiveScopeHash: frozenWritingScopeHash(projection.scope) } }
}

/** Only an obsolete target-resolution question is released. A user preference,
 * approval or genuinely missing target still requires its real answer. */
export async function boundRevisionCorrectionResolvesInput(tx: Prisma.TransactionClient, subject: Subject,
  scope: Original & { writing?: TaskSpec['scope']['writing']; targetCorrection?: BoundRevisionCorrection | null }, marker: { kind?: string; callId: string }) {
  const correction = scope.targetCorrection
  if (marker.kind !== 'writing_scope' || !correction || correction.taskId !== scope.taskId || scope.writing?.kind !== 'bounded') return false
  const runIds = await originalTaskRunIds(tx, subject, scope)
  const question = await tx.agentRunEvent.findFirst({ where: { runId: { in: runIds }, type: 'tool.call',
    payload: { path: ['callId'], equals: marker.callId } }, orderBy: { createdAt: 'desc' }, select: { runId: true, seq: true, payload: true } })
  const payload = question?.payload as { toolName?: string; args?: { question?: unknown; options?: unknown } } | null
  if (!question || payload?.toolName !== 'ask_user' || typeof payload.args?.question !== 'string'
    || !targetQuestionOnly(payload.args.question, payload.args.options, scope.prompt, correction)) return false
  const failure = await tx.agentRunEvent.findFirst({ where: { runId: question.runId, seq: { lt: question.seq }, type: 'tool.result',
    payload: { path: ['failureCode'], equals: 'SCOPE_NEEDS_INPUT' } }, orderBy: { seq: 'desc' }, select: { payload: true } })
  const failed = failure?.payload as { toolName?: string } | null
  return failed?.toolName === 'story_compiler_prepare'
}
