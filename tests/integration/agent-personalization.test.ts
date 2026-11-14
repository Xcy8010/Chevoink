import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearPersonalizationMemories,
  createPersonalizationMemory,
  deletePersonalizationMemory,
  getAgentPersonalization,
  getAgentPersonalizationContext,
  getPersonalizationMemoryEpoch,
  listPersonalizationMemories,
  patchAgentPersonalization,
  saveConversationMemory,
  updatePersonalizationMemory,
} from '../../api/lib/agent/personalization.js'
import { prisma } from '../../api/lib/prisma.js'
import { DEFAULT_AGENT_PERSONALIZATION_SETTINGS } from '../../shared/contracts/agent-personalization.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })

describe.skipIf(!dbAvailable)('account personalization (isolated PostgreSQL)', () => {
  const users: string[] = []
  let ownerId: string
  let readerId: string

  beforeEach(async () => {
    for (const nickname of ['author-one', 'author-two']) {
      const user = await prisma.user.create({ data: { nickname, passwordHash: 'not-a-real-password' } })
      users.push(user.id)
    }
    ;[ownerId, readerId] = users
  })

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: { in: users } } })
    users.length = 0
  })

  it('returns defaults lazily and preserves only one concurrent settings write at the same revision', async () => {
    expect(await getAgentPersonalization(ownerId)).toEqual({ settings: DEFAULT_AGENT_PERSONALIZATION_SETTINGS, revision: 0 })
    expect(await prisma.agentPersonalization.count({ where: { userId: ownerId } })).toBe(0)
    const results = await Promise.allSettled([
      patchAgentPersonalization(ownerId, { expectedRevision: 0, style: 'direct' }),
      patchAgentPersonalization(ownerId, { expectedRevision: 0, preferredName: '小叶' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'PERSONALIZATION_CONFLICT' } })
    const current = await getAgentPersonalization(ownerId)
    const next = await patchAgentPersonalization(ownerId, { expectedRevision: 1, warmth: 'more' })
    expect(next).toEqual({ revision: 2, settings: { ...current.settings, warmth: 'more' } })
    expect(await getAgentPersonalization(readerId)).toEqual({ settings: DEFAULT_AGENT_PERSONALIZATION_SETTINGS, revision: 0 })
  })

  it('fences item edits/deletes by owner and revision, including a concurrent collection clear', async () => {
    const note = await createPersonalizationMemory(ownerId, '请用第三人称讨论。')
    const edit = { text: '回复时用第三人称。', expectedRevision: note.revision }
    await expect(updatePersonalizationMemory(readerId, note.id, edit)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    await expect(deletePersonalizationMemory(readerId, note.id, note.revision)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(await listPersonalizationMemories(readerId)).toEqual({ memories: [], revision: 0, memoryEpoch: 0 })
    const initial = await listPersonalizationMemories(ownerId)
    const updated = await updatePersonalizationMemory(ownerId, note.id, edit)
    expect(updated).toMatchObject({ text: edit.text, revision: note.revision + 1, source: 'manual' })
    await expect(deletePersonalizationMemory(ownerId, note.id, note.revision)).rejects.toMatchObject({ status: 409 })
    await expect(clearPersonalizationMemories(ownerId, initial.revision)).rejects.toMatchObject({ status: 409 })
    const { revision } = await deletePersonalizationMemory(ownerId, note.id, updated.revision)
    expect(await listPersonalizationMemories(ownerId)).toEqual({ revision, memories: [], memoryEpoch: 2 })
  })

  it('deduplicates concurrent conversational saves and invalidates old sources on disable/clear', async () => {
    const epoch = await getPersonalizationMemoryEpoch(ownerId)
    const source = new Date(0)
    await expect(saveConversationMemory(ownerId, 'unverified', epoch)).rejects.toMatchObject({ code: 'PERSONALIZATION_MEMORY_CONFLICT' })
    const results = await Promise.all([
      saveConversationMemory(ownerId, 'Use  ASCII', epoch, undefined, source),
      saveConversationMemory(ownerId, 'use ＡＳＣＩＩ', epoch, undefined, source),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['created', 'existing'])
    expect(results[0].memory.id).toBe(results[1].memory.id)
    await patchAgentPersonalization(ownerId, { expectedRevision: 0, memoryEnabled: false })
    expect(await getAgentPersonalizationContext(ownerId, 'ASCII')).toMatchObject({ settings: { memoryEnabled: false }, memories: [] })
    await expect(saveConversationMemory(ownerId, 'another note', epoch)).rejects.toMatchObject({ code: 'PERSONALIZATION_MEMORY_DISABLED' })
    await createPersonalizationMemory(ownerId, 'Manual while disabled')
    const visible = await listPersonalizationMemories(ownerId)
    expect(visible.memories).toHaveLength(2)
    await clearPersonalizationMemories(ownerId, visible.revision)
    await patchAgentPersonalization(ownerId, { expectedRevision: 1, memoryEnabled: true })
    const currentEpoch = await getPersonalizationMemoryEpoch(ownerId)
    await expect(saveConversationMemory(ownerId, 'old note', epoch)).rejects.toMatchObject({ code: 'PERSONALIZATION_MEMORY_CONFLICT' })
    await expect(saveConversationMemory(ownerId, 'old note', currentEpoch, undefined, new Date(0))).rejects.toMatchObject({ code: 'PERSONALIZATION_MEMORY_CONFLICT' })
    const profile = await prisma.agentPersonalization.findUniqueOrThrow({ where: { userId: ownerId } })
    const newSource = new Date(profile.memoryEpochChangedAt!.getTime() + 1)
    const fresh = await saveConversationMemory(ownerId, 'new note', currentEpoch, undefined, newSource)
    expect(fresh).toMatchObject({ status: 'created', memory: { source: 'conversation' } })
  })

  it('limits author context and supports mutation in the caller transaction', async () => {
    await prisma.$transaction(async tx => {
      await createPersonalizationMemory(ownerId, '关于编辑沟通，我喜欢先讲结论。', tx)
      const context = await getAgentPersonalizationContext(ownerId, '编辑沟通', tx)
      expect(context.memories.map(memory => memory.text)).toEqual(['关于编辑沟通，我喜欢先讲结论。'])
      throw new Error('abort test transaction')
    }).catch(error => { expect(error).toMatchObject({ message: 'abort test transaction' }) })
    expect(await listPersonalizationMemories(ownerId)).toEqual({ memories: [], revision: 0, memoryEpoch: 0 })
    const relevant = await createPersonalizationMemory(ownerId, '给我解释 POV 术语时用第三人称讨论。')
    for (let i = 0; i < 7; i++) await createPersonalizationMemory(ownerId, `协作偏好 ${i}`.padEnd(490, '细'))
    await createPersonalizationMemory(readerId, 'Private POV note')
    const matched = await getAgentPersonalizationContext(ownerId, '请解释 POV')
    expect(matched.memories.map(memory => memory.id)).toEqual([relevant.id])
    const fallback = await getAgentPersonalizationContext(ownerId, 'XYZ')
    expect(fallback.memories.length).toBeGreaterThan(0)
    expect(fallback.memories.length).toBeLessThanOrEqual(4)
    expect(fallback.memories.reduce((count, memory) => count + memory.text.length, 0)).toBeLessThanOrEqual(1_200)
  })
})
