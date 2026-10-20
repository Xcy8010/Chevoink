import { describe, expect, it } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

describe.runIf(available)('real compiler reference range selection', () => {
  it('reselects the nearest three and invalidates changed, inserted, reordered or archived sources', () => fixture(async f => {
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 10, orderInVolume: 10 } })
    const earlier = await Promise.all([1, 3, 5, 7].map(orderIndex => prisma.chapter.create({ data: {
      authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId, orderIndex, orderInVolume: orderIndex,
      title: `合成前文${orderIndex}`, content: `约束${orderIndex}：只有完成补给才能恢复储量。`, revision: 1,
    } })))
    const read = () => readCompilerContinuitySource(prisma, f, chapter, earlier[3].id)
    const first = await read()
    expect(first && 'preceding' in first ? first.preceding.map(row => row.id) : []).toEqual(earlier.slice(1).map(row => row.id))
    await prisma.chapter.update({ where: { id: earlier[0].id }, data: { content: '范围外改动', revision: { increment: 1 } } })
    expect(await read()).toEqual(first)
    await prisma.chapter.update({ where: { id: earlier[1].id }, data: { content: '范围内条件变更', revision: { increment: 1 } } })
    const changed = await read()
    expect(runtimeJson(changed).hash).not.toBe(runtimeJson(first).hash)
    const inserted = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId,
      orderIndex: 8, orderInVolume: 8, title: '插入前文', content: '新条件', revision: 1 } })
    const afterInsert = await read()
    expect(runtimeJson(afterInsert).hash).not.toBe(runtimeJson(changed).hash)
    expect(afterInsert && 'preceding' in afterInsert ? afterInsert.preceding.map(row => row.id) : []).toEqual([earlier[2].id, earlier[3].id, inserted.id])
    await prisma.chapter.update({ where: { id: inserted.id }, data: { orderIndex: 2, orderInVolume: 2 } })
    expect(runtimeJson(await read()).hash).not.toBe(runtimeJson(afterInsert).hash)
    await prisma.chapter.update({ where: { id: earlier[1].id }, data: { archivedAt: new Date() } })
    const removed = await read()
    expect(removed && 'preceding' in removed ? removed.preceding.map(row => row.id) : []).toEqual([inserted.id, earlier[2].id, earlier[3].id])
    expect(removed?.content).toContain('新条件')
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(chapter.content)
  }))
})
