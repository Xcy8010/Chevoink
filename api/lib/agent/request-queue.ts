import type { AgentQueuedRequest, Prisma } from '@prisma/client'
import { startAgentLoopRunSchema, type StartAgentLoopRunRequest } from '../../../shared/contracts/index.js'
import type { AgentQueueAction, AgentQueueSnapshot } from '../../../shared/contracts/agent-queue.js'
import { DataAccessError, prisma } from '../prisma.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { assertManagedAttachmentsAccess } from '../agent-attachment-storage.js'
import { getActiveRunIdBySession, hasActiveRunInSession, stopAgentRun } from './active-runs.js'
import { forkAgentSessionData, startLoopRunLocked, toAgentSession } from './run-service.js'
import { withUserRunLock } from './run-lock.js'

const editable = ['pending', 'held']
const conflict = () => new DataAccessError(409, 'QUEUE_CHANGED', '待发需求已发送或被修改，请刷新后再操作。')
async function ownedSession(userId: string, sessionId: string) {
  const session = await prisma.agentSession.findFirst({ where: { id: sessionId, userId } })
  if (!session) throw new DataAccessError(404, 'NOT_FOUND', '会话不存在或无权访问。')
  return session
}
const latestRun = (sessionId: string) => prisma.agentRun.findFirst({ where: { sessionId, engine: 'loop' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, status: true } })

export function queueCanDispatch(status: string | undefined, priority: number): boolean {
  return !status || status === 'completed' || (priority > 0 && ['paused', 'failed', 'cancelled'].includes(status))
}

export async function listQueuedRequests(userId: string, sessionId: string): Promise<AgentQueueSnapshot> {
  await ownedSession(userId, sessionId)
  const [rows, latest] = await Promise.all([
    prisma.agentQueuedRequest.findMany({ where: { userId, sessionId, status: { in: editable } }, orderBy: [{ priority: 'desc' }, { sequence: 'asc' }] }),
    latestRun(sessionId),
  ])
  return {
    items: rows.map(row => {
      const input = row.payload as unknown as StartAgentLoopRunRequest
      return { id: row.id, sessionId, prompt: input.prompt, attachmentCount: input.attachments?.length ?? 0, status: row.status, revision: row.revision,
        error: row.error ?? (!queueCanDispatch(latest?.status, row.priority) && ['paused', 'failed', 'cancelled'].includes(latest?.status ?? '') ? '当前任务已停止；可继续原任务，或调整方向发送此需求。' : null) }
    }),
    latestRunId: latest?.id ?? null,
  }
}

export async function enqueueRequest(userId: string, id: string, raw: StartAgentLoopRunRequest) {
  return withUserRunLock(userId, async () => {
    const input = startAgentLoopRunSchema.parse(raw)
    const session = await ownedSession(userId, input.sessionId)
    if (session.novelId !== input.novelId) throw new DataAccessError(400, 'VALIDATION_ERROR', '会话与作品不匹配。')
    await assertManagedAttachmentsAccess(input.attachments, userId)
    return prisma.$transaction(async tx => {
      // Same order as run admission; the pending row and import's busy check
      // cannot pass each other, including when the manuscript is empty.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-admission:${userId}`}, 0))::text`
      await lockNovelActiveScope(tx, session.novelId)
      const prior = await tx.agentQueuedRequest.findUnique({ where: { id } })
      if (prior) {
        if (prior.userId !== userId) throw conflict()
        return { id: prior.id }
      }
      const count = await tx.agentQueuedRequest.count({ where: { userId, status: { in: editable } } })
      if (count >= 50) throw new DataAccessError(400, 'QUEUE_FULL', '待发需求最多保留 50 条，请先处理已有需求。')
      await tx.agentQueuedRequest.create({ data: { id, userId, sessionId: session.id, payload: { ...input, mode: 'build' } as Prisma.InputJsonValue } })
      return { id }
    })
  })
}

export async function actOnQueuedRequest(userId: string, sessionId: string, id: string, action: AgentQueueAction, revision: number, prompt?: string) {
  return withUserRunLock(userId, async () => {
    await ownedSession(userId, sessionId)
    const item = await prisma.agentQueuedRequest.findFirst({ where: { id, userId, sessionId, status: { in: editable }, revision } })
    if (!item) throw conflict()
    const input = startAgentLoopRunSchema.parse(item.payload)
    if (action === 'new' || action === 'fork') {
      // Move the durable request in the SAME transaction as creating the window.
      // Failed network replies therefore cannot create duplicate windows/prompts.
      const transfer = async (tx: Prisma.TransactionClient, targetId: string) => {
        const moved = await tx.agentQueuedRequest.updateMany({ where: { id, userId, sessionId, revision, status: { in: editable } },
          data: { sessionId: targetId, payload: { ...input, sessionId: targetId } as Prisma.InputJsonValue, status: 'pending', priority: 1, error: null, revision: { increment: 1 } } })
        if (moved.count !== 1) throw conflict()
      }
      if (action === 'fork') {
        const result = await forkAgentSessionData(userId, sessionId, { onCreated: transfer })
        return { session: result.session }
      }
      const session = await prisma.$transaction(async tx => {
        const created = await tx.agentSession.create({ data: { userId, novelId: input.novelId, title: input.prompt.slice(0, 80) } })
        await transfer(tx, created.id)
        return created
      })
      return { session: toAgentSession(session) }
    }
    const data: Prisma.AgentQueuedRequestUpdateManyMutationInput = { revision: { increment: 1 } }
    if (action === 'delete') data.status = 'cancelled'
    if (action === 'edit') {
      const parsed = startAgentLoopRunSchema.parse({ ...input, prompt })
      data.payload = parsed as Prisma.InputJsonValue
    }
    if (action === 'steer') {
      // Do not launch while abort cleanup/tools are still in flight. Worker waits
      // for deregistration AND a persisted terminal status, including after restart.
      data.priority = 1
      data.status = 'pending'
      data.error = null
      await prisma.agentQueuedRequest.updateMany({ where: { userId, sessionId, status: { in: editable } }, data: { priority: 0 } })
    }
    const updated = await prisma.agentQueuedRequest.updateMany({ where: { id, userId, sessionId, revision, status: { in: editable } }, data })
    if (updated.count !== 1) throw conflict()
    if (action === 'steer') {
      const activeId = getActiveRunIdBySession(sessionId)
      if (activeId) stopAgentRun(activeId)
    }
    return {}
  })
}

async function dispatchSession(candidate: AgentQueuedRequest) {
  await withUserRunLock(candidate.userId, async () => {
    if (hasActiveRunInSession(candidate.sessionId)) return
    const item = await prisma.agentQueuedRequest.findFirst({ where: { sessionId: candidate.sessionId, userId: candidate.userId, status: { in: editable } }, orderBy: [{ priority: 'desc' }, { sequence: 'asc' }] })
    if (!item || item.status === 'held') return
    const latest = await latestRun(item.sessionId)
    if (!queueCanDispatch(latest?.status, item.priority)) return
    try {
      const user = await prisma.user.findUnique({ where: { id: item.userId }, select: { bannedAt: true } })
      if (!user || user.bannedAt) throw new DataAccessError(403, 'ACCOUNT_UNAVAILABLE', '当前账号无法启动任务，需求已保留。')
      const input = startAgentLoopRunSchema.parse(item.payload)
      await startLoopRunLocked(item.userId, input, { queuedRequest: { id: item.id, revision: item.revision } })
    } catch (error) {
      if (error instanceof DataAccessError && ['RUN_IN_PROGRESS', 'RUN_LIMIT', 'QUEUE_CHANGED'].includes(error.code)) return
      // Never silently discard a draft or repeatedly spend credits retrying it.
      await prisma.agentQueuedRequest.updateMany({ where: { id: item.id, status: 'pending', revision: item.revision }, data: { status: 'held', error: error instanceof DataAccessError ? error.message : '发送失败，需求已保留。请稍后调整方向重试。', revision: { increment: 1 } } })
    }
  })
}

let ticking = false
export async function dispatchQueuedRequests() {
  if (ticking) return
  ticking = true
  try {
    const rows = await prisma.agentQueuedRequest.findMany({ where: { status: 'pending' }, distinct: ['sessionId'], orderBy: { createdAt: 'asc' } })
    for (const row of rows) await dispatchSession(row)
  } catch (error) { console.error('[agent-queue] dispatch failed', error) }
  finally { ticking = false }
}
