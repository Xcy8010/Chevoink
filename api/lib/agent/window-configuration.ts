import { Prisma, type AgentRun } from '@prisma/client'
import { z } from 'zod'
import { agentWindowConfigurationSchema, type AgentWindowConfiguration, type AgentWindowConfigurationPayload, type PatchAgentWindowConfiguration } from '../../../shared/contracts/agent-window-configuration.js'
import { prisma, DataAccessError } from '../prisma.js'
import { resolveAssignedModel } from './model-assignments.js'
import { agentModelSelectionSchema } from '../../../shared/contracts/agent-model-assignments.js'
import { MAIN_RUN_FILTER } from './runtime-child.js'

const storedConfigurationSchema = z.object({ revision: z.number().int().positive(), configuration: agentWindowConfigurationSchema }).strict()

function projectRunWindowConfiguration(startRequest: Prisma.JsonValue | null, taskSpec: Prisma.JsonValue | null,
  history: ReadonlyArray<{ response: Prisma.JsonValue }>): { modelSelectionSource: NonNullable<AgentWindowConfigurationPayload['modelSelectionSource']>; creativeFreedom: AgentWindowConfiguration['creativeFreedom'] } {
  const request = startRequest as Prisma.JsonObject | null
  const spec = taskSpec as Prisma.JsonObject | null
  const changes = history.map(change => change.response as Prisma.JsonObject).filter(change => change.appliesToRun !== false)
  const applied = changes.map(change => (change.configuration ?? change) as Prisma.JsonObject)
  const modelChange = changes.find(change => ((change.configuration ?? change) as Prisma.JsonObject).modelSelectionExplicit === true)
  const assignments = (request?.modelAssignments as Prisma.JsonObject | undefined)?.assignments as Prisma.JsonObject | undefined
  const inherited = modelChange ? Boolean(modelChange.modelAssignments)
    : request?.modelSelectionExplicit !== true && Boolean(assignments?.main || assignments?.chapter_writing)
  const mode = applied.map(change => change.creativeFreedom).find(value => value === 'stable' || value === 'balanced' || value === 'bold')
    ?? spec?.creativeFreedom ?? request?.creativeFreedom
  return { modelSelectionSource: inherited ? 'inherited' : modelChange || request?.modelSelectionExplicit === true ? 'explicit' : 'unknown',
    creativeFreedom: mode === 'stable' || mode === 'bold' ? mode : 'balanced' }
}

/** Active-run ownership is independent of preferences for future requests. */
export async function readRunWindowConfiguration(db: Prisma.TransactionClient | typeof prisma,
  run: Pick<AgentRun, 'id' | 'userId' | 'sessionId' | 'novelId' | 'taskRootId' | 'startRequest' | 'taskSpec'>) {
  const history = await db.agentConfigurationChange.findMany({ where: { run: { userId: run.userId, sessionId: run.sessionId, novelId: run.novelId,
    ...(run.taskRootId ? { taskRootId: run.taskRootId } : { id: run.id }) } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { response: true } })
  return projectRunWindowConfiguration(run.startRequest, run.taskSpec, history)
}

export async function getWindowConfiguration(userId: string, sessionId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<AgentWindowConfigurationPayload> {
  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId }, select: { id: true, novelId: true, title: true, toolPolicy: true } })
  if (!session) throw new DataAccessError(404, 'NOT_FOUND', '窗口不存在或无权访问。')
  const policy = session.toolPolicy as Prisma.JsonObject | null
  const stored = policy?.windowConfiguration === undefined ? null : storedConfigurationSchema.parse(policy.windowConfiguration)
  if (!stored) {
    const latest = await db.agentRun.findFirst({ where: { ...MAIN_RUN_FILTER, sessionId, userId, novelId: session.novelId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { modelTier: true, customModelId: true, reasoningEffort: true, startRequest: true, taskSpec: true, taskRootId: true,
        configurationChanges: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { response: true } } } })
    if (latest) {
      const history = latest.taskRootId ? await db.agentConfigurationChange.findMany({
        where: { run: { taskRootId: latest.taskRootId, userId, sessionId, novelId: session.novelId } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { response: true },
      }) : latest.configurationChanges
      const restored = projectRunWindowConfiguration(latest.startRequest, latest.taskSpec, history)
      const model = agentModelSelectionSchema.safeParse({ modelTier: latest.modelTier,
        ...(latest.customModelId ? { customModelId: latest.customModelId } : {}), reasoningEffort: latest.reasoningEffort })
      return { sessionId, novelId: session.novelId, title: session.title, revision: 0, source: 'last_run',
        modelSelectionSource: restored.modelSelectionSource,
        configuration: { model: restored.modelSelectionSource === 'inherited' || !model.success ? null : model.data,
          creativeFreedom: restored.creativeFreedom } }
    }
  }
  return { sessionId, novelId: session.novelId, title: session.title, revision: stored?.revision ?? 0,
    source: stored ? 'saved' : 'default', configuration: stored?.configuration ?? agentWindowConfigurationSchema.parse({}) }
}

/** Already validated selections; this DB-only step shares the tool receipt transaction. */
export async function applyWindowConfiguration(tx: Prisma.TransactionClient, userId: string, sessionId: string, input: PatchAgentWindowConfiguration) {
  const session = await tx.agentSession.findFirst({ where: { id: sessionId, userId }, select: { id: true, toolPolicy: true } })
  if (!session) throw new DataAccessError(404, 'NOT_FOUND', '窗口不存在或无权访问。')
  const current = await getWindowConfiguration(userId, sessionId, tx)
  if (current.revision !== input.expectedRevision) throw new DataAccessError(409, 'WINDOW_CONFIGURATION_CONFLICT', '窗口配置已更新，请刷新后重试。')
  const configuration = { ...current.configuration, ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.creativeFreedom !== undefined ? { creativeFreedom: input.creativeFreedom } : {}) }
  // A session owns its preferences. The policy's five permission fields remain
  // untouched; compare the complete JSON so concurrent permission edits survive.
  const policy = session.toolPolicy as Prisma.JsonObject | null
  if ((await tx.agentSession.updateMany({ where: { id: sessionId, userId,
    toolPolicy: { equals: session.toolPolicy === null ? Prisma.AnyNull : session.toolPolicy as Prisma.InputJsonValue } },
    data: { toolPolicy: { ...policy, windowConfiguration: { revision: current.revision + 1, configuration } } } })).count !== 1) {
    throw new DataAccessError(409, 'WINDOW_CONFIGURATION_CONFLICT', '窗口配置已更新，请刷新后重试。')
  }
  return { ...current, source: 'saved' as const, modelSelectionSource: configuration.model ? 'explicit' as const : 'inherited' as const,
    revision: current.revision + 1, configuration }
}

export async function patchWindowConfiguration(userId: string, sessionId: string, input: PatchAgentWindowConfiguration) {
  await getWindowConfiguration(userId, sessionId)
  const model = input.model ? (await resolveAssignedModel(userId, input.model)).selection : input.model
  return prisma.$transaction(tx => applyWindowConfiguration(tx, userId, sessionId, { ...input, ...(model !== undefined ? { model } : {}) }))
}
