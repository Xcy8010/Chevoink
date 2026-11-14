/// <reference lib="es2022.intl" />

import { createHash } from 'node:crypto'
import type { AgentPersonalization, AgentPersonalizationMemory as StoredMemory, Prisma } from '@prisma/client'
import {
  DEFAULT_AGENT_PERSONALIZATION_SETTINGS,
  type AgentPersonalizationMemoriesPayload,
  type AgentPersonalizationMemory,
  type AgentPersonalizationPayload,
  type AgentPersonalizationSettings,
  type PatchAgentPersonalization,
  type PatchAgentPersonalizationMemory,
} from '../../../shared/contracts/agent-personalization.js'
import { DataAccessError, prisma } from '../prisma.js'
import { databaseNow } from './runtime-common.js'

const memoryOrder = [{ updatedAt: 'desc' }, { id: 'desc' }] satisfies Prisma.AgentPersonalizationMemoryOrderByWithRelationInput[]

function projectSettings(profile: AgentPersonalization | null): AgentPersonalizationSettings {
  if (!profile) return { ...DEFAULT_AGENT_PERSONALIZATION_SETTINGS }
  return {
    memoryEnabled: profile.memoryEnabled,
    preferredName: profile.preferredName,
    aboutMe: profile.aboutMe,
    customInstructions: profile.customInstructions,
    style: profile.style,
    warmth: profile.warmth,
    enthusiasm: profile.enthusiasm,
    detail: profile.detail,
    emoji: profile.emoji,
    format: profile.format,
  }
}

function projectMemory(memory: StoredMemory): AgentPersonalizationMemory {
  const { id, text, source, revision, createdAt, updatedAt } = memory
  return { id, text, source, revision, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() }
}

const settingsConflict = () => new DataAccessError(409, 'PERSONALIZATION_CONFLICT', '个性化设置已更新，请刷新后重试。')
const memoryConflict = () => new DataAccessError(409, 'PERSONALIZATION_MEMORY_CONFLICT', '记忆已更新，请刷新后重试。')

function transact<T>(tx: Prisma.TransactionClient | undefined, work: (db: Prisma.TransactionClient) => Promise<T>) {
  return tx ? work(tx) : prisma.$transaction(work)
}

function readSnapshot<T>(tx: Prisma.TransactionClient | undefined, work: (db: Prisma.TransactionClient) => Promise<T>) {
  return tx ? work(tx) : prisma.$transaction(work, { isolationLevel: 'RepeatableRead' })
}

/** Settings and memory writes serialize on this account's profile, including the first write. */
async function lockProfile(tx: Prisma.TransactionClient, userId: string) {
  await tx.agentPersonalization.createMany({ data: { userId }, skipDuplicates: true })
  await tx.$queryRaw`SELECT user_id FROM agent_personalizations WHERE user_id = ${userId} FOR UPDATE`
  return tx.agentPersonalization.findUniqueOrThrow({ where: { userId } })
}

function digestMemory(text: string) {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
  return createHash('sha256').update(normalized).digest('hex')
}

export async function getAgentPersonalization(userId: string, db: Prisma.TransactionClient = prisma): Promise<AgentPersonalizationPayload> {
  const profile = await db.agentPersonalization.findUnique({ where: { userId } })
  return { settings: projectSettings(profile), revision: profile?.revision ?? 0 }
}

export async function getPersonalizationMemoryEpoch(userId: string, db: Prisma.TransactionClient = prisma): Promise<number> {
  const profile = await db.agentPersonalization.findUnique({ where: { userId }, select: { memoryEpoch: true } })
  return profile?.memoryEpoch ?? 0
}

export function patchAgentPersonalization(userId: string, input: PatchAgentPersonalization, tx?: Prisma.TransactionClient): Promise<AgentPersonalizationPayload> {
  return transact(tx, async db => {
    const profile = await lockProfile(db, userId)
    const { expectedRevision, ...changes } = input
    if (profile.revision !== expectedRevision) throw settingsConflict()
    const memoryChanged = changes.memoryEnabled !== undefined && changes.memoryEnabled !== profile.memoryEnabled
    const memoryFence = memoryChanged ? { memoryEpoch: { increment: 1 }, memoryEpochChangedAt: await databaseNow(db) } : {}
    const updated = await db.agentPersonalization.update({
      where: { userId },
      data: { ...changes, revision: { increment: 1 }, ...memoryFence },
    })
    return { settings: projectSettings(updated), revision: updated.revision }
  })
}

export function listPersonalizationMemories(userId: string, tx?: Prisma.TransactionClient): Promise<AgentPersonalizationMemoriesPayload & { memoryEpoch: number }> {
  return readSnapshot(tx, async db => {
    const profile = await db.agentPersonalization.findUnique({ where: { userId }, select: { memoryRevision: true, memoryEpoch: true } })
    if (!profile) return { memories: [], revision: 0, memoryEpoch: 0 }
    const memories = await db.agentPersonalizationMemory.findMany({ where: { userId }, orderBy: memoryOrder })
    return { memories: memories.map(projectMemory), revision: profile.memoryRevision, memoryEpoch: profile.memoryEpoch }
  })
}

async function insertMemory(tx: Prisma.TransactionClient, userId: string, text: string, source: StoredMemory['source']) {
  const textDigest = digestMemory(text)
  const existing = await tx.agentPersonalizationMemory.findUnique({ where: { userId_textDigest: { userId, textDigest } } })
  if (existing) return { memory: projectMemory(existing), status: 'existing' as const }
  const row = await tx.agentPersonalizationMemory.create({ data: { userId, text, textDigest, source } })
  await tx.agentPersonalization.update({ where: { userId }, data: { memoryRevision: { increment: 1 } } })
  return { memory: projectMemory(row), status: 'created' as const }
}

export function createPersonalizationMemory(userId: string, text: string, tx?: Prisma.TransactionClient) {
  return transact(tx, async db => {
    await lockProfile(db, userId)
    return (await insertMemory(db, userId, text, 'manual')).memory
  })
}

export function saveConversationMemory(userId: string, text: string, expectedMemoryEpoch: number, tx?: Prisma.TransactionClient, sourceCreatedAt?: Date) {
  return transact(tx, async db => {
    const profile = await lockProfile(db, userId)
    if (!profile.memoryEnabled) throw new DataAccessError(409, 'PERSONALIZATION_MEMORY_DISABLED', '个人记忆已关闭。')
    if (profile.memoryEpoch !== expectedMemoryEpoch || !sourceCreatedAt ||
        (profile.memoryEpochChangedAt && sourceCreatedAt <= profile.memoryEpochChangedAt)) throw memoryConflict()
    return insertMemory(db, userId, text, 'conversation')
  })
}

async function getOwnedMemory(tx: Prisma.TransactionClient, userId: string, id: string, expectedRevision: number) {
  const memory = await tx.agentPersonalizationMemory.findUnique({ where: { id, userId } })
  if (!memory) throw new DataAccessError(404, 'NOT_FOUND', '记忆不存在或无权访问。')
  if (memory.revision !== expectedRevision) throw memoryConflict()
  return memory
}

async function advanceMemoryVersions(tx: Prisma.TransactionClient, userId: string) {
  const updated = await tx.agentPersonalization.update({
    where: { userId },
    data: { memoryRevision: { increment: 1 }, memoryEpoch: { increment: 1 }, memoryEpochChangedAt: await databaseNow(tx) },
    select: { memoryRevision: true },
  })
  return { revision: updated.memoryRevision }
}

export function updatePersonalizationMemory(userId: string, memoryId: string, input: PatchAgentPersonalizationMemory, tx?: Prisma.TransactionClient) {
  return transact(tx, async db => {
    await lockProfile(db, userId)
    const memory = await getOwnedMemory(db, userId, memoryId, input.expectedRevision)
    if (input.text === memory.text) return projectMemory(memory)
    const textDigest = digestMemory(input.text)
    const duplicate = await db.agentPersonalizationMemory.findUnique({ where: { userId_textDigest: { userId, textDigest } }, select: { id: true } })
    if (duplicate && duplicate.id !== memoryId) throw new DataAccessError(409, 'PERSONALIZATION_MEMORY_CONFLICT', '该记忆已存在。')
    const updated = await db.agentPersonalizationMemory.update({
      where: { id: memoryId, userId },
      data: { text: input.text, textDigest, revision: { increment: 1 } },
    })
    await advanceMemoryVersions(db, userId)
    return projectMemory(updated)
  })
}

export function deletePersonalizationMemory(userId: string, memoryId: string, expectedRevision: number, tx?: Prisma.TransactionClient) {
  return transact(tx, async db => {
    await lockProfile(db, userId)
    await getOwnedMemory(db, userId, memoryId, expectedRevision)
    await db.agentPersonalizationMemory.delete({ where: { id: memoryId, userId } })
    return advanceMemoryVersions(db, userId)
  })
}

export function clearPersonalizationMemories(userId: string, expectedRevision: number, tx?: Prisma.TransactionClient) {
  return transact(tx, async db => {
    const profile = await lockProfile(db, userId)
    if (profile.memoryRevision !== expectedRevision) throw memoryConflict()
    await db.agentPersonalizationMemory.deleteMany({ where: { userId } })
    return advanceMemoryVersions(db, userId)
  })
}

const memorySegmenter = new Intl.Segmenter('zh', { granularity: 'word' })

function memoryTerms(text: string) {
  const words = new Set<string>()
  for (const part of memorySegmenter.segment(text.normalize('NFKC').toLowerCase())) {
    if (part.isWordLike && part.segment.length > 1) words.add(part.segment)
  }
  return words
}

export function getAgentPersonalizationContext(userId: string, prompt: string, tx?: Prisma.TransactionClient) {
  return readSnapshot(tx, async db => {
    const profile = await db.agentPersonalization.findUnique({ where: { userId } })
    const settings = projectSettings(profile)
    const memoryEpoch = profile?.memoryEpoch ?? 0
    const memories: AgentPersonalizationMemory[] = []
    if (!profile?.memoryEnabled) return { settings, memories, memoryEpoch }
    const candidates = await db.agentPersonalizationMemory.findMany({ where: { userId }, orderBy: memoryOrder, take: 48 })
    const terms = memoryTerms(prompt)
    const ranked = candidates.map(memory => ({
      memory,
      score: [...memoryTerms(memory.text)].filter(term => terms.has(term)).length,
    })).sort((a, b) => b.score - a.score)
    const hasMatch = (ranked[0]?.score ?? 0) > 0
    let budget = 1_200
    for (const { memory, score } of ranked) {
      if (memories.length === 4 || (hasMatch && score === 0)) break
      if (memory.text.length > budget) continue
      memories.push(projectMemory(memory))
      budget -= memory.text.length
    }
    return { settings, memories, memoryEpoch }
  })
}
