import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { isExplicitNovelMetadataRequest, isNovelDirectionSetup, requiresManuscriptDelivery } from './task-spec.js'
import { taskSpecSchema, type TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { BOOTSTRAP_NOVEL_SUMMARY } from '../../../shared/contracts/novel-publish.js'
import { runtimeJson } from './runtime-common.js'
import type { ToolContext } from './tools/types.js'

const declined = (answer: string) => /(?:不要|不用|不需要|无需|暂不|先别|禁止|不必).{0,8}(?:初始化|创建作品|建书)|只讨论|先讨论|都不满意|都不合适|没有满意/u.test(answer)
const metadataWrites = ['novel_create', 'novel_update_meta', 'novel_rename']

type NovelMetadata = { chapterCount: number; wordCount: number; title?: string; displayTitle?: string | null; summary: string; tagNames: string[] }
type DirectionChoice = { question: string; answer: string; purpose?: unknown }
type Subject = Pick<ToolContext, 'userId' | 'novelId' | 'runId'>
type Original = Awaited<ReturnType<typeof readOriginalTaskRequest>>
type SetupObservation = { name: string; args: unknown; display: unknown; snapshot: unknown }

export function isEmptyNovelMetadata(novel: NovelMetadata): boolean {
  return novel.chapterCount === 0 && novel.wordCount === 0 && novel.tagNames.length === 0
    && (!novel.summary.trim() || !novel.displayTitle?.trim() && novel.summary === BOOTSTRAP_NOVEL_SUMMARY)
}

export function hasNovelDirectionDelivery(spec: TaskSpec): boolean {
  return spec.postconditions.some(condition => condition.code === 'NOVEL_METADATA_INITIALIZED')
    && isNovelDirectionSetup(spec.goals.join('\n')) && !requiresManuscriptDelivery(spec)
}

export function novelSetupNotice(title: string): string {
  return `已保存《${title}》的书名、简介和标签。要不要开始写大纲？`
}

function latestDirectionChoice(choices: DirectionChoice[], structured: boolean) {
  return choices.filter(choice => choice.answer.trim() && (choice.purpose === 'novel_direction'
    // Frozen version-one tasks can still use their already accepted answers.
    || !structured && (/初始化|创建.{0,8}作品|建立.{0,8}作品|书名.{0,30}简介.{0,30}标签/u.test(choice.question) || declined(choice.answer)))).at(-1)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function observedChoice(display: unknown, args: unknown): DirectionChoice[] {
  const question = display as { kind?: string; question?: string; options?: Array<{ label: string; detail?: string }>; answer?: string } | null
  if (question?.kind !== 'question' || typeof question.answer !== 'string' || typeof question.question !== 'string') return []
  return [{ answer: question.answer, purpose: asRecord(args)?.purpose,
    question: question.question + '\n' + (question.options ?? []).map(option => option.label + ' ' + (option.detail ?? '')).join('\n') }]
}

async function readSetupObservations(db: Prisma.TransactionClient, ctx: Subject, original: Original, actions: string[]) {
  const runIds = await originalTaskRunIds(db, ctx, original)
  const [messages, receipts] = await Promise.all([
    db.agentMessage.findMany({ where: { runId: { in: runIds }, role: 'assistant', run: { userId: ctx.userId, novelId: ctx.novelId } },
      orderBy: { createdAt: 'asc' }, select: { parts: true } }),
    db.agentEffectReceipt.findMany({ where: { operation: { originRunId: { in: runIds }, kind: 'tool', status: 'succeeded',
      taskRoot: { userId: ctx.userId, novelId: ctx.novelId }, action: { in: actions } } },
      orderBy: { createdAt: 'asc' }, include: { operation: true } }),
  ])
  const observations: SetupObservation[] = []
  for (const message of messages) for (const raw of Array.isArray(message.parts) ? message.parts : []) {
    const part = asRecord(raw)
    if (part?.type === 'tool-call' && part.status === 'success' && typeof part.toolName === 'string' && actions.includes(part.toolName)) {
      observations.push({ name: part.toolName, args: part.args, display: part.display, snapshot: part.snapshot })
    }
  }
  for (const receipt of receipts) {
    if (runtimeJson(receipt.result).hash !== receipt.resultHash || runtimeJson(receipt.operation.inputSnapshot).hash !== receipt.operation.inputHash) {
      throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '作品初始化回执无法核实。')
    }
    const input = asRecord(asRecord(receipt.operation.inputSnapshot)?.input)
    const result = asRecord(asRecord(receipt.result)?.toolResult)
    if (result && result.outcome !== 'failed') {
      observations.push({ name: receipt.operation.action, args: input?.args, display: result.display, snapshot: result.snapshot })
    }
  }
  return observations
}

async function readDirectionChoice(db: Prisma.TransactionClient, ctx: ToolContext, original: Original) {
  const structured = taskSpecSchema.safeParse(original.spec).data?.scope.novelInitializationProtocol === 2
  const current = latestDirectionChoice([...(ctx.authorQuestionAnswers?.values() ?? [])]
    .filter(choice => choice.userId === ctx.userId && choice.novelId === ctx.novelId && choice.runId === ctx.runId), structured)
  if (current) return current
  const observations = await readSetupObservations(db, ctx, original, ['ask_user'])
  return latestDirectionChoice(observations.flatMap(observation => observedChoice(observation.display, observation.args)), structured)
}

async function assertDirectionChoice(db: Prisma.TransactionClient, ctx: ToolContext, original: Original) {
  const latest = await readDirectionChoice(db, ctx, original)
  if (!latest || declined(latest.answer)) {
    throw new DataAccessError(409, 'NOVEL_DIRECTION_REQUIRED', '先向作者提供故事方向，并说明回答后会完善当前空作品的书名、简介与标签；收到实际回答后再初始化，未回答不代选。')
  }
}

export async function assertNovelInitializationDirection(db: Prisma.TransactionClient, ctx: ToolContext) {
  const original = await readOriginalTaskRequest(db, ctx)
  assertFreshPlanSetup(ctx, original.spec)
  if (!original.prompt) throw new DataAccessError(409, 'NOVEL_SETUP_AUTHORITY_REQUIRED', '当前作品初始化缺少可核实的原作者请求。')
  if (isNovelDirectionSetup(original.prompt)) return assertDirectionChoice(db, ctx, original)
  const choice = await readDirectionChoice(db, ctx, original)
  if (choice && declined(choice.answer)) throw new DataAccessError(409, 'NOVEL_DIRECTION_REQUIRED', '作者已选择暂不初始化，未保存作品信息。')
}

/** Current saved fields plus this task's real successful writes. */
export async function readNovelInitializationCompletion(db: Prisma.TransactionClient, ctx: Subject): Promise<
  { status: 'complete'; title: string; missing: [] } | { status: 'declined' | 'incomplete'; missing: string[] }> {
  const original = await readOriginalTaskRequest(db, ctx)
  const [novel, observations] = await Promise.all([
    db.novel.findFirst({ where: { id: ctx.novelId, authorId: ctx.userId }, select: { title: true, displayTitle: true, summary: true, tagNames: true } }),
    readSetupObservations(db, ctx, original, [...metadataWrites, 'ask_user']),
  ])
  const choices = observations.filter(observation => observation.name === 'ask_user')
    .flatMap(observation => observedChoice(observation.display, observation.args))
  const choice = latestDirectionChoice(choices, taskSpecSchema.safeParse(original.spec).data?.scope.novelInitializationProtocol === 2)
  if (choice && declined(choice.answer)) return { status: 'declined', missing: [] }
  const writes: Record<string, unknown> = {}
  for (const observation of observations) {
    if (!metadataWrites.includes(observation.name)) continue
    const fields = asRecord(observation.args)
    if (!fields) continue
    for (const field of ['title', 'summary', 'tags']) if (fields[field] !== undefined) writes[field] = fields[field]
  }
  const missing = [
    !novel?.displayTitle?.trim() || typeof writes.title !== 'string' || writes.title.trim() !== novel.title ? '书名' : '',
    !novel?.summary.trim() || typeof writes.summary !== 'string' || writes.summary.trim() !== novel.summary ? '简介' : '',
    !novel?.tagNames.length || !Array.isArray(writes.tags) || JSON.stringify([...new Set(writes.tags.map(String).map(tag => tag.trim()))]) !== JSON.stringify(novel.tagNames) ? '标签' : '',
  ].filter(Boolean)
  return !novel || missing.length ? { status: 'incomplete', missing } : { status: 'complete', title: novel.title, missing: [] }
}

async function hasSameTaskPlaceholderRename(db: Prisma.TransactionClient, ctx: ToolContext, original: Original, novel: NovelMetadata) {
  if (!novel.displayTitle?.trim() || novel.summary !== BOOTSTRAP_NOVEL_SUMMARY || !isEmptyNovelMetadata({ ...novel, displayTitle: null })) return false
  const renames = await readSetupObservations(db, ctx, original, ['novel_rename'])
  return [...renames, ...(ctx.legacyBatchRenames ?? [])].some(observation => {
    const snapshot = asRecord(observation.snapshot)
    const title = asRecord(observation.args)?.title
    return typeof title === 'string' && title.trim() === novel.title && novel.title === novel.displayTitle && snapshot?.target === 'novel'
      && snapshot.targetId === ctx.novelId && snapshot.field === 'title'
      && (snapshot.previousValue === '未命名作品' || snapshot.previousValue === '我的第一部作品')
  })
}

export async function assertNovelMetadataIntent(db: Prisma.TransactionClient, ctx: ToolContext, novel: NovelMetadata) {
  const original = await readOriginalTaskRequest(db, ctx)
  assertFreshPlanSetup(ctx, original.spec)
  const spec = taskSpecSchema.safeParse(original.spec).data
  // Historical build tasks keep their frozen tool grant and observed metadata
  // CAS. Fresh initialization semantics never retrofit those contracts.
  if (spec && !spec.scope.novelInitializationProtocol) return { completeInitialization: false }
  const completeInitialization = spec?.postconditions.some(condition => condition.code === 'NOVEL_METADATA_INITIALIZED') === true
  if (original.prompt && isExplicitNovelMetadataRequest(original.prompt)) {
    const choice = await readDirectionChoice(db, ctx, original)
    if (choice && declined(choice.answer)) throw new DataAccessError(409, 'NOVEL_DIRECTION_REQUIRED', '作者已选择暂不初始化，未覆盖作品信息。')
    return { completeInitialization }
  }
  if (original.prompt && isNovelDirectionSetup(original.prompt) && spec?.scope.novelInitializationTarget !== 'existing') {
    const empty = isEmptyNovelMetadata(novel)
    const titleAlreadySaved = !empty && spec?.scope.novelInitializationTarget === 'empty' && await hasSameTaskPlaceholderRename(db, ctx, original, novel)
    if (empty || titleAlreadySaved) {
      await assertDirectionChoice(db, ctx, original)
      // The durable reducer requires all three fields in the current operation.
      return { completeInitialization, canOmitTitle: titleAlreadySaved && ctx.legacyBatchRenames !== undefined }
    }
  }
  throw new DataAccessError(409, 'NOVEL_SETUP_AUTHORITY_REQUIRED', '修改已有内容或已设置元信息的作品，需要作者明确的修改意图；方向选择不等于覆盖现有作品。')
}

function assertFreshPlanSetup(ctx: ToolContext, spec: unknown) {
  if (ctx.mode === 'plan' && !taskSpecSchema.safeParse(spec).data?.scope.novelInitializationProtocol) {
    throw new DataAccessError(409, 'NOVEL_SETUP_AUTHORITY_REQUIRED', '原规划任务未授权新增作品信息写入，未保存作品。')
  }
}
