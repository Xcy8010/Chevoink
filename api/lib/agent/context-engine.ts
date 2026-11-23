import { createHash, randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'

import type {
  AgentMessagePart,
  ContextCheckpoint,
  ContextCheckpointSummary,
  ContextDetail,
  ContextDetailRecord,
  ContextState,
  TaskSpec,
  UserDirective,
} from '../../../shared/contracts/index.js'
import { env } from '../../config/env.js'
import { contextUsageSchema } from '../../../shared/contracts/context-compaction-contracts.js'
import { DataAccessError, prisma } from '../prisma.js'
import { parseModelCapabilities } from '../credits.js'
import { attachmentHistoryUrl, CONTEXT_COMPACTION_THRESHOLD, estimateTextTokens, resolveSessionContextWindow } from './context-budget.js'
import { extractDirectiveCandidates } from './task-spec.js'
import { MAIN_RUN_FILTER } from './runtime-child.js'

const WARNING_THRESHOLD = 0.65
const RECENT_TAIL_MESSAGES = 24
const compactionJobs = new Map<string, { force: boolean; promise: Promise<ContextCheckpoint | null> }>()

export type ContextCheckpointBoundary = { createdAt: Date; messageId: string | null }

function lastSourceMessageId(sourceMessageIds: unknown): string | null {
  if (!Array.isArray(sourceMessageIds)) return null
  const value = sourceMessageIds.at(-1)
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function isAfterCheckpointBoundary(record: { id: string; createdAt: Date }, boundary: ContextCheckpointBoundary | null): boolean {
  if (!boundary) return true
  const timestampDelta = record.createdAt.getTime() - boundary.createdAt.getTime()
  if (timestampDelta !== 0) return timestampDelta > 0
  return boundary.messageId ? record.id > boundary.messageId : false
}

function checkpointBoundary(record: { sourceEndedAt: Date; sourceMessageIds: unknown } | null | undefined): ContextCheckpointBoundary | null {
  return record ? { createdAt: record.sourceEndedAt, messageId: lastSourceMessageId(record.sourceMessageIds) } : null
}

async function resolveSessionContextWindowTokens(userId: string, sessionId: string): Promise<number> {
  const latestRun = await prisma.agentRun.findFirst({
    where: { sessionId, userId, ...MAIN_RUN_FILTER },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { modelTier: true, customModelId: true },
  })
  if (!latestRun) return env.agentContextWindowTokens
  const model = await prisma.aiModelConfig.findFirst({
    where: latestRun.modelTier === 'custom' && latestRun.customModelId
      ? { id: latestRun.customModelId, ownerUserId: userId }
      : { ownerUserId: null, tier: latestRun.modelTier },
    select: { metadata: true, provider: true },
  })
  return resolveSessionContextWindow(env.agentContextWindowTokens, parseModelCapabilities(model?.metadata, model?.provider).contextWindowTokens)
}

function jsonText(value: unknown): string {
  return JSON.stringify(value)
}

function directiveRecord(record: {
  id: string; novelId: string; sessionId: string | null; volumeId: string | null; chapterId: string | null
  taskSpecId: string | null; scope: string; kind: string; text: string; status: string; sourceMessageId: string
  supersededBy: string | null; createdAt: Date; updatedAt: Date
}): UserDirective {
  return {
    ...record,
    scope: record.scope as UserDirective['scope'],
    kind: record.kind as UserDirective['kind'],
    status: record.status as UserDirective['status'],
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export async function captureUserDirectives(input: {
  userId: string
  novelId: string
  sessionId: string
  chapterId: string | null
  sourceMessageId: string
  taskSpec: TaskSpec
  prompt: string
}): Promise<UserDirective[]> {
  const candidates = extractDirectiveCandidates(input.prompt)
  const created: UserDirective[] = []
  for (const candidate of candidates) {
    // Extraction identifies wording, not permission to apply it to future tasks.
    const scope = /以后|今后|长期|始终|永久|后续所有章节|整部作品都|全书都/.test(candidate.text) ? 'global' as const : 'task' as const
    const existing = await prisma.userDirective.findFirst({
      where: { userId: input.userId, novelId: input.novelId, status: 'active', kind: candidate.kind, text: candidate.text, scope,
        ...(scope === 'task' ? { sessionId: input.sessionId, taskSpecId: input.taskSpec.id } : {}) },
    })
    if (existing) {
      created.push(directiveRecord(existing))
      continue
    }
    const record = await prisma.userDirective.create({
      data: {
        userId: input.userId,
        novelId: input.novelId,
        sessionId: input.sessionId,
        chapterId: input.chapterId,
        taskSpecId: input.taskSpec.id,
        scope,
        kind: candidate.kind,
        text: candidate.text,
        sourceMessageId: input.sourceMessageId,
      },
    })
    created.push(directiveRecord(record))
  }
  return created
}

export async function listActiveDirectives(userId: string, novelId: string,
  scope?: { sessionId: string; chapterId?: string | null; taskSpecId?: string; runId?: string },
  db: Prisma.TransactionClient = prisma): Promise<UserDirective[]> {
  let applicable: Prisma.UserDirectiveWhereInput[] | undefined
  if (scope) {
    applicable = [{ scope: 'global' }]
    const chapter = scope.chapterId ? await db.chapter.findFirst({ where: { id: scope.chapterId, novelId, authorId: userId }, select: { id: true, volumeId: true } }) : null
    if (chapter) applicable.push({ scope: 'chapter', chapterId: chapter.id }, { scope: 'volume', volumeId: chapter.volumeId })
    const run = !scope.taskSpecId && scope.runId ? await db.agentRun.findFirst({ where: { id: scope.runId, userId, novelId, sessionId: scope.sessionId }, select: { taskRootId: true, taskSpec: true } }) : null
    const spec = run?.taskSpec && typeof run.taskSpec === 'object' && !Array.isArray(run.taskSpec) ? run.taskSpec : null
    const taskSpecId = scope.taskSpecId ?? run?.taskRootId ?? (typeof spec?.id === 'string' ? spec.id : undefined)
    if (taskSpecId) applicable.push({ scope: 'task', sessionId: scope.sessionId, taskSpecId })
    // Older directive_save records used the run ID as provenance, not a task ID.
    // They may apply to that exact run, never every later run in the session.
    if (scope.runId) applicable.push({ scope: 'task', sessionId: scope.sessionId, taskSpecId: null, sourceMessageId: scope.runId })
  }
  const records = await db.userDirective.findMany({
    where: { userId, novelId, status: 'active', ...(applicable ? { OR: applicable } : {}) },
    orderBy: [{ scope: 'asc' }, { createdAt: 'asc' }],
  })
  return records.map(directiveRecord)
}

export async function saveDirective(input: {
  userId: string; novelId: string; sessionId: string; chapterId: string | null; sourceMessageId: string
  text: string; kind: UserDirective['kind']; scope: UserDirective['scope']
  taskSpecId?: string
}, db: Prisma.TransactionClient = prisma): Promise<UserDirective> {
  const existing = await db.userDirective.findFirst({ where: { userId: input.userId, novelId: input.novelId, scope: input.scope,
    kind: input.kind, text: input.text, status: 'active',
    ...(input.scope === 'task' ? { sessionId: input.sessionId, ...(input.taskSpecId ? { taskSpecId: input.taskSpecId } : { taskSpecId: null, sourceMessageId: input.sourceMessageId }) }
      : input.scope === 'chapter' ? { chapterId: input.chapterId } : {}),
  }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  if (existing) return directiveRecord(existing)
  const record = await db.userDirective.create({ data: { ...input, volumeId: null } })
  return directiveRecord(record)
}

export async function supersedeDirective(userId: string, novelId: string, directiveId: string, replacement?: string, transaction?: Prisma.TransactionClient): Promise<UserDirective> {
  if (!transaction) return prisma.$transaction(tx => supersedeDirective(userId, novelId, directiveId, replacement, tx))
  const current = await transaction.userDirective.findFirst({ where: { id: directiveId, userId, novelId, status: 'active' } })
  if (!current) throw new DataAccessError(404, 'DIRECTIVE_NOT_FOUND', '指令不存在、已失效或不属于当前作品。')
  const text = replacement?.trim()
  const nextId = randomUUID()
  const changed = await transaction.userDirective.updateMany({ where: { id: current.id, userId, novelId, status: 'active', updatedAt: current.updatedAt },
    data: text ? { status: 'superseded', supersededBy: nextId } : { status: 'cancelled' } })
  if (changed.count !== 1) throw new DataAccessError(409, 'DIRECTIVE_CHANGED', '指令已变化，请重新读取后处理。')
  if (!text) return directiveRecord(await transaction.userDirective.findUniqueOrThrow({ where: { id: current.id } }))
  const next = await transaction.userDirective.create({
      data: {
        id: nextId, userId, novelId, sessionId: current.sessionId, volumeId: current.volumeId,
        chapterId: current.chapterId, taskSpecId: current.taskSpecId, scope: current.scope, kind: current.kind,
        text, sourceMessageId: current.sourceMessageId,
      },
    })
  return directiveRecord(next)
}

export function renderDirectiveDigest(directives: UserDirective[]): string | null {
  if (!directives.length) return null
  return `[系统] 作者长期有效指令账本（优先级高于旧对话；仅 active 生效）：\n${directives.map((item) => `- [${item.kind}/${item.scope}] ${item.text} (directiveId=${item.id})`).join('\n')}`
}

// Session summaries may carry book rules, but never another session's task directives.
async function sessionDirectives(userId: string, novelId: string, sessionId: string) {
  const rows = await prisma.userDirective.findMany({ where: { userId, novelId, status: 'active',
    OR: [{ scope: { not: 'task' } }, { sessionId, scope: 'task' }] }, orderBy: [{ scope: 'asc' }, { createdAt: 'asc' }] })
  return rows.map(directiveRecord)
}

function messageText(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  return (parts as AgentMessagePart[]).map((part) => {
    if (part.type === 'text') return part.text
    if (part.type === 'attachment') return `[附件 ${part.name}]`
    if (part.type === 'tool-call') {
      return `[工具 ${part.toolName}${part.summary ? `：${part.summary}` : ''}]`
    }
    return ''
  }).filter(Boolean).join('\n')
}

function mergeUnique(...lists: string[][]): string[] {
  return [...new Set(lists.flat().map((item) => item.trim()).filter(Boolean))]
}

function checkpointRecord(record: {
  id: string; sessionId: string; runId: string | null; sourceMessageCount: number; sourceTokens: number
  summaryTokens: number; model: string; version: number; sourceHash: string; summary: unknown; validation: unknown; createdAt: Date
}): ContextCheckpoint {
  return {
    id: record.id, sessionId: record.sessionId, runId: record.runId, sourceMessageCount: record.sourceMessageCount,
    sourceTokens: record.sourceTokens, summaryTokens: record.summaryTokens, model: record.model, version: record.version,
    sourceHash: record.sourceHash, summary: record.summary as ContextCheckpointSummary,
    validation: record.validation as ContextCheckpoint['validation'], createdAt: record.createdAt.toISOString(),
  }
}

export function renderCheckpointDigest(checkpoint: ContextCheckpoint, current?: { runId: string; directives: UserDirective[] }): string {
  const s = current ? { ...checkpoint.summary,
    // A session checkpoint can span prior tasks. Keep their completed work and
    // receipts as history, but never carry their pending objectives forward.
    goals: checkpoint.runId === current.runId ? checkpoint.summary.goals : [],
    pending: checkpoint.runId === current.runId ? checkpoint.summary.pending : [],
    constraints: current.directives.filter(item => item.kind === 'must' || item.kind === 'must_not').map(item => item.text),
    decisions: current.directives.filter(item => item.kind === 'decision').map(item => item.text),
  } : checkpoint.summary
  return `[系统] 已验证的历史上下文检查点（checkpointId=${checkpoint.id}）：\n目标：${s.goals.join('；') || '无'}\n约束：${s.constraints.join('；') || '无'}\n决策：${s.decisions.join('；') || '无'}\n已完成：${s.completed.join('；') || '无'}\n待处理：${s.pending.join('；') || '无'}\n工具凭据：${s.toolReceipts.map((item) => `${item.toolName}:${item.summary}${item.artifactId ? `(${item.artifactId})` : ''}`).join('；') || '无'}。如需原文细节请重新调用读取工具，禁止凭摘要补写事实。`
}

async function compactSessionContextInternal(userId: string, sessionId: string, force: boolean): Promise<ContextCheckpoint | null> {
  const session = await prisma.agentSession.findFirst({ where: { id: sessionId, userId }, select: { id: true, novelId: true } })
  if (!session) throw new DataAccessError(404, 'AGENT_SESSION_NOT_FOUND', 'Agent 会话不存在。')
  const previous = await prisma.contextCheckpoint.findFirst({ where: { sessionId }, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }] })
  const [directives, afterPrevious, contextWindowTokens] = await Promise.all([
    sessionDirectives(userId, session.novelId, sessionId),
    prisma.agentMessage.findMany({
      where: { ...windowMessagesWhere(sessionId, checkpointBoundary(previous)), run: { ...MAIN_RUN_FILTER, status: { in: ['completed', 'failed', 'cancelled'] } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, runId: true, role: true, parts: true, createdAt: true, run: { select: { outputSummary: true } } },
    }),
    resolveSessionContextWindowTokens(userId, sessionId),
  ])
  const source = afterPrevious.slice(0, Math.max(0, afterPrevious.length - RECENT_TAIL_MESSAGES))
  const activeText = afterPrevious.map((item) => messageText(item.parts)).join('\n')
  const beforeTokens = estimateTextTokens(activeText) + (previous?.summaryTokens ?? 0)
  if (!force && beforeTokens < Math.floor(contextWindowTokens * CONTEXT_COMPACTION_THRESHOLD)) return null
  // 强制压缩也必须有新的可压缩消息；返回旧检查点会让前端误报“生成了新版本”。
  if (source.length === 0) return null

  const priorSummary = previous?.summary as ContextCheckpointSummary | undefined
  const goals = source.filter((item) => item.role === 'user').map((item) => messageText(item.parts).slice(0, 240))
  const completed = source.filter((item) => item.role === 'assistant').flatMap((item) => item.run.outputSummary ? [item.run.outputSummary] : [])
  const receipts = source.flatMap((item) => {
    if (!Array.isArray(item.parts)) return []
    return (item.parts as unknown as AgentMessagePart[]).flatMap((part) => part.type === 'tool-call' && part.status === 'success'
      ? [{ toolName: part.toolName, summary: part.summary ?? '执行成功', artifactId: part.toolName === 'read_file' ? attachmentHistoryUrl(part.args) ?? null : null }]
      : [])
  })
  const constraints = directives.filter((item) => item.kind === 'must' || item.kind === 'must_not').map((item) => item.text)
  const decisions = directives.filter((item) => item.kind === 'decision').map((item) => item.text)
  const summary: ContextCheckpointSummary = {
    goals: mergeUnique(priorSummary?.goals ?? [], goals).slice(-30),
    // 约束与决策以 active 账本重建，避免已 superseded/cancelled 的旧要求从历史摘要复活。
    constraints: mergeUnique(constraints),
    decisions: mergeUnique(decisions),
    completed: mergeUnique(priorSummary?.completed ?? [], completed).slice(-40),
    pending: priorSummary?.pending ?? [],
    toolReceipts: [...(priorSummary?.toolReceipts ?? []), ...receipts].slice(-60),
    directiveIds: directives.map((item) => item.id),
  }
  const summaryTokens = estimateTextTokens(jsonText(summary))
  const retainedTokens = estimateTextTokens(afterPrevious.slice(source.length).map(item => messageText(item.parts)).join('\n'))
  if (summaryTokens + retainedTokens >= beforeTokens) return null
  const hardIds = directives.filter((item) => item.kind === 'must' || item.kind === 'must_not').map((item) => item.id)
  const missingDirectiveIds = hardIds.filter((id) => !summary.directiveIds.includes(id))
  const validation = {
    hardConstraintRetention: hardIds.length === 0 ? 1 : (hardIds.length - missingDirectiveIds.length) / hardIds.length,
    missingDirectiveIds,
    valid: missingDirectiveIds.length === 0,
  }
  if (!validation.valid) throw new DataAccessError(409, 'CONTEXT_COMPACTION_VALIDATION_FAILED', '上下文压缩未完整保留硬约束，已拒绝生成检查点。')
  const sourceText = source.map((item) => `${item.id}:${item.role}:${messageText(item.parts)}`).join('\n')
  const sourceHash = createHash('sha256').update(`${previous?.sourceHash ?? ''}\n${sourceText}`).digest('hex')
  const duplicate = await prisma.contextCheckpoint.findFirst({ where: { sessionId, sourceHash } })
  if (duplicate) return checkpointRecord(duplicate)
  try {
    const created = await prisma.contextCheckpoint.create({
      data: {
        sessionId, runId: source.at(-1)?.runId ?? null, sourceMessageCount: source.length,
        sourceMessageIds: source.map((item) => item.id), sourceStartedAt: source[0].createdAt,
        sourceEndedAt: source.at(-1)!.createdAt, sourceTokens: estimateTextTokens(sourceText),
        summaryTokens, model: 'deterministic-v2', version: (previous?.version ?? 0) + 1,
        sourceHash,
        summary: summary as unknown as object, validation,
      },
    })
    return checkpointRecord(created)
  } catch (error) {
    // 多实例同时压缩同一输入时唯一键只允许一个版本落库；失败实例读取赢家结果。
    const raced = await prisma.contextCheckpoint.findFirst({ where: { sessionId, sourceHash } })
    if (raced) return checkpointRecord(raced)
    throw error
  }
}

/** 同一进程内按会话单飞，避免自动压缩与手动压缩同时生成重复版本。 */
export async function compactSessionContext(userId: string, sessionId: string, force = false): Promise<ContextCheckpoint | null> {
  const key = `${userId}:${sessionId}`
  const active = compactionJobs.get(key)
  if (active) {
    // 手动压缩不能被一个阈值未满足的自动任务“吞掉”；先等它结束，再按强制语义重试。
    if (force && !active.force) return active.promise.then(() => compactSessionContext(userId, sessionId, true))
    return active.promise
  }
  const job = compactSessionContextInternal(userId, sessionId, force).finally(() => {
    if (compactionJobs.get(key)?.promise === job) compactionJobs.delete(key)
  })
  compactionJobs.set(key, { force, promise: job })
  return job
}

export async function getContextState(userId: string, sessionId: string, preferRequest = false): Promise<ContextState> {
  const session = await prisma.agentSession.findFirst({ where: { id: sessionId, userId }, select: { novelId: true } })
  if (!session) throw new DataAccessError(404, 'AGENT_SESSION_NOT_FOUND', 'Agent 会话不存在。')
  const [checkpoint, directives, latest] = await Promise.all([
    prisma.contextCheckpoint.findFirst({ where: { sessionId }, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }] }),
    sessionDirectives(userId, session.novelId, sessionId),
    preferRequest ? prisma.agentRun.findFirst({
      where: { userId, sessionId, ...MAIN_RUN_FILTER, events: { some: { type: 'context.usage' } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, events: { where: { type: 'context.usage' }, orderBy: { seq: 'desc' }, take: 1,
        select: { seq: true, createdAt: true, payload: true } } },
    }) : null,
  ])
  const base = { warningThreshold: WARNING_THRESHOLD, activeDirectiveCount: directives.length,
    checkpoint: checkpoint ? checkpointRecord(checkpoint) : null }
  const event = latest?.events[0]
  if (latest && event && (!checkpoint || event.createdAt > checkpoint.createdAt)) {
    const sample = contextUsageSchema.safeParse(event.payload)
    if (sample.success) {
      const { estimatedTokens, contextWindowTokens, compactAtTokens } = sample.data
      // Both execution protocols record the post-compaction measurement directly
      // after completion. Read that exact pair, including for existing sessions.
      const runScope = { userId, sessionId, ...MAIN_RUN_FILTER }
      const completion = await prisma.agentRunEvent.findFirst({
        where: { run: runScope, type: 'context.compaction', payload: { path: ['state'], equals: 'completed' },
          OR: [{ runId: { not: latest.id } }, { seq: { lt: event.seq } }],
          createdAt: { ...(checkpoint && { gt: checkpoint.createdAt }), lte: event.createdAt } },
        orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }], select: { runId: true, seq: true },
      })
      const first = completion
        ? await prisma.agentRunEvent.findUnique({ where: { runId_seq: { runId: completion.runId, seq: completion.seq + 1 }, type: 'context.usage' },
          select: { type: true, payload: true } })
        : checkpoint ? await prisma.agentRunEvent.findFirst({ where: { run: runScope, type: 'context.usage',
          createdAt: { gt: checkpoint.createdAt, lte: event.createdAt } }, orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }],
          select: { type: true, payload: true } }) : null
      const retained = first?.type === 'context.usage' ? contextUsageSchema.safeParse(first.payload) : null
      return { ...base, requestSample: { runId: latest.id, seq: event.seq }, estimatedTokens, contextWindowTokens,
        ...(retained?.success && { retainedTokens: retained.data.estimatedTokens }),
        usageRatio: estimatedTokens / contextWindowTokens, compactionThreshold: compactAtTokens / contextWindowTokens }
    }
  }
  // Historical clients and sessions without a measured request use saved history.
  const [recent, contextWindowTokens] = await Promise.all([
    prisma.agentMessage.findMany({ where: windowMessagesWhere(sessionId, checkpointBoundary(checkpoint)),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { parts: true, createdAt: true } }),
    resolveSessionContextWindowTokens(userId, sessionId),
  ])
  const estimatedTokens = estimateTextTokens(recent.map((item) => messageText(item.parts)).join('\n')) + (checkpoint?.summaryTokens ?? 0)
  return {
    ...base, estimatedTokens, contextWindowTokens,
    ...(preferRequest && checkpoint && { retainedTokens: checkpoint.summaryTokens + estimateTextTokens(
      recent.filter(item => item.createdAt <= checkpoint.createdAt).map(item => messageText(item.parts)).join('\n')) }),
    usageRatio: estimatedTokens / contextWindowTokens, compactionThreshold: CONTEXT_COMPACTION_THRESHOLD,
  }
}

export async function loadContextCheckpoint(sessionId: string): Promise<{ checkpoint: ContextCheckpoint | null; sourceEndedAt: Date | null; sourceEndMessageId: string | null }> {
  const record = await prisma.contextCheckpoint.findFirst({ where: { sessionId }, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }] })
  return {
    checkpoint: record ? checkpointRecord(record) : null,
    sourceEndedAt: record?.sourceEndedAt ?? null,
    sourceEndMessageId: lastSourceMessageId(record?.sourceMessageIds),
  }
}

function detailRecord(record: { id: string; role: string; parts: unknown; createdAt: Date }, boundary: ContextCheckpointBoundary | null): ContextDetailRecord {
  const text = messageText(record.parts)
  return {
    id: record.id,
    role: record.role,
    createdAt: record.createdAt.toISOString(),
    estimatedTokens: estimateTextTokens(text),
    excerpt: text.slice(0, 160),
    inWindow: isAfterCheckpointBoundary(record, boundary),
  }
}

function windowMessagesWhere(sessionId: string, boundary: ContextCheckpointBoundary | null): Prisma.AgentMessageWhereInput {
  if (!boundary) return { sessionId }
  return { sessionId, OR: [
    { createdAt: { gt: boundary.createdAt } },
    ...(boundary.messageId ? [{ createdAt: boundary.createdAt, id: { gt: boundary.messageId } }] : []),
  ] }
}

/** The detail view describes retained conversation history, independently of the current model request. */
export async function getContextDetail(
  userId: string,
  sessionId: string,
  view: 'records' | 'checkpoints' | 'final',
  page: number,
  pageSize: number,
): Promise<ContextDetail> {
  const session = await prisma.agentSession.findFirst({ where: { id: sessionId, userId }, select: { novelId: true } })
  if (!session) throw new DataAccessError(404, 'AGENT_SESSION_NOT_FOUND', 'Agent 会话不存在。')
  const skip = (page - 1) * pageSize

  if (view === 'checkpoints') {
    const [total, rows] = await Promise.all([
      prisma.contextCheckpoint.count({ where: { sessionId } }),
      prisma.contextCheckpoint.findMany({ where: { sessionId }, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
    ])
    return { view, items: rows.map(checkpointRecord), total, page, pageSize }
  }

  const checkpoint = await prisma.contextCheckpoint.findFirst({ where: { sessionId }, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }] })
  const boundary = checkpointBoundary(checkpoint)

  if (view === 'records') {
    const [total, rows] = await Promise.all([
      prisma.agentMessage.count({ where: { sessionId } }),
      prisma.agentMessage.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: { id: true, role: true, parts: true, createdAt: true },
      }),
    ])
    return { view, items: rows.map((item) => detailRecord(item, boundary)), total, page, pageSize }
  }

  const [directives, windowRows] = await Promise.all([
    sessionDirectives(userId, session.novelId, sessionId),
    prisma.agentMessage.findMany({
      where: windowMessagesWhere(sessionId, boundary),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, role: true, parts: true, createdAt: true },
    }),
  ])
  const items = windowRows.map((item) => detailRecord(item, boundary))
  const windowTokens = estimateTextTokens(windowRows.map((item) => messageText(item.parts)).join('\n'))
  const checkpointTokens = checkpoint?.summaryTokens ?? 0
  return {
    view: 'final',
    estimatedTokens: windowTokens + checkpointTokens,
    checkpointTokens,
    checkpointDigest: checkpoint ? renderCheckpointDigest(checkpointRecord(checkpoint)) : null,
    directiveDigest: renderDirectiveDigest(directives),
    window: { items: items.slice(skip, skip + pageSize), total: items.length, page, pageSize },
  }
}
