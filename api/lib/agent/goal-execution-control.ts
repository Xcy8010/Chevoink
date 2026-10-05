import type { AgentGoal, Prisma } from '@prisma/client'
import { z } from 'zod'
import { actOnAgentGoalSchema, createAgentGoalSchema } from '../../../shared/contracts/agent-goal.js'
import { DataAccessError } from '../prisma.js'
import { parseExecutionControl, serializeExecutionControl, untilCompletionControl, verifiedUserExecutionControl,
  type EffectiveExecutionControl } from './execution-control.js'
import { runtimeJson } from './runtime-common.js'

const object = (value: Prisma.JsonValue): Prisma.JsonObject | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : null
const invalid = (): never => { throw new DataAccessError(409, 'GOAL_RECONCILIATION_REQUIRED', '目标执行限制的授权回执不一致。') }
const proofSchema = z.object({ version: z.literal(1), revision: z.number().int().positive(), envelope: z.unknown() }).strict()
export const goalControlPointerSchema = z.object({ criterionId: z.string(), receiptHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const policyReceiptSchema = z.object({ version: z.literal(1), revision: z.number().int().positive(), authorityHash: z.string(), sourceActionId: z.string(),
  requestHash: z.string(), envelope: z.unknown(), stateVersion: z.number().int().positive(), previous: goalControlPointerSchema.nullable(),
  previousControlHash: z.string(), executionControl: z.unknown() }).strict()

/** Called only after owned-goal admission/fencing. Metadata alone never grants a user limit. */
export async function readGoalExecutionControl(tx: Prisma.TransactionClient, ownedGoalId: string): Promise<EffectiveExecutionControl> {
  const goal = await tx.agentGoal.findUniqueOrThrow({ where: { id: ownedGoalId } })
  // Validate current immutable revision even when a later action supplied limits.
  const baseline = await readControlRevision(tx, ownedGoalId)
  const rawPointer = object(goal.executionOptions)?.goalExecutionControl
  const policies = await tx.agentGoalEvidence.findMany({ where: { goalId: goal.id, kind: 'execution-control' }, select: { receipt: true, criterionId: true } })
  const parsedPolicies = policies.map(row => ({ ...row, proof: policyReceiptSchema.safeParse(row.receipt) }))
  if (parsedPolicies.some(row => !row.proof.success)) return invalid()
  if (new Set(parsedPolicies.flatMap(row => row.proof.success ? [row.proof.data.stateVersion] : [])).size !== parsedPolicies.length) return invalid()
  const latest = parsedPolicies.sort((a, b) => (b.proof.success ? b.proof.data.stateVersion : 0) - (a.proof.success ? a.proof.data.stateVersion : 0))[0]
  if (!latest) {
    if (rawPointer !== undefined) return invalid()
    return baseline
  }
  const pointer = goalControlPointerSchema.safeParse(rawPointer)
  if (!pointer.success || pointer.data.criterionId !== latest.criterionId || pointer.data.receiptHash !== runtimeJson(latest.receipt).hash) return invalid()
  return readPolicy(tx, goal, pointer.data)
}

async function readPolicy(tx: Prisma.TransactionClient, goal: AgentGoal, pointer: z.infer<typeof goalControlPointerSchema>, beforeVersion = goal.stateVersion + 1): Promise<EffectiveExecutionControl> {
  const row = await tx.agentGoalEvidence.findFirst({ where: { goalId: goal.id, criterionId: pointer.criterionId, kind: 'execution-control' } })
  if (!row || runtimeJson(row.receipt).hash !== pointer.receiptHash) return invalid()
  const parsed = policyReceiptSchema.safeParse(row.receipt)
  if (!parsed.success || parsed.data.stateVersion >= beforeVersion || parsed.data.revision > goal.currentRevision) return invalid()
  const proof = parsed.data
  let recordedControl
  try { recordedControl = parseExecutionControl(proof.executionControl) } catch { return invalid() }
  const revision = await tx.agentGoalRevision.findUnique({ where: { goalId_revision: { goalId: goal.id, revision: proof.revision } } })
  if (!revision || revision.authorityHash !== proof.authorityHash || revision.sourceActionId !== proof.sourceActionId
    || runtimeJson(revision.request).hash !== proof.requestHash) return invalid()
  const envelope = z.object({ operation: z.literal('action'), sessionId: z.literal(goal.sessionId), goalId: z.literal(goal.id), body: actOnAgentGoalSchema }).strict().safeParse(proof.envelope)
  if (!envelope.success || envelope.data.body.action !== 'resume' || !envelope.data.body.budgetChange
    || Object.keys(envelope.data.body.budgetChange).length === 0 || pointer.criterionId !== `execution-control:${envelope.data.body.requestId}`) return invalid()
  const previous = proof.previous ? await readPolicy(tx, goal, proof.previous, proof.stateVersion) : await readControlRevision(tx, goal.id, proof.revision)
  if (runtimeJson(serializeExecutionControl(previous)).hash !== proof.previousControlHash) return invalid()
  const limits = envelope.data.body.budgetChange
  const effective = verifiedUserExecutionControl({ ...previous.limits, ...(limits.tokenLimit === undefined ? {} : { tokens: BigInt(limits.tokenLimit) }),
    ...(limits.activeTimeLimitMs === undefined ? {} : { activeTimeMs: BigInt(limits.activeTimeLimitMs) }) })
  const serialized = serializeExecutionControl(effective)
  if (runtimeJson(serialized).hash !== runtimeJson(recordedControl).hash) return invalid()
  const command = await tx.agentGoalCommand.findUnique({ where: { userId_requestId: { userId: goal.userId, requestId: envelope.data.body.requestId } } })
  const response = command ? object(command.response) : null
  if (!command || command.requestHash !== runtimeJson(envelope.data).hash || !response || !response.executionControl
    || response.id !== goal.id || response.sessionId !== goal.sessionId || response.novelId !== goal.novelId || response.revision !== proof.revision
    || response.pendingRevision !== null || response.stateVersion !== proof.stateVersion || response.executionControlReceiptHash !== pointer.receiptHash
    || runtimeJson(response.executionControl).hash !== runtimeJson(serialized).hash) return invalid()
  return effective
}

async function readControlRevision(tx: Prisma.TransactionClient, ownedGoalId: string, sourceRevisionNumber?: number): Promise<EffectiveExecutionControl> {
  const goal = await tx.agentGoal.findUniqueOrThrow({ where: { id: ownedGoalId } })
  const revision = await tx.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId: goal.id, revision: sourceRevisionNumber ?? goal.currentRevision } } })
  const request = object(revision.request)
  if (!request || !('executionControl' in request)) return untilCompletionControl('unknown_legacy')
  let control
  try { control = parseExecutionControl(request.executionControl) } catch { return invalid() }
  const authorityHash = runtimeJson({ objective: revision.objective, request: revision.request, novelId: goal.novelId, userId: goal.userId }).hash
  if (revision.authorityHash !== authorityHash) {
    // Activation keeps its original immutable source hash and frozen options.
    const activation = await tx.agentGoalEvidence.findUnique({ where: { goalId_revision_criterionId: { goalId: goal.id, revision: 1, criterionId: 'activation-source' } } })
    const source = activation ? object(activation.receipt) : null
    const { executionControl: _control, ...options } = request
    void _control
    if (revision.revision !== 1 || control.origin !== 'system_default' || !source
      || revision.authorityHash !== runtimeJson({ ...source, baselineBound: false }).hash
      || source.optionsHash !== runtimeJson(options).hash) return invalid()
  }
  if (control.origin !== 'user') return untilCompletionControl(control.origin)
  const parsed = proofSchema.safeParse(request.executionControlProof)
  if (!parsed.success) return invalid()
  const proof = parsed.data
  const sourceRevision = await tx.agentGoalRevision.findUnique({ where: { goalId_revision: { goalId: goal.id, revision: proof.revision } } })
  const sourceRequest = sourceRevision ? object(sourceRevision.request) : null
  if (!sourceRevision || proof.revision > revision.revision || !sourceRequest || !sourceRequest.executionControl || !sourceRequest.executionControlProof
    || runtimeJson(sourceRequest.executionControl).hash !== runtimeJson(control).hash
    || runtimeJson(sourceRequest.executionControlProof).hash !== runtimeJson(proof).hash
    || sourceRevision.authorityHash !== runtimeJson({ objective: sourceRevision.objective, request: sourceRevision.request, novelId: goal.novelId, userId: goal.userId }).hash) return invalid()
  const create = z.object({ operation: z.literal('create'), target: z.union([z.object({ sessionId: z.string() }).strict(), z.object({ novelId: z.string() }).strict()]), body: createAgentGoalSchema }).strict().safeParse(proof.envelope)
  const body = create.success ? create.data.body : null
  if (!body || body.requestId !== sourceRevision.sourceActionId) return invalid()
  if (create.success && (proof.revision !== 1 || create.data.body.objective !== sourceRevision.objective
    || ('sessionId' in create.data.target ? create.data.target.sessionId !== goal.sessionId : create.data.target.novelId !== goal.novelId))) return invalid()
  const limits = create.success ? create.data.body.limits : undefined
  if (!limits || Object.keys(limits).length === 0) return invalid()
  const effective = verifiedUserExecutionControl({ tokens: limits.tokenLimit === undefined ? null : BigInt(limits.tokenLimit),
    turns: null, activeTimeMs: limits.activeTimeLimitMs === undefined ? null : BigInt(limits.activeTimeLimitMs) })
  if (runtimeJson(serializeExecutionControl(effective)).hash !== runtimeJson(control).hash) return invalid()
  const command = await tx.agentGoalCommand.findUnique({ where: { userId_requestId: { userId: goal.userId, requestId: body.requestId } } })
  const response = command ? object(command.response) : null
  if (!command || command.requestHash !== runtimeJson(proof.envelope).hash || !response || !response.executionControl
    || response.id !== goal.id || response.sessionId !== goal.sessionId || response.novelId !== goal.novelId
    || response.revision !== sourceRevision.revision || response.pendingRevision !== null
    || runtimeJson(response.executionControl).hash !== runtimeJson(control).hash) return invalid()
  return effective
}
