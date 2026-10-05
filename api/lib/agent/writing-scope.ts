import { z } from 'zod'
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

type Subject = { userId: string; novelId: string; runId: string }
type Writing = NonNullable<TaskSpec['scope']['writing']>
const numeric = '[一二两三四五六七八九十百千0-9]+'
export function chapterNumber(text: string): number | null {
  if (/^\d+$/u.test(text)) return Number(text) || null
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  let sum = 0, pending = 0
  for (const char of text) {
    if (digits[char]) pending = digits[char]
    else if (char === '十' || char === '百' || char === '千') { sum += (pending || 1) * ({ 十: 10, 百: 100, 千: 1000 }[char]); pending = 0 }
    else return null
  }
  return sum + pending || null
}

/** Pure extraction uses the whole admission request; generated goals are not authority. */
export function requestedWritingRange(prompt: string): { kind: 'first' | 'next' | 'range' | 'count' | 'unbounded'; start?: number; count?: number; volume?: number; anchor?: 'editor' } | null {
  const positive = prompt.split(/[。！？!?；;\n，,]+/u).filter(clause => !/(?:不要|无需|不用|不必|禁止|不得|不能|不写|do not|don't)/iu.test(clause)).join('，')
  const range = positive.match(new RegExp(`第?(${numeric})(?:章)?(?:至|到|[-–~～])第?(${numeric})章`, 'u'))
  if (range) { const start = chapterNumber(range[1]), end = chapterNumber(range[2]); if (start && end && end >= start && end - start < 1000) return { kind: 'range', start, count: end - start + 1 } }
  const volume = positive.match(new RegExp(`第(${numeric})卷.{0,4}第(${numeric})章`, 'u'))
  if (volume) { const v = chapterNumber(volume[1]), chapter = chapterNumber(volume[2]); if (v && chapter) return { kind: 'range', start: chapter, count: 1, volume: v } }
  if (/(?:下[一1]章|next chapter)/iu.test(positive)) return { kind: 'next', count: 1,
    ...(/(?:当前(?:这)?(?:章|章节)|正在编辑(?:的)?(?:这章|章节|章))(?:之|以)?后|after\s+(?:the\s+)?(?:current|currently edited)\s+chapter/iu.test(positive) ? { anchor: 'editor' as const } : {}) }
  const firstCount = positive.match(new RegExp(`前(${numeric})章`, 'u'))
  if (firstCount) { const count = chapterNumber(firstCount[1]); if (count && count <= 1000) return { kind: 'range', start: 1, count } }
  if (/(?:首章|第一章|第1章|first chapter)/iu.test(positive)) return { kind: 'first', start: 1, count: 1 }
  const ordinal = positive.match(new RegExp(`第(${numeric})章|chapter\\s*(\\d+)`, 'iu'))
  if (ordinal) { const start = chapterNumber(ordinal[1] ?? ordinal[2]); if (start) return { kind: 'range', start, count: 1 } }
  const countMatch = positive.match(new RegExp(`(?:写|创作|完成|起草).{0,6}(${numeric})章`, 'u'))
  if (countMatch) { const count = chapterNumber(countMatch[1]); if (count && count <= 1000) return { kind: 'count', count } }
  if (/(?:自动|自主|自行|全权).{0,16}(?:写完|完成全书|创作全书|逐章写)|(?:write|finish).{0,24}(?:autonomously|automatically)/iu.test(positive)) return { kind: 'unbounded' }
  return null
}

export async function freezeWritingScope(tx: Prisma.TransactionClient, subject: Subject, spec: TaskSpec, prompt: string): Promise<TaskSpec> {
  if (spec.scope.writing || !['write', 'revise', 'review'].includes(spec.intent) || spec.writingPacing === 'proposal_only' || spec.writingPacing === 'conversation_only') return spec
  await lockNovelActiveScope(tx, subject.novelId)
  const original = await readOriginalTaskRequest(tx, subject)
  if (original.parentRunId) {
    const parent = taskSpecSchema.parse(original.spec)
    return { ...spec, scope: parent.scope, hardConstraints: parent.hardConstraints }
  }
  const admissionPrompt = original.prompt ?? prompt
  const range = requestedWritingRange(admissionPrompt)
  const chapters = await tx.chapter.findMany({ where: { authorId: subject.userId, ...activeChapterScope(subject.novelId) },
    select: { id: true, orderIndex: true, orderInVolume: true, volumeId: true, volume: { select: { orderIndex: true } } }, orderBy: { orderIndex: 'asc' } })
  const run = await tx.agentRun.findFirstOrThrow({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId }, select: { chapterId: true } })
  const base = { version: 1 as const, titleAndBodyOnly: /(?:只(?:要|输出|给|需)|仅(?:输出|给|需)).{0,16}(?:标题|章名).{0,12}(?:正文|内容)|only.{0,20}title.{0,12}(?:body|text)/iu.test(admissionPrompt), repairAuthorized: hasOriginalRepairAuthority(admissionPrompt) }
  let writing: Writing
  if (range?.kind === 'unbounded') writing = { ...base, kind: 'unbounded', targets: [] }
  else if (range) {
    const anchor = run.chapterId ? chapters.find(item => item.id === run.chapterId) : null
    const start = range.start ?? (range.anchor === 'editor' ? anchor ? anchor.orderIndex + 1 : null : (chapters.at(-1)?.orderIndex ?? 0) + 1)
    const targets: Writing['targets'] = []
    for (let i = 0; start !== null && i < (range.count ?? 1); i++) {
      const position = start + i
      if (range.volume) {
        const volume = await tx.volume.findFirst({ where: { novelId: subject.novelId, archivedAt: null, orderIndex: range.volume }, select: { id: true } })
        if (!volume) { targets.length = 0; break }
        const existing = chapters.find(item => item.volumeId === volume.id && item.orderInVolume === position)
        const prior = chapters.filter(item => item.volume.orderIndex < range.volume!).length
        targets.push({ orderIndex: existing?.orderIndex ?? prior + position, chapterId: existing?.id ?? null, volumeId: volume.id, positionInVolume: position })
      } else targets.push({ orderIndex: position, chapterId: chapters.find(item => item.orderIndex === position)?.id ?? null })
    }
    writing = { ...base, kind: targets.length ? 'bounded' : 'needs_input', targets }
  } else if (run.chapterId) {
    const target = chapters.find(item => item.id === run.chapterId)
    writing = { ...base, kind: target ? 'bounded' : 'needs_input', targets: target ? [{ orderIndex: target.orderIndex, chapterId: target.id }] : [] }
  } else writing = { ...base, kind: 'needs_input', targets: [] }
  return { ...spec, scope: { ...spec.scope, writing } }
}

const bindingSchema = z.object({ version: z.literal(1), taskId: z.string(), targets: z.array(z.object({ orderIndex: z.number().int().positive(), chapterId: z.string() }).strict()) }).strict()
export async function readWritingScope(tx: Prisma.TransactionClient, subject: Subject) {
  const original = await readOriginalTaskRequest(tx, subject)
  const spec = taskSpecSchema.safeParse(original.spec)
  let writing = spec.success ? spec.data.scope.writing : undefined
  const source = await tx.agentRun.findFirstOrThrow({ where: { id: original.sourceRunId, userId: subject.userId, novelId: subject.novelId } })
  if (!writing && original.prompt) {
    const range = requestedWritingRange(original.prompt)
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
  return { ...original, writing, bindings }
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

export async function assertWritingTarget(tx: Prisma.TransactionClient, subject: Subject, target: { chapterId?: string; orderIndex?: number }) {
  await lockWritingRunLineage(tx, subject)
  if (!await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId, status: { in: ['queued', 'running', 'awaiting_approval'] } }, select: { id: true } })) {
    throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '当前执行已暂停或结束，不能再写入章节。')
  }
  const scope = await readWritingScope(tx, subject)
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
  await assertWritingTarget(tx, subject, existing ? { chapterId: existing.id } : { orderIndex: slot?.orderIndex ?? args.position })
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

export async function assertWritingStructureAuthority(tx: Prisma.TransactionClient, subject: Subject) {
  const scope = await readWritingScope(tx, subject)
  if (scope.writing && scope.writing.kind !== 'unbounded') throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '原请求仅授权指定章节正文，未授权拆分、合并或重排作品结构。')
}

export function questionExpandsWritingScope(question: string, options: Array<{ label: string; detail?: string }>, writing: Writing | undefined, original: string | null): boolean {
  if (!writing || writing.kind === 'unbounded') return false
  const texts = [question, ...options.flatMap(option => [option.label, option.detail ?? ''])]
  return texts.some(text => {
    if (/封面|cover/iu.test(text) && !(original ?? '').split(/[。！？!?；;\n，,]+/u).some(clause => !/(?:不要|无需|不用|不必|禁止|不得|不能|do not|don't)/iu.test(clause) && /封面|cover/iu.test(clause))) return true
    if (!/(?:写|推进|创作|完成|write|draft)/iu.test(text)) return false
    const request = requestedWritingRange(text)
    if (!request) return false
    if (request.kind === 'next' || request.kind === 'unbounded' || request.kind === 'count') return true
    return !writing.targets.some(target => target.orderIndex === request.start) || (request.count ?? 1) > writing.targets.length
  })
}

/** Auto-delivery is limited to a chapter artifact request. Explicit additional
 * human-requested work keeps the ordinary completion checks in control. */
export function allowsChapterOnlyCompletion(prompt: string | null, requireExclusiveFormat = true): boolean {
  if (!prompt || !requestedWritingRange(prompt) || (requireExclusiveFormat && !/(?:只(?:要|输出|给|需)|仅(?:输出|给|需)).{0,16}(?:标题|章名).{0,12}(?:正文|内容)|only.{0,20}title.{0,12}(?:body|text)/iu.test(prompt))) return false
  const positive = prompt.split(/[。！？!?；;\n，,]+/u).filter(clause => !/(?:不要|无需|不用|不必|禁止|不得|不能|do not|don't)/iu.test(clause))
  if (!positive.some(clause => /(?:写|完成|修改|润色|起草|write|draft|revise)/iu.test(clause))) return false
  // A second independent action makes the output contract non-exclusive; do
  // not guess an exhaustive list of artifact nouns such as poems or diagrams.
  if (positive.some(clause => /(?:另|另外|此外|同时|顺便|再|还|也|并|而且).{0,12}(?:写|作|生成|给|提供|做|绘|设计|制作|保存|导出|发布)|(?:also|additionally|besides).{0,20}(?:write|create|produce|generate|export|publish)/iu.test(clause))) return false
  return !positive.some(clause => /(?:生成|制作|设计|绘制|保存|导出|发布|提供|给出|列出|需要|要做|produce|create|generate|export|publish).{0,24}(?:封面|大纲|计划|报告|设定集|人物表|插图|文件|cover|outline|report|illustration|file)|(?:检查|审阅|评估|分析|review|analy[sz]e).{0,16}(?:章节|正文|质量|连续性|chapter|quality|continuity)/iu.test(clause))
}

export async function assertQuestionWritingScope(tx: Prisma.TransactionClient, subject: Subject, question: string, options: Array<{ label: string; detail?: string }>) {
  const scope = await readWritingScope(tx, subject)
  if (questionExpandsWritingScope(question, options, scope.writing, scope.prompt)) throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '该问题或选项扩大原任务范围；继续已授权章节，不诱导封面或续章。')
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

async function readChapterDelivery(tx: Prisma.TransactionClient, subject: Subject, presentationKind: 'auto' | 'completed_saved_only') {
  await lockNovelActiveScope(tx, subject.novelId)
  const scope = await readWritingScope(tx, subject)
  if (scope.writing?.kind !== 'bounded' || !scope.writing.targets.length
    || (presentationKind === 'auto' && !scope.writing.titleAndBodyOnly)
    || !allowsChapterOnlyCompletion(scope.prompt, presentationKind === 'auto')) return null
  const targets = scope.writing.targets.map(target => ({ ...target, chapterId: target.chapterId ?? scope.bindings?.targets.find(item => item.orderIndex === target.orderIndex)?.chapterId }))
  const presentation = await readWritingPresentation(tx, subject, targets)
  if (presentationKind === 'completed_saved_only' && presentation?.mode !== 'saved_only') return null
  const runIds = await originalTaskRunIds(tx, subject, scope)
  const chapters = []
  const length = scope.prompt?.match(/(\d{2,6})\s*(?:[-–~～]|至|到)\s*(\d{2,6})\s*字/u)
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
    const { compilerContinuityCoverage, compilerContinuityCoverageMatches } = await import('./compiler-continuity-contract.js')
    const validation = terminal.validation as { checkedRevision?: number; independentCheck?: string; errorCount?: number; coverage?: unknown; reviewFocus?: string } | null
    if (validation?.independentCheck === 'complete' && validation.checkedRevision === chapter.revision && (validation.errorCount ?? 0) > 0
      && compilerContinuityCoverageMatches(validation.coverage, compilerContinuityCoverage({ chapter, bridge: terminal.bridge, sceneTasks: terminal.sceneTasks.sort((a, b) => a.ordinal - b.ordinal), source, focus: validation.reviewFocus }))) return null
    const report = await tx.chapterQualityReport.findFirst({ where: { userId: subject.userId, novelId: subject.novelId, compilationId: terminal.id, chapterId: chapter.id, chapterRevision: chapter.revision }, include: { findings: true }, orderBy: { createdAt: 'desc' } })
    if (report && (await import('./quality-report-contract.js')).qualityReportMatchesContent(report, chapter.revision, chapter.content)
      && report.findings.some(finding => finding.severity === 'error' && finding.disposition !== 'repaired' && finding.authorFeedback !== 'rejected')) return null
    if (length && (chapter.content.trim().length < Number(length[1]) || chapter.content.trim().length > Number(length[2]))) return null
    chapters.push({ ...chapter, contentHash: runtimeJson({ content: chapter.content }).hash })
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
