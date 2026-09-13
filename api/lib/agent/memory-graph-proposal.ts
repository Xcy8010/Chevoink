import type { Prisma, ProjectMemoryType } from '@prisma/client'
import { z } from 'zod'

export const memoryGraphProposalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('relation'), fromName: z.string().trim().min(1).max(128), toName: z.string().trim().min(1).max(128),
    relationType: z.string().min(1).max(64), state: z.string().max(1000).optional(),
    validFrom: z.number().int().positive().optional(), validTo: z.number().int().positive().optional() }),
  z.object({ kind: z.literal('event'), description: z.string().min(1).max(4000), storyTime: z.string().max(160).optional(),
    location: z.string().max(160).optional(), participants: z.array(z.string()).max(30), causes: z.array(z.string()).max(20), effects: z.array(z.string()).max(20) }),
])
export type MemoryGraphProposal = z.infer<typeof memoryGraphProposalSchema>
const savedProposalSchema = z.object({ title: z.string(), content: z.string(), proposal: memoryGraphProposalSchema })

/** Reviewed text and structured payload must match; never project stale fields after a free-text edit. */
export async function projectReviewedMemoryGraph(tx: Prisma.TransactionClient, memory: {
  id: string; novelId: string; title: string; content: string; memoryType: ProjectMemoryType; graphProposal: Prisma.JsonValue | null
}, replacesTitle?: string) {
  const previous = replacesTitle === undefined ? [] : await tx.projectMemoryEntry.findMany({ where: {
    novelId: memory.novelId, memoryType: memory.memoryType, title: replacesTitle, id: { not: memory.id }, status: { in: ['confirmed', 'inferred'] },
  }, select: { id: true } })
  const sourceIds = [memory.id, ...previous.map(item => item.id)]
  await tx.storyEvent.updateMany({ where: { novelId: memory.novelId, sourceId: { in: sourceIds } }, data: { status: 'invalid' } })
  await tx.entityRelation.deleteMany({ where: { fromEntity: { novelId: memory.novelId }, sourceId: { in: sourceIds } } })
  const parsed = savedProposalSchema.safeParse(memory.graphProposal)
  if (!parsed.success) return
  if (parsed.data.title !== memory.title || parsed.data.content !== memory.content) return
  const proposal = parsed.data.proposal
  if (proposal.kind === 'event') {
    const fields = { description: proposal.description, storyTime: proposal.storyTime, location: proposal.location,
      participants: proposal.participants, causes: proposal.causes, effects: proposal.effects }
    const existing = await tx.storyEvent.findFirst({ where: { novelId: memory.novelId, sourceId: memory.id } })
    const data = { ...fields, title: memory.title, status: 'confirmed' as const }
    if (existing) await tx.storyEvent.update({ where: { id: existing.id }, data })
    else await tx.storyEvent.create({ data: { ...data, novelId: memory.novelId, sourceId: memory.id } })
    return
  }
  const entities = []
  for (const name of [proposal.fromName, proposal.toName]) entities.push(await tx.storyEntity.upsert({
    where: { novelId_entityType_canonicalName: { novelId: memory.novelId, entityType: 'character', canonicalName: name } },
    create: { novelId: memory.novelId, entityType: 'character', canonicalName: name, status: 'inferred' }, update: {},
  }))
  const where = { fromEntityId: entities[0].id, toEntityId: entities[1].id, relationType: proposal.relationType, validFrom: proposal.validFrom ?? null }
  const existing = await tx.entityRelation.findFirst({ where })
  const data = { state: proposal.state ?? null, validTo: proposal.validTo ?? null, confidence: 1, sourceId: memory.id, revision: null }
  if (existing) await tx.entityRelation.update({ where: { id: existing.id }, data })
  else await tx.entityRelation.create({ data: { ...where, ...data } })
}
