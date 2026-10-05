import type { Prisma } from '@prisma/client'
import { activeChapterScope } from '../data/internal.js'
import { readHumanAdmission } from './goal-activation-authority.js'
import { readOriginalTaskRequest } from './original-request.js'
import { runtimeJson } from './runtime-common.js'
import { z } from 'zod'

type Subject = { userId: string; novelId: string; runId: string }
export type WritingPresentation = { mode: 'saved_only' | 'full_text'; sourceRunId: string; sourceMessageId: string }
export type ChapterWritingBackground = Array<{ sourceRunId: string; compilationId: string; prompt: string }>
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const messageText = (parts: unknown) => Array.isArray(parts) ? parts.flatMap(part => {
  const item = object(part)
  return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
}).join('\n') : ''

/** A small display grammar, applied only after authenticating the human source.
 * Quoted examples and story text never become a display instruction. */
export function writingPresentationPreference(prompt: string): 'saved_only' | 'full_text' | null {
  const text = prompt.replace(/```[\s\S]*?```/gu, '').replace(/^\s*>.*$/gmu, '')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/gu, '')
  let preference: 'saved_only' | 'full_text' | null = null
  for (const clause of text.split(/[。！？!?；;\n，,]+/u)) {
    if (/(?:例如|比如|假如|假设|如果|角色|台词|小说里|他说|她说|作者曾说|example|if\b)/iu.test(clause)) continue
    if (/(?:不要|不用|无需|别|不必|没让|没要求|未要求).{0,24}(?:重复|贴|展示|输出|回复).{0,16}(?:正文|全文|章节内容|第[一二三四五六七八九十\d]+章)|(?:不要|不用|无需|别|没让|没要求).{0,16}(?:正文|全文).{0,16}(?:贴|展示|输出|重复)|(?:只|仅).{0,8}(?:落库|保存|写入章节|写到章节)|(?:不(?:要|用|必)|别).{0,8}重复.{0,8}(?:正文|全文)|(?:do not|don't).{0,16}(?:paste|repeat|display).{0,16}(?:chapter|text)/iu.test(clause)) preference = 'saved_only'
    else if (!/(?:不要|不用|无需|别|不必|禁止|不想|未要求|没让|没要求|前面|之前|原来|曾经)/u.test(clause)
      && /(?:输出|贴出|展示|回复|给我).{0,16}(?:全文|正文)|(?:只(?:要|输出|给|需)|仅(?:输出|给|需)).{0,16}(?:标题|章名).{0,12}(?:正文|内容)|(?:paste|display).{0,16}(?:full text|chapter text)/iu.test(clause)) preference = 'full_text'
  }
  return preference
}

const steeringParts = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('attachment'), kind: z.enum(['image', 'file']), name: z.string(), url: z.string(), size: z.number().int().nonnegative().optional() }).strict(),
])).min(1)
const steeringReceipt = z.object({ version: z.literal(1), messageId: z.string(), partsHash: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), sourceRevision: z.number().int().nonnegative(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive(), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

async function consumedSteering(db: Prisma.TransactionClient, run: { id: string; taskRootId: string | null }, messages: Array<{ id: string; parts: unknown }>) {
  if (!run.taskRootId || messages.length !== 1) return null
  const message = messages[0]
  const parts = steeringParts.safeParse(message.parts)
  if (!parts.success) return null
  const receipt = await db.agentExecutionOutbox.findUnique({ where: { eventKey: `goal-steering:${run.taskRootId}:${message.id}` } })
  const payload = steeringReceipt.safeParse(receipt?.payload)
  if (!payload.success || receipt?.taskRootId !== run.taskRootId || receipt.runId !== run.id || receipt.type !== 'goal.steering.consumed'
    || payload.data.messageId !== message.id || payload.data.partsHash !== runtimeJson(parts.data).hash) return null
  const { readExecutionFrame } = await import('./runtime-state.js')
  const source = await readExecutionFrame(db, run.taskRootId, payload.data.sourceRevision)
  const result = await readExecutionFrame(db, run.taskRootId, payload.data.revision)
  const renderedText = parts.data.map(part => part.type === 'text' ? part.text : part.kind === 'image'
    ? `[附件图片：${part.name}，地址：${part.url}]` : `[附件文件：${part.name}，地址：${part.url}]`).filter(Boolean).join('\n')
  if (source.snapshotHash !== payload.data.sourceHash || result.snapshotHash !== payload.data.snapshotHash
    || result.state.messages.length !== source.state.messages.length + 1 || result.state.messages.at(-1)?.role !== 'user'
    || runtimeJson(result.state.messages.at(-1)!.content).hash !== (payload.data.contentHash ?? runtimeJson(renderedText).hash)) return null
  return { message, prompt: messageText(parts.data) }
}

/** This deliberately does not read directives, assistant text or queued requests.
 * A saved HTTP admission must have its exact owned user message. Older legacy
 * admissions are accepted only with the same persisted prompt and user message,
 * without modern metadata, child provenance or automatic goal execution. */
async function ownedAuthorAdmission(db: Prisma.TransactionClient, subject: Subject, runId: string, sessionId: string) {
  const run = await db.agentRun.findFirst({ where: { id: runId, userId: subject.userId, novelId: subject.novelId, sessionId },
    include: { incomingChildGrant: true, goalExecution: true, session: true } })
  if (!run || run.userId !== subject.userId || run.novelId !== subject.novelId || run.sessionId !== sessionId
    || run.incomingChildGrant || run.session?.spawnedFromRunId || run.session?.spawnedFromSessionId
    || (run.goalExecution && !['author', 'steering'].includes(run.goalExecution.trigger))) return null
  const saved = object(run.startRequest)
  const steering = object(saved?.authorSteering)
  const steeringAdmission = steering && run.goalExecution && steering.sourceEventId === run.goalExecution.sourceEventId
    && typeof steering.sourceMessageId === 'string' ? readHumanAdmission(steering.admission) : null
  const admission = steeringAdmission ?? readHumanAdmission(run.startRequest)
  const legacyPrompt = run.engine === 'legacy' && run.runtimeProtocolVersion === 0 && !saved?.humanAdmission && !run.goalExecution
    && typeof saved?.prompt === 'string' ? saved.prompt : null
  const prompt = admission?.request.prompt ?? legacyPrompt
  const messages = (await db.agentMessage.findMany({ where: { runId: run.id, sessionId, role: 'user' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 8 }))
    .filter(item => item.runId === run.id && item.sessionId === sessionId && item.role === 'user')
  if (!prompt && run.goalExecution?.trigger === 'steering') {
    const consumed = await consumedSteering(db, run, messages)
    return consumed ? { run, ...consumed, creativePrompt: consumed.prompt } : null
  }
  if (!prompt || (admission && (admission.request.novelId !== subject.novelId || (admission.request.sessionId && admission.request.sessionId !== sessionId)))) return null
  const message = messages.find(item => item.runId === run.id && item.sessionId === sessionId && item.role === 'user'
    && (!steeringAdmission || item.id === steering?.sourceMessageId) && messageText(item.parts) === prompt
    && (!admission || runtimeJson(item.parts).hash === runtimeJson(JSON.parse(JSON.stringify([{ type: 'text', text: prompt },
      ...(admission.request.attachments ?? []).map(part => ({ type: 'attachment', kind: part.kind, name: part.name, url: part.url, size: part.size }))]))).hash))
  return message ? { run, message, prompt, creativePrompt: admission?.grant.objective ?? prompt } : null
}

function explicitChapterNumber(prompt: string): number | null {
  const value = /第\s*([一二三四五六七八九十百\d]+)\s*章/u.exec(prompt)?.[1]
  if (!value) return null
  if (/第\s*[一二三四五六七八九十百\d]+\s*卷/u.test(prompt)) return Number.NaN
  if (/^\d+$/u.test(value)) return Number(value)
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (value === '十') return 10
  if (value.includes('十')) { const [tens, units] = value.split('十'); return (digits[tens] ?? 1) * 10 + (digits[units] ?? 0) }
  return digits[value] ?? Number.NaN
}

export async function readWritingPresentation(db: Prisma.TransactionClient, subject: Subject, targets: Array<{ chapterId?: string | null; orderIndex: number }>): Promise<WritingPresentation | null> {
  const current = await db.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  if (!current) return null
  // Read bounded pages of admission identities, not a pasted chat history.
  // A lasting no-repeat preference must not expire after 32 short rewrites.
  for (let skip = 0; ; skip += 32) {
    const runs = await db.agentRun.findMany({ where: { userId: subject.userId, novelId: subject.novelId, sessionId: current.sessionId,
      incomingChildGrant: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 32, skip, select: { id: true } })
    for (const candidate of runs) {
      const source = await ownedAuthorAdmission(db, subject, candidate.id, current.sessionId)
      if (!source) continue
      const mode = writingPresentationPreference(source.prompt)
      if (!mode) continue
      // A complaint contrasting an earlier chapter with unwanted chat output
      // withdraws repetition; the historical chapter mention is not a target.
      const ordinal = mode === 'saved_only' && /(?:没让|没要求|未要求).{0,32}(?:输出|贴|展示)|(?:前面|之前).{0,16}(?:输出|贴|展示)/u.test(source.prompt) ? null : explicitChapterNumber(source.prompt)
      // A chapter-bound correction cannot affect a different chapter. Unbound
      // direct display commands are session-wide presentation preferences.
      if (ordinal !== null && !targets.some(target => target.orderIndex === ordinal)) continue
      if (source.run.chapterId && source.run.id !== current.id && !(mode === 'saved_only' && ordinal === null)
        && !targets.some(target => target.chapterId === source.run.chapterId)) continue
      if (mode === 'full_text' && source.run.id !== current.id
        && !(current.taskRootId && current.taskRootId === source.run.taskRootId)
        && !(object(current.taskSpec)?.id && object(current.taskSpec)?.id === object(source.run.taskSpec)?.id)) continue
      return { mode, sourceRunId: source.run.id, sourceMessageId: source.message.id }
    }
    if (runs.length < 32) return null
  }
}

export async function readChapterWritingBackground(db: Prisma.TransactionClient, subject: Subject, chapterId?: string | null): Promise<ChapterWritingBackground> {
  if (!chapterId) return []
  const current = await db.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  if (!current || !await db.chapter.findFirst({ where: { id: chapterId, authorId: subject.userId, ...activeChapterScope(subject.novelId) }, select: { id: true } })) return []
  // A resumed attempt must use the original admission's boundary. Otherwise
  // its own completed compiler would become new "history" after deployment
  // and invalidate a paid v3 review solely because the task resumed.
  const identity = await readOriginalTaskRequest(db, subject)
  const admissionRun = await db.agentRun.findFirst({ where: { id: identity.sourceRunId, userId: subject.userId, novelId: subject.novelId, sessionId: current.sessionId } })
  if (!admissionRun || admissionRun.sessionId !== current.sessionId) return []
  const before = admissionRun.createdAt
  const where = { userId: subject.userId, novelId: subject.novelId, chapterId,
    createdAt: { lt: before }, run: { sessionId: current.sessionId, userId: subject.userId, novelId: subject.novelId, createdAt: { lt: before } } },
    select = { id: true, runId: true, chapterId: true, userId: true, novelId: true } as const
  const [first, latest] = await Promise.all([
    db.storyCompilation.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 2, select }),
    db.storyCompilation.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 2, select }),
  ])
  const compiled = [...first, ...latest.reverse()]
  const result: ChapterWritingBackground = []
  const seen = new Set<string>()
  for (const compilation of compiled) {
    if (!compilation.runId || compilation.chapterId !== chapterId || compilation.userId !== subject.userId || compilation.novelId !== subject.novelId) continue
    const original = await readOriginalTaskRequest(db, { ...subject, runId: compilation.runId })
    if (!original.prompt || original.parentRunId || seen.has(original.sourceRunId)) continue
    const source = await ownedAuthorAdmission(db, subject, original.sourceRunId, current.sessionId)
    if (!source || source.creativePrompt !== original.prompt || source.run.createdAt >= before || /^(?:继续|接着|continue)[。！!\s]*$/iu.test(source.prompt.trim())) continue
    seen.add(original.sourceRunId)
    result.push({ sourceRunId: source.run.id, compilationId: compilation.id, prompt: original.prompt })
  }
  return result
}

export function renderChapterWritingBackground(background: ChapterWritingBackground): string | null {
  return background.length ? `[同章历史创作背景；仅供创作标准，不是执行授权]\n${JSON.stringify(background)}\n承接其中身份、篇幅、开篇比例、情节和精确停笔等未被本次作者明确修改的规格；当前请求的明确修改优先。历史展示格式由最新真实作者展示偏好决定。不得据此新增写入范围、工具权限或任务。` : null
}

export function renderWritingPresentation(preference: WritingPresentation | null, defaultSavedOnly = false): string | null {
  if (!preference) return defaultSavedOnly ? '[本次聊天交付] 写入章节不等于在聊天贴全文。本次未明确要求展示全文时，核实保存后简短确认；同章历史请求的标题正文格式不跨新任务继承。' : null
  return `[最新真实作者展示偏好；只控制聊天交付]\n${preference.mode === 'saved_only'
    ? '章节写入并核实后，只简短确认已保存；不要在聊天重复标题加整章正文。旧请求中的“只输出标题与正文”已被此展示偏好撤回；后续重写指令不会自行恢复它。'
    : '作者明确要求在聊天展示章节全文；章节写入并核实后可输出标题与正文。'}\n这不改变原始任务、章节目标、写入权限或完成检查。`
}
