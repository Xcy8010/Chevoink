import { integrationSmsRegistration } from '../support/sms-registration.js'
import { randomInt, randomUUID } from 'node:crypto'

import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import { deleteAgentSessionData } from '../../api/lib/agent/run-service.js'
import {
  enqueueChapterMemoryExtraction,
  getMemoryGraph,
  projectStoryMemoryAt,
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
  let cookie = ''
  let novelId = ''
  let volumeId = ''
  const chapterIds: string[] = []

  beforeAll(async () => {
    const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
    const phone = `+861392${unique}`
    const register = await request(app).post('/api/auth/register')
      .send({ ...await integrationSmsRegistration(phone), phone, nickname: `记忆评测${unique}`, password: 'Memory-Test-123!' })
    const cookies = Array.isArray(register.headers['set-cookie']) ? register.headers['set-cookie'] : [register.headers['set-cookie']]
    cookie = cookies.find((item: string) => item?.startsWith('chevoink_session=')) as string
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

  it('同类型同标题原位更新，人物图谱和召回立即使用新版', async () => {
    const original = await saveStoryMemory({
      userId, novelId, memoryType: 'characterCard', layer: 'L1', title: '林舟',
      content: '林舟的母亲在故事开始前已经去世。', importance: 90, confidence: 1, status: 'confirmed',
      evidence: { sourceType: 'author_input', sourceId: 'author-fact-1', confidence: 1 },
    })
    const updated = await saveStoryMemory({
      userId, novelId, memoryType: 'characterCard', layer: 'L1', title: '林舟',
      content: '林舟的母亲在第八十章来到钟楼探望他。', importance: 90, confidence: 1, status: 'confirmed',
      evidence: { sourceType: 'chapter', sourceId: chapterIds[79], revision: 1, confidence: 1 },
    })
    expect(updated).toMatchObject({ action: 'updated', id: original.id })
    const inbox = await listMemoryReviewInbox(userId, novelId)
    expect(inbox).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: updated.id })]))
    const recalled = await searchStoryMemory({ userId, novelId, query: '林舟', memoryType: 'characterCard' })
    expect(recalled).toEqual([expect.objectContaining({ id: original.id, content: expect.stringContaining('来到钟楼探望') })])
    const graph = await getMemoryGraph(userId, novelId)
    expect(graph.nodes).toContainEqual(expect.objectContaining({ label: '林舟', description: recalled[0].content }))
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

  it('same-name profiles keep separate identities, aliases and deletion boundaries', async () => {
    const input = { userId, novelId, memoryType: 'characterCard' as const, layer: 'L1' as const, title: '砚师',
      importance: 80, status: 'confirmed' as const, confidence: 1, evidence: { sourceType: 'author_input' as const, sourceId: 'author-character', confidence: 1 } }
    const north = await saveStoryMemory({ ...input, identityKey: '北岸砚师', content: '北岸的师傅。' })
    const south = await saveStoryMemory({ ...input, identityKey: '南岸砚师', content: '南岸的师傅。' })
    const list = async (title: string) => (await listStoryMemories(userId, novelId, { title, page: 1, pageSize: 10 })).items
    expect((await list(input.title)).map(card => card.id).sort()).toEqual([north.id, south.id].sort())
    const northHits = await searchStoryMemory({ userId, novelId, memoryType: 'characterCard', query: '北岸砚师', publicOnly: true })
    expect(northHits[0]).toMatchObject({ id: north.id, identityKey: '北岸砚师' })
    expect(northHits.find(card => card.id === south.id)?.identityKey).toBe('南岸砚师')
    await expect(saveStoryMemory({ ...input, content: '没有区分两个砚师。' })).rejects.toMatchObject({ code: 'MEMORY_TITLE_CONFLICT' })
    const northRow = (await list(input.title)).find(card => card.id === north.id)!
    await updateStoryMemoryEntry(userId, north.id, { title: '北岸老师傅', expectedVersion: northRow.version })
    expect((await list(input.title)).map(card => card.id).sort()).toEqual([north.id, south.id].sort())
    const deleted = await deleteStoryMemoryEntry(userId, south.id, 1)
    expect(deleted.deleted).toBe(true)
    const revised = await saveStoryMemory({ ...input, content: '修好旧砚。', section: '技艺', title: '北岸老师傅' })
    expect(revised.id).toBe(north.id)
    expect((await list(input.title)).map(card => card.id)).toEqual([north.id])
    await expect(saveStoryMemory({ ...input, identityKey: '南岸砚师', content: '旧卡不能复活。' })).rejects.toMatchObject({ code: 'MEMORY_DELETED' })
    await deleteStoryMemoryEntry(userId, north.id, (await list(input.title))[0].version)
    await expect(saveStoryMemory({ ...input, title: '北岸老师傅', content: '省略区分键也不能复活。' })).rejects.toMatchObject({ code: 'MEMORY_DELETED' })
  })

  it('recalls the visible name of a disguised person without prematurely disclosing the true name, aliases or key', async () => {
    const base = { userId, novelId, memoryType: 'characterCard' as const, layer: 'L1' as const, importance: 90, status: 'confirmed' as const, confidence: 1,
      evidence: { sourceType: 'author_input' as const, sourceId: 'secret-name-fixture', confidence: 1 } }
    const keeper = await saveStoryMemory({ ...base, title: '帐房', content: '记得旧账。' })
    const guest = await saveStoryMemory({ ...base, title: '过江客', content: '一名旅人。', sourceChapterId: chapterIds[0] })
    await saveStoryMemory({ ...base, memoryId: guest.id, title: '黑塔密使', identityKey: '潜伏的门主', aliases: ['夜使'],
      section: '身份', content: '他是黑塔派来的信使。', effectiveFromChapterId: chapterIds[39], knownBy: [keeper.id] })
    const recall = async (order: number, viewpointMemoryId?: string) => (await searchStoryMemory({
      userId, novelId, memoryType: 'characterCard', query: '过江客', limit: 20, atChapterOrder: order, publicOnly: true, viewpointMemoryId,
    })).find(hit => hit.id === guest.id)
    expect(await recall(1, keeper.id)).toMatchObject({ title: '过江客', content: '一名旅人。' })
    expect(await recall(1, keeper.id)).not.toHaveProperty('identityKey')
    expect(await recall(40)).toMatchObject({ title: '过江客', content: '一名旅人。' })
    expect(await recall(40)).not.toHaveProperty('identityKey')
    expect(await recall(40, keeper.id)).toMatchObject({ title: '黑塔密使', identityKey: '潜伏的门主', content: expect.stringContaining('黑塔') })
    const latest = await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: guest.id } })
    await updateStoryMemoryEntry(userId, guest.id, { title: '后来改用的密名', expectedVersion: latest.version })
    const saved = await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: guest.id } })
    const early = await projectStoryMemoryAt(prisma, novelId, [saved], { atChapterOrder: 1, publicOnly: true })
    expect(early[0]).toMatchObject({ title: '过江客' })
    expect(early[0].aliases).not.toContain('黑塔密使')
  })

  it('preserves possession, source and character knowledge across distant chapters and edits', async () => {
    const base = { userId, novelId, layer: 'L1' as const, importance: 90, status: 'confirmed' as const, confidence: 1,
      evidence: { sourceType: 'author_input' as const, sourceId: 'author-key', confidence: 1 } }
    const viewer = await saveStoryMemory({ ...base, memoryType: 'characterCard', title: '午桥', content: '南渡口掌柜。' })
    const item = { ...base, memoryType: 'itemCard' as const, title: '铜鱼符' }
    const earlyEvidence = { sourceType: 'chapter' as const, sourceId: chapterIds[1], revision: 1, confidence: 1 }
    const first = await saveStoryMemory({ ...item, sourceChapterId: chapterIds[1], section: '持有人', content: '巡河人。', evidence: earlyEvidence })
    const later = await saveStoryMemory({ ...item, memoryId: first.id, sourceChapterId: chapterIds[44], section: '持有人', content: '渡口掌柜。', evidence: { ...earlyEvidence, sourceId: chapterIds[44] } })
    const earlyHits = await searchStoryMemory({ userId, novelId, query: item.title, atChapterId: chapterIds[32], memoryType: 'itemCard' })
    expect(earlyHits[0].evidence.map(e => e.sourceId)).toEqual([chapterIds[1]])
    await saveStoryMemory({ ...item, memoryId: first.id, effectiveFromChapterId: chapterIds[44], section: '秘密', content: '这是缺失的信印。', knownBy: [viewer.id] })
    expect(later.id).toBe(first.id)
    const recall = async (atChapterId: string, viewpointMemoryId?: string) => (await searchStoryMemory({
      userId, novelId, query: item.title, memoryType: item.memoryType, atChapterId, viewpointMemoryId, publicOnly: true,
    }))[0]?.content
    expect(await recall(chapterIds[0])).toBeUndefined()
    expect(await recall(chapterIds[32])).toContain('巡河人')
    expect(await recall(chapterIds[60])).toContain('渡口掌柜')
    expect(await recall(chapterIds[60])).not.toContain('信印')
    expect(await recall(chapterIds[60], viewer.id)).toContain('信印')
    const mixed = await searchStoryMemory({ userId, novelId, query: item.title, memoryType: 'itemCard', viewpointMemoryId: viewer.id, atChapterId: chapterIds[60] })
    expect(mixed[0].evidence).toEqual([])
    await saveStoryMemory({ ...item, memoryId: first.id, effectiveFromChapterId: chapterIds[1], section: '持有人', content: '北岸巡河人。' })
    expect(await recall(chapterIds[32])).toContain('北岸巡河人')
    expect(await recall(chapterIds[60])).toContain('渡口掌柜')
    await expect(saveStoryMemory({ ...item, section: '秘密', content: '线索', knownBy: ['some-other-novel'] })).rejects.toMatchObject({ code: 'MEMORY_TARGET_MISSING' })
  })

  it('links appearances only to chapters containing the profile or its verified source span', async () => {
    const read = () => listStoryMemories(userId, novelId, { title: '湾桥亭', page: 1, pageSize: 10 })
    const c = await prisma.chapter.update({ where: { id: chapterIds[24] }, data: { content: '他们经过湾桥亭。', revision: { increment: 1 } } })
    await saveStoryMemory({ userId, novelId, sourceChapterId: c.id, memoryType: 'locationCard', layer: 'L1', title: '湾桥亭',
      content: '临河的石亭。', importance: 60, confidence: 1, status: 'confirmed', evidence: { sourceType: 'chapter', sourceId: c.id, revision: c.revision, confidence: 1 } })
    expect((await read()).items[0]).toMatchObject({ appearances: [{ id: c.id, title: c.title }], sourceChapter: { id: c.id, title: c.title } })
    await prisma.chapter.update({ where: { id: c.id }, data: { content: '他们直接回家。', revision: { increment: 1 } } })
    const card = (await read()).items[0]
    expect(card?.appearances ?? []).toEqual([])
    expect(card?.sourceChapter).toBeUndefined()
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

  it('links chapter mentions to the existing biography and creates distinct cards for named subjects', async () => {
    const biography = '岑野是渡船修理工。\n\n## 人物设定\n\n遇到争执，他先把扳手放下。'
    const person = await saveStoryMemory({ userId, novelId, memoryType: 'characterCard', layer: 'L1', title: '岑野', aliases: ['岑师傅'],
      content: biography, importance: 75, status: 'confirmed', confidence: 1, evidence: { sourceType: 'author_input', sourceId: 'biography', confidence: 1 } })
    const names = [['item', '引潮铃'], ['location', '芦汀坞'], ['scene', '落闸夜谈']]
    await prisma.storyEntity.createMany({ data: names.map(([entityType, canonicalName]) => ({ novelId, entityType, canonicalName, status: 'confirmed',
      description: entityType === 'item' ? '引潮铃的最后一响能改变潮位。' : '' })) })
    const chapter = await prisma.chapter.update({ where: { id: chapterIds[82] }, data: {
      content: '落闸夜谈从岑师傅在芦汀坞敲响引潮铃开始。', revision: { increment: 1 },
    } })
    const extraction = { novelId, chapterId: chapter.id, chapterRevision: chapter.revision, before: '', after: chapter.content }
    const job = await enqueueChapterMemoryExtraction(extraction)
    expect((await waitForMemoryExtractionJob(job)).status).toBe('completed')
    expect(await enqueueChapterMemoryExtraction(extraction)).toBe(job)
    const list = async (title: string) => (await listStoryMemories(userId, novelId, { title, page: 1, pageSize: 10 })).items
    expect(await list('岑野')).toMatchObject([{ id: person.id, content: biography, appearances: [{ id: chapter.id }] }])
    for (const [type, name] of names) expect(await list(name)).toMatchObject([{ title: name, memoryType: type + 'Card', appearances: [{ id: chapter.id }] }])
    expect((await list('引潮铃'))[0].content).toContain('## 物品设定\n\n引潮铃的最后一响能改变潮位。')
    const visible = await searchStoryMemory({ userId, novelId, memoryType: 'itemCard', query: '引潮铃', atChapterId: chapter.id, publicOnly: true })
    expect(visible[0]).toMatchObject({ title: '引潮铃', content: expect.stringContaining('出场') })
    expect(visible[0].content).not.toContain('潮位')
  })

  it('materializes recognized subjects on graph reuse without exposing undated descriptions in earlier chapter context', async () => {
    const objects = [['character', '杜行舟'], ['item', '白玉算盘'], ['location', '潜龙涧'], ['scene', '亭下别离']]
    await prisma.storyEntity.createMany({ data: objects.map(([entityType, canonicalName]) => ({ novelId, entityType, canonicalName,
      description: '[AI关系网] 全书结局才披露的来历。', status: 'inferred' })) })
    await prisma.chapter.update({ where: { id: chapterIds[56] }, data: {
      content: '亭下别离时，杜行舟拿着白玉算盘走出潜龙涧。', revision: { increment: 1 },
    } })
    const list = () => prisma.projectMemoryEntry.findMany({ where: { novelId, title: { in: objects.map(([, name]) => name) } }, orderBy: { id: 'asc' } })
    const path = `/api/agent/novels/${novelId}/memory-sets`
    await request(app).get(path).set('Cookie', cookie).expect(200)
    await request(app).post(path).expect(401)
    expect(await list()).toEqual([])
    const catalog = await request(app).post(path).set('Cookie', cookie).expect(200)
    expect(catalog.body.data.sets.map((set: { memoryType: string }) => set.memoryType)).toEqual(expect.arrayContaining(['itemCard', 'locationCard', 'sceneCard', 'characterCard']))
    const created = await list()
    expect(created.map(c => c.memoryType).sort()).toEqual(['characterCard', 'itemCard', 'locationCard', 'sceneCard'])
    expect(created.every(c => c.content.includes('全书结局才披露的来历') && !c.content.includes('[AI关系网]'))).toBe(true)
    expect(await projectStoryMemoryAt(prisma, novelId, created, { atChapterOrder: 1, publicOnly: true })).toEqual([])
    const present = await projectStoryMemoryAt(prisma, novelId, created, { atChapterOrder: 57, publicOnly: true })
    expect(present).toHaveLength(4)
    expect(present.every(c => c.content.includes('出场') && !c.content.includes('全书结局'))).toBe(true)
    expect(await syncNovelMemoryProjection(userId, novelId)).toMatchObject({ reused: true })
    await request(app).post(path).set('Cookie', cookie).expect(200)
    expect(await list()).toEqual(created)
    const item = created.find(c => c.memoryType === 'itemCard')!
    await deleteStoryMemoryEntry(userId, item.id, item.version)
    await syncNovelMemoryProjection(userId, novelId)
    expect((await list()).filter(c => c.title === '白玉算盘')).toMatchObject([{ id: item.id, status: 'invalid' }])
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

  it('legacy pending cards appear in the catalog and recall, with only the latest version of a setting', async () => {
    const input = { userId, novelId, memoryType: 'worldbuilding' as const, layer: 'L1' as const, title: '月相制度', content: '旧设定', importance: 80,
      confidence: 1, status: 'confirmed' as const, evidence: { sourceType: 'artifact' as const, sourceId: 'test-source', confidence: 1 } }
    const original = await saveStoryMemory(input)
    const oldRollup = await prisma.projectMemoryEntry.create({ data: { novelId, memoryType: 'storyBible',
      title: '故事圣经（系统增量）', content: '月相制度：旧设定', status: 'inferred' } })
    const legacy = await prisma.projectMemoryEntry.create({ data: { novelId, memoryType: input.memoryType, title: input.title,
      content: '满月前三日封港', status: 'conflicted', reviewStatus: 'pending', updatedAt: new Date(Date.now() + 1000) } })
    expect((await listStoryMemories(userId, novelId, { query: '满月前三日', page: 1, pageSize: 2 })).items.map(item => item.id)).toEqual([legacy.id])
    expect((await searchStoryMemory({ userId, novelId, query: input.title, memoryType: input.memoryType })).map(item => item.id)).toContain(legacy.id)
    expect((await searchStoryMemory({ userId, novelId, query: input.title })).map(item => item.id)).not.toContain(oldRollup.id)
    expect((await listStoryMemories(userId, novelId, { title: input.title, page: 1, pageSize: 2 })).items.map(item => item.id)).toEqual([legacy.id])
    const edited = await updateStoryMemoryEntry(userId, legacy.id, { content: '满月前两日封港', expectedVersion: legacy.version })
    expect(edited).toMatchObject({ id: legacy.id, content: '满月前两日封港', version: legacy.version + 1 })
    expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ status: 'superseded' })
    await expect(resolveMemoryReview(userId, legacy.id, true)).rejects.toMatchObject({ code: 'MEMORY_REVIEW_STALE' })
  })

  it('identifies chapter summaries by source and keeps explicit changes through automatic projections', async () => {
    const first = chapterIds[33]
    const second = chapterIds[34]
    const chapterMemory = { userId, novelId, memoryType: 'chapterSummary' as const, layer: 'L2' as const, importance: 70,
      confidence: 0.9, status: 'inferred' as const, title: '同名章节', content: '第一个章节的摘要',
      sourceChapterId: first, evidence: { sourceType: 'chapter' as const, sourceId: first, revision: 1, confidence: 1 } }
    const old = await readChapterSummaryId(first)
    const revised = await saveStoryMemory({ ...chapterMemory, explicitSave: true })
    expect(revised.id).toBe(old)
    const distinct = await saveStoryMemory({ ...chapterMemory, sourceChapterId: second, evidence: { ...chapterMemory.evidence, sourceId: second }, content: '第二个章节的摘要' })
    expect(distinct.id).not.toBe(revised.id)
    await expect(saveStoryMemory({ ...chapterMemory, memoryId: revised.id, sourceChapterId: second,
      evidence: { ...chapterMemory.evidence, sourceId: second } })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_REQUIRED' })
    await expect(saveStoryMemory({ ...chapterMemory, sourceChapterId: undefined,
      evidence: { sourceType: 'artifact', sourceId: 'ambiguous-summary', confidence: 0.5 } })).rejects.toMatchObject({ code: 'MEMORY_TITLE_CONFLICT' })
    await saveStoryMemory({ ...chapterMemory, title: `章节:${first}`, content: '自动摘录', systemDerived: true })
    const cards = await listStoryMemories(userId, novelId, { title: chapterMemory.title, memoryType: 'chapterSummary', page: 1, pageSize: 10 })
    expect(cards.items).toHaveLength(2)
    expect(cards.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: revised.id, content: '第一个章节的摘要' }),
      expect.objectContaining({ id: distinct.id, content: '第二个章节的摘要' }),
    ]))
    const linked = await listStoryMemories(userId, novelId, { title: `章节:${first}`, memoryType: 'chapterSummary', page: 1, pageSize: 2 })
    expect(linked.items.map(item => item.id)).toEqual([revised.id])

    async function readChapterSummaryId(sourceChapterId: string) {
      return (await prisma.projectMemoryEntry.findFirstOrThrow({ where: { novelId, sourceChapterId, memoryType: 'chapterSummary' } })).id
    }
  })

  it('keeps separate cards on rename collisions and preserves shared revisions after deleting an earlier conversation', async () => {
    const older = await prisma.agentSession.create({ data: { userId, novelId, title: '旧对话' } })
    const newer = await prisma.agentSession.create({ data: { userId, novelId, title: '新对话' } })
    const novel = await prisma.novel.findUniqueOrThrow({ where: { id: novelId }, select: { manuscriptRevision: true } })
    const runData = { userId, novelId, ...novel, mode: 'act' as const, action: 'workspaceAgent' as const,
      agentType: 'writingOrchestrator' as const, status: 'completed' as const, engine: 'loop' }
    const oldRun = await prisma.agentRun.create({ data: { ...runData, sessionId: older.id } })
    const newRun = await prisma.agentRun.create({ data: { ...runData, sessionId: newer.id } })
    const input = { userId, novelId, memoryType: 'worldbuilding' as const, layer: 'L1' as const, title: '灯塔位置', content: '灯塔在南岸',
      importance: 70, confidence: 1, status: 'inferred' as const, explicitSave: true,
      evidence: { sourceType: 'artifact' as const, sourceId: oldRun.id, confidence: 0.5 } }
    const original = await saveStoryMemory({ ...input, runId: oldRun.id })
    const other = await saveStoryMemory({ ...input, title: '码头位置', content: '码头在西岸' })
    const updated = await saveStoryMemory({ ...input, runId: newRun.id, content: '灯塔迁到北岸', evidence: { ...input.evidence, sourceId: newRun.id } })
    expect(updated.id).toBe(original.id)
    await expect(updateStoryMemoryEntry(userId, updated.id, { title: '码头位置', expectedVersion: 2 })).rejects.toMatchObject({ code: 'MEMORY_TITLE_CONFLICT' })
    await deleteAgentSessionData(userId, older.id)
    expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ content: '灯塔迁到北岸', version: 2 })
    expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ content: '码头在西岸', version: 1 })
  })

  it('replaying identical structured memory leaves the card and graph edge version stable', async () => {
    const input = { userId, novelId, memoryType: 'relationshipState' as const, layer: 'L2' as const, title: '槐→桥:伙伴',
      content: '槐与桥在雨季结为伙伴。', importance: 75, confidence: 0.8, status: 'inferred' as const,
      evidence: { sourceType: 'artifact' as const, sourceId: 'relation-fixture', confidence: 0.5 },
      graphProposal: { kind: 'relation' as const, fromName: '槐', toName: '桥', relationType: '伙伴', state: '雨季结盟' } }
    const saved = await saveStoryMemory(input)
    const originalGraph = await getMemoryGraph(userId, novelId)
    const originalEdge = originalGraph.edges.find(edge => edge.sourceId === saved.id)
    expect(originalEdge).toBeDefined()
    expect(await saveStoryMemory(input)).toMatchObject({ id: saved.id, action: 'updated' })
    expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: saved.id } })).toMatchObject({ version: 1 })
    expect((await getMemoryGraph(userId, novelId)).edges.find(edge => edge.sourceId === saved.id)).toEqual(originalEdge)
  })

  it('a legacy sibling cannot resurrect a memory removed by its author', async () => {
    const title = '曾用年号'
    await prisma.projectMemoryEntry.create({ data: { novelId, memoryType: 'worldbuilding', title, content: '旧版待审', status: 'inferred', reviewStatus: 'pending' } })
    await prisma.projectMemoryEntry.create({ data: { novelId, memoryType: 'worldbuilding', title, content: '已删除内容', status: 'invalid',
      reviewStatus: 'rejected', revisions: { create: { before: '已删除内容', after: '', reason: 'author_delete' } } } })
    expect((await listStoryMemories(userId, novelId, { title, page: 1, pageSize: 5 })).items).toEqual([])
    expect((await searchStoryMemory({ userId, novelId, query: title })).some(item => item.title === title)).toBe(false)
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
    await expect(saveStoryMemory(input)).rejects.toMatchObject({ code: 'MEMORY_DELETED' })
    await expect(saveStoryMemory({ ...input, title: '改名绕过', memoryId: saved.id })).rejects.toMatchObject({ code: 'MEMORY_TARGET_MISSING' })
    await expect(saveStoryMemory({ ...input, title: '新名', memoryId: 'absent-id' })).rejects.toMatchObject({ code: 'MEMORY_TARGET_MISSING' })
    await expect(updateStoryMemoryEntry(userId, saved.id, { content: '复活', expectedVersion: current.version })).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' })
    expect(await prisma.memoryRevision.count({ where: { memoryId: saved.id, reason: 'author_delete' } })).toBe(1)
  })

  it('author changes take effect while automatic projections preserve manual edits and source version fences', async () => {
    const input = { userId, novelId, memoryType: 'chapterSummary' as const, layer: 'L2' as const, title: '来源保护样例', content: '原始摘录', importance: 60,
      confidence: 0.8, status: 'inferred' as const, evidence: { sourceType: 'chapter' as const, sourceId: chapterIds[5], revision: 1, confidence: 0.8 } }
    const original = await saveStoryMemory(input)
    const sameRevision = await saveStoryMemory({ ...input, content: '同版更新' })
    expect(sameRevision).toMatchObject({ id: original.id, action: 'updated' })
    await updateStoryMemoryEntry(userId, original.id, { content: '作者权威修订', expectedVersion: 2 })
    // A projection cannot merely claim r2: first commit the actual source r2.
    await expect(saveStoryMemory({ ...input, content: '伪造新版投影', systemDerived: true, evidence: { ...input.evidence, revision: 2 } }))
      .rejects.toMatchObject({ code: 'MEMORY_SOURCE_REQUIRED' })
    await prisma.chapter.update({ where: { id: chapterIds[5] }, data: { revision: { increment: 1 } } })
    await saveStoryMemory({ ...input, content: '新投影', systemDerived: true, evidence: { ...input.evidence, revision: 2 } })
    expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ content: '作者权威修订' })
  })

  it('legacy review requests cannot promote an already replaced card or a changed chapter source', async () => {
    const input = { userId, novelId, memoryType: 'worldbuilding' as const, layer: 'L1' as const, title: '过期候选样例', content: '原设定', importance: 70,
      confidence: 1, status: 'confirmed' as const, evidence: { sourceType: 'artifact' as const, sourceId: 'late-source', confidence: 1 } }
    const original = await saveStoryMemory(input)
    const proposal = await prisma.projectMemoryEntry.create({ data: { novelId, memoryType: input.memoryType, title: input.title, content: '旧候选', status: 'inferred', reviewStatus: 'pending' } })
    await expect(saveStoryMemory({ ...input, memoryId: original.id, content: '旧卡失效' })).rejects.toMatchObject({ code: 'MEMORY_TARGET_MISSING' })
    await saveStoryMemory({ ...input, memoryId: proposal.id, content: '后来确认的新版' })
    await expect(resolveMemoryReview(userId, proposal.id, true)).rejects.toMatchObject({ code: 'MEMORY_REVIEW_STALE' })
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterIds[9] } })
    const sourced = await prisma.projectMemoryEntry.create({ data: { novelId, memoryType: input.memoryType, title: '过期来源样例', content: '章节旧摘要',
      status: 'inferred', reviewStatus: 'pending', evidence: { create: { sourceType: 'chapter', sourceId: chapter.id, confidence: 0.8, revision: chapter.revision } } } })
    await prisma.chapter.update({ where: { id: chapter.id }, data: { revision: { increment: 1 } } })
    await expect(resolveMemoryReview(userId, sourced.id, true)).rejects.toMatchObject({ code: 'MEMORY_SOURCE_REQUIRED' })
  })

  it('does not reintroduce a superseded name from a linked legacy proposal', async () => {
    const original = await prisma.projectMemoryEntry.create({ data: { novelId, memoryType: 'worldbuilding', title: '前宫名', content: '最早的宫名', status: 'confirmed' } })
    const proposal = await prisma.projectMemoryEntry.create({ data: { novelId, memoryType: 'worldbuilding', title: original.title,
      content: '废弃的宫名想法', status: 'inferred', reviewStatus: 'pending',
      revisions: { create: { before: original.content, after: '废弃的宫名想法', reason: 'agent_proposal@1', supersededBy: original.id } } } })
    await prisma.projectMemoryEntry.update({ where: { id: original.id }, data: { title: '新宫名', content: '已更名为新宫名', version: 2 } })
    expect((await listStoryMemories(userId, novelId, { title: proposal.title, page: 1, pageSize: 2 })).items).toEqual([])
    expect((await listStoryMemories(userId, novelId, { title: '新宫名', page: 1, pageSize: 2 })).items.map(item => item.id)).toEqual([original.id])
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
