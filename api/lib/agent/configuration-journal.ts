import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentRun, Prisma } from '@prisma/client'
import type { StartAgentLoopRunRequest } from '../../../shared/contracts/agent-events.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError } from '../prisma.js'
import { configurationDirectives } from './configuration-command.js'
import { readHumanAdmission } from './goal-activation-authority.js'
import { readGoalConsentSourceRun } from './goal-consent.js'
import { databaseNow, lockOwnedRun, runtimeJson, runtimeTransaction } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { MAIN_RUN_FILTER } from './runtime-child.js'
import { readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'

export const configurationConsentSchema = z.object({ version: z.literal(1), sourceRunId: z.string(), sourceRootId: z.string(),
  executionRunId: z.string().optional(),
  sourceEpoch: z.string().nullable(), sourceRequestHash: z.string().regex(/^[a-f0-9]{64}$/), messageId: z.string(),
  messageHash: z.string().regex(/^[a-f0-9]{64}$/), consumed: z.boolean() }).strict()
function onlyConfiguration(input: StartAgentLoopRunRequest) {
  if (input.attachments?.length || !configurationDirectives(input.prompt).length) return false
  // A prompt that also asks for manuscript work remains a normal new request.
  const manuscriptRequest = input.prompt.replace(/创作模式|(?:平衡|严谨|大胆)创作(?=$|[，,。；;！？!?\s])/gu, '')
  return !/(?:写(?:第|下|一|首|新)|续写|改写|重写|润色|创作|删除|新建|生成(?:正文|章节|大纲)|\bwrite\b|\bdraft\b)/iu.test(manuscriptRequest)
}
/** Called only for an authenticated HTTP request under admission/session locks. */
export async function bindConfigurationConsent(tx: Prisma.TransactionClient, userId: string, input: StartAgentLoopRunRequest) {
  if (!onlyConfiguration(input)) return null
  const session = await tx.agentSession.findFirst({ where: { id: input.sessionId, novelId: input.novelId, userId } })
  if (!session || session.spawnedFromSessionId) return null
  const run = await tx.agentRun.findFirst({ where: { ...MAIN_RUN_FILTER, userId, sessionId: session.id, novelId: input.novelId, engine: 'loop',
    status: { in: ['running', 'awaiting_approval'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  if (!run) return null
  await lockOwnedRun(tx, userId, run.id)
  const source = await readGoalConsentSourceRun(tx, run)
  const admitted = readHumanAdmission(source.startRequest), spec = taskSpecSchema.safeParse(source.taskSpec)
  if (!admitted || !spec.success || admitted.request.novelId !== input.novelId || admitted.request.sessionId !== input.sessionId) return null
  const lease = run.taskRootId ? await tx.agentRunLease.findUnique({ where: { runId: run.id } }) : null
  if (run.taskRootId && (!lease?.enabled || !lease.expiresAt || lease.expiresAt <= await databaseNow(tx))) return null
  const messageId = randomUUID(), parts = [{ type: 'text', text: input.prompt }]
  await tx.agentMessage.create({ data: { id: messageId, runId: source.id, sessionId: session.id, role: 'user', parts } })
  return configurationConsentSchema.parse({ version: 1, sourceRunId: source.id, sourceRootId: run.taskRootId ?? spec.data.id, executionRunId: run.id,
    sourceEpoch: lease?.epoch.toString() ?? null, sourceRequestHash: admitted.grant.requestHash, messageId, messageHash: runtimeJson(parts).hash, consumed: false })
}

export async function readConfigurationConsents(tx: Prisma.TransactionClient, run: AgentRun, consumed: boolean, epoch?: bigint, includeHistoricalEpochs = false) {
  const source = await readGoalConsentSourceRun(tx, run)
  const admitted = readHumanAdmission(source.startRequest)
  if (!admitted) return []
  const rows = await tx.agentQueuedRequest.findMany({ where: { userId: run.userId, sessionId: run.sessionId,
    status: { in: ['held', 'consented'] }, payload: { path: ['configurationConsent', 'sourceRunId'], equals: source.id } }, orderBy: { sequence: 'asc' } })
  const result: Array<{ row: typeof rows[number]; consent: z.infer<typeof configurationConsentSchema>; prompt: string; currentEpoch: boolean }> = []
  for (const row of rows) {
    const envelope = row.payload as Record<string, unknown>, consent = configurationConsentSchema.safeParse(envelope.configurationConsent)
    const author = readHumanAdmission(row.payload)
    if (!consent.success || !author || consent.data.consumed !== consumed) continue
    const currentEpoch = consent.data.sourceEpoch === (epoch?.toString() ?? null) && (consent.data.executionRunId ?? consent.data.sourceRunId) === run.id
    if (consent.data.sourceRootId !== (run.taskRootId ?? taskSpecSchema.parse(source.taskSpec).id)
      || consent.data.sourceRequestHash !== admitted.grant.requestHash || !includeHistoricalEpochs && !currentEpoch
      || author.request.novelId !== run.novelId || author.request.sessionId !== run.sessionId || !onlyConfiguration(author.request)) continue
    const message = await tx.agentMessage.findFirst({ where: { id: consent.data.messageId, runId: source.id, sessionId: run.sessionId, role: 'user' } })
    if (!message || runtimeJson(message.parts).hash !== consent.data.messageHash
      || runtimeJson(message.parts).hash !== runtimeJson([{ type: 'text', text: author.request.prompt }]).hash)
      throw new DataAccessError(409, 'CONFIGURATION_SOURCE_INVALID', '配置请求与原作者消息不一致。')
    result.push({ row, consent: consent.data, prompt: author.request.prompt, currentEpoch })
  }
  return result
}
async function consumed(tx: Prisma.TransactionClient, item: Awaited<ReturnType<typeof readConfigurationConsents>>[number]) {
  await tx.agentQueuedRequest.update({ where: { id: item.row.id }, data: { status: 'consented', payload: runtimeJson({ ...item.row.payload as object,
    configurationConsent: { ...item.consent, consumed: true } }).value, error: null } })
}
export async function consumeLegacyConfigurationConsent(userId: string, runId: string) {
  return runtimeTransaction(async tx => {
    const run = await lockOwnedRun(tx, userId, runId)
    if (run.runtimeProtocolVersion !== 0 || !['running', 'awaiting_approval'].includes(run.status)) return []
    const items = await readConfigurationConsents(tx, run, false)
    for (const item of items) await consumed(tx, item)
    return items.map(item => ({ id: item.consent.messageId, prompt: item.prompt }))
  })
}
export async function consumeDurableConfigurationConsent(token: RunLeaseToken) {
  return withRunLease(token, async tx => {
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: token.runId } })
    const current = await readExecutionStateInTransaction(tx, token.taskRootId)
    if (current.frame.state.phase !== 'idle') return false
    let index = current.frame.state.messages.length - 1
    while (index >= 0 && current.frame.state.messages[index].role === 'tool') index--
    const assistant = current.frame.state.messages[index]
    if (assistant?.role === 'assistant' && assistant.toolCalls?.some(call => !current.frame.state.messages.slice(index + 1).some(message => message.role === 'tool' && message.toolCallId === call.id))) return false
    const items = await readConfigurationConsents(tx, run, false, token.epoch)
    if (!items.length) return false
    const next = await saveExecutionStateInTransaction(tx, token, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash,
      snapshot: { ...current.frame.state, messages: [...current.frame.state.messages, ...items.map(item => ({ role: 'user' as const, content: item.prompt }))] } })
    for (const item of items) {
      await consumed(tx, item)
      await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: token.taskRootId, runId: token.runId,
        eventKey: `configuration-consent:${item.row.id}`, type: 'configuration.consent.consumed', payload: { messageId: item.consent.messageId,
          messageHash: item.consent.messageHash, epoch: token.epoch.toString(), revision: next.revision, snapshotHash: next.snapshotHash } } })
    }
    return true
  })
}
