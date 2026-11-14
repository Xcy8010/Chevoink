import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  changePersonalizationRule,
  readPersonalizationRules,
  clearPersonalizationMemories,
  createPersonalizationMemory,
  deletePersonalizationMemory,
  getAgentPersonalization,
  getAgentPersonalizationContext,
  getPersonalizationMemoryEpoch,
  listPersonalizationMemories,
  patchAgentPersonalization,
  restorePersonalizationMemory,
  saveConversationMemory,
  updatePersonalizationMemory,
} from '../../api/lib/agent/personalization.js'
import { prisma } from '../../api/lib/prisma.js'
import { DEFAULT_AGENT_PERSONALIZATION_SETTINGS } from '../../shared/contracts/agent-personalization.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { randomUUID } from 'node:crypto'
import { automaticRepairPermitted } from '../../api/lib/agent/personalization-tool-policy.js'

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
    expect(await getAgentPersonalization(ownerId)).toEqual({ settings: DEFAULT_AGENT_PERSONALIZATION_SETTINGS, revision: 0, rules: [] })
    expect(await prisma.agentPersonalization.count({ where: { userId: ownerId } })).toBe(0)
    const results = await Promise.allSettled([
      patchAgentPersonalization(ownerId, { expectedRevision: 0, style: 'direct' }),
      patchAgentPersonalization(ownerId, { expectedRevision: 0, detail: 'more' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'PERSONALIZATION_CONFLICT' } })
    const current = await getAgentPersonalization(ownerId)
    const next = await patchAgentPersonalization(ownerId, { expectedRevision: 1, warmth: 'more' })
    expect(next).toEqual({ revision: 2, settings: { ...current.settings, warmth: 'more' }, rules: [] })
    expect(await getAgentPersonalization(readerId)).toEqual({ settings: DEFAULT_AGENT_PERSONALIZATION_SETTINGS, revision: 0, rules: [] })
  })

  it('fences item edits/deletes by owner and revision, including a concurrent collection clear', async () => {
    const note = await createPersonalizationMemory(ownerId, '请用第三人称讨论。')
    const edit = { text: '回复时用第三人称。', expectedRevision: note.revision }
    await expect(updatePersonalizationMemory(readerId, note.id, edit)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    await expect(deletePersonalizationMemory(readerId, note.id, note.revision)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(await listPersonalizationMemories(readerId)).toEqual({ memories: [], archived: [], revision: 0, memoryEpoch: 0 })
    const initial = await listPersonalizationMemories(ownerId)
    const updated = await updatePersonalizationMemory(ownerId, note.id, edit)
    expect(updated).toMatchObject({ text: edit.text, revision: note.revision + 1, source: 'manual' })
    await expect(deletePersonalizationMemory(ownerId, note.id, note.revision)).rejects.toMatchObject({ status: 409 })
    await expect(clearPersonalizationMemories(ownerId, initial.revision)).rejects.toMatchObject({ status: 409 })
    const { revision } = await deletePersonalizationMemory(ownerId, note.id, updated.revision)
    expect(await listPersonalizationMemories(ownerId)).toEqual({ revision, memories: [], archived: [], memoryEpoch: 2 })
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
    expect(results[0]).toMatchObject({ memory: { id: expect.any(String) } })
    expect(results[1]).toMatchObject({ memory: 'memory' in results[0] ? { id: results[0].memory.id } : undefined })
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
    expect(await listPersonalizationMemories(ownerId)).toEqual({ memories: [], archived: [], revision: 0, memoryEpoch: 0 })
    const relevant = await createPersonalizationMemory(ownerId, '给我解释 POV 术语时用第三人称讨论。')
    for (let i = 0; i < 7; i++) await createPersonalizationMemory(ownerId, `协作偏好 ${i}`.padEnd(490, '细'))
    await createPersonalizationMemory(readerId, 'Private POV note')
    const matched = await getAgentPersonalizationContext(ownerId, '请解释 POV')
    expect(matched.memories.map(memory => memory.id)).toEqual([relevant.id])
    const fallback = await getAgentPersonalizationContext(ownerId, 'XYZ')
    expect(fallback.memories).toEqual([])
    expect(fallback.memories.length).toBeLessThanOrEqual(4)
    expect(fallback.memories.reduce((count, memory) => count + memory.text.length, 0)).toBeLessThanOrEqual(1_200)
  })

  it('ranks all 50 active entries once per author run without counting stable defaults', async () => {
    const core = await createPersonalizationMemory(ownerId, '以后请叫我小叶')
    const relevant = await createPersonalizationMemory(ownerId, '解释 POV 时举第三人称的例子')
    for (let i = 0; i < 48; i++) await createPersonalizationMemory(ownerId, `虚构偏好 ${i}`)
    await prisma.agentPersonalizationMemory.updateMany({ where: { id: { in: [core.id, relevant.id] } }, data: { updatedAt: new Date('2025-01-01') } })
    const novel = await prisma.novel.create({ data: { authorId: ownerId, title: '合成作品', slug: randomUUID(), summary: '' } })
    const session = await prisma.agentSession.create({ data: { userId: ownerId, novelId: novel.id, title: '合成对话' } })
    const run = await prisma.agentRun.create({ data: { userId: ownerId, novelId: novel.id, sessionId: session.id,
      status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop' } })
    try {
      expect((await getAgentPersonalizationContext(ownerId, '帮我解释 POV', undefined, run.id)).memories.map(row => row.id)).toEqual([core.id, relevant.id])
      await getAgentPersonalizationContext(ownerId, '帮我解释 POV', undefined, run.id)
      await listPersonalizationMemories(ownerId)
      const rows = await prisma.agentPersonalizationMemory.findMany({ where: { id: { in: [core.id, relevant.id] } } })
      expect(rows.find(row => row.id === core.id)).toMatchObject({ hitCount: 0, lastHitAt: null })
      expect(rows.find(row => row.id === relevant.id)).toMatchObject({ hitCount: 1, lastHitAt: expect.any(Date) })
      expect((await getAgentPersonalizationContext(ownerId, '你好')).memories.map(row => row.id)).toEqual([core.id])
    } finally {
      await prisma.agentRun.delete({ where: { id: run.id } })
      await prisma.agentSession.delete({ where: { id: session.id } })
      await prisma.novel.delete({ where: { id: novel.id } })
    }
  })

  it('merges equivalent phrasing, requires an explicit correction and protects fixed core text', async () => {
    const source = new Date()
    const original = await saveConversationMemory(ownerId, '以后叫我小景', 0, undefined, source)
    expect(original).toMatchObject({ status: 'created' })
    if (!('memory' in original)) throw new Error('Expected an active memory')
    await expect(saveConversationMemory(ownerId, '今后请称呼我小景', 0, undefined, source))
      .resolves.toMatchObject({ status: 'merged', memory: { id: original.memory.id, text: '以后叫我小景' } })
    await expect(saveConversationMemory(ownerId, '以后叫我阿墨', 0, undefined, source))
      .resolves.toEqual({ status: 'not_saved', reason: 'ambiguous' })
    await expect(saveConversationMemory(ownerId, '更正：以后叫我阿墨', 0, undefined, source, true))
      .resolves.toMatchObject({ status: 'corrected', memory: { id: original.memory.id, pinned: true } })
    const epoch = await getPersonalizationMemoryEpoch(ownerId)
    await expect(saveConversationMemory(ownerId, '更正：以后叫我小笔', epoch, undefined, new Date(Date.now() + 5000)))
      .resolves.toEqual({ status: 'not_saved', reason: 'ambiguous' })
    expect((await listPersonalizationMemories(ownerId)).memories).toMatchObject([{ text: '更正：以后叫我阿墨', pinned: true }])
  })

  it('does not displace a young or fixed entry and keeps overflow recoverable for 30 days', async () => {
    const source = new Date()
    const old = await saveConversationMemory(ownerId, '我平时喜欢古典意象', 0, undefined, source)
    const popular = await saveConversationMemory(ownerId, '我长期偏好讨论世界观', 0, undefined, source)
    const fixed = await saveConversationMemory(ownerId, '我喜欢比较大纲', 0, undefined, source, true)
    if (!('memory' in old && 'memory' in fixed && 'memory' in popular)) throw new Error('Expected three active memories')
    for (let i = 0; i < 46; i++) await createPersonalizationMemory(ownerId, `手动条目 ${i}`)
    const finalWrites = await Promise.allSettled([
      createPersonalizationMemory(ownerId, '同时新增甲'),
      createPersonalizationMemory(ownerId, '同时新增乙'),
    ])
    expect(finalWrites.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    await expect(saveConversationMemory(ownerId, '以后请叫我小景', 0, undefined, source)).resolves.toEqual({ status: 'not_saved', reason: 'capacity' })
    await prisma.agentPersonalizationMemory.updateMany({ where: { id: { in: [old.memory.id, popular.memory.id, fixed.memory.id] } },
      data: { createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-01') } })
    await prisma.agentPersonalizationMemory.update({ where: { id: popular.memory.id }, data: { hitCount: 7, lastHitAt: new Date() } })
    await expect(saveConversationMemory(ownerId, '只用于这次的轻量偏好', 0, undefined, source)).resolves.toEqual({ status: 'not_saved', reason: 'capacity' })
    await expect(saveConversationMemory(ownerId, '以后请叫我小景', 0, undefined, source)).resolves.toMatchObject({ status: 'created' })
    const list = await listPersonalizationMemories(ownerId)
    expect(list.memories).toHaveLength(50)
    expect(list.memories.some(memory => memory.id === fixed.memory.id)).toBe(true)
    expect(list.archived).toMatchObject([{ id: old.memory.id, lastChange: 'capacity', recoveryUntil: expect.any(String) }])
    const archived = list.archived[0]
    expect(Date.parse(archived.recoveryUntil!) - Date.now()).toBeGreaterThan(29 * 86_400_000)
    expect((await getAgentPersonalizationContext(ownerId, '古典意象')).memories.some(memory => memory.id === archived.id)).toBe(false)
    await expect(restorePersonalizationMemory(readerId, archived.id, archived.revision)).rejects.toMatchObject({ status: 404 })
    await expect(restorePersonalizationMemory(ownerId, archived.id, archived.revision)).rejects.toMatchObject({ code: 'PERSONALIZATION_MEMORY_FULL' })
    const removable = list.memories.find(memory => memory.text.startsWith('同时新增'))!
    await deletePersonalizationMemory(ownerId, removable.id, removable.revision)
    const restored = await restorePersonalizationMemory(ownerId, archived.id, archived.revision)
    expect(restored).toMatchObject({ id: archived.id, lastChange: 'restored', recoveryUntil: null })
    await expect(listPersonalizationMemories(ownerId)).resolves.toMatchObject({ archived: [] })
  })

  it('shares rule CAS without changing another account or the memory switch', async () => {
    const first = await changePersonalizationRule(ownerId, 'chapter_read', 'deny', 0)
    expect(first).toMatchObject({ revision: 1, rules: [{ toolName: 'chapter_read', permission: 'deny' }] })
    await expect(changePersonalizationRule(ownerId, 'chapter_read', 'allow', 0)).rejects.toMatchObject({ code: 'PERSONALIZATION_CONFLICT' })
    await expect(getAgentPersonalization(readerId)).resolves.toMatchObject({ revision: 0, rules: [] })
    await expect(changePersonalizationRule(ownerId, 'chapter_read', null, 1)).resolves.toMatchObject({ revision: 2, rules: [], settings: { memoryEnabled: true } })
  })

  it('stores original rule text independently of the permission applied by the runtime', async () => {
    await changePersonalizationRule(ownerId, 'chapter_read', 'ask', 0)
    const text = '查阅章节前，先问我。'
    const documented = await changePersonalizationRule(ownerId, 'chapter_read', 'ask', 1, undefined, text)
    expect(documented).toMatchObject({ revision: 2, rules: [{ toolName: 'chapter_read', permission: 'ask', text }] })
    await expect(getAgentPersonalization(readerId)).resolves.toMatchObject({ rules: [] })
    await expect(readPersonalizationRules(ownerId)).resolves.toEqual([{ toolName: 'chapter_read', permission: 'ask' }])
    await expect(changePersonalizationRule(ownerId, 'chapter_read', 'ask', 1, undefined, '过期草稿')).rejects.toMatchObject({ code: 'PERSONALIZATION_CONFLICT' })
    await expect(changePersonalizationRule(ownerId, 'chapter_read', 'deny', 2)).resolves.toMatchObject({
      revision: 3, rules: [{ toolName: 'chapter_read', permission: 'deny' }],
    })
    await changePersonalizationRule(ownerId, 'chapter_read', null, 3)
    const recreated = await changePersonalizationRule(ownerId, 'chapter_read', 'allow', 4)
    expect(recreated.revision).toBe(5)
    expect(recreated.rules).toEqual([{ toolName: 'chapter_read', permission: 'allow' }])
    await changePersonalizationRule(ownerId, 'chapter_read', 'deny', 5, undefined, '不要查阅章节。')
    // Simulate an earlier server that only writes the original permission column.
    const writeLegacyRules = (toolRules: Array<{ toolName: string; permission: string }>) => prisma.agentPersonalization.update({
      where: { userId: ownerId }, data: { toolRules, revision: { increment: 1 } },
    })
    await writeLegacyRules([{ toolName: 'chapter_read', permission: 'allow' }])
    expect((await getAgentPersonalization(ownerId)).rules).toEqual([{ toolName: 'chapter_read', permission: 'allow' }])
    await changePersonalizationRule(ownerId, 'chapter_read', 'allow', 7, undefined, '可以直接查阅章节。')
    await writeLegacyRules([])
    await writeLegacyRules([{ toolName: 'chapter_read', permission: 'allow' }])
    const upgraded = await getAgentPersonalization(ownerId)
    expect(upgraded.revision).toBe(10)
    expect(upgraded.rules).toEqual([{ toolName: 'chapter_read', permission: 'allow' }])
  })

  it('keeps quality checks report-only when an implicit repair has an ask or deny rule', async () => {
    await changePersonalizationRule(ownerId, 'quality_revision_apply', 'ask', 0)
    await expect(automaticRepairPermitted(ownerId, prisma, 'quality')).resolves.toBe(false)
    await expect(automaticRepairPermitted(ownerId, prisma, 'continuity')).resolves.toBe(true)
    await expect(automaticRepairPermitted(readerId, prisma, 'quality')).resolves.toBe(true)
    await changePersonalizationRule(ownerId, 'chapter_edit_range', 'deny', 1)
    await expect(prisma.$transaction(tx => automaticRepairPermitted(ownerId, tx, 'continuity', true))).resolves.toBe(false)
  })
})
