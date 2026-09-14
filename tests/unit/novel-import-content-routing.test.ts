import { describe, expect, it } from 'vitest'
import { normalizeImportTitle, routeImportContent } from '../../api/lib/novel-import/content-routing'
import type { NovelImportChapter, ParsedNovelImport } from '../../api/lib/novel-import/parsers/types'

const chapter = (title: string, content = '正文内容'): NovelImportChapter => ({ title, content, source: 'x.txt#char=0-4' })
const parsed = (chapters: NovelImportChapter[], volumeTitle = '卷一'): ParsedNovelImport => ({
  volumes: [{ title: volumeTitle, chapters }], metadata: {}, warnings: [], sourceChars: 8, parserVersion: 'test-1',
})

describe('normalizeImportTitle 归一化', () => {
  it('trim + 小写 + 压缩全部空白，供路由与合并共用同一口径', () => {
    expect(normalizeImportTitle('  第一章  ')).toBe('第一章')
    expect(normalizeImportTitle('Chapter One')).toBe('chapterone')
    expect(normalizeImportTitle('A B\tC\nD')).toBe('abcd')
  })
})

describe('routeImportContent 标题关键词路由', () => {
  it('计划类标题分流到 plans，不进章节桶', () => {
    for (const title of ['故事大纲', '写作计划', '剧情规划', '内容梗概', '主线梳理', 'Story Outline', 'Series Plan']) {
      const routed = routeImportContent(parsed([chapter(title)]))
      expect(routed.plans, title).toEqual([{ title, content: '正文内容' }])
      expect(routed.volumes, title).toEqual([])
    }
  })

  it('设定类标题分流到 memories 并映射记忆类型', () => {
    const character = routeImportContent(parsed([chapter('人物小传')]))
    expect(character.memories?.[0]).toMatchObject({ memoryType: 'characterCard', title: '人物小传' })
    // 同时含「角色」与「设定」时人物优先
    expect(routeImportContent(parsed([chapter('角色设定')])).memories?.[0].memoryType).toBe('characterCard')
    expect(routeImportContent(parsed([chapter('世界观')])).memories?.[0].memoryType).toBe('worldbuilding')
    expect(routeImportContent(parsed([chapter('背景资料')])).memories?.[0].memoryType).toBe('worldbuilding')
    // 「资料」命中记忆桶但不属人物/世界观，回落 storyBible
    expect(routeImportContent(parsed([chapter('资料汇编')])).memories?.[0].memoryType).toBe('storyBible')
  })

  it('计划关键词优先于记忆关键词', () => {
    const routed = routeImportContent(parsed([chapter('人物大纲')]))
    expect(routed.plans?.[0].title).toBe('人物大纲')
    expect(routed.memories).toBeUndefined()
  })

  it('普通章节标题保留在章节桶', () => {
    const routed = routeImportContent(parsed([chapter('第一章 风起')]))
    expect(routed.plans).toBeUndefined()
    expect(routed.memories).toBeUndefined()
    expect(routed.volumes[0].chapters).toHaveLength(1)
  })

  it('空正文段落不路由，原样留在章节桶交给完整性报告', () => {
    const routed = routeImportContent(parsed([chapter('故事大纲', '   ')]))
    expect(routed.plans).toBeUndefined()
    expect(routed.volumes[0].chapters).toHaveLength(1)
  })

  it('混合来源分桶后各归其位，被完全路由空的卷不再进入预览', () => {
    const routed = routeImportContent({
      volumes: [
        { title: '设定卷', chapters: [chapter('世界观')] },
        { title: '正文卷', chapters: [chapter('第一章'), chapter('故事大纲'), chapter('人物设定')] },
      ],
      metadata: {}, warnings: [], sourceChars: 20, parserVersion: 'test-1',
    })
    expect(routed.volumes).toHaveLength(1)
    expect(routed.volumes[0]).toMatchObject({ title: '正文卷' })
    expect(routed.volumes[0].chapters.map(c => c.title)).toEqual(['第一章'])
    expect(routed.plans?.map(p => p.title)).toEqual(['故事大纲'])
    expect(routed.memories?.map(m => m.title)).toEqual(['世界观', '人物设定'])
  })
})
