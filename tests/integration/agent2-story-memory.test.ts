import { randomInt, randomUUID } from 'node:crypto'

import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import {
  enqueueChapterMemoryExtraction,
  getMemoryGraph,
  listMemoryReviewInbox,
  saveEntityRelation,
  saveStoryMemory,
  searchStoryMemory,
  syncNovelMemoryProjection,
  updateStoryMemoryEntry, deleteStoryMemoryEntry, resolveMemoryReview, listStoryMemories,
} from '../../api/lib/agent/story-memory.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)

async function waitForMemoryExtractionJob(jobId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: jobId } })
    if (job.status === 'completed' || job.status === 'failed') {
      return job
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: jobId } })
}

afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
})

describe.skipIf(!dbAvailable)('Agent 2.0 P4 故事记忆与混合召回（需 DB）', () => {
  let userId = ''
  let novelId = ''
  let volumeId = ''
  const chapterIds: string[] = []

  beforeAll(async () => {
    const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
    const phone = `+861392${unique}`
    const register = await request(app).post('/api/auth/register')
      .send({ phone, nickname: `记忆评测${unique}`, password: 'Memory-Test-123!' })
    const cookies = Array.isArray(register.headers['set-cookie']) ? register.headers['set-cookie'] : [register.headers['set-cookie']]
    const cookie = cookies.find((item: string) => item?.startsWith('chevoink_session=')) as string
    userId = (await prisma.user.findUniqueOrThrow({ where: { phone }, select: { id: true } })).id
    const novel = await request(app).post('/api/novels').set('Cookie', cookie)
      .send({ title: '百章记忆评测', summary: '验证来源、召回与冲突。', tags: [] })
    novelId = novel.body.data.novel.id as string
    volumeId = (await prisma.volume.findFirstOrThrow({ where: { novelId }, select: { id: true } })).id
    for (let index = 1; index <= 100; index += 1) chapterIds.push(randomUUID())
    await prisma.chapter.createMany({ data: chapterIds.map((id, offset) => ({
      id, novelId, authorId: userId, volumeId, orderIndex: offset + 1, orderInVolume: offset + 1,
      title: `第${offset + 1}章`, summary: null,
      content: offset === 72 ? '林舟在钟楼下找到紫晶钥匙，并把它藏进旧怀表。' : `第${offset + 1}章发生了独立事件标记 FACT-${offset + 1}。`,
      wordCount: 30, status: 'draft', visibility: 'private', revision: 1,
    })) })
    for (let index = 0; index < 100; index += 1) {
      const fact = index === 72 ? '林舟在钟楼下找到紫晶钥匙，并把它藏进旧怀表。' : `第${index + 1}章事实 FACT-${index + 1}`
      await saveStoryMemory({
        userId, novelId, sourceChapterId: chapterIds[index], memoryType: 'chapterSummary', layer: 'L2',
        title: `章节:${chapterIds[index]}`, content: fact, importance: 60, confidence: 1, status: 'confirmed',
        evidence: { sourceType: 'chapter', sourceId: chapterIds[index], revision: 1, span: { start: 0, end: fact.length }, confidence: 1 },
      })
    }
  }, 30_000)

  it('100 章关键事实由词法+向量+图谱 RRF 召回，且来源章节和 revision 精确', async () => {
    const hits = await searchStoryMemory({ userId, novelId, query: '紫晶钥匙藏在哪里', limit: 5 })
    const target = hits.find((item) => item.content.includes('旧怀表'))
    expect(target).toBeDefined()
    expect(target?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'chapter', sourceId: chapterIds[72], revision: 1 }),
    ]))
    expect(target?.lexicalScore).toBeGreaterThan(0)
  })

  it('确定事实冲突不静默覆盖，而是生成 conflicted 候选进入作者审核箱', async () => {
    await saveStoryMemory({
      userId, novelId, memoryType: 'characterCard', layer: 'L1', title: '林舟',
      content: '林舟的母亲在故事开始前已经去世。', importance: 90, confidence: 1, status: 'confirmed',
      evidence: { sourceType: 'author_input', sourceId: 'author-fact-1', confidence: 1 },
    })
    const conflict = await saveStoryMemory({
      userId, novelId, memoryType: 'characterCard', layer: 'L1', title: '林舟',
      content: '林舟的母亲在第八十章来到钟楼探望他。', importance: 90, confidence: 1, status: 'confirmed',
      evidence: { sourceType: 'chapter', sourceId: chapterIds[79], revision: 1, confidence: 1 },
    })
    expect(conflict.action).toBe('conflict')
    const inbox = await listMemoryReviewInbox(userId, novelId)
    expect(inbox).toEqual(expect.arrayContaining([expect.objectContaining({ id: conflict.id, status: 'conflicted', reviewStatus: 'pending' })]))
    const canonical = await prisma.projectMemoryEntry.findFirstOrThrow({
      where: { novelId, memoryType: 'characterCard', title: '林舟', status: 'confirmed' },
    })
    expect(canonical.content).toContain('已经去世')
  })

  it('关系图只读投影返回实体、关系和稳定版本', async () => {
    await saveEntityRelation({
      userId, novelId, fromName: '林舟', toName: '顾棠', relationType: '共同调查',
      state: '暂时结盟', validFrom: 73, sourceId: chapterIds[72], revision: 1, confidence: 0.96,
    })
    const graph = await getMemoryGraph(userId, novelId)
    const labels = graph.nodes.map((node) => node.label)
    expect(labels).toEqual(expect.arrayContaining(['林舟', '顾棠']))
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: '共同调查', state: '暂时结盟', confidence: 0.96 }),
    ]))
    expect(graph.version).toMatch(/^[a-f0-9]{16}$/)
    expect(graph.updatedAt).toMatch(/T/)
  })

  it('章节变更按 revision 幂等抽取并增量生成章摘要与卷摘要', async () => {
    const chapter = await prisma.chapter.update({
      where: { id: chapterIds[0] }, data: { content: '雨夜里，林舟第一次抵达白塔。', revision: { increment: 1 } },
    })
    const jobId = await enqueueChapterMemoryExtraction({
      novelId, chapterId: chapter.id, chapterRevision: chapter.revision, before: '旧内容', after: chapter.content,
    })
    const job = await waitForMemoryExtractionJob(jobId)
    expect(job.status).toBe('completed')
    expect(await prisma.projectMemoryEntry.findFirst({ where: { novelId, memoryType: 'volumeSummary', title: `卷:${volumeId}` } })).not.toBeNull()
  })

  it('已有正文可无模型调用地初始化关系图，重复同步保持幂等', async () => {
    await prisma.chapter.update({ where: { id: chapterIds[1] }, data: { content: '林舟说：“去钟楼。” 顾棠问：“现在吗？”', revision: { increment: 1 } } })
    await prisma.chapter.update({ where: { id: chapterIds[2] }, data: { content: '顾棠点头，林舟转身走进雨里。', revision: { increment: 1 } } })
    await prisma.storyEntity.create({
      data: {
        novelId, entityType: 'character', canonicalName: '林舟知', status: 'inferred',
        description: '从正文中自动识别，出现于 1 个章节。',
      },
    })
    const first = await syncNovelMemoryProjection(userId, novelId)
    const relationCount = await prisma.entityRelation.count({ where: { fromEntity: { novelId }, relationType: '同章出现' } })
    const second = await syncNovelMemoryProjection(userId, novelId)
    const repeatedRelationCount = await prisma.entityRelation.count({ where: { fromEntity: { novelId }, relationType: '同章出现' } })
    const graph = await getMemoryGraph(userId, novelId)
    expect(first.entityCount).toBeGreaterThan(0)
    expect(second.jobCount).toBe(0)
    expect(graph.nodes.map((node) => node.label)).toEqual(expect.arrayContaining(['林舟', '顾棠']))
    expect(graph.nodes.map((node) => node.label)).not.toContain('林舟知')
    expect(repeatedRelationCount).toBe(relationCount)
  })

  it('model proposals cannot self-confirm or overwrite even with ID/overwrite; only author review activates them', async () => {
    const input = { userId, novelId, memoryType: 'worldbuilding' as const, layer: 'L1' as const, title: '审核保护样例', content: '旧设定', importance: 80,
      confidence: 1, status: 'confirmed' as const, evidence: { sourceType: 'artifact' as const, sourceId: 'test-source', confidence: 1 } }
    const original = await saveStoryMemory(input)
    const proposal = await saveStoryMemory({ ...input, content: '新候选设定', memoryId: original.id, overwrite: true, agentGenerated: true })
    expect(proposal.id).not.toBe(original.id)
    expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ content: '旧设定' })
    expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({ status: 'inferred', reviewStatus: 'pending' })
    expect((await searchStoryMemory({ userId, novelId, query: '新候选设定', limit: 50 })).some(item => item.id === proposal.id)).toBe(false)
    const repeat = await saveStoryMemory({ ...input, content: '新候选设定', memoryId: original.id, agentGenerated: true })
    expect(repeat.id).toBe(proposal.id)
    await resolveMemoryReview(userId, proposal.id, true)
    expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ status: 'superseded' })
    expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({ status: 'confirmed', reviewStatus: 'accepted' })
    await expect(resolveMemoryReview(userId, proposal.id, true)).rejects.toMatchObject({ code: 'MEMORY_REVIEW_STALE' })
  })

  it('author edit/delete uses optimistic versions, preserves audit, scopes owners and blocks resurrection', async () => {
    const input = { userId, novelId, memoryType: 'worldbuilding' as const, layer: 'L1' as const, title: '删除保护样例', content: '旧内容', importance: 70,
      confidence: 1, status: 'confirmed' as const, evidence: { sourceType: 'artifact' as const, sourceId: 'delete-source', confidence: 1 } }
    const saved = await saveStoryMemory(input)
    const updated = await updateStoryMemoryEntry(userId, saved.id, { content: '作者修订', expectedVersion: 1 })
    expect(updated.version).toBe(2)
    await expect(updateStoryMemoryEntry(userId, saved.id, { content: '旧窗口覆盖', expectedVersion: 1 })).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' })
    await expect(deleteStoryMemoryEntry('another-user', saved.id, 2)).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' })
    await expect(deleteStoryMemoryEntry(userId, saved.id, 1)).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' })
    const concurrent = await Promise.allSettled([
      updateStoryMemoryEntry(userId, saved.id, { content: '并发修订', expectedVersion: 2 }),
      deleteStoryMemoryEntry(userId, saved.id, 2),
    ])
    expect(concurrent.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    const current = await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: saved.id } })
    await deleteStoryMemoryEntry(userId, saved.id, current.version)
    expect(await deleteStoryMemoryEntry(userId, saved.id, 1)).toMatchObject({ deleted: true })
    expect((await listStoryMemories(userId, novelId, { page: 1, pageSize: 1000 })).items.some(item => item.id === saved.id)).toBe(false)
    await expect(saveStoryMemory({ ...input, agentGenerated: true })).rejects.toMatchObject({ code: 'MEMORY_DELETED' })
    await expect(saveStoryMemory({ ...input, title: '改名绕过', memoryId: saved.id, agentGenerated: true })).rejects.toMatchObject({ code: 'MEMORY_TARGET_MISSING' })
    await expect(saveStoryMemory({ ...input, title: '新名', memoryId: 'absent-id', agentGenerated: true })).rejects.toMatchObject({ code: 'MEMORY_TARGET_MISSING' })
    await expect(updateStoryMemoryEntry(userId, saved.id, { content: '复活', expectedVersion: current.version })).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' })
    expect(await prisma.memoryRevision.count({ where: { memoryId: saved.id, reason: 'author_delete' } })).toBe(1)
  })

  it('same source identifier is not overwrite authority; source projections never overwrite an author edit', async () => {
    const input = { userId, novelId, memoryType: 'chapterSummary' as const, layer: 'L2' as const, title: '来源保护样例', content: '原始摘录', importance: 60,
      confidence: 0.8, status: 'inferred' as const, evidence: { sourceType: 'chapter' as const, sourceId: chapterIds[5], revision: 1, confidence: 0.8 } }
    const original = await saveStoryMemory(input)
    const sameRevision = await saveStoryMemory({ ...input, content: '同版冲突' })
    expect(sameRevision.action).toBe('conflict')
    await updateStoryMemoryEntry(userId, original.id, { content: '作者权威修订', expectedVersion: 1 })
    // A projection cannot merely claim r2: first commit the actual source r2.
    await expect(saveStoryMemory({ ...input, content: '伪造新版投影', systemDerived: true, evidence: { ...input.evidence, revision: 2 } }))
      .rejects.toMatchObject({ code: 'MEMORY_SOURCE_REQUIRED' })
    await prisma.chapter.update({ where: { id: chapterIds[5] }, data: { revision: { increment: 1 } } })
    await saveStoryMemory({ ...input, content: '新投影', systemDerived: true, evidence: { ...input.evidence, revision: 2 } })
    expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ content: '作者权威修订' })
  })

  it('late proposals cannot replace a newer author edit or a changed chapter source', async () => {
    const input = { userId, novelId, memoryType: 'worldbuilding' as const, layer: 'L1' as const, title: '过期候选样例', content: '原设定', importance: 70,
      confidence: 1, status: 'confirmed' as const, evidence: { sourceType: 'artifact' as const, sourceId: 'late-source', confidence: 1 } }
    const original = await saveStoryMemory(input)
    const proposal = await saveStoryMemory({ ...input, content: '旧候选', memoryId: original.id, agentGenerated: true })
    await updateStoryMemoryEntry(userId, original.id, { content: '后来确认的新版', expectedVersion: 1 })
    await expect(resolveMemoryReview(userId, proposal.id, true)).rejects.toMatchObject({ code: 'MEMORY_PROPOSAL_STALE' })
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterIds[9] } })
    const sourced = await saveStoryMemory({ ...input, title: '过期来源样例', agentGenerated: true,
      evidence: { sourceType: 'chapter', sourceId: chapter.id, confidence: 0.8, revision: chapter.revision } })
    await prisma.chapter.update({ where: { id: chapter.id }, data: { revision: { increment: 1 } } })
    await expect(resolveMemoryReview(userId, sourced.id, true)).rejects.toMatchObject({ code: 'MEMORY_SOURCE_REQUIRED' })
  })

  it('title lookup searches the full owned set and deleting source cards invalidates system aggregates', async () => {
    const input = { userId, novelId, memoryType: 'worldbuilding' as const, layer: 'L1' as const, title: '聚合源样例', content: '即将删除的事实', importance: 70,
      confidence: 1, status: 'confirmed' as const, evidence: { sourceType: 'artifact' as const, sourceId: 'aggregate-source', confidence: 1 } }
    const original = await saveStoryMemory(input)
    const derived = await saveStoryMemory({ ...input, memoryType: 'storyBible', title: '故事圣经（系统增量）', systemDerived: true })
    expect((await listStoryMemories(userId, novelId, { title: input.title, page: 1, pageSize: 2 })).items.map(item => item.id)).toEqual([original.id])
    await deleteStoryMemoryEntry(userId, original.id, 1)
    expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: derived.id } })).toMatchObject({ status: 'superseded' })
    expect((await searchStoryMemory({ userId, novelId, query: '即将删除的事实', limit: 50 })).some(item => item.id === derived.id)).toBe(false)
  })
})
