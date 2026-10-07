import { describe, expect, it } from 'vitest'
import { chapterTitleOrdinal, plainChapterTitle } from '../../shared/structure/chapter-title.js'
import { buildChapterDraft } from '../../src/features/studio/lib/form-state.js'
import type { Chapter } from '../../shared/contracts/index.js'
import { splitText } from '../../api/lib/novel-import/parsers/text.js'

describe('plain chapter titles preserve narrative names and identity', () => {
  it.each([
    ['第45章 火墙', '火墙'], ['第46章《火墙》', '火墙'], ['第47章〈火墙〉', '火墙'],
    [' 第 四十八 章 ： 《定南》 ', '定南'], ['第４８节·〈定南〉', '定南'],
    ['《第48章《定南》》', '定南'], ['第一百二十三回 重逢', '重逢'],
    ['《读《史记》》', '读《史记》'], ['读《史记》', '读《史记》'],
    ['《史记》与《汉书》', '《史记》与《汉书》'], ['〈甲〉和〈乙〉', '〈甲〉和〈乙〉'],
    ['序章', '序章'], ['第一卷 边镇棋子', '第一卷 边镇棋子'], ['第三个人', '第三个人'],
    ['第47章', ''], ['《》', ''], ['第47章《》', ''], ['  ', ''], ['《未闭合', '《未闭合'],
  ])('%s formats without changing real inner book names', (value, expected) => {
    expect(plainChapterTitle(value)).toBe(expected)
    expect(plainChapterTitle(plainChapterTitle(value))).toBe(expected)
  })
  it('keeps source ordinals distinct even when the plain names repeat', () => {
    expect(chapterTitleOrdinal('第45章《火墙》')).toBe(45)
    expect(chapterTitleOrdinal('《第45章《火墙》》')).toBe(45)
    expect(chapterTitleOrdinal('第４６章 火墙')).toBe(46)
    expect(chapterTitleOrdinal('第一百零五章 重逢')).toBe(105)
    expect(chapterTitleOrdinal('第十万章 重逢')).toBe(100000)
    expect(chapterTitleOrdinal('第十二万三千四百五十六章 重逢')).toBe(123456)
    expect(chapterTitleOrdinal('第一万零五章 重逢')).toBe(10005)
    expect(chapterTitleOrdinal('火墙')).toBeNull()
  })
  it('recognizes touching book-name marks in imports without consuming body text', () => {
    const parsed = splitText('第45章《火墙》\n正文含《史记》。\n第46章〈火墙〉\n另一章正文。', 'book.txt')
    expect(parsed.volumes[0].chapters.map(chapter => [chapter.title, chapter.content])).toEqual([
      ['第45章《火墙》', '正文含《史记》。\n'], ['第46章〈火墙〉', '另一章正文。'],
    ])
  })
  it('shows existing malformed titles in the editor without writing revisions or body', () => {
    const chapter = { id: 'original47', title: '第47章《火墙》', revision: 6, content: '逐字原正文', orderIndex: 47, orderInVolume: 31 } as Chapter
    const draft = buildChapterDraft(chapter)
    expect(draft).toMatchObject({ title: '火墙', content: chapter.content, revision: 6 })
    expect(chapter).toMatchObject({ title: '第47章《火墙》', revision: 6, content: '逐字原正文' })
  })
})
