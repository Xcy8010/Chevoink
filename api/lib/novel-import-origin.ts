import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { DataAccessError } from './prisma.js'
import { isManagedAttachmentOwnedBy, MANAGED_AGENT_ATTACHMENT_PREFIX, resolveManagedAttachmentPath } from './agent-attachment-storage.js'
import { databaseNow, runtimeJson } from './agent/runtime-common.js'
import { readExecutionStateInTransaction } from './agent/runtime-state.js'

export const novelImportWaitingSchema = z.object({ version: z.literal(1), operationId: z.string(), callId: z.string(),
  attachmentUrl: z.string().max(1024), expiresAt: z.string().datetime() }).strict()

const refuse = (): never => { throw new DataAccessError(403, 'IMPORT_ATTACHMENT_SCOPE', '导入必须绑定当前持久任务的原始上传与等待位置，不能凭任务编号绕过写入隔离。') }
export interface NovelImportOrigin { runId: string; callId: string }

/** DB-only origin proof shared with the human import service. Neither a model
 * runId nor a general tool approval grants a novel write exemption. */
export async function verifyNovelImportOrigin(tx: Prisma.TransactionClient, scope: { userId: string; novelId: string },
  origin: NovelImportOrigin, options?: { commitJobId?: string }): Promise<{ agentRunId: string; agentToolCallId: string }> {
  scope = { userId: scope.userId, novelId: scope.novelId }
  const run = await tx.agentRun.findFirst({ where: { id: origin.runId, ...scope, runtimeProtocolVersion: 1,
    status: { in: ['queued', 'running'] } } })
  if (!run?.taskRootId || !await tx.agentSession.findFirst({ where: { id: run.sessionId, ...scope }, select: { id: true } })) return refuse()
  const root = await tx.agentTaskRoot.findFirst({ where: { id: run.taskRootId, ...scope, sessionId: run.sessionId, status: 'active' } })
  if (!root) return refuse()
  const { frame } = await readExecutionStateInTransaction(tx, root.id)
  if (frame.state.phase !== 'awaiting_operation' || !frame.state.pendingOperationId) return refuse()
  const operation = await tx.agentOperation.findFirst({ where: { id: frame.state.pendingOperationId, taskRootId: root.id,
    originRunId: run.id, kind: 'tool', action: 'novel_import', status: 'prepared' } })
  const input = z.object({ input: z.object({ callId: z.string(), novelId: z.string(),
    args: z.discriminatedUnion('action', [z.object({ action: z.literal('prepare'), attachmentUrl: z.string() }).strict(),
      z.object({ action: z.literal('commit'), jobId: z.string().uuid() }).strict()]) }) }).safeParse(operation?.inputSnapshot)
  if (!operation || !input.success || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash
    || input.data.input.callId !== origin.callId || input.data.input.novelId !== scope.novelId) return refuse()
  if (options?.commitJobId) {
    const job = await tx.novelImportJob.findFirst({ where: { id: options.commitJobId, ...scope, agentRunId: run.id, agentToolCallId: origin.callId } })
    if (!job) return refuse()
    if (input.data.input.args.action === 'commit') {
      if (input.data.input.args.jobId !== options.commitJobId) return refuse()
      return { agentRunId: run.id, agentToolCallId: origin.callId }
    }
  }
  if (input.data.input.args.action !== 'prepare') return refuse()
  const request = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `import:${operation.id}` } })
  const waiting = novelImportWaitingSchema.safeParse(request?.payload)
  if (!request || request.taskRootId !== root.id || request.runId !== run.id || request.operationId !== operation.id
    || request.type !== 'import.requested' || !waiting.success || waiting.data.operationId !== operation.id
    || waiting.data.callId !== origin.callId || waiting.data.attachmentUrl !== input.data.input.args.attachmentUrl
    || Date.parse(waiting.data.expiresAt) <= (await databaseNow(tx)).getTime()) return refuse()
  const url = waiting.data.attachmentUrl
  const original = await tx.agentMessage.findFirst({ where: { runId: run.id, sessionId: run.sessionId, role: 'user' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { parts: true } })
  const attachment = z.object({ type: z.literal('attachment'), kind: z.literal('file'), name: z.string().min(1).max(255), url: z.literal(url) })
  if (!Array.isArray(original?.parts) || !original.parts.some(part => attachment.safeParse(part).success) || !resolveManagedAttachmentPath(url)) return refuse()
  if (!isManagedAttachmentOwnedBy(url, scope.userId)) {
    if (url.slice(MANAGED_AGENT_ATTACHMENT_PREFIX.length).includes('/')) return refuse()
    const grant = await tx.legacyAgentAttachmentGrant.findUnique({ where: { url } })
    if (!grant || grant.ownerUserId !== scope.userId || grant.revokedAt) return refuse()
  }
  return { agentRunId: run.id, agentToolCallId: origin.callId }
}
