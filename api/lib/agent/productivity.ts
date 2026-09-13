import type { Prisma } from '@prisma/client'

import type {
  AgentEvalComparisonView,
  AgentEvalRunMetric,
  AgentScheduleView,
  AgentSubtaskLogEntry,
  AgentSubtaskLogsView,
  AgentSubtaskRole,
  AgentSubtaskView,
  StoryBranchDiffView,
  StoryBranchView,
} from '../../../shared/contracts/index.js'
import { DataAccessError, prisma } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { startLoopRun, stopLoopRun } from './run-service.js'

async function requireNovel(userId: string, novelId: string) {
  const novel = await prisma.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权访问。')
}

async function requireSession(userId: string, sessionId: string) {
  const session = await prisma.agentSession.findFirst({ where: { id: sessionId, userId } })
  if (!session) throw new DataAccessError(404, 'AGENT_SESSION_NOT_FOUND', '任务不存在或无权访问。')
  return session
}

function branchView(item: { id: string; novelId: string; chapterId: string; sourceRunId: string | null; name: string; baseRevision: number; headContent: string; status: string; mergedAt: Date | null; createdAt: Date; updatedAt: Date }): StoryBranchView {
  return { ...item, mergedAt: item.mergedAt?.toISOString() ?? null, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() }
}

function subtaskView(item: { id: string; novelId: string; parentSessionId: string | null; childSessionId: string | null; childRunId: string | null; name: string; role: string; triggerCondition: string; callableBy: string; prompt: string; tokenBudget: number; status: string; enabled: boolean; createdAt: Date; updatedAt: Date }, stats: { runCount: number; lastRunAt: Date | null }): AgentSubtaskView {
  // 状态归一：定义层只有 ready（启用）与 cancelled（停用）两种展示态
  const status = item.status === 'cancelled' || !item.enabled ? 'cancelled' : 'ready'
  return {
    id: item.id,
    novelId: item.novelId,
    parentSessionId: item.parentSessionId,
    childSessionId: item.childSessionId,
    childRunId: item.childRunId,
    name: item.name,
    role: item.role as AgentSubtaskRole,
    triggerCondition: item.triggerCondition,
    callableBy: 'main_and_subagents',
    prompt: item.prompt,
    tokenBudget: item.tokenBudget,
    status,
    enabled: item.enabled,
    runCount: stats.runCount,
    lastRunAt: stats.lastRunAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

/** 内嵌调用统计：每个定义的累计调用次数与最近调用时间 */
async function loadSubtaskStats(ids: string[]): Promise<Map<string, { runCount: number; lastRunAt: Date | null }>> {
  if (!ids.length) return new Map()
  const grouped = await prisma.agentSubtaskRun.groupBy({ by: ['subtaskId'], where: { subtaskId: { in: ids } }, _count: { _all: true }, _max: { createdAt: true } })
  return new Map(grouped.map((row) => [row.subtaskId, { runCount: row._count._all, lastRunAt: row._max.createdAt }]))
}

function scheduleView(item: { id: string; novelId: string; sessionId: string; name: string; prompt: string; cadenceMinutes: number; nextRunAt: Date; lastRunId: string | null; status: string; createdAt: Date; updatedAt: Date }): AgentScheduleView {
  return { ...item, nextRunAt: item.nextRunAt.toISOString(), createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() }
}

function findSnapshotContent(parts: Prisma.JsonValue, chapterId: string): string | null {
  if (!Array.isArray(parts)) return null
  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue
    const record = part as Record<string, unknown>
    const snapshot = record.snapshot
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue
    const snap = snapshot as Record<string, unknown>
    const targetId = typeof snap.chapterId === 'string' ? snap.chapterId : typeof snap.targetId === 'string' ? snap.targetId : null
    if (targetId !== chapterId) continue
    if (snap.target === 'chapter' && snap.field === 'content' && typeof snap.previousValue === 'string') return snap.previousValue
    for (const key of ['content', 'beforeContent', 'previousContent']) {
      if (typeof snap[key] === 'string') return snap[key] as string
    }
  }
  return null
}

export async function listStoryBranches(userId: string, novelId: string) {
  await requireNovel(userId, novelId)
  const items = await prisma.storyBranch.findMany({ where: { userId, novelId }, orderBy: { updatedAt: 'desc' }, take: 100 })
  return { items: items.map(branchView) }
}

export async function createStoryBranch(userId: string, input: { novelId: string; chapterId: string; sourceRunId?: string | null; name: string }) {
  await requireNovel(userId, input.novelId)
  const chapter = await prisma.chapter.findFirst({ where: { id: input.chapterId, ...activeChapterScope(input.novelId), authorId: userId }, select: { id: true, content: true, revision: true } })
  if (!chapter) throw new DataAccessError(404, 'CHAPTER_NOT_FOUND', '章节不存在或无权访问。')
  let baseContent = chapter.content
  if (input.sourceRunId) {
    const run = await prisma.agentRun.findFirst({ where: { id: input.sourceRunId, userId, novelId: input.novelId }, select: { id: true } })
    if (!run) throw new DataAccessError(404, 'RUN_NOT_FOUND', '快照对应任务不存在。')
    const messages = await prisma.agentMessage.findMany({ where: { runId: run.id }, select: { parts: true }, orderBy: { createdAt: 'desc' } })
    baseContent = messages.map((message) => findSnapshotContent(message.parts, chapter.id)).find((content): content is string => content !== null) ?? chapter.content
  }
  const item = await prisma.storyBranch.create({ data: { userId, novelId: input.novelId, chapterId: chapter.id, sourceRunId: input.sourceRunId ?? null, name: input.name.trim().slice(0, 160), baseRevision: chapter.revision, baseContent, headContent: baseContent } })
  return { item: branchView(item) }
}

export async function updateStoryBranch(userId: string, branchId: string, input: { name?: string; content?: string }) {
  const branch = await prisma.storyBranch.findFirst({ where: { id: branchId, userId } })
  if (!branch) throw new DataAccessError(404, 'BRANCH_NOT_FOUND', '版本分支不存在。')
  const item = await prisma.storyBranch.update({ where: { id: branch.id }, data: { name: input.name?.trim().slice(0, 160), headContent: input.content } })
  return { item: branchView(item) }
}

function lineDelta(before: string, after: string) {
  const left = before.split('\n')
  const right = after.split('\n')
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1
  let suffix = 0
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1
  return { removedLines: Math.max(0, left.length - prefix - suffix), addedLines: Math.max(0, right.length - prefix - suffix) }
}

export async function getStoryBranchDiff(userId: string, branchId: string): Promise<{ diff: StoryBranchDiffView }> {
  const branch = await prisma.storyBranch.findFirst({ where: { id: branchId, userId } })
  if (!branch) throw new DataAccessError(404, 'BRANCH_NOT_FOUND', '版本分支不存在。')
  const chapter = await prisma.chapter.findFirst({ where: { id: branch.chapterId, ...activeChapterScope(branch.novelId), authorId: userId }, select: { title: true, revision: true } })
  if (!chapter) throw new DataAccessError(404, 'CHAPTER_NOT_FOUND', '源章节已不存在。')
  return { diff: { branchId: branch.id, chapterId: branch.chapterId, chapterTitle: chapter.title, baseRevision: branch.baseRevision, currentRevision: chapter.revision, conflicted: chapter.revision !== branch.baseRevision, before: branch.baseContent, after: branch.headContent, ...lineDelta(branch.baseContent, branch.headContent) } }
}

export async function mergeStoryBranch(userId: string, branchId: string) {
  const result = await prisma.$transaction(async (tx) => {
    const branch = await tx.storyBranch.findFirst({ where: { id: branchId, userId } })
    if (!branch) throw new DataAccessError(404, 'BRANCH_NOT_FOUND', '版本分支不存在。')
    await lockNovelActiveScope(tx, branch.novelId)
    if (branch.status !== 'active') throw new DataAccessError(409, 'BRANCH_NOT_ACTIVE', '该版本分支已合并或关闭。')
    const chapter = await tx.chapter.findFirst({ where: { id: branch.chapterId, ...activeChapterScope(branch.novelId), authorId: userId }, select: { revision: true, wordCount: true } })
    if (!chapter) throw new DataAccessError(404, 'CHAPTER_NOT_FOUND', '源章节已不存在。')
    const updated = await tx.chapter.updateMany({ where: { id: branch.chapterId, ...activeChapterScope(branch.novelId), authorId: userId, revision: branch.baseRevision }, data: { content: branch.headContent, wordCount: branch.headContent.length, revision: { increment: 1 } } })
    if (updated.count !== 1) throw new DataAccessError(409, 'BRANCH_CONFLICT', '源章节在分支创建后已变化，请比较差异后重新建立分支。')
    await tx.novel.update({ where: { id: branch.novelId }, data: { wordCount: { increment: branch.headContent.length - chapter.wordCount } } })
    return tx.storyBranch.update({ where: { id: branch.id }, data: { status: 'merged', mergedAt: new Date() } })
  })
  return { item: branchView(result) }
}

export async function listAgentSubtasks(userId: string, novelId: string) {
  await requireNovel(userId, novelId)
  const items = await prisma.agentSubtask.findMany({ where: { userId, novelId }, orderBy: { createdAt: 'desc' }, take: 100 })
  const stats = await loadSubtaskStats(items.map((item) => item.id))
  return { items: items.map((item) => subtaskView(item, stats.get(item.id) ?? { runCount: 0, lastRunAt: null })) }
}

export async function createAgentSubtask(userId: string, input: { novelId: string; parentSessionId?: string | null; name: string; role: AgentSubtaskRole; triggerCondition: string; prompt: string; tokenBudget?: number }) {
  await requireNovel(userId, input.novelId)
  if (input.parentSessionId) {
    const parent = await requireSession(userId, input.parentSessionId)
    if (parent.novelId !== input.novelId) throw new DataAccessError(400, 'SESSION_NOVEL_MISMATCH', '任务与作品不匹配。')
  }
  const name = input.name.trim().slice(0, 160)
  // 只落定义（模板）：执行由主 run 通过 subagent_run 内嵌发起，不再新建会话与独立 run
  const record = await prisma.agentSubtask.create({ data: { userId, novelId: input.novelId, parentSessionId: input.parentSessionId ?? null, name, role: input.role, triggerCondition: input.triggerCondition.trim(), callableBy: 'main_and_subagents', prompt: input.prompt.trim(), tokenBudget: input.tokenBudget ?? 16_000, status: 'ready', enabled: true } })
  return { item: subtaskView(record, { runCount: 0, lastRunAt: null }) }
}

export async function updateAgentSubtask(userId: string, subtaskId: string, input: { name?: string; role?: AgentSubtaskRole; triggerCondition?: string; prompt?: string; enabled?: boolean }) {
  const item = await prisma.agentSubtask.findFirst({ where: { id: subtaskId, userId } })
  if (!item) throw new DataAccessError(404, 'SUBTASK_NOT_FOUND', '子 Agent 不存在。')
  const name = input.name?.trim().slice(0, 160)
  const updated = await prisma.agentSubtask.update({
    where: { id: item.id },
    data: {
      name,
      role: input.role,
      triggerCondition: input.triggerCondition?.trim(),
      prompt: input.prompt?.trim(),
      ...(input.enabled === undefined ? {} : input.enabled
        ? { enabled: true, status: 'ready' }
        : { enabled: false, status: 'cancelled', cancelledAt: new Date() }),
    },
  })
  // 停用时兼容旧架构：旧数据可能仍挂着独立子 run，一并停止
  if (input.enabled === false && item.childRunId) await stopLoopRun(userId, item.childRunId).catch(() => {})
  const stats = await loadSubtaskStats([item.id])
  return { item: subtaskView(updated, stats.get(item.id) ?? { runCount: 0, lastRunAt: null }) }
}

export async function deleteAgentSubtask(userId: string, subtaskId: string) {
  const item = await prisma.agentSubtask.findFirst({ where: { id: subtaskId, userId } })
  if (!item) throw new DataAccessError(404, 'SUBTASK_NOT_FOUND', '子 Agent 不存在。')
  if (item.childRunId) await stopLoopRun(userId, item.childRunId).catch(() => {})
  // 调用记录随定义级联删除；旧架构的独立会话归档保留历史，避免外键阻断或历史丢失
  await prisma.$transaction([
    prisma.agentSubtask.delete({ where: { id: item.id } }),
    ...(item.childSessionId ? [prisma.agentSession.update({ where: { id: item.childSessionId }, data: { status: 'archived' } })] : []),
  ])
  return { deleted: true }
}

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function shortText(value: unknown, fallback = ''): string {
  const text = typeof value === 'string' ? value : fallback
  return text.length > 180 ? `${text.slice(0, 177)}…` : text
}

function eventLog(record: { id: string; type: string; payload: Prisma.JsonValue; createdAt: Date }) {
  const payload = asRecord(record.payload)
  const mapping: Record<string, { title: string; detail: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
    'run.started': { title: '开始执行', detail: shortText(payload.title, '子 Agent 已接收任务并开始工作。'), tone: 'neutral' },
    'message.start': { title: '开始组织回复', detail: '正在整理任务结果。', tone: 'neutral' },
    'text.final': { title: '生成回复', detail: shortText(payload.text, '已生成一段回复。'), tone: 'neutral' },
    'tool.call': { title: '调用工具', detail: shortText(payload.title, typeof payload.toolName === 'string' ? payload.toolName : '正在使用工作区工具。'), tone: 'neutral' },
    'tool.result': { title: payload.ok === false ? '工具执行未完成' : '工具执行完成', detail: shortText(payload.summary, '工具已返回结果。'), tone: payload.ok === false ? 'warning' : 'success' },
    'permission.ask': { title: '等待授权', detail: shortText(payload.title, '需要用户确认后继续。'), tone: 'warning' },
    'run.paused': { title: '执行已暂停', detail: payload.reason === 'approval_timeout' ? '等待授权超时。' : '任务已由用户暂停。', tone: 'warning' },
    'run.finished': { title: payload.status === 'succeeded' ? '任务已完成' : payload.status === 'cancelled' ? '任务已取消' : '任务执行失败', detail: shortText(payload.outputSummary, '本次执行已经结束。'), tone: payload.status === 'succeeded' ? 'success' : payload.status === 'cancelled' ? 'warning' : 'danger' },
    error: { title: '执行异常', detail: shortText(payload.message, '运行过程中发生异常。'), tone: 'danger' },
  }
  const translated = mapping[record.type] ?? { title: '执行进度', detail: '子 Agent 更新了运行状态。', tone: 'neutral' as const }
  return { id: record.id, time: record.createdAt.toISOString(), ...translated }
}

export async function getAgentSubtaskLogs(userId: string, subtaskId: string): Promise<AgentSubtaskLogsView> {
  const item = await prisma.agentSubtask.findFirst({ where: { id: subtaskId, userId } })
  if (!item) throw new DataAccessError(404, 'SUBTASK_NOT_FOUND', '子 Agent 不存在。')
  const entries: AgentSubtaskLogEntry[] = []
  // 新架构：内嵌调用记录（最近 20 次）
  const runs = await prisma.agentSubtaskRun.findMany({ where: { subtaskId: item.id }, orderBy: { createdAt: 'desc' }, take: 20 })
  for (const run of runs) {
    const running = run.status === 'running'
    const ok = run.status === 'succeeded'
    entries.push({
      id: run.id,
      time: run.createdAt.toISOString(),
      title: running ? '正在内嵌执行' : ok ? '内嵌调用完成' : '内嵌调用未完成',
      detail: shortText(run.resultSummary ?? run.task, '本次调用已结束。'),
      tone: ok ? 'success' : running ? 'neutral' : 'warning',
    })
  }
  // 旧架构兑底：历史独立 child run 的事件流
  if (item.childRunId) {
    const events = await prisma.agentRunEvent.findMany({ where: { runId: item.childRunId }, orderBy: { seq: 'asc' }, take: 300 })
    entries.push(...events.filter((event) => !['text.delta', 'reasoning.delta', 'tool.delta', 'step.finish', 'message.start'].includes(event.type)).map(eventLog))
  }
  if (entries.length === 0) entries.push({ id: `${item.id}-created`, time: item.createdAt.toISOString(), title: '已创建子 Agent', detail: `触发条件：${item.triggerCondition}`, tone: 'neutral' })
  return { subtaskId: item.id, name: item.name, status: item.enabled ? 'ready' : item.status, entries }
}

export async function cancelAgentSubtask(userId: string, subtaskId: string) {
  const item = await prisma.agentSubtask.findFirst({ where: { id: subtaskId, userId } })
  if (!item) throw new DataAccessError(404, 'SUBTASK_NOT_FOUND', '子 Agent 任务不存在。')
  // 停用语义：定义保留但不再出现在主 Agent 目录；旧架构的独立子 run 一并停止
  if (item.childRunId) await stopLoopRun(userId, item.childRunId).catch(() => {})
  const updated = await prisma.agentSubtask.update({ where: { id: item.id }, data: { enabled: false, status: 'cancelled', cancelledAt: new Date() } })
  const stats = await loadSubtaskStats([item.id])
  return { item: subtaskView(updated, stats.get(item.id) ?? { runCount: 0, lastRunAt: null }) }
}

/** 主 run 的服务端执行目录：尾部注入，主控据此按触发条件用 subagent_run 内嵌调用。 */
export async function renderSubagentCatalog(userId: string, novelId: string, pinnedSubagentId?: string): Promise<string> {
  const { requireSelectedSubagent, selectedSubagentGuidance } = await import('./subagent-selection.js')
  const pinned = pinnedSubagentId ? await requireSelectedSubagent(userId, novelId, pinnedSubagentId) : null
  const items = await prisma.agentSubtask.findMany({ where: { userId, novelId, enabled: true }, orderBy: { createdAt: 'asc' }, take: 20, select: { id: true, name: true, role: true, triggerCondition: true, prompt: true } })
  const listed = pinned ? [pinned, ...items.filter(item => item.id !== pinned.id)].slice(0, 20) : items
  if (!listed.length) return ''
  return [
    '[子 Agent 目录] 你可以像调用工具一样，用 subagent_run 把命中触发条件的任务交给以下具名子 Agent 内嵌执行（不新开任务窗口；它会自主使用工具完成任务并返回报告，你必须审查其报告后再向作者汇报；调用时传 subagentId 与自包含的 task）：',
    ...(pinned ? [selectedSubagentGuidance(pinned.id)] : []),
    ...listed.map((item) => `- 「${item.name}」（subagentId=${item.id}，角色=${item.role}）\n  触发条件：${item.triggerCondition}\n  职责：${item.prompt}`),
  ].join('\n')
}

export async function listAgentSchedules(userId: string, novelId: string) {
  await requireNovel(userId, novelId)
  const items = await prisma.agentSchedule.findMany({ where: { userId, novelId }, orderBy: { updatedAt: 'desc' }, take: 100 })
  return { items: items.map(scheduleView) }
}

export async function createAgentSchedule(userId: string, input: { novelId: string; sessionId: string; name: string; prompt: string; cadenceMinutes: number; nextRunAt?: string }) {
  const session = await requireSession(userId, input.sessionId)
  if (session.novelId !== input.novelId) throw new DataAccessError(400, 'SESSION_NOVEL_MISMATCH', '任务与作品不匹配。')
  const item = await prisma.agentSchedule.create({ data: { userId, novelId: input.novelId, sessionId: session.id, name: input.name.trim().slice(0, 160), prompt: input.prompt.trim(), cadenceMinutes: input.cadenceMinutes, nextRunAt: input.nextRunAt ? new Date(input.nextRunAt) : new Date(Date.now() + input.cadenceMinutes * 60_000) } })
  return { item: scheduleView(item) }
}

export async function updateAgentSchedule(userId: string, scheduleId: string, input: { status?: 'active' | 'paused'; nextRunAt?: string }) {
  const schedule = await prisma.agentSchedule.findFirst({ where: { id: scheduleId, userId } })
  if (!schedule) throw new DataAccessError(404, 'SCHEDULE_NOT_FOUND', '定时任务不存在。')
  const item = await prisma.agentSchedule.update({ where: { id: schedule.id }, data: { status: input.status, nextRunAt: input.nextRunAt ? new Date(input.nextRunAt) : undefined, lockedAt: null } })
  return { item: scheduleView(item) }
}

export async function runDueAgentSchedules(now = new Date()) {
  const due = await prisma.agentSchedule.findMany({ where: { status: 'active', nextRunAt: { lte: now }, OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - 10 * 60_000) } }] }, take: 8, orderBy: { nextRunAt: 'asc' } })
  for (const schedule of due) {
    const locked = await prisma.agentSchedule.updateMany({ where: { id: schedule.id, status: 'active', nextRunAt: { lte: now }, OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - 10 * 60_000) } }] }, data: { lockedAt: now } })
    if (!locked.count) continue
    try {
      const run = await startLoopRun(schedule.userId, { sessionId: schedule.sessionId, novelId: schedule.novelId, mode: 'build', prompt: schedule.prompt, creativeFreedom: 'balanced', qualityMode: 'premium', modelTier: 'speed', reasoningEffort: 'high' })
      await prisma.agentSchedule.update({ where: { id: schedule.id }, data: { lastRunId: run.runId, nextRunAt: new Date(now.getTime() + schedule.cadenceMinutes * 60_000), lockedAt: null } })
    } catch {
      await prisma.agentSchedule.update({ where: { id: schedule.id }, data: { nextRunAt: new Date(now.getTime() + 5 * 60_000), lockedAt: null } }).catch(() => {})
    }
  }
}

export async function listEvalComparisons(userId: string, novelId: string) {
  await requireNovel(userId, novelId)
  const items = await prisma.agentEvalComparison.findMany({ where: { userId, novelId }, orderBy: { createdAt: 'desc' }, take: 50 })
  return { items: items.map((item) => ({ id: item.id, novelId: item.novelId, name: item.name, runIds: item.runIds as string[], metrics: item.metrics as unknown as AgentEvalRunMetric[], createdAt: item.createdAt.toISOString() } satisfies AgentEvalComparisonView)) }
}

export async function createEvalComparison(userId: string, input: { novelId: string; name: string; runIds: string[] }) {
  await requireNovel(userId, input.novelId)
  const runs = await prisma.agentRun.findMany({ where: { id: { in: input.runIds }, userId, novelId: input.novelId }, select: { id: true, modelTier: true, reasoningEffort: true, status: true, usage: true, startedAt: true, finishedAt: true, outputSummary: true } })
  if (runs.length !== new Set(input.runIds).size) throw new DataAccessError(404, 'RUN_NOT_FOUND', '部分对比任务不存在或不属于当前作品。')
  const metrics: AgentEvalRunMetric[] = runs.map((run) => {
    const usage = run.usage && typeof run.usage === 'object' && !Array.isArray(run.usage) ? run.usage as Record<string, unknown> : {}
    return { runId: run.id, modelTier: run.modelTier, reasoningEffort: run.reasoningEffort, status: run.status, promptTokens: Number(usage.promptTokens ?? 0), completionTokens: Number(usage.completionTokens ?? 0), totalTokens: Number(usage.totalTokens ?? 0), durationMs: run.startedAt && run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null, outputSummary: run.outputSummary }
  })
  const item = await prisma.agentEvalComparison.create({ data: { userId, novelId: input.novelId, name: input.name.trim().slice(0, 160), runIds: input.runIds, metrics: metrics as unknown as Prisma.InputJsonValue } })
  return { item: { id: item.id, novelId: item.novelId, name: item.name, runIds: input.runIds, metrics, createdAt: item.createdAt.toISOString() } satisfies AgentEvalComparisonView }
}
