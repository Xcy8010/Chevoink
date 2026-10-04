import { Prisma } from '@prisma/client'
import { agentModelSelectionSchema, frozenModelAssignmentsSchema, modelAssignmentsSchema, patchModelAssignmentsSchema,
  type AgentModelSelection, type FrozenModelAssignments, type ModelAssignments, type ModelAssignmentsPayload, type PatchModelAssignments } from '../../../shared/contracts/agent-model-assignments.js'
import { assertCreditAccess, getModelTierRuntime } from '../credits.js'
import { DataAccessError, prisma } from '../prisma.js'

/** A newly selected model without an effort uses its configured native default. */
export async function resolveAssignedModel(userId: string, input: AgentModelSelection, needsVision = false) {
  const selection = agentModelSelectionSchema.parse(input)
  const candidate = await getModelTierRuntime(selection.modelTier, userId, selection.customModelId)
  const runtime = selection.reasoningEffort === undefined ? candidate
    : await getModelTierRuntime(selection.modelTier, userId, selection.customModelId, selection.reasoningEffort)
  if (needsVision && !runtime.visionEnabled) throw new DataAccessError(400, 'MODEL_VISION_REQUIRED', '所选模型不支持图片理解。')
  return { runtime, selection: { ...selection, reasoningEffort: runtime.reasoningEffort } }
}

async function requireNovel(userId: string, novelId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  if (!await tx.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { id: true } })) {
    throw new DataAccessError(404, 'NOT_FOUND', '作品不存在或无权访问。')
  }
}
export function mergeModelAssignments(global: ModelAssignments, novel: ModelAssignments): ModelAssignments {
  return modelAssignmentsSchema.parse({ ...global, ...novel })
}
export async function getModelAssignments(userId: string, novelId?: string): Promise<ModelAssignmentsPayload> {
  if (novelId) await requireNovel(userId, novelId)
  const rows = await prisma.agentModelAssignment.findMany({ where: { userId, scopeKey: { in: novelId ? ['', novelId] : [''] } } })
  const read = (key: string) => { const row = rows.find(item => item.scopeKey === key)
    return { revision: row?.revision ?? 0, assignments: modelAssignmentsSchema.parse(row?.assignments ?? {}) } }
  const global = read(''), novel = novelId ? read(novelId) : null
  const effective: ModelAssignmentsPayload['effective'] = {}
  for (const [key, selection] of Object.entries(global.assignments)) effective[key as keyof ModelAssignments] = { selection, source: 'global' }
  for (const [key, selection] of Object.entries(novel?.assignments ?? {})) effective[key as keyof ModelAssignments] = { selection, source: 'novel' }
  return { version: 1, global, novel, effective }
}
export async function freezeModelAssignments(userId: string, novelId?: string): Promise<FrozenModelAssignments | undefined> {
  const payload = await getModelAssignments(userId, novelId)
  const assignments = mergeModelAssignments(payload.global.assignments, payload.novel?.assignments ?? {})
  if (!Object.keys(assignments).length) return undefined
  const sources = Object.fromEntries(Object.entries(payload.effective).map(([key, value]) => [key, value.source]))
  return frozenModelAssignmentsSchema.parse({ version: 1, globalRevision: payload.global.revision, novelRevision: payload.novel?.revision ?? 0, assignments, sources })
}
export async function patchModelAssignments(userId: string, raw: PatchModelAssignments): Promise<ModelAssignmentsPayload> {
  const input = patchModelAssignmentsSchema.parse(raw)
  if (input.novelId) await requireNovel(userId, input.novelId)
  const patch: Partial<Record<keyof ModelAssignments, AgentModelSelection | null>> = {}
  for (const [key, selection] of Object.entries(input.assignments)) {
    patch[key as keyof ModelAssignments] = selection === null ? null : (await resolveAssignedModel(userId, selection, key === 'vision')).selection
  }
  try {
    await prisma.$transaction(tx => applyModelAssignmentsPatch(tx, userId, input, patch))
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new DataAccessError(409, 'MODEL_ASSIGNMENT_CONFLICT', '模型分配已更新，请刷新后重试。')
    throw error
  }
  return getModelAssignments(userId, input.novelId)
}
/** Database-only CAS; usable inside a durable configuration effect transaction. */
export async function applyModelAssignmentsPatch(tx: Prisma.TransactionClient, userId: string, input: PatchModelAssignments,
  patch: Partial<Record<keyof ModelAssignments, AgentModelSelection | null>>) {
      if (input.novelId) await requireNovel(userId, input.novelId, tx)
      const scopeKey = input.novelId ?? ''
      const current = await tx.agentModelAssignment.findUnique({ where: { userId_scopeKey: { userId, scopeKey } } })
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new DataAccessError(409, 'MODEL_ASSIGNMENT_CONFLICT', '模型分配已更新，请刷新后重试。')
      const assignments = { ...modelAssignmentsSchema.parse(current?.assignments ?? {}) }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete assignments[key as keyof ModelAssignments]
        else assignments[key as keyof ModelAssignments] = value
      }
      if (!current) await tx.agentModelAssignment.create({ data: { userId, scopeKey, novelId: input.novelId ?? null, assignments } })
      else if ((await tx.agentModelAssignment.updateMany({ where: { id: current.id, userId, revision: input.expectedRevision },
        data: { assignments, revision: { increment: 1 } } })).count !== 1) throw new DataAccessError(409, 'MODEL_ASSIGNMENT_CONFLICT', '模型分配已更新，请刷新后重试。')
  return assignments
}

/** Availability/credit checks happen at dispatch, never during a preferences read. */
export async function admitAssignedModel(userId: string, selection: AgentModelSelection, needsVision = false) {
  await assertCreditAccess(userId, selection.modelTier)
  return resolveAssignedModel(userId, selection, needsVision)
}
