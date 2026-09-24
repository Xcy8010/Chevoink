import type { Prisma } from '@prisma/client'
import { readAuthorEnded } from './author-ended.js'
import type { AgentRun, AgentTodoSnapshot } from '../../../shared/contracts/index.js'
import { getTaskRunIds } from './task-lineage.js'
import { loadSessionTodoItems } from './tools/todo-tools.js'
import { readDurableTodoItems } from './tools/durable-todo.js'
import { readExecutionStateInTransaction } from './runtime-state.js'
import type { AgentRollbackChapterRef, AgentRollbackImpactPreview, AgentRollbackResult, AgentRollbackSnapshot, AgentUIMessage } from '../../../shared/contracts/index.js'
import type { AgentMessagePart } from '../../../shared/contracts/index.js'
import { DataAccessError, prisma } from '../prisma.js'
import { activeChapterScope, assertActiveWriteCount, recalculateNovelStats, updateActiveChapter } from '../data/internal.js'
import { normalizeNovelStructure } from '../data/volume.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { getActiveRunIdBySession, hasActiveRunInSession } from './active-runs.js'
import { publishDurableEvents } from './runtime-event-projection.js'

const historyRunState = { select: { runtimeProtocolVersion: true, status: true, finishedAt: true, taskRoot: { select: { status: true } } } } as const

function visibleHistoryParts(parts: AgentMessagePart[], run: { runtimeProtocolVersion: number; taskRoot: { status: string } | null }): AgentMessagePart[] {
  const stopped = run.runtimeProtocolVersion === 1 && ['paused', 'completed'].includes(run.taskRoot?.status ?? '')
  return parts.map(part => {
    if (part.type !== 'tool-call') return part
    const visible = part.snapshot ? { ...part, snapshot: undefined } : part
    // Match the existing live terminal reducer without marking the operation
    // failed in execution storage: an unknown result still needs reconciliation.
    return stopped && part.status === 'running' ? { ...visible, status: 'failed' as const, summary: run.taskRoot?.status === 'paused' ? '已停止' : '已中断' } : visible
  })
}

async function synchronizeDurableHistory(userId: string, runs: Array<{ id: string; runtimeProtocolVersion: number; taskRootId: string | null }>) {
  const roots = new Set<string>()
  for (const run of runs) {
    if (run.runtimeProtocolVersion !== 1 || !run.taskRootId || roots.has(run.taskRootId)) continue
    roots.add(run.taskRootId)
    // History must also work when no browser was connected during execution.
    // Batches are bounded; all writes remain the same root-locked projection.
    while ((await publishDurableEvents(userId, run.id, 200)).length >= 200) { /* drain committed history */ }
  }
}

/**
 * 任务会话消息服务（自 run-service.ts 模块级拆分而来，行为原样保留）：
 * 历史消息拉取、单轮删除与快照回滚。
 */

/** 旧版 view_image 把 coverAssetId 直接存进 display 图片地址，前端渲染即破图；
 * 读侧按归属批量反查真实图片地址替换（只读自愈，不改库） */
async function normalizeLegacyViewedImageUrls(userId: string, parts: AgentMessagePart[]): Promise<AgentMessagePart[]> {
  const candidateIds = new Set<string>()
  for (const part of parts) {
    if (part.type !== 'tool-call' || part.display?.kind !== 'viewedImage') continue
    for (const image of part.display.images) {
      if (!image.url.startsWith('http://') && !image.url.startsWith('https://') && !image.url.startsWith('/')) {
        candidateIds.add(image.url)
      }
    }
  }
  if (candidateIds.size === 0) return parts

  const assets = await prisma.coverAsset.findMany({
    where: { id: { in: Array.from(candidateIds) }, ownerUserId: userId },
    select: { id: true, imageUrl: true },
  })
  if (assets.length === 0) return parts
  const urlById = new Map(assets.map((asset) => [asset.id, asset.imageUrl] as const))

  return parts.map((part) => {
    if (part.type !== 'tool-call' || part.display?.kind !== 'viewedImage') return part
    let changed = false
    const images = part.display.images.map((image) => {
      const resolved = urlById.get(image.url)
      if (!resolved) return image
      changed = true
      return { ...image, url: resolved }
    })
    return changed ? { ...part, display: { ...part.display, images } } : part
  })
}

/** 刷新后「继续执行」按钮的数据来源：当前无活跃 run 时，仅当会话「最近一个」run 停在 failed/paused 才供前端续跑。
 * 不能取历史任意 failed run：旧 run 失败后作者已开新 run 并正常收尾时，任务已闭环，
 * 刷新后不应再冒「继续执行」按钮（作者反馈：收尾完成后刷新仍见按钮）。 */
async function getSessionRunState(sessionId: string): Promise<{ activeRunId: string | null; resumeRunId: string | null; authorEnded?: AgentRun['authorEnded'] }> {
  const local = getActiveRunIdBySession(sessionId)
  if (local) return { activeRunId: local, resumeRunId: null }
  const run = await prisma.agentRun.findFirst({
    where: { sessionId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, status: true, usage: true, runtimeProtocolVersion: true, taskRoot: { select: { status: true } } },
  })
  const durableActive = run?.runtimeProtocolVersion === 1 && run.taskRoot?.status === 'active'
    && ['queued', 'running', 'awaiting_approval'].includes(run.status)
  const ending = readAuthorEnded(run?.usage)
  return { activeRunId: durableActive ? run.id : null, ...ending,
    resumeRunId: !ending.authorEnded && run && (run.status === 'failed' || run.status === 'paused') ? run.id : null }
}

/** 读取当前逻辑任务的权威清单，避免会话旧消息和衍生副本覆盖真实状态。 */
export async function loadCurrentTodoSnapshot(userId: string, sessionId: string): Promise<AgentTodoSnapshot | null> {
  return prisma.$transaction(async tx => {
    const run = await tx.agentRun.findFirst({ where: { userId, sessionId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, taskSpec: true, taskRootId: true, runtimeProtocolVersion: true, usage: true } })
    if (!run) return null
    const spec = run.taskSpec
    const taskId = run.taskRootId ?? (spec && typeof spec === 'object' && !Array.isArray(spec) && typeof spec.id === 'string' ? spec.id : run.id)
    const ended = readAuthorEnded(run.usage).authorEnded
    if (ended?.todoItems) return { runId: run.id, taskId, items: ended.todoItems }
    if (run.runtimeProtocolVersion === 1 && run.taskRootId) {
      // 初次准入尚未初始化时清单为空；已提交但尚未 reduce 的操作不能倒灌进执行状态。
      const head = await tx.agentExecutionState.findUnique({ where: { taskRootId: run.taskRootId } })
      if (!head) return { runId: run.id, taskId, items: [] }
      const state = await readExecutionStateInTransaction(tx, run.taskRootId)
      return { runId: run.id, taskId, items: await readDurableTodoItems(tx, run.taskRootId, state.head.revision, state.frame.state.pendingOperationId) }
    }
    return { runId: run.id, taskId, items: await loadSessionTodoItems(sessionId, await getTaskRunIds(sessionId, run.id, tx), tx) }
  }, { isolationLevel: 'RepeatableRead' })
}

export type ListSessionMessagesOptions = {
  /** 加载更早游标：只取早于该时间开始的 run 轮次 */
  beforeRunStartedAt?: string | null
  /** 单页轮数上限（按 run 计） */
  runLimit?: number
}

/** 拉取整轮消息与当前任务状态；分页仅影响历史展示，不影响 Agent 执行上下文。 */
export async function listLoopSessionMessages(
  userId: string,
  sessionId: string,
  options: ListSessionMessagesOptions = {},
): Promise<{
  messages: AgentUIMessage[]
  activeRunId: string | null
  /** 无活跃 run 但存在可续跑的 failed/paused run：前端据此在刷新后仍显示「继续执行」按钮 */
  resumeRunId: string | null
  authorEnded?: AgentRun['authorEnded']
  todoSnapshot: AgentTodoSnapshot | null
  pagination: { hasMore: boolean; earliestRunStartedAt: string | null }
  /** 分支溯源：非空时前端在复制过来的对话下方渲染「从聊天中继续」分隔线 */
  fork: { forkedFromSessionId: string; forkedFromMessageId: string | null; forkedAt: string | null } | null
}> {
  const session = await prisma.agentSession.findFirst({
    where: { id: sessionId, userId },
    select: { id: true, forkedFromSessionId: true, forkedFromMessageId: true, forkedAt: true },
  })

  if (!session) {
    throw new DataAccessError(404, 'NOT_FOUND', '会话不存在或无权访问。')
  }

  const fork = session.forkedFromSessionId
    ? {
        forkedFromSessionId: session.forkedFromSessionId,
        forkedFromMessageId: session.forkedFromMessageId,
        forkedAt: session.forkedAt?.toISOString() ?? null,
      }
    : null

  const runLimit = options.runLimit ?? null
  if (runLimit != null) {
    // 分页模式：先取 run 轮次窗口（多取 1 个判断 hasMore），再取窗口内全部消息；
    // 按 run 整轮返回，天然不会把某轮截成两半
    const runs = await prisma.agentRun.findMany({
      where: {
        sessionId,
        ...(options.beforeRunStartedAt ? { createdAt: { lt: new Date(options.beforeRunStartedAt) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: runLimit + 1,
    })
    const hasMore = runs.length > runLimit
    const pageRuns = runs.slice(0, runLimit)
    await synchronizeDurableHistory(userId, pageRuns)
    const pageRunIds = pageRuns.map((run) => run.id)
    const pageRootIds = pageRuns.flatMap(run => run.runtimeProtocolVersion === 1 && run.taskRootId ? [run.taskRootId] : [])
    const records = pageRunIds.length
      ? await prisma.agentMessage.findMany({
          // A resumed durable run shares the original task's message identities.
          // Keep that logical task whole even when its original run is outside
          // this page; otherwise a fresh reload can lose the prompt/tool cards.
          where: { sessionId, ...(pageRootIds.length ? { OR: [{ runId: { in: pageRunIds } }, { run: { taskRootId: { in: pageRootIds } } }] }
            : { runId: { in: pageRunIds } }) },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: { run: historyRunState },
        })
      : []

    const pagedMessages: AgentUIMessage[] = []
    for (const record of records) {
      const stripped = visibleHistoryParts(record.parts as unknown as AgentMessagePart[], record.run)
      pagedMessages.push({
        id: record.id,
        runId: record.runId,
        role: record.role as 'user' | 'assistant',
        parts: await normalizeLegacyViewedImageUrls(userId, stripped),
        createdAt: record.createdAt.toISOString(),
        completedAt: record.role === 'assistant' && record.run.status === 'completed' ? record.run.finishedAt?.toISOString() ?? null : null,
      })
    }

    return {
      messages: pagedMessages,
      ...await getSessionRunState(sessionId),
      todoSnapshot: await loadCurrentTodoSnapshot(userId, sessionId),
      pagination: {
        hasMore,
        earliestRunStartedAt: pageRuns.length ? pageRuns[pageRuns.length - 1].createdAt.toISOString() : null,
      },
      fork,
    }
  }

  // 全量模式（删除/回退后的界面重拉等低频操作）：保留大窗口，避免已加载内容变少
  const durableRuns = await prisma.agentRun.findMany({ where: { sessionId, runtimeProtocolVersion: 1, taskRootId: { not: null } },
    orderBy: { createdAt: 'desc' }, distinct: ['taskRootId'], take: 2000,
    select: { id: true, runtimeProtocolVersion: true, taskRootId: true } })
  await synchronizeDurableHistory(userId, durableRuns)
  const newestRecords = await prisma.agentMessage.findMany({
    where: { sessionId },
    // 必须先取最新窗口再恢复为时间正序。旧实现按 asc + take 会永久截掉
    // 长会话末尾的工具操作与最终总结，刷新后看起来就像“上一轮消失”。
    // 窗口提到 2000：多章长会话（每轮几十个工具消息）轻松超过 500，
    // 截掉的会是最早几轮（开场/前几章的总结与操作），刷新后像“前面的内容丢了”。
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 2000,
    include: { run: historyRunState },
  })
  const records = newestRecords.reverse()

  // 轮次完整性：窗口边界若切在同一轮 run 中间，把该轮更早的消息补齐。
  // 否则最老一轮只剩后半截（如只剩总结没有操作），看起来像内容丢失。
  const boundary = records[0]
  if (boundary?.runId) {
    const runEarliest = await prisma.agentMessage.findFirst({
      where: { sessionId, runId: boundary.runId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    })
    if (runEarliest && runEarliest.id !== boundary.id) {
      const remainder = await prisma.agentMessage.findMany({
        where: { sessionId, runId: boundary.runId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { run: historyRunState },
      })
      const known = new Set(records.map((record) => record.id))
      records.unshift(...remainder.filter((record) => !known.has(record.id)))
    }
  }

  const messages: AgentUIMessage[] = []
  for (const record of records) {
    const stripped = visibleHistoryParts(record.parts as unknown as AgentMessagePart[], record.run)
    messages.push({
      id: record.id,
      runId: record.runId,
      role: record.role as 'user' | 'assistant',
      parts: await normalizeLegacyViewedImageUrls(userId, stripped),
      createdAt: record.createdAt.toISOString(),
      completedAt: record.role === 'assistant' && record.run.status === 'completed' ? record.run.finishedAt?.toISOString() ?? null : null,
    })
  }

  return {
    messages,
    ...await getSessionRunState(sessionId),
    todoSnapshot: await loadCurrentTodoSnapshot(userId, sessionId),
    pagination: { hasMore: false, earliestRunStartedAt: null },
    fork,
  }
}

async function findOwnedSessionMessage(userId: string, sessionId: string, messageId: string) {
  const session = await prisma.agentSession.findFirst({
    where: { id: sessionId, userId },
    select: { id: true, novelId: true },
  })

  if (!session) {
    throw new DataAccessError(404, 'NOT_FOUND', '会话不存在或无权访问。')
  }

  const message = await prisma.agentMessage.findFirst({
    where: { id: messageId, sessionId },
  })

  if (!message) {
    throw new DataAccessError(404, 'NOT_FOUND', '消息不存在或已被删除。')
  }

  if (hasActiveRunInSession(sessionId) || (await getSessionRunState(sessionId)).activeRunId) {
    throw new DataAccessError(409, 'RUN_IN_PROGRESS', '当前会话有任务正在执行，请先停止后再操作。')
  }

  return { session, message }
}

/** 删除一轮对话：按消息所属 run 整轮删除（级联清理消息/事件），不恢复工作区内容 */
export async function deleteLoopSessionMessage(
  userId: string,
  sessionId: string,
  messageId: string,
): Promise<{ deleted: true; runId: string }> {
  const { message } = await findOwnedSessionMessage(userId, sessionId, messageId)

  await prisma.$transaction(async (tx) => {
    await tx.projectMemoryEntry.deleteMany({ where: { runId: message.runId } })
    await tx.agentArtifact.deleteMany({ where: { runId: message.runId } })
    await tx.agentRun.delete({ where: { id: message.runId } }).catch(() => {})
  })

  return { deleted: true, runId: message.runId }
}

type CollectedRollback =
  | { kind: 'snapshot'; snapshot: AgentRollbackSnapshot }
  | { kind: 'created_chapter'; chapterId: string }

/** 从一批消息中按时间正序收集可回滚动作（快照 + 新建章节） */
function collectRollbackActions(records: Array<{ parts: unknown }>): CollectedRollback[] {
  const actions: CollectedRollback[] = []

  for (const record of records) {
    const parts = record.parts as AgentMessagePart[]
    if (!Array.isArray(parts)) {
      continue
    }
    for (const part of parts) {
      if (part.type !== 'tool-call' || part.status !== 'success') {
        continue
      }
      if (part.toolName === 'chapter_create' && part.display?.kind === 'chapterRef') {
        actions.push({ kind: 'created_chapter', chapterId: part.display.chapterId })
        continue
      }
      if (part.snapshot) {
        actions.push({ kind: 'snapshot', snapshot: part.snapshot })
      }
    }
  }

  return actions
}

type RollbackChapterRow = {
  id: string
  title: string
  publishedTitle: string | null
  status: string
  publishedRevision: number | null
}

type RollbackClassification = {
  missingIds: string[]
  removedRefs: AgentRollbackChapterRef[]
  restoredRefs: AgentRollbackChapterRef[]
  protectedRefs: AgentRollbackChapterRef[]
  novelFields: string[]
}

/** 已发布章节的创作稿不允许被回退破坏：新建章节的删除、正文/标题的快照还原一律跳过。
 * 否则章节行会被物理删除（读者端断链消失），或正文被还原成空快照（创作区被清空）。 */
function isPublishedChapterRow(row: Pick<RollbackChapterRow, 'status' | 'publishedRevision'>): boolean {
  return row.status === 'published' || row.publishedRevision != null
}

/** 分类回退动作的目标：不存在的目标保持原 409 语义；已发布章节进保护清单；其余按删除/还原归类 */
async function classifyRollbackActions(
  db: Prisma.TransactionClient,
  userId: string,
  novelId: string,
  actions: CollectedRollback[],
): Promise<RollbackClassification> {
  const chapterIds = [...new Set(actions.flatMap(action => action.kind === 'created_chapter'
    ? [action.chapterId] : action.snapshot.target === 'chapter' ? [action.snapshot.targetId] : []))]
  const rows: RollbackChapterRow[] = chapterIds.length
    ? await db.chapter.findMany({
        where: { id: { in: chapterIds }, authorId: userId, ...activeChapterScope(novelId) },
        select: { id: true, title: true, publishedTitle: true, status: true, publishedRevision: true },
      })
    : []
  const byId = new Map(rows.map(row => [row.id, row] as const))
  const toRef = (row: RollbackChapterRow): AgentRollbackChapterRef => ({ chapterId: row.id, title: row.publishedTitle ?? row.title })

  const classification: RollbackClassification = { missingIds: [], removedRefs: [], restoredRefs: [], protectedRefs: [], novelFields: [] }
  const protectedIds = new Set<string>()
  const removedIds = new Set<string>()
  const restoredIds = new Set<string>()

  for (const action of actions) {
    if (action.kind === 'snapshot' && action.snapshot.target === 'novel') {
      if (!classification.novelFields.includes(action.snapshot.field)) {
        classification.novelFields.push(action.snapshot.field)
      }
      continue
    }

    const chapterId = action.kind === 'created_chapter' ? action.chapterId : action.snapshot.targetId
    const row = byId.get(chapterId)
    if (!row) {
      if (!classification.missingIds.includes(chapterId)) {
        classification.missingIds.push(chapterId)
      }
      continue
    }

    if (isPublishedChapterRow(row)) {
      if (!protectedIds.has(chapterId)) {
        protectedIds.add(chapterId)
        classification.protectedRefs.push(toRef(row))
      }
    } else if (action.kind === 'created_chapter') {
      if (!removedIds.has(chapterId)) {
        removedIds.add(chapterId)
        classification.removedRefs.push(toRef(row))
      }
    } else if (!restoredIds.has(chapterId)) {
      restoredIds.add(chapterId)
      classification.restoredRefs.push(toRef(row))
    }
  }

  return classification
}

/** 回退执行与影响预览共用的目标解析：校验会话归属与活跃 run，返回待回退的 run 与动作清单 */
async function resolveRollbackScope(
  userId: string,
  sessionId: string,
  messageId: string,
): Promise<{ session: { id: string; novelId: string }; runIds: string[]; actions: CollectedRollback[] }> {
  const { session, message } = await findOwnedSessionMessage(userId, sessionId, messageId)

  const targetRun = await prisma.agentRun.findUnique({
    where: { id: message.runId },
    select: { id: true, createdAt: true },
  })

  if (!targetRun) {
    throw new DataAccessError(404, 'NOT_FOUND', '对应的任务记录不存在。')
  }

  const runs = await prisma.agentRun.findMany({
    where: { sessionId, createdAt: { gte: targetRun.createdAt } },
    select: { id: true },
  })
  const runIds = runs.map((run) => run.id)

  const records = await prisma.agentMessage.findMany({
    where: { runId: { in: runIds } },
    orderBy: { createdAt: 'asc' },
    select: { parts: true },
  })

  // 后发生的先恢复：同一字段多次写入时最终回到最早的 previousValue
  const actions = collectRollbackActions(records).reverse()
  return { session, runIds, actions }
}

/**
 * 回退到某轮对话之前：逆序重放该轮及之后所有写操作的快照（新建章节直接删除），
 * 然后删除这些 run（级联清理消息/事件/记忆/产物）。
 * 已发布章节受保护：新建删除与正文/标题快照还原一律跳过，只保留现状。
 */
export async function rollbackLoopSessionFromMessage(
  userId: string,
  sessionId: string,
  messageId: string,
): Promise<AgentRollbackResult> {
  const { session, runIds, actions } = await resolveRollbackScope(userId, sessionId, messageId)

  const result = await prisma.$transaction(async (tx) => {
    await lockNovelActiveScope(tx, session.novelId)
    for (const runId of runIds) await assertAgentManuscriptCurrent(tx, { userId, novelId: session.novelId, runId })
    // Validate the entire rollback before deleting history or touching content.
    // Old run snapshots are not authority to modify import-retained chapters.
    // 已发布章节进入保护清单：读者端不能因回退断链，创作区正文也不能被回退清空。
    const classification = await classifyRollbackActions(tx, userId, session.novelId, actions)
    if (classification.missingIds.length) throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '回滚目标已归档或不存在，未修改正文或任务历史。')
    const protectedIds = new Set(classification.protectedRefs.map((reference) => reference.chapterId))
    for (const action of actions) {
      if (action.kind === 'created_chapter') {
        if (protectedIds.has(action.chapterId)) {
          continue
        }
        const deleted = await tx.chapter.deleteMany({ where: { id: action.chapterId, authorId: userId, ...activeChapterScope(session.novelId) } })
        assertActiveWriteCount(deleted.count, 'chapter')
        continue
      }

      const { snapshot } = action
      if (snapshot.target === 'chapter') {
        if (protectedIds.has(snapshot.targetId)) {
          continue
        }
        const exists = await tx.chapter.findFirst({
          where: { id: snapshot.targetId, authorId: userId, ...activeChapterScope(session.novelId) },
          select: { id: true, revision: true },
        })
        if (!exists) {
          continue
        }
        if (snapshot.field === 'content') {
          const content = snapshot.previousValue ?? ''
          await updateActiveChapter(tx, { id: snapshot.targetId, novelId: session.novelId, authorId: userId, revision: exists.revision },
            { content, wordCount: content.length, revision: { increment: 1 } })
        } else if (snapshot.field === 'title') {
          await updateActiveChapter(tx, { id: snapshot.targetId, novelId: session.novelId, authorId: userId, revision: exists.revision },
            { title: snapshot.previousValue ?? '', revision: { increment: 1 } })
        }
        continue
      }

      // novel 字段快照：白名单内逐字段恢复，status 需要枚举合法才写回
      if (snapshot.field === 'title' && snapshot.previousValue !== null) {
        await tx.novel.update({ where: { id: session.novelId }, data: { title: snapshot.previousValue } })
      } else if (snapshot.field === 'summary') {
        await tx.novel.update({ where: { id: session.novelId }, data: { summary: snapshot.previousValue ?? '' } })
      } else if (snapshot.field === 'coverPrompt') {
        await tx.novel.update({ where: { id: session.novelId }, data: { coverPrompt: snapshot.previousValue } })
      } else if (snapshot.field === 'coverAssetId') {
        await tx.novel.update({ where: { id: session.novelId }, data: { coverAssetId: snapshot.previousValue } })
      } else if (
        snapshot.field === 'status' &&
        (snapshot.previousValue === 'draft' ||
          snapshot.previousValue === 'published' ||
          snapshot.previousValue === 'completed' ||
          snapshot.previousValue === 'archived')
      ) {
        await tx.novel.update({
          where: { id: session.novelId },
          data: { status: snapshot.previousValue },
        })
      }
    }

    // Reuse the two-phase chapter AND volume ordering algorithm; retained rows
    // neither consume active positions nor contribute to creative statistics.
    await normalizeNovelStructure(tx, session.novelId)
    await recalculateNovelStats(tx, session.novelId)

    await tx.projectMemoryEntry.deleteMany({ where: { runId: { in: runIds } } })
    await tx.agentArtifact.deleteMany({ where: { runId: { in: runIds } } })
    await tx.agentRun.deleteMany({ where: { id: { in: runIds } } })

    return { protectedChapters: classification.protectedRefs }
  })

  return { rolledBack: true, removedRunCount: runIds.length, protectedChapters: result.protectedChapters }
}

/** 回退影响预览（只读）：确认弹窗前展示将删除/还原/保留的内容，不写任何数据；
 * 与服务端执行共享同一分类逻辑，预览与回退结果保持一致 */
export async function previewLoopSessionRollback(
  userId: string,
  sessionId: string,
  messageId: string,
): Promise<AgentRollbackImpactPreview> {
  const { session, runIds, actions } = await resolveRollbackScope(userId, sessionId, messageId)

  const classification = await classifyRollbackActions(prisma, userId, session.novelId, actions)
  if (classification.missingIds.length) throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '回滚目标已归档或不存在，未修改正文或任务历史。')

  const [removedMemoryCount, removedArtifactCount] = await Promise.all([
    prisma.projectMemoryEntry.count({ where: { runId: { in: runIds } } }),
    prisma.agentArtifact.count({ where: { runId: { in: runIds } } }),
  ])

  return {
    removedChapters: classification.removedRefs,
    restoredChapters: classification.restoredRefs,
    protectedChapters: classification.protectedRefs,
    novelFields: classification.novelFields,
    removedRunCount: runIds.length,
    removedMemoryCount,
    removedArtifactCount,
  }
}
