import { describe, expect, it } from 'vitest'
import { buildNovelImportPlacement } from '../../api/lib/novel-import/placement.js'

const volume = (id: string, title: string, orderIndex: number) => ({ id, title, orderIndex })
const chapter = (id: string, volumeId: string, title: string, orderIndex: number, orderInVolume = 1) => ({ id, volumeId, title, orderIndex, orderInVolume })
const source = (title: string, ...titles: string[]) => ({ title, chapters: titles.map(title => ({ title, content: `原文${title}` })) })
const plan = (volumes: ReturnType<typeof volume>[], chapters: ReturnType<typeof chapter>[], input: ReturnType<typeof source>[]) => {
  let id = 0
  return buildNovelImportPlacement(volumes, chapters, input, () => `new-${++id}`)
}

describe('import volume placement', () => {
  it.each(['第一卷', '第1卷', '第0001卷·启程', '正文卷'])('reuses default first volume for %s and preserves source order', title => {
    const result = plan([volume('v1', '第一卷', 1)], [], [source(title, '第一章', '第二章', '第三章', '第四章')])
    expect(result.newVolumes).toEqual([])
    expect(result.chapters.map(c => [c.volumeId, c.orderIndex, c.orderInVolume])).toEqual([[ 'v1', 1, 1 ], [ 'v1', 2, 2 ], [ 'v1', 3, 3 ], [ 'v1', 4, 4 ]])
  })
  it('matches an exported ordinal plus title without matching a different named volume', () => {
    const existing = [volume('v1', '启程', 1)]
    expect(plan(existing, [], [source('第1卷·启程', '甲')]).newVolumes).toEqual([])
    expect(plan(existing, [], [source('第1卷·归来', '甲')]).newVolumes).toHaveLength(1)
  })
  it('matches chapters only inside the destination and backs up shifted retained positions', () => {
    const result = plan([volume('v1', '第一卷', 1), volume('v2', '第二卷', 2)], [chapter('c1', 'v1', '同名', 1), chapter('c2', 'v2', '同名', 2)], [source('第一卷', '同名', '新增')])
    expect(result.archivedChapterIds).toEqual(['c1'])
    expect(result.chapters.map(c => [c.volumeId, c.orderIndex])).toEqual([['v1', 1], ['v1', 2]])
    expect(result.reorderedBefore).toEqual([{ id: 'c2', volumeId: 'v2', orderIndex: 2, orderInVolume: 1 }])
    expect(result.reorderedAfter).toEqual([{ id: 'c2', volumeId: 'v2', orderIndex: 3, orderInVolume: 1 }])
    expect(result.lastChapterTitle).toBe('同名')
  })
  it('preserves unmatched chapter slots and appends additions within their volume', () => {
    const result = plan([volume('v1', '第一卷', 1)], [chapter('a', 'v1', '甲', 1), chapter('b', 'v1', '保留', 2, 2)], [source('第一卷', '甲', '新章')])
    expect(result.chapters.map(c => [c.title, c.orderIndex, c.orderInVolume])).toEqual([['甲', 1, 1], ['新章', 3, 3]])
    expect(result.reorderedBefore).toEqual([])
  })
  it('does not overwrite a namesake in another explicitly named volume', () => {
    const result = plan([volume('v1', '第一卷', 1)], [chapter('a', 'v1', '甲', 1)], [source('番外', '甲')])
    expect(result.archivedChapterIds).toEqual([])
    expect(result.newVolumes).toHaveLength(1)
    expect(result.chapters[0]).toMatchObject({ orderIndex: 2, orderInVolume: 1 })
  })
  it('keeps new chapters before their next matching anchor and rejects reversed anchors', () => {
    const volumes = [volume('v1', '第一卷', 1)]
    const chapters = [chapter('a', 'v1', '甲', 1), chapter('b', 'v1', '乙', 2, 2)]
    const result = plan(volumes, chapters, [source('第一卷', '新前章', '甲', '新中章', '乙', '新后章')])
    expect(result.chapters.map(c => [c.title, c.orderIndex])).toEqual([['新前章', 1], ['甲', 2], ['新中章', 3], ['乙', 4], ['新后章', 5]])
    expect(() => plan(volumes, chapters, [source('第一卷', '乙', '甲')])).toThrow(expect.objectContaining({ code: 'IMPORT_PLACEMENT_AMBIGUOUS' }))
  })
  it('rejects ambiguous destination volumes, unscoped multivolume text, and duplicate target chapter names', () => {
    const reject = (fn: () => unknown) => expect(fn).toThrow(expect.objectContaining({ code: 'IMPORT_PLACEMENT_AMBIGUOUS' }))
    reject(() => plan([volume('v1', '同卷', 1), volume('v2', '同卷', 2)], [], [source('同卷', '甲')]))
    reject(() => plan([volume('v1', '第一卷', 1), volume('v2', '第二卷', 2)], [], [source('正文卷', '甲')]))
    reject(() => plan([volume('v1', '第一卷', 1)], [chapter('a', 'v1', '甲', 1), chapter('b', 'v1', '甲', 2, 2)], [source('第一卷', '甲')]))
    reject(() => plan([volume('v1', '第一卷', 1)], [chapter('a', 'v1', '甲', 1)], [source('第一卷', '甲', '甲')]))
    reject(() => plan([volume('v1', '第一卷', 1)], [], [source('第一卷', '甲'), source('第1卷', '乙')]))
  })
  it('keeps repeated source titles when there is no existing match, and leaves metadata-only imports untouched', () => {
    expect(plan([], [], [source('第一卷', '甲', '甲')]).chapters).toHaveLength(2)
    const result = plan([volume('v1', '第一卷', 1)], [chapter('a', 'v1', '甲', 9, 4)], [])
    expect(result).toMatchObject({ chapters: [], reorderedBefore: [], reorderedAfter: [], lastChapterTitle: '甲' })
  })
})
