import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { isExplicitNovelMetadataRequest, isNovelDirectionSetup } from './task-spec.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { runtimeJson } from './runtime-common.js'
import type { ToolContext } from './tools/types.js'

const initializationQuestion = (question: string) => /初始化|创建.{0,8}作品|建立.{0,8}作品|书名.{0,30}简介.{0,30}标签/u.test(question)
const declined = (answer: string) => /(?:不要|不用|不需要|无需|暂不|先别|禁止|不必).{0,8}(?:初始化|创建作品|建书)|只讨论|先讨论|都不满意|都不合适|没有满意/u.test(answer)

export async function assertNovelInitializationDirection(db: Prisma.TransactionClient, ctx: ToolContext) {
  const original = await readOriginalTaskRequest(db, ctx)
  assertFreshPlanSetup(ctx, original.spec)
  if (!original.prompt) throw new DataAccessError(409, 'NOVEL_SETUP_AUTHORITY_REQUIRED', '当前作品初始化缺少可核实的原作者请求。')
  if (!isNovelDirectionSetup(original.prompt) || isExplicitNovelMetadataRequest(original.prompt)) {
    const choice = await readDirectionChoice(db, ctx, original)
    if (choice && declined(choice.answer)) throw new DataAccessError(409, 'NOVEL_DIRECTION_REQUIRED', '作者已选择暂不初始化，未保存作品信息。')
    return
  }
  return assertDirectionChoice(db, ctx, original)
}

async function readDirectionChoice(db: Prisma.TransactionClient, ctx: ToolContext, original: Awaited<ReturnType<typeof readOriginalTaskRequest>>) {
  const choices: Array<{ question: string; answer: string }> = [...(ctx.authorQuestionAnswers?.values() ?? [])].filter(choice => choice.userId === ctx.userId && choice.novelId === ctx.novelId && choice.runId === ctx.runId)
  if (!choices.length) {
    const runIds = await originalTaskRunIds(db, ctx, original)
    const [messages, receipts] = await Promise.all([
      db.agentMessage.findMany({ where: { runId: { in: runIds }, role: 'assistant', run: { userId: ctx.userId, novelId: ctx.novelId } },
        orderBy: { createdAt: 'asc' }, select: { parts: true } }),
      db.agentEffectReceipt.findMany({ where: { operation: { kind: 'tool', action: 'ask_user', status: 'succeeded',
        originRunId: { in: runIds }, taskRoot: { userId: ctx.userId, novelId: ctx.novelId } } },
        orderBy: { createdAt: 'asc' }, select: { result: true, resultHash: true } }),
    ])
    const observe = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      const display = value as { kind?: string; question?: string; answer?: string; options?: Array<{ label: string; detail?: string }> }
      if (display.kind === 'question' && typeof display.question === 'string' && typeof display.answer === 'string') {
        choices.push({ question: display.question + '\n' + (display.options ?? []).map(option => option.label + ' ' + (option.detail ?? '')).join('\n'), answer: display.answer })
      }
    }
    // Only server-recorded successful calls carry an actual question answer;
    // assistant text and another task's messages cannot authorize setup.
    for (const message of messages) for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (part && typeof part === 'object' && !Array.isArray(part) && part.type === 'tool-call'
        && part.toolName === 'ask_user' && part.status === 'success') observe(part.display)
    }
    for (const receipt of receipts) {
      if (runtimeJson(receipt.result).hash !== receipt.resultHash) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '作者提问回执无法核实，未初始化作品。')
      const result = (receipt.result && typeof receipt.result === 'object' && !Array.isArray(receipt.result) ? receipt.result : {}) as { toolResult?: { display?: unknown } }
      observe(result.toolResult?.display)
    }
  }
  return choices.filter(choice => (initializationQuestion(choice.question) || declined(choice.answer)) && choice.answer.trim()).at(-1)
}

async function assertDirectionChoice(db: Prisma.TransactionClient, ctx: ToolContext, original: Awaited<ReturnType<typeof readOriginalTaskRequest>>) {
  const latest = await readDirectionChoice(db, ctx, original)
  if (!latest || declined(latest.answer)) {
    throw new DataAccessError(409, 'NOVEL_DIRECTION_REQUIRED', '先向作者提供故事方向，并说明回答后会完善当前空作品的书名、简介与标签；收到实际回答后再初始化，未回答不代选。')
  }
}

/** Current saved fields plus this task's real successful writes; model prose is never proof. */
export async function readNovelInitializationCompletion(db: Prisma.TransactionClient,
  ctx: Pick<ToolContext, 'userId' | 'novelId' | 'runId'>): Promise<{ status: 'complete' | 'declined' | 'incomplete'; missing: string[] }> {
  const original = await readOriginalTaskRequest(db, ctx), runIds = await originalTaskRunIds(db, ctx, original)
  const [novel, messages, receipts] = await Promise.all([
    db.novel.findFirst({ where: { id: ctx.novelId, authorId: ctx.userId }, select: { title: true, displayTitle: true, summary: true, tagNames: true } }),
    db.agentMessage.findMany({ where: { runId: { in: runIds }, role: 'assistant' }, orderBy: { createdAt: 'asc' }, select: { parts: true } }),
    db.agentEffectReceipt.findMany({ where: { operation: { originRunId: { in: runIds }, kind: 'tool', status: 'succeeded',
      taskRoot: { userId: ctx.userId, novelId: ctx.novelId }, action: { in: ['novel_create', 'novel_update_meta', 'novel_rename', 'ask_user'] } } },
      orderBy: { createdAt: 'asc' }, include: { operation: true } }),
  ])
  const writes: Record<string, unknown> = {}, answers: string[] = []
  const observe = (name: string, args: unknown, display: unknown) => {
    if (name === 'ask_user' && display && typeof display === 'object') {
      const question = display as { question?: string; options?: Array<{ label: string; detail?: string }>; answer?: string }
      if (question.answer && (declined(question.answer) || initializationQuestion((question.question ?? '') + (question.options ?? []).map(option => option.label + (option.detail ?? '')).join('\n')))) answers.push(question.answer)
    }
    if (!['novel_create', 'novel_update_meta', 'novel_rename'].includes(name) || !args || typeof args !== 'object') return
    const fields = args as Record<string, unknown>
    for (const field of ['title', 'summary', 'tags']) if (fields[field] !== undefined) writes[field] = fields[field]
  }
  for (const message of messages) for (const part of Array.isArray(message.parts) ? message.parts : []) {
    if (part && typeof part === 'object' && !Array.isArray(part) && part.type === 'tool-call' && part.status === 'success') observe(String(part.toolName), part.args, part.display)
  }
  for (const receipt of receipts) {
    if (runtimeJson(receipt.result).hash !== receipt.resultHash || runtimeJson(receipt.operation.inputSnapshot).hash !== receipt.operation.inputHash) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '作品初始化写入回执无法核实。')
    const input = receipt.operation.inputSnapshot as { input?: { args?: unknown } } | null, result = receipt.result as { toolResult?: { display?: unknown; outcome?: string } } | null
    if (result?.toolResult?.outcome !== 'failed') observe(receipt.operation.action, input?.input?.args, result?.toolResult?.display)
  }
  if (answers.length && declined(answers.at(-1)!)) return { status: 'declined', missing: [] }
  const missing = [
    !novel?.displayTitle?.trim() || typeof writes.title !== 'string' || writes.title.trim() !== novel.title ? '书名' : '',
    !novel?.summary.trim() || typeof writes.summary !== 'string' || writes.summary.trim() !== novel.summary ? '简介' : '',
    !novel?.tagNames.length || !Array.isArray(writes.tags) || JSON.stringify([...new Set(writes.tags.map(String).map(tag => tag.trim()))]) !== JSON.stringify(novel.tagNames) ? '标签' : '',
  ].filter(Boolean)
  return { status: missing.length ? 'incomplete' : 'complete', missing }
}

export async function assertNovelMetadataIntent(db: Prisma.TransactionClient, ctx: ToolContext,
  novel: { chapterCount: number; wordCount: number; summary: string; tagNames: string[] }) {
  const original = await readOriginalTaskRequest(db, ctx)
  assertFreshPlanSetup(ctx, original.spec)
  const parsed = taskSpecSchema.safeParse(original.spec)
  // Historical build tasks keep their frozen tool grant and observed metadata
  // CAS. Fresh initialization semantics never retrofit those contracts.
  // The plan-mode guard above still denies their newly introduced write entry.
  if (parsed.success && parsed.data.scope.novelInitializationProtocol !== 1) return false
  const complete = parsed.data?.postconditions.some(condition => condition.code === 'NOVEL_METADATA_INITIALIZED') === true
  if (original.prompt && isExplicitNovelMetadataRequest(original.prompt)) {
    const choice = await readDirectionChoice(db, ctx, original)
    if (choice && declined(choice.answer)) throw new DataAccessError(409, 'NOVEL_DIRECTION_REQUIRED', '作者已选择暂不初始化，未覆盖作品信息。')
    return complete
  }
  if (original.prompt && isNovelDirectionSetup(original.prompt) && novel.chapterCount === 0 && novel.wordCount === 0
    && !novel.summary.trim() && novel.tagNames.length === 0) {
    await assertDirectionChoice(db, ctx, original)
    return complete
  }
  throw new DataAccessError(409, 'NOVEL_SETUP_AUTHORITY_REQUIRED', '修改已有内容或已设置元信息的作品，需要作者明确的修改意图；方向选择不等于覆盖现有作品。')
}

function assertFreshPlanSetup(ctx: ToolContext, spec: unknown) {
  if (ctx.mode === 'plan' && taskSpecSchema.safeParse(spec).data?.scope.novelInitializationProtocol !== 1) {
    throw new DataAccessError(409, 'NOVEL_SETUP_AUTHORITY_REQUIRED', '原规划任务未授权新增作品信息写入，未保存作品。')
  }
}
