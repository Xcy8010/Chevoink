import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { agentWindowConfigurationSchema, type AgentWindowConfigurationPayload, type PatchAgentWindowConfiguration } from '../../../shared/contracts/agent-window-configuration.js'
import { prisma, DataAccessError } from '../prisma.js'
import { resolveAssignedModel } from './model-assignments.js'
import { agentModelSelectionSchema } from '../../../shared/contracts/agent-model-assignments.js'
import { MAIN_RUN_FILTER } from './runtime-child.js'

// The existing sparse preference store also holds window preferences. Its
// fixed-length key keeps the session namespace separate from novel/global rows.
export function windowConfigurationKey(sessionId: string) {
  return createHash('sha256').update(`agent-window:${sessionId}`).digest('hex')
}

export async function getWindowConfiguration(userId: string, sessionId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<AgentWindowConfigurationPayload> {
  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId }, select: { id: true, novelId: true, title: true } })
  if (!session) throw new DataAccessError(404, 'NOT_FOUND', '窗口不存在或无权访问。')
  const stored = await db.agentModelAssignment.findUnique({ where: { userId_scopeKey: { userId, scopeKey: windowConfigurationKey(sessionId) } } })
  if (!stored) {
    const latest = await db.agentRun.findFirst({ where: { ...MAIN_RUN_FILTER, sessionId, userId, novelId: session.novelId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { modelTier: true, customModelId: true, reasoningEffort: true, startRequest: true, taskSpec: true, taskRootId: true,
        configurationChanges: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { response: true } } } })
    if (latest) {
      const request = latest.startRequest as Prisma.JsonObject | null
      const spec = latest.taskSpec as Prisma.JsonObject | null
      const history = latest.taskRootId ? await db.agentConfigurationChange.findMany({
        where: { run: { taskRootId: latest.taskRootId, userId, sessionId, novelId: session.novelId } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { response: true },
      }) : latest.configurationChanges
      const changes = history.map(change => change.response as Prisma.JsonObject).filter(change => change.appliesToRun !== false)
      const applied = changes.map(change => (change.configuration ?? change) as Prisma.JsonObject)
      const modelChange = changes.find(change => ((change.configuration ?? change) as Prisma.JsonObject).modelSelectionExplicit === true)
      const assignments = (request?.modelAssignments as Prisma.JsonObject | undefined)?.assignments as Prisma.JsonObject | undefined
      const inherited = modelChange ? Boolean(modelChange.modelAssignments)
        : request?.modelSelectionExplicit !== true && Boolean(assignments?.main || assignments?.chapter_writing)
      const model = agentModelSelectionSchema.safeParse({ modelTier: latest.modelTier,
        ...(latest.customModelId ? { customModelId: latest.customModelId } : {}), reasoningEffort: latest.reasoningEffort })
      const mode = applied.map(change => change.creativeFreedom).find(value => value === 'stable' || value === 'balanced' || value === 'bold')
        ?? spec?.creativeFreedom ?? request?.creativeFreedom
      return { sessionId, novelId: session.novelId, title: session.title, revision: 0, source: 'last_run',
        modelSelectionSource: inherited ? 'inherited' : modelChange || request?.modelSelectionExplicit === true ? 'explicit' : 'unknown',
        configuration: { model: inherited || !model.success ? null : model.data,
          creativeFreedom: mode === 'stable' || mode === 'bold' ? mode : 'balanced' } }
    }
  }
  return { sessionId, novelId: session.novelId, title: session.title, revision: stored?.revision ?? 0,
    source: stored ? 'saved' : 'default', configuration: agentWindowConfigurationSchema.parse(stored?.assignments ?? {}) }
}

/** Already validated selections; this DB-only step shares the tool receipt transaction. */
export async function applyWindowConfiguration(tx: Prisma.TransactionClient, userId: string, sessionId: string, input: PatchAgentWindowConfiguration) {
  const current = await getWindowConfiguration(userId, sessionId, tx)
  if (current.revision !== input.expectedRevision) throw new DataAccessError(409, 'WINDOW_CONFIGURATION_CONFLICT', '窗口配置已更新，请刷新后重试。')
  const configuration = { ...current.configuration, ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.creativeFreedom !== undefined ? { creativeFreedom: input.creativeFreedom } : {}) }
  const scopeKey = windowConfigurationKey(sessionId)
  if (current.revision === 0) await tx.agentModelAssignment.create({ data: { userId, novelId: current.novelId, scopeKey, assignments: configuration } })
  else if ((await tx.agentModelAssignment.updateMany({ where: { userId, scopeKey, revision: input.expectedRevision },
    data: { assignments: configuration, revision: { increment: 1 } } })).count !== 1) {
    throw new DataAccessError(409, 'WINDOW_CONFIGURATION_CONFLICT', '窗口配置已更新，请刷新后重试。')
  }
  return { ...current, source: 'saved' as const, modelSelectionSource: configuration.model ? 'explicit' as const : 'inherited' as const,
    revision: current.revision + 1, configuration }
}

export async function patchWindowConfiguration(userId: string, sessionId: string, input: PatchAgentWindowConfiguration) {
  await getWindowConfiguration(userId, sessionId)
  const model = input.model ? (await resolveAssignedModel(userId, input.model)).selection : input.model
  try {
    return await prisma.$transaction(tx => applyWindowConfiguration(tx, userId, sessionId, { ...input, ...(model !== undefined ? { model } : {}) }))
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new DataAccessError(409, 'WINDOW_CONFIGURATION_CONFLICT', '窗口配置已更新，请刷新后重试。')
    throw error
  }
}
