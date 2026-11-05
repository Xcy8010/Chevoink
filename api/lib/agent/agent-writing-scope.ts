import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { agentWritingScopeInputSchema, type AgentWritingScopeInput } from '../../../shared/contracts/agent-writing-scope.js'
import { taskSpecSchema, type TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { activeChapterScope } from '../data/internal.js'
import { DataAccessError } from '../prisma.js'
import { runtimeJson } from './runtime-common.js'
import { ownedAuthorAdmission } from './writing-request-context.js'
import { readOriginalTaskRequest } from './original-request.js'
import type { ToolContext } from './tools/types.js'

type Subject = { userId: string; novelId: string; runId: string }
type Original = Awaited<ReturnType<typeof readOriginalTaskRequest>>
const receiptSchema = z.object({ version: z.literal(1), agentWritingScopeBinding: z.literal(true), taskId: z.string(), userId: z.string(), novelId: z.string(),
  sourceRunId: z.string(), originHash: z.string(), requestHash: z.string(), input: agentWritingScopeInputSchema,
  projection: taskSpecSchema, contentHash: z.string() }).strict()

/** Only the new client protocol opts in. Old tasks never acquire this policy on resume. */
export function enableAgentWritingScope(spec: TaskSpec): TaskSpec {
  const scope = { ...spec.scope, agentWritingProtocol: 1 as const }
  delete scope.writing; delete scope.writingActions; delete scope.writingInterpretation; delete scope.writingTargetProtocol
  delete scope.writingClarificationProtocol; delete scope.localEditBoundary; delete scope.writingCoordinationProtocol
  return { ...spec, scope, writingPacing: undefined, ambiguity: 'safe_to_assume',
    postconditions: spec.postconditions.filter(item => !['EARLIER_CONTENT_UNCHANGED', 'CHANGESET_VERIFIED'].includes(item.code)),
    expectedOutputs: [{ kind: 'text', required: true, description: '理解并完成完整作者请求；作用于正文前由主Agent确定意图与真实目标，普通讨论直接答复。' }] }
}

/** Receipt reader, not a second natural-language interpretation. */
export async function readAgentWritingScope(tx: Prisma.TransactionClient, subject: Subject, original: Original, spec: TaskSpec) {
  if (spec.scope.agentWritingProtocol !== 1) return null
  const rows = await tx.agentArtifact.findMany({ where: { runId: original.sourceRunId, artifactType: 'continuityReview',
    metadata: { path: ['agentWritingScopeBinding'], equals: true }, run: { userId: subject.userId, novelId: subject.novelId } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 2 })
  if (!rows.length) return null
  const parsed = receiptSchema.safeParse(rows[0].metadata)
  if (rows.length !== 1 || !parsed.success) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '正文任务解释记录损坏。')
  const { contentHash, ...payload } = parsed.data
  if (runtimeJson(payload).hash !== contentHash || payload.taskId !== original.taskId || payload.userId !== subject.userId
    || payload.novelId !== subject.novelId || payload.sourceRunId !== original.sourceRunId
    || payload.originHash !== runtimeJson({ prompt: original.prompt, spec: original.spec }).hash
    || payload.requestHash !== createHash('sha256').update(original.prompt ?? '').digest('hex')
    || payload.projection.id !== spec.id || payload.projection.scope.novelId !== subject.novelId) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '正文任务解释与原作者请求不一致。')
  }
  return { input: payload.input, spec: { ...payload.projection, scope: { ...payload.projection.scope,
    agentWritingBinding: { sourceRunId: original.sourceRunId, receiptHash: contentHash, requiredChecks: payload.input.requiredChecks } } } as TaskSpec }
}

/** The existing main model supplies the interpretation. No classifier call,
 * guessed keyword authority, paid probe or manuscript mutation occurs here. */
export async function bindAgentWritingScope(tx: Prisma.TransactionClient, ctx: ToolContext, input: AgentWritingScopeInput) {
  const original = await readOriginalTaskRequest(tx, ctx), spec = taskSpecSchema.parse(original.spec)
  if (ctx.mode !== 'build' || ctx.inlineChild || original.parentRunId || spec.scope.agentWritingProtocol !== 1)
    throw new DataAccessError(409, 'TASK_SCOPE_BIND_UNAVAILABLE', '该历史或只读任务保留原合同，不能重新分配正文权限。')
  const { lockWritingRunLineage } = await import('./writing-scope.js')
  await lockWritingRunLineage(tx, ctx)
  await ctx.assertCurrentExecution?.(tx)
  const run = await tx.agentRun.findFirst({ where: { id: ctx.runId, userId: ctx.userId, novelId: ctx.novelId,
    status: { in: ['queued', 'running'] } }, include: { session: true } })
  if (!run || run.session.sandboxMode === 'read_only') throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '当前任务不可分配正文写入。')
  const human = await ownedAuthorAdmission(tx, ctx, original.sourceRunId, run.sessionId)
  if (!human || human.prompt !== original.prompt) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '未找到本任务真实作者请求。')
  const previous = await readAgentWritingScope(tx, ctx, original, spec)
  if (previous) {
    if (runtimeJson(previous.input).hash !== runtimeJson(input).hash) throw new DataAccessError(409, 'TASK_SCOPE_BIND_CONFLICT', '本任务已经锁定另一组正文目标，不能扩大或替换；复用原绑定执行。')
    return { ...input, targets: previous.spec.scope.writing!.targets }
  }
  const chapters = await tx.chapter.findMany({ where: { authorId: ctx.userId, ...activeChapterScope(ctx.novelId) },
    select: { id: true, orderIndex: true, revision: true, content: true }, orderBy: { orderIndex: 'asc' } })
  const targets: NonNullable<TaskSpec['scope']['writing']>['targets'] = [], regions = []
  const maxOrder = chapters.at(-1)?.orderIndex ?? 0
  for (const [index, requested] of input.targets.entries()) {
    const chapter = chapters.find(item => requested.chapterId ? item.id === requested.chapterId : item.orderIndex === requested.orderIndex)
    if (requested.chapterId && !chapter || chapter && requested.orderIndex !== undefined && chapter.orderIndex !== requested.orderIndex
      || !chapter && (input.intent !== 'write' || requested.orderIndex !== maxOrder + targets.filter(item => item.chapterId === null).length + 1)
      || chapter && ctx.protectedChapterIds?.has(chapter.id) && input.intent !== 'review')
      throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '目标不属于当前作品、位置冲突或属于保护章节。请核对真实目录。')
    const target = { chapterId: chapter?.id ?? null, orderIndex: chapter?.orderIndex ?? requested.orderIndex! }
    if (targets.some(item => item.orderIndex === target.orderIndex || item.chapterId && item.chapterId === target.chapterId))
      throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '正文目标不能重复。')
    const selection = spec.scope.selectionBoundary
    if (selection && (input.intent !== 'revise' || input.targets.length !== 1 || target.chapterId !== selection.chapterId))
      throw new DataAccessError(409, 'AUTHOR_SELECTION_SCOPE', '本次真实选区只允许修改原章节选区。')
    if (selection && requested.preserveText.length) throw new DataAccessError(409, 'AUTHOR_SELECTION_SCOPE', '真实选区边界已保留选区外原文；选区内需保留的文字请在精确补丁中避开，不另设整章语义边界。')
    targets.push(target)
    if (input.locality === 'local' && input.intent !== 'review' && !selection) {
      if (!chapter || input.intent !== 'revise' || !chapter.content.trim()) throw new DataAccessError(409, 'AUTHOR_LOCAL_SCOPE', '语义局部修改需要已有正文。')
      const preserve = input.targets[index].preserveText
      if (preserve.some(text => !chapter.content.includes(text) || chapter.content.indexOf(text) !== chapter.content.lastIndexOf(text)))
        throw new DataAccessError(409, 'CHAPTER_ANCHOR_CONFLICT', '明确保留文字未在原文唯一定位，请先读取核对。')
      regions.push({ chapterId: chapter.id, revision: chapter.revision, contentHash: runtimeJson({ content: chapter.content }).hash,
        start: 0, end: chapter.content.length, prefix: '', suffix: '', protectedText: preserve })
    }
  }
  const requestHash = createHash('sha256').update(original.prompt!).digest('hex')
  const projection = JSON.parse(JSON.stringify(taskSpecSchema.parse({ ...spec, intent: input.intent, writingPacing: input.intent === 'review' ? undefined : 'explicit_writing',
    scope: { ...spec.scope, authorEffects: { version: 1, requestHash, manuscript: input.intent !== 'review',
      structure: spec.scope.authorEffects?.structure ?? false, artifact: spec.scope.authorEffects?.artifact ?? false },
      writing: { version: 1, kind: 'bounded', targets, repairAuthorized: input.intent === 'revise', titleAndBodyOnly: false },
      ...(regions.length ? { localEditBoundary: { version: 4, kind: 'semantic', regions } } : {}),
    } }))) as TaskSpec
  const payload = { version: 1 as const, agentWritingScopeBinding: true as const, taskId: original.taskId, userId: ctx.userId, novelId: ctx.novelId,
    sourceRunId: original.sourceRunId, originHash: runtimeJson({ prompt: original.prompt, spec: original.spec }).hash, requestHash, input, projection }
  await tx.agentArtifact.create({ data: { runId: original.sourceRunId, artifactType: 'continuityReview', title: 'Agent正文任务解释',
    content: '主Agent根据真实作者请求确定正文意图和目标；系统校验对象与执行边界，原始合同保持不变。', metadata: runtimeJson({ ...payload, contentHash: runtimeJson(payload).hash }).value } })
  return { ...input, targets }
}
