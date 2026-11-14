/// <reference lib="es2022.intl" />

import { createHash } from 'node:crypto'
import { Prisma, type AgentPersonalization, type AgentPersonalizationMemory as StoredMemory } from '@prisma/client'
import {
  AGENT_PERSONALIZATION_LIMITS, DEFAULT_AGENT_PERSONALIZATION_SETTINGS, agentPersonalizationRuleSchema,
  type AgentPersonalizationMemoriesPayload, type AgentPersonalizationMemory, type AgentPersonalizationPayload,
  type AgentPersonalizationRule, type AgentPersonalizationSettings, type PatchAgentPersonalization, type PatchAgentPersonalizationMemory,
} from '../../../shared/contracts/agent-personalization.js'
import { DataAccessError, prisma } from '../prisma.js'
import { databaseNow } from './runtime-common.js'

const memoryOrder = [{ updatedAt: 'desc' }, { id: 'desc' }] satisfies Prisma.AgentPersonalizationMemoryOrderByWithRelationInput[]
const day = 86_400_000
const observationPeriod = 14 * day
const stalePeriod = 30 * day
const recoveryPeriod = 30 * day

function projectSettings(profile: AgentPersonalization | null): AgentPersonalizationSettings {
  if (!profile) return { ...DEFAULT_AGENT_PERSONALIZATION_SETTINGS }
  const { memoryEnabled, customInstructions, style, warmth, enthusiasm, detail, emoji, format } = profile
  return { memoryEnabled, customInstructions, style, warmth, enthusiasm, detail, emoji, format }
}

function projectMemory(memory: StoredMemory): AgentPersonalizationMemory {
  const { id, text, source, revision, pinned, recoveryUntil, lastChange, createdAt, updatedAt } = memory
  return { id, text, source, revision, pinned, recoveryUntil: recoveryUntil?.toISOString() ?? null, lastChange,
    createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() }
}

function projectRules(raw: Prisma.JsonValue | undefined): AgentPersonalizationRule[] {
  if (raw === undefined) return []
  if (Array.isArray(raw)) {
    const rules: AgentPersonalizationRule[] = []
    for (const value of raw) {
      const rule = agentPersonalizationRuleSchema.safeParse(value)
      if (!rule.success || rules.some(item => item.toolName === rule.data.toolName)) break
      rules.push(rule.data)
    }
    if (rules.length === raw.length) return rules
  }
  throw new DataAccessError(409, 'PERSONALIZATION_RULES_INVALID', '个性化权限无法核实，请重新加载。')
}

function projectProfile(profile: AgentPersonalization | null): AgentPersonalizationPayload {
  const texts = profile?.toolRuleTexts
  const rules = projectRules(profile?.toolRules).map(rule => {
    const text = texts && typeof texts === 'object' && !Array.isArray(texts) ? texts[rule.toolName] : undefined
    return typeof text === 'string' && text ? { ...rule, text } : rule
  })
  return { settings: projectSettings(profile), revision: profile?.revision ?? 0, rules }
}

const settingsConflict = () => new DataAccessError(409, 'PERSONALIZATION_CONFLICT', '个性化设置已更新，请刷新后重试。')
const memoryConflict = () => new DataAccessError(409, 'PERSONALIZATION_MEMORY_CONFLICT', '记忆已更新，请刷新后重试。')
const memoryFull = () => new DataAccessError(409, 'PERSONALIZATION_MEMORY_FULL', '有效记忆已达到 50 条，请先腾出一个位置。')
const memoryUnavailable = () => new DataAccessError(404, 'NOT_FOUND', '记忆不存在或无权访问。')

function transact<T>(tx: Prisma.TransactionClient | undefined, work: (db: Prisma.TransactionClient) => Promise<T>) {
  return tx ? work(tx) : prisma.$transaction(work)
}

function readSnapshot<T>(tx: Prisma.TransactionClient | undefined, work: (db: Prisma.TransactionClient) => Promise<T>) {
  return tx ? work(tx) : prisma.$transaction(work, { isolationLevel: 'RepeatableRead' })
}

/** Every account settings and memory change serializes on one row; the unique
 * numbered slots also enforce the cap when a writer lacks this lock. */
async function lockProfile(tx: Prisma.TransactionClient, userId: string) {
  await tx.agentPersonalization.createMany({ data: { userId }, skipDuplicates: true })
  await tx.$queryRaw`SELECT user_id FROM agent_personalizations WHERE user_id = ${userId} FOR UPDATE`
  return tx.agentPersonalization.findUniqueOrThrow({ where: { userId } })
}

export async function readPersonalizationRules(userId: string, db: Prisma.TransactionClient = prisma, lock?: 'share' | 'update') {
  if (lock === 'update') return projectRules((await lockProfile(db, userId)).toolRules)
  if (lock === 'share') {
    const rows = await db.$queryRaw<Array<{ tool_rules: Prisma.JsonValue }>>`SELECT tool_rules FROM agent_personalizations WHERE user_id = ${userId} FOR SHARE`
    return projectRules(rows[0]?.tool_rules)
  }
  const profile = await db.agentPersonalization.findUnique({ where: { userId }, select: { toolRules: true } })
  return projectRules(profile?.toolRules)
}

export async function getAgentPersonalization(userId: string, db: Prisma.TransactionClient = prisma) {
  return projectProfile(await db.agentPersonalization.findUnique({ where: { userId } }))
}

export async function getPersonalizationMemoryEpoch(userId: string, db: Prisma.TransactionClient = prisma): Promise<number> {
  const profile = await db.agentPersonalization.findUnique({ where: { userId }, select: { memoryEpoch: true } })
  return profile?.memoryEpoch ?? 0
}

export function patchAgentPersonalization(userId: string, input: PatchAgentPersonalization, tx?: Prisma.TransactionClient) {
  return transact(tx, async db => {
    const profile = await lockProfile(db, userId)
    const { expectedRevision, ...changes } = input
    if (profile.revision !== expectedRevision) throw settingsConflict()
    const memoryChanged = changes.memoryEnabled !== undefined && changes.memoryEnabled !== profile.memoryEnabled
    const memoryFence = memoryChanged ? { memoryEpoch: { increment: 1 }, memoryEpochChangedAt: await databaseNow(db) } : {}
    const updated = await db.agentPersonalization.update({
      where: { userId }, data: { ...changes, revision: { increment: 1 }, ...memoryFence },
    })
    return projectProfile(updated)
  })
}

export function changePersonalizationRule(userId: string, toolName: string, permission: AgentPersonalizationRule['permission'] | null,
  expectedRevision: number, tx?: Prisma.TransactionClient, text?: string, originalToolName = toolName) {
  return transact(tx, async db => {
    const profile = await lockProfile(db, userId)
    if (profile.revision !== expectedRevision) throw settingsConflict()
    const rules = projectRules(profile.toolRules)
    const existing = rules.find(rule => rule.toolName === toolName)
    if (originalToolName !== toolName && (existing || !rules.some(rule => rule.toolName === originalToolName)))
      throw new DataAccessError(409, 'PERSONALIZATION_RULE_TARGET_CONFLICT', '这项操作已有规则，或原来的规则已经删除。')
    const previous = profile.toolRuleTexts
    const texts = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous } : {}
    if ((!existing && permission === null) || (existing?.permission === permission
      && (text === undefined || text === (texts[toolName] ?? '')))) return projectProfile(profile)
    const toolRules = rules.filter(rule => rule.toolName !== toolName && rule.toolName !== originalToolName)
    if (permission !== null) toolRules.push({ toolName, permission })
    toolRules.sort((a, b) => a.toolName.localeCompare(b.toolName))
    if (originalToolName !== toolName) delete texts[originalToolName]
    if (permission === null || text === '' || (text === undefined && existing?.permission !== permission)) delete texts[toolName]
    else if (text !== undefined) texts[toolName] = text
    return projectProfile(await db.agentPersonalization.update({
      where: { userId }, data: { toolRules, toolRuleTexts: texts as Prisma.InputJsonObject, revision: { increment: 1 } },
    }))
  })
}

export function listPersonalizationMemories(userId: string, tx?: Prisma.TransactionClient): Promise<AgentPersonalizationMemoriesPayload & { memoryEpoch: number }> {
  return readSnapshot(tx, async db => {
    const profile = await db.agentPersonalization.findUnique({ where: { userId }, select: { memoryRevision: true, memoryEpoch: true } })
    if (!profile) return { memories: [], archived: [], revision: 0, memoryEpoch: 0 }
    const rows = await db.agentPersonalizationMemory.findMany({
      where: { userId, OR: [{ activeSlot: { not: null } }, { recoveryUntil: { gt: await databaseNow(db) } }] }, orderBy: memoryOrder,
    })
    return { memories: rows.filter(row => row.activeSlot !== null).map(projectMemory),
      archived: rows.filter(row => row.activeSlot === null).map(projectMemory), revision: profile.memoryRevision, memoryEpoch: profile.memoryEpoch }
  })
}

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
const digestMemory = (text: string) => createHash('sha256').update(normalize(text)).digest('hex')

/** Narrow, high-confidence equivalence only. Different values on the same
 * topic are a conflict, never proof of a replacement. */
export function identifyMemory(text: string): { topic: string | null; meaning: string; correction: boolean; protected: boolean } {
  const clean = normalize(text).replace(/[。.!！]+$/u, '')
  const correction = /^(?:更正|纠正|改一下|correction|update)[:：,，]\s*/u.test(clean)
  const statement = clean.replace(/^(?:更正|纠正|改一下|correction|update)[:：,，]\s*/u, '')
  const address = /^(?:(?:以后|今后|从今以后|从现在起)(?:请)?(?:叫我|称呼我)(?:为)?|请(?:叫我|称呼我)(?:为)?|(?:please )?call me\s+)([^，,。!?！？:：;；\n]{1,80})$/u.exec(statement)
  if (address) return { topic: 'address', meaning: address[1].trim(), correction, protected: true }
  const language = /^(?:以后|今后|从现在起)(?:请)?(?:用|使用)(简体中文|繁体中文|普通话|中文|英语|英文|日语|日文)(?:回答(?:我)?|回复(?:我)?|交流)$/u.exec(statement)
  if (language) return { topic: 'language', meaning: ({ 英语: '英文', 日语: '日文' } as Record<string, string>)[language[1]] ?? language[1], correction, protected: true }
  const taboo = /^(?:以后|今后|请一直|我明确要求)\s*(?:请)?(?:不要|别|禁止|避免)/u.test(statement)
  return { topic: taboo ? 'boundary' : null, meaning: statement.replace(/^(?:请记住[:：,，]\s*|请\s+)/u, ''), correction: false, protected: taboo }
}

function nextSlot(rows: StoredMemory[]) {
  const occupied = new Set(rows.map(row => row.activeSlot))
  for (let slot = 1; slot <= AGENT_PERSONALIZATION_LIMITS.activeMemories; slot++) if (!occupied.has(slot)) return slot
  return null
}

async function advanceMemoryVersions(db: Prisma.TransactionClient, userId: string, fence: boolean, now?: Date) {
  const updated = await db.agentPersonalization.update({
    where: { userId },
    data: { memoryRevision: { increment: 1 }, ...(fence ? { memoryEpoch: { increment: 1 }, memoryEpochChangedAt: now ?? await databaseNow(db) } : {}) },
    select: { memoryRevision: true },
  })
  return { revision: updated.memoryRevision }
}

type InsertOutcome =
  | { status: 'created' | 'existing' | 'merged' | 'corrected'; memory: AgentPersonalizationMemory }
  | { status: 'not_saved'; reason: 'capacity' | 'ambiguous' | 'recoverable' }

async function insertMemory(db: Prisma.TransactionClient, userId: string, text: string, pinned: boolean, conversation: boolean): Promise<InsertOutcome> {
  const now = await databaseNow(db)
  await db.agentPersonalizationMemory.deleteMany({ where: { userId, recoveryUntil: { lte: now } } })
  const textDigest = digestMemory(text)
  const identity = identifyMemory(text)
  const active = await db.agentPersonalizationMemory.findMany({ where: { userId, activeSlot: { not: null } } })
  const exact = active.find(memory => memory.textDigest === textDigest)
  const equivalent = exact ?? active.find(memory => {
    const previous = identifyMemory(memory.text)
    return previous.topic === identity.topic && previous.meaning === identity.meaning
  })
  if (equivalent) {
    const merged = !exact && (equivalent.source === 'conversation' || !conversation)
    const pin = pinned && !equivalent.pinned
    if (!merged && !pin) return { status: 'existing', memory: projectMemory(equivalent) }
    const updated = await db.agentPersonalizationMemory.update({ where: { id: equivalent.id }, data: {
      pinned: equivalent.pinned || pinned, lastChange: merged ? 'merged' : 'edited', revision: { increment: 1 },
    } })
    await advanceMemoryVersions(db, userId, false)
    return { status: merged ? 'merged' : 'existing', memory: projectMemory(updated) }
  }
  if (await db.agentPersonalizationMemory.findUnique({ where: { userId_textDigest: { userId, textDigest } }, select: { id: true } })) {
    return { status: 'not_saved', reason: 'recoverable' }
  }
  if (conversation && (identity.topic === 'address' || identity.topic === 'language')) {
    const conflicts = active.filter(memory => memory.topic === identity.topic)
    if (conflicts.length) {
      const existing = conflicts[0]
      if (!identity.correction || conflicts.length !== 1 || existing.pinned || existing.source !== 'conversation')
        return { status: 'not_saved', reason: 'ambiguous' }
      const updated = await db.agentPersonalizationMemory.update({ where: { id: existing.id }, data: {
        text, textDigest, pinned, lastChange: 'corrected', hitCount: 0, lastHitAt: null, revision: { increment: 1 },
      } })
      await advanceMemoryVersions(db, userId, true, now)
      return { status: 'corrected', memory: projectMemory(updated) }
    }
  }
  let slot = nextSlot(active)
  if (slot === null && conversation && (identity.protected || pinned || /^(?:我(?:平时|通常|一贯|长期)|以后|今后)/u.test(text))) {
    const old = active.filter(memory => memory.source === 'conversation' && !memory.pinned && !memory.topic
      && memory.hitCount <= 1 && now.getTime() - memory.updatedAt.getTime() >= observationPeriod
      && now.getTime() - (memory.lastHitAt ?? memory.createdAt).getTime() >= stalePeriod)
      .sort((a, b) => a.hitCount - b.hitCount || (a.lastHitAt ?? a.createdAt).getTime() - (b.lastHitAt ?? b.createdAt).getTime())
      .find(memory => (identity.protected || pinned) || memory.hitCount === 0)
    if (old) {
      slot = old.activeSlot
      await db.agentPersonalizationMemory.update({ where: { id: old.id }, data: {
        activeSlot: null, recoveryUntil: new Date(now.getTime() + recoveryPeriod), lastChange: 'capacity', revision: { increment: 1 },
      } })
    }
  }
  if (slot === null) return { status: 'not_saved', reason: 'capacity' }
  const row = await db.agentPersonalizationMemory.create({ data: { userId, text, textDigest, activeSlot: slot, topic: identity.topic,
    pinned, source: conversation ? 'conversation' : 'manual' } })
  await advanceMemoryVersions(db, userId, active.some(item => item.activeSlot === slot), now)
  return { memory: projectMemory(row), status: 'created' }
}

export function createPersonalizationMemory(userId: string, text: string, tx?: Prisma.TransactionClient, pinned = false) {
  return transact(tx, async db => {
    await lockProfile(db, userId)
    const result = await insertMemory(db, userId, text, pinned, false)
    if (result.status === 'not_saved') {
      if (result.reason === 'recoverable') throw new DataAccessError(409, 'PERSONALIZATION_MEMORY_RECOVERABLE', '这条记忆可以从「最近整理」中恢复。')
      throw memoryFull()
    }
    return result.memory
  })
}

export function saveConversationMemory(userId: string, text: string, expectedMemoryEpoch: number, tx?: Prisma.TransactionClient, sourceCreatedAt?: Date, pinned = false) {
  return transact(tx, async db => {
    const profile = await lockProfile(db, userId)
    if (!profile.memoryEnabled) throw new DataAccessError(409, 'PERSONALIZATION_MEMORY_DISABLED', '个人记忆已关闭。')
    if (profile.memoryEpoch !== expectedMemoryEpoch || !sourceCreatedAt ||
        (profile.memoryEpochChangedAt && sourceCreatedAt <= profile.memoryEpochChangedAt)) throw memoryConflict()
    return insertMemory(db, userId, text, pinned, true)
  })
}

async function getOwnedMemory(tx: Prisma.TransactionClient, userId: string, id: string, expectedRevision: number) {
  const memory = await tx.agentPersonalizationMemory.findUnique({ where: { id, userId } })
  if (!memory || memory.recoveryUntil && memory.recoveryUntil <= await databaseNow(tx)) throw memoryUnavailable()
  if (memory.revision !== expectedRevision) throw memoryConflict()
  return memory
}

export function updatePersonalizationMemory(userId: string, memoryId: string, input: PatchAgentPersonalizationMemory, tx?: Prisma.TransactionClient) {
  return transact(tx, async db => {
    await lockProfile(db, userId)
    const memory = await getOwnedMemory(db, userId, memoryId, input.expectedRevision)
    if (memory.activeSlot === null) throw memoryConflict()
    const text = input.text ?? memory.text
    const pinned = input.pinned ?? memory.pinned
    if (text === memory.text && pinned === memory.pinned) return projectMemory(memory)
    const textDigest = digestMemory(text)
    if (textDigest !== memory.textDigest && await db.agentPersonalizationMemory.findUnique({
      where: { userId_textDigest: { userId, textDigest } }, select: { id: true },
    })) throw new DataAccessError(409, 'PERSONALIZATION_MEMORY_CONFLICT', '该记忆已存在。')
    const updated = await db.agentPersonalizationMemory.update({
      where: { id: memoryId, userId },
      data: { text, textDigest, topic: identifyMemory(text).topic, pinned, source: 'manual', lastChange: 'edited', revision: { increment: 1 },
        ...(text === memory.text ? {} : { hitCount: 0, lastHitAt: null }) },
    })
    await advanceMemoryVersions(db, userId, true)
    return projectMemory(updated)
  })
}

export function restorePersonalizationMemory(userId: string, memoryId: string, expectedRevision: number, tx?: Prisma.TransactionClient) {
  return transact(tx, async db => {
    await lockProfile(db, userId)
    const memory = await getOwnedMemory(db, userId, memoryId, expectedRevision)
    if (memory.activeSlot !== null) throw memoryConflict()
    const active = await db.agentPersonalizationMemory.findMany({ where: { userId, activeSlot: { not: null } } })
    const slot = nextSlot(active)
    if (slot === null) throw memoryFull()
    const updated = await db.agentPersonalizationMemory.update({ where: { id: memoryId, userId }, data: {
      activeSlot: slot, recoveryUntil: null, lastChange: 'restored', revision: { increment: 1 },
    } })
    await advanceMemoryVersions(db, userId, true)
    return projectMemory(updated)
  })
}

export function deletePersonalizationMemory(userId: string, memoryId: string, expectedRevision: number, tx?: Prisma.TransactionClient) {
  return transact(tx, async db => {
    await lockProfile(db, userId)
    await getOwnedMemory(db, userId, memoryId, expectedRevision)
    await db.agentPersonalizationMemory.delete({ where: { id: memoryId, userId } })
    return advanceMemoryVersions(db, userId, true)
  })
}

export function clearPersonalizationMemories(userId: string, expectedRevision: number, tx?: Prisma.TransactionClient) {
  return transact(tx, async db => {
    const profile = await lockProfile(db, userId)
    if (profile.memoryRevision !== expectedRevision) throw memoryConflict()
    await db.agentPersonalizationMemory.deleteMany({ where: { userId } })
    return advanceMemoryVersions(db, userId, true)
  })
}

const memorySegmenter = new Intl.Segmenter('zh', { granularity: 'word' })

function memoryTerms(text: string) {
  const words = new Set<string>()
  for (const part of memorySegmenter.segment(normalize(text))) {
    if (part.isWordLike && part.segment.length > 1) words.add(part.segment)
  }
  return words
}

async function recordMemoryHits(userId: string, runId: string, ids: string[]) {
  if (ids.length === 0) return
  // An initial author run is the idempotency key. Core/default rows never enter
  // this statement. Counter updates do not change text CAS or eviction age.
  await prisma.$executeRaw`
    WITH hits AS (
      INSERT INTO agent_personalization_memory_hits (memory_id, run_id)
      SELECT m.id, r.id FROM agent_personalization_memories m
      JOIN agent_runs current_run ON current_run.id = ${runId} AND current_run.user_id = m.user_id
      LEFT JOIN agent_task_roots root ON root.id = current_run.task_root_id
      LEFT JOIN agent_messages source ON source.id = root.source_message_id
      JOIN agent_runs r ON r.id = COALESCE(source.run_id, current_run.id) AND r.user_id = m.user_id
      WHERE m.user_id = ${userId} AND m.active_slot IS NOT NULL AND m.id IN (${Prisma.join(ids)})
      ON CONFLICT DO NOTHING RETURNING memory_id
    )
    UPDATE agent_personalization_memories m
    SET hit_count = m.hit_count + 1, last_hit_at = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    FROM hits WHERE m.id = hits.memory_id AND m.active_slot IS NOT NULL`
}

export async function getAgentPersonalizationContext(userId: string, prompt: string, tx?: Prisma.TransactionClient, authorRunId?: string) {
  const result = await readSnapshot(tx, async db => {
    const profile = await db.agentPersonalization.findUnique({ where: { userId } })
    const settings = projectSettings(profile)
    const memoryEpoch = profile?.memoryEpoch ?? 0
    const memories: AgentPersonalizationMemory[] = []
    const hits: string[] = []
    if (!profile?.memoryEnabled) return { settings, memories, memoryEpoch, hits }
    const candidates = await db.agentPersonalizationMemory.findMany({ where: { userId, activeSlot: { not: null } }, orderBy: memoryOrder })
    const terms = memoryTerms(prompt)
    const ranked = candidates.map(memory => ({
      memory,
      core: memory.topic === 'address' ? 3 : memory.topic === 'language' ? 2 : memory.topic === 'boundary' || memory.pinned ? 1 : 0,
      score: [...memoryTerms(memory.text)].filter(term => terms.has(term)).length,
    })).sort((a, b) => b.core - a.core || (b.core >= 2 ? Number(b.memory.pinned) - Number(a.memory.pinned) : 0) || b.score - a.score)
    let budget = 1_200
    const includedTopics = new Set<string>()
    for (const { memory, score, core } of ranked) {
      if (memories.length === 6 || (!core && !score)) break
      if (memory.text.length > budget || core >= 2 && includedTopics.has(memory.topic!)) continue
      memories.push(projectMemory(memory))
      if (core >= 2) includedTopics.add(memory.topic!)
      if (!core && score) hits.push(memory.id)
      budget -= memory.text.length
    }
    return { settings, memories, memoryEpoch, hits }
  })
  if (!tx && authorRunId) await recordMemoryHits(userId, authorRunId, result.hits)
  return { settings: result.settings, memories: result.memories, memoryEpoch: result.memoryEpoch }
}
