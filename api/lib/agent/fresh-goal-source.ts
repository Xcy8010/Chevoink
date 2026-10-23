import type { AgentGoal, Prisma } from '@prisma/client'
import { z } from 'zod'
import { createAgentGoalSchema, agentGoalExecutionOptionsSchema } from '../../../shared/contracts/agent-goal.js'
import type { StartAgentLoopRunRequest } from '../../../shared/contracts/index.js'
import { startAgentLoopRunSchema } from '../../../shared/contracts/schemas.js'
import { runtimeError, runtimeJson } from './runtime-common.js'

const envelopeSchema = z.object({ operation: z.literal('create'), target: z.union([
  z.object({ sessionId: z.string() }).strict(), z.object({ novelId: z.string() }).strict(),
]), body: createAgentGoalSchema }).strict()
const sourceSchema = z.object({ version: z.literal(1), origin: z.literal('http'), envelope: envelopeSchema }).strict()
const object = (raw: Prisma.JsonValue) => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null

/** Model assignment is the only normalization admission can make. Selection,
 * attachments, quality, skills, token controls and every other option survive. */
export function assertFreshGoalOptions(input: StartAgentLoopRunRequest, options: z.infer<typeof agentGoalExecutionOptionsSchema>, exactModel = false) {
  const stripModel = (value: z.infer<typeof agentGoalExecutionOptionsSchema>) => {
    const { modelTier: _tier, customModelId: _custom, reasoningEffort: _effort, ...rest } = value
    void _tier; void _custom; void _effort
    return rest
  }
  const actual = agentGoalExecutionOptionsSchema.parse(input)
  if (runtimeJson(exactModel ? actual : stripModel(actual)).hash !== runtimeJson(exactModel ? options : stripModel(options)).hash) {
    return runtimeError('RUNTIME_BOOTSTRAP_SOURCE_REQUIRED', '目标原始选区、执行设置或资料不一致。')
  }
}

/** Only the HTTP create handler issues this optional admission provenance.
 * It reuses the original goal command/revision; it is never a new permission. */
export async function readFreshGoalSource(tx: Prisma.TransactionClient, goal: AgentGoal) {
  const revision = await tx.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId: goal.id, revision: 1 } } })
  const request = object(revision.request)
  if (!request || request.nativeAdmission === undefined) return null
  const parsed = sourceSchema.safeParse(request.nativeAdmission)
  if (!parsed.success) return runtimeError('RUNTIME_BOOTSTRAP_SOURCE_REQUIRED', '目标原始准入不完整，不能重新装配。')
  const { envelope } = parsed.data, { body, target } = envelope
  const command = await tx.agentGoalCommand.findUnique({ where: { userId_requestId: { userId: goal.userId, requestId: body.requestId } } })
  const response = command ? object(command.response) : null
  if (!command || command.requestHash !== runtimeJson(envelope).hash || !response || response.id !== goal.id
    || response.sessionId !== goal.sessionId || response.novelId !== goal.novelId || response.revision !== 1
    || revision.sourceActionId !== body.requestId || revision.objective !== body.objective
    || ('sessionId' in target ? target.sessionId !== goal.sessionId : target.novelId !== goal.novelId)
    || revision.authorityHash !== runtimeJson({ objective: revision.objective, request: revision.request, novelId: goal.novelId, userId: goal.userId }).hash
    || runtimeJson(agentGoalExecutionOptionsSchema.parse(request)).hash !== runtimeJson(body.options).hash) {
    return runtimeError('RUNTIME_BOOTSTRAP_SOURCE_REQUIRED', '目标准入与原创建回执不一致。')
  }
  return { objective: body.objective, options: body.options }
}

/** Historical reader: a later goal revision must not invalidate old event
 * identity. Current goal epoch/status is fenced separately on every effect. */
export async function readFreshGoalBootstrapSource(tx: Prisma.TransactionClient, userId: string, runId: string) {
  const binding = await tx.agentGoalExecution.findUnique({ where: { runId }, include: { goal: true } })
  if (!binding) return null
  const goal = binding.goal
  if (goal.userId !== userId) return runtimeError('RUNTIME_BOOTSTRAP_SOURCE_REQUIRED', '目标不属于原任务作者。')
  const original = await readFreshGoalSource(tx, goal)
  // A normal HTTP task can later activate a goal. Its historical bootstrap
  // still belongs to its original human source, never to that later binding.
  if (!original) return null
  if (binding.goalRevision !== 1 || binding.continuationIndex !== 1 || binding.trigger !== 'author'
    || binding.sourceEventId !== `${goal.id}:1:1`) return runtimeError('RUNTIME_BOOTSTRAP_SOURCE_REQUIRED', '只有原目标的首次作者准入可以初始化。')
  const run = await tx.agentRun.findFirst({ where: { id: runId, userId, novelId: goal.novelId, sessionId: goal.sessionId } })
  const saved = startAgentLoopRunSchema.safeParse(run?.startRequest)
  if (!run || !saved.success || saved.data.prompt !== original.objective
    || saved.data.sessionId !== goal.sessionId || saved.data.novelId !== goal.novelId
    || saved.data.mode !== original.options.mode || saved.data.mode !== (run.mode === 'act' ? 'build' : run.mode)
    || (saved.data.chapterId?.trim() || null) !== (original.options.chapterId?.trim() || null)
    || runtimeJson(saved.data.attachments ?? []).hash !== runtimeJson(original.options.attachments ?? []).hash) {
    return runtimeError('RUNTIME_BOOTSTRAP_SOURCE_REQUIRED', '目标原始输入与执行记录不一致。')
  }
  assertFreshGoalOptions(saved.data, original.options)
  return { binding, request: saved.data }
}
