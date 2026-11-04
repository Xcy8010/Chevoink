import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError } from '../prisma.js'
import { activeVolumeWhere } from '../data/internal.js'
import { createVolumeData } from '../data/volume.js'
import { lexAuthorWritingRequest } from './author-writing-request.js'
import { chapterNumber, numeric } from './writing-target-range.js'
import { readOriginalTaskRequest } from './original-request.js'
import { runtimeJson } from './runtime-common.js'
import type { ToolContext } from './tools/types.js'

type Intent = NonNullable<TaskSpec['scope']['volumeCreateIntent']>
const requestHash = (prompt: string) => createHash('sha256').update(prompt).digest('hex')
export const isElidedVolumeAddition = (prompt: string) => /^(?:请(?:你)?|你|现在|直接|就|来|\s)*(?:(?:可以|能不能)?(?:帮我|替我|为我)(?:来)?)?(?:加|添加|加上|新增)(?:一下|吧|好吗|可以吗|吗)?[。！!？?\s]*$/u.test(lexAuthorWritingRequest(prompt).masked)
const textParts = (parts: unknown) => Array.isArray(parts) ? parts.flatMap(part => part && typeof part === 'object' && !Array.isArray(part)
  && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n') : ''
export const volumeIntentTitle = (title: string) => title.trim().replace(new RegExp(`^第\\s*${numeric}\\s*卷\\s*`, 'u'), '').replace(/^[《「〈]|[》」〉]$/gu, '').trim()

/** A title list is a referent, never authority. Only the new human command opts in. */
function namedEmptyVolumes(text: string): Intent['targets'] | null {
  const context = lexAuthorWritingRequest(text).masked
  if (text.length > 24_000 || !/目录|左栏|侧栏|卷名/u.test(context)
    || !/(?:新建|创建|新增|添加|增加|加).{0,24}(?:空卷|新卷)/u.test(context)) return null
  if (/(?:新建|创建|新增|添加|增加|加)(?:(?!卷|[，,。；;\n]).){0,16}(?:章节|正文|封面|标签|人物|角色|细纲|大纲|计划)/u.test(text)) return null
  const patterns = [new RegExp(`《第\\s*(${numeric})\\s*卷\\s*([^》\n]{1,120})》`, 'gu'),
    new RegExp(`第\\s*(${numeric})\\s*卷\\s*《([^》\n]{1,120})》`, 'gu')]
  const targets = new Map<number, string>()
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const orderIndex = chapterNumber(match[1]), title = volumeIntentTitle(match[2])
    if (!orderIndex || !title || targets.has(orderIndex) && targets.get(orderIndex) !== title) return null
    targets.set(orderIndex, title)
  }
  return targets.size && targets.size <= 20 ? [...targets].map(([orderIndex, title]) => ({ orderIndex, title })).sort((a, b) => a.orderIndex - b.orderIndex) : null
}

/** Fresh HTTP admission only, under the existing novel lock. No old run is changed. */
export async function readVolumeCreateIntent(db: Prisma.TransactionClient, subject: { userId: string; novelId: string; sessionId: string; runId: string; prompt: string }): Promise<Intent | undefined> {
  if (!isElidedVolumeAddition(subject.prompt)) return
  const previous = await db.agentRun.findFirst({ where: { userId: subject.userId, novelId: subject.novelId, sessionId: subject.sessionId,
    id: { not: subject.runId }, engine: 'loop', session: { spawnedFromRunId: null } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, status: true } })
  if (!previous || previous.status !== 'completed') return
  const messages = await db.agentMessage.findMany({ where: { runId: previous.id, sessionId: subject.sessionId, role: 'assistant' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 8, select: { id: true, parts: true } })
  const message = messages.find(item => textParts(item.parts).trim())
  const targets = message && namedEmptyVolumes(textParts(message.parts))
  if (!message || !targets || new Set(targets.map(target => target.title)).size !== targets.length) return
  const existing = await db.volume.findMany({ where: { novelId: subject.novelId, ...activeVolumeWhere }, orderBy: { orderIndex: 'asc' }, select: { title: true, orderIndex: true } })
  if (targets.some(target => existing.some(volume => volume.orderIndex === target.orderIndex && volumeIntentTitle(volume.title) !== target.title))) return
  const missing = targets.filter(target => !existing.some(volume => volume.orderIndex === target.orderIndex))
  if (!missing.length || missing.some((target, index) => target.orderIndex !== existing.length + index + 1)) return
  return { version: 1, requestHash: requestHash(subject.prompt), sourceMessageId: message.id, sourceHash: runtimeJson(message.parts).hash, targets: missing }
}

/** Current owner/manuscript fencing and novel lock are held by the caller. */
export async function readConfirmedVolumeTarget(db: Prisma.TransactionClient, ctx: ToolContext, args: { title: string; summary?: string; position?: number; boundary?: unknown; targetOrderIndex?: number }) {
  const original = await readOriginalTaskRequest(db, ctx)
  const spec = taskSpecSchema.safeParse(original.spec).data, intent = spec?.scope.volumeCreateIntent
  if (!intent) return null
  const fail = () => { throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '本次只获准添加已确认的空卷；来源、卷名或原卷序不匹配，未新建、迁移或覆盖内容。') }
  if (ctx.sandboxMode === 'read_only' || ctx.inlineChild || original.parentRunId || spec?.scope.volumeCreationProtocol !== 1 || !original.prompt || !isElidedVolumeAddition(original.prompt)
    || requestHash(original.prompt) !== intent.requestHash || args.position !== undefined || args.boundary || args.targetOrderIndex !== undefined) fail()
  const sourceRun = await db.agentRun.findFirst({ where: { id: original.sourceRunId, userId: ctx.userId, novelId: ctx.novelId }, select: { sessionId: true } })
  if (!sourceRun) return fail()
  const message = await db.agentMessage.findFirst({ where: { id: intent.sourceMessageId, sessionId: sourceRun.sessionId, role: 'assistant',
    run: { userId: ctx.userId, novelId: ctx.novelId, status: 'completed', session: { spawnedFromRunId: null } } }, select: { parts: true } })
  const offered = message && namedEmptyVolumes(textParts(message.parts))
  if (!message || runtimeJson(message.parts).hash !== intent.sourceHash || !offered
    || intent.targets.some(target => !offered.some(item => item.orderIndex === target.orderIndex && item.title === target.title))) return fail()
  const target = intent.targets.find(item => item.title === volumeIntentTitle(args.title))
  if (!target) return fail()
  const volumes = await db.volume.findMany({ where: { novelId: ctx.novelId, ...activeVolumeWhere }, orderBy: { orderIndex: 'asc' } })
  const current = volumes.find(item => item.orderIndex === target.orderIndex)
  if (current) { if (volumeIntentTitle(current.title) !== target.title) return fail(); return { current } }
  if (target.orderIndex !== volumes.length + 1 || volumes.some(item => volumeIntentTitle(item.title) === target.title)) return fail()
  return { current: null }
}

export async function createConfirmedVolume(db: Prisma.TransactionClient, ctx: ToolContext, args: { title: string; summary?: string; position?: number; boundary?: unknown; targetOrderIndex?: number }) {
  const confirmed = await readConfirmedVolumeTarget(db, ctx, args)
  if (!confirmed) return null
  return confirmed.current ?? createVolumeData(ctx.userId, ctx.novelId, { title: args.title, summary: args.summary }, db)
}
