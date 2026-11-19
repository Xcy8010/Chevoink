import { describe, expect, it } from 'vitest'
import type { Prisma, ProjectMemoryEntry } from '@prisma/client'
import { prepareProfileUpdate, projectStoryMemoryAt, renderProfileAt, selectProfileExcerpt, splitProfileMarkdown } from '../../api/lib/agent/story-profile.js'

type Change = Parameters<typeof renderProfileAt>[0][number]
const orders = new Map([['c1', 1], ['c7', 7], ['c40', 40]])
const change = (section: string, body: string, chapterId: string | null, extra?: Partial<Change>): Change =>
  ({ section, body, chapterId, knownBy: [], restricted: false, manual: false, ...extra })
const base = [
  change('', '守门人。', 'c1'), change('现状', '留在山门。', 'c1'),
  change('现状', '已经离开。', 'c7'), change('隐情', '真名是阿礼。', 'c7', { restricted: true, knownBy: ['ming'] }),
  change('隐情', '真名是阿礼。', 'c40'),
]
const row = { id: 'm1', title: '守门人', memoryType: 'characterCard', profileTracked: true, sourceChapterId: null,
  content: renderProfileAt(base, orders) } as ProjectMemoryEntry
function db(changes: Change[] = base) {
  return {
    chapter: { findMany: async () => [...orders].map(([id, orderIndex]) => ({ id, orderIndex })) },
    storyProfileChange: { findMany: async () => changes.map(change => ({ memoryId: row.id, ...change })) },
  } as unknown as Prisma.TransactionClient
}

describe('story profile revisions', () => {
  it('finds a relevant fact far beyond the short model context excerpt', () => {
    const text = '## 简介\n\n' + '幼时住在山门。'.repeat(400) + '\n\n## 持有人\n\n' + '早年流转经过数人。'.repeat(100) + '铜鱼符现由渡口掌柜保管。'
    const excerpt = selectProfileExcerpt(text, '铜鱼符的持有人是谁', 100)
    expect(excerpt.length).toBeLessThanOrEqual(100)
    expect(excerpt).toContain('持有人')
    expect(excerpt).toContain('渡口掌柜')
  })
  it('keeps fenced examples, nested headings and repeated headings intact', () => {
    const text = '引言\n\n## 身份\n\n```md\n## 这是代码\n```\n\n### 过去\n\n第一段\n\n## 身份\n\n第二段'
    const sections = [...splitProfileMarkdown(text)].map(([section, body]) => change(section, body, null))
    expect(sections).toHaveLength(3)
    expect(renderProfileAt(sections, orders)).toBe(text)
  })

  it('renders facts known at the selected chapter and to the selected person', async () => {
    const project = async (scope: Parameters<typeof projectStoryMemoryAt>[3]) =>
      (await projectStoryMemoryAt(db(), 'n', [row], scope))[0]?.content
    expect(await project({ atChapterOrder: 6 })).toContain('留在山门')
    expect(await project({ atChapterId: 'c7', publicOnly: true })).not.toContain('阿礼')
    expect(await project({ atChapterOrder: 8, viewpointMemoryId: 'other' })).not.toContain('阿礼')
    expect(await project({ atChapterOrder: 8, viewpointMemoryId: 'ming' })).toContain('阿礼')
    expect(await project({ atChapterOrder: 40, publicOnly: true })).toContain('阿礼')
    expect(await project({ atChapterOrder: 0 })).toBeUndefined()
  })

  it('does not rank or display aliases, names or identity keys disclosed only to a later viewpoint', async () => {
    const first = await prepareProfileUpdate(db([]), 'n', null, { title: '摆渡人', content: '在岸边等候。', sourceChapterId: 'c1' })
    const known = await prepareProfileUpdate(db(first.changes), 'n', { ...row, title: '摆渡人', content: first.content }, {
      title: '北境密探', identityKey: '王室耳目', aliases: ['斑鹭'], section: '身份', content: '效力于王室。', sourceChapterId: 'c40', knownBy: ['ming'],
    })
    const current = { ...row, title: '北境密探', identityKey: '王室耳目', aliases: ['摆渡人', '斑鹭'], content: known.content }
    const history = [...first.changes, ...known.changes]
    const replay = async (scope: Parameters<typeof projectStoryMemoryAt>[3]) => (await projectStoryMemoryAt(db(history), 'n', [current], scope))[0]
    expect(await replay({ atChapterOrder: 2, viewpointMemoryId: 'ming' })).toMatchObject({ title: '摆渡人', identityKey: null })
    expect((await replay({ atChapterOrder: 40, publicOnly: true })).aliases).not.toContain('斑鹭')
    expect(await replay({ atChapterOrder: 40, viewpointMemoryId: 'ming' })).toMatchObject({ title: '北境密探', aliases: expect.arrayContaining(['斑鹭']), identityKey: '王室耳目' })
    const renamed = await prepareProfileUpdate(db(history), 'n', current, { title: '新的隐名', content: current.content, manual: true })
    const early = await projectStoryMemoryAt(db([...history, ...renamed.changes]), 'n', [{ ...current, title:'新的隐名' }], { atChapterOrder:1, publicOnly:true })
    expect(early[0].aliases).not.toContain('北境密探')
  })

  it('only writes edited sections, retaining chapter and audience for editor changes', async () => {
    const history = base.slice(0, -1)
    const edits = await prepareProfileUpdate(db(history), 'n', row, { content: row.content.replace('真名是阿礼。', '阿礼来自北岸。'), manual: true })
    expect(edits.changes).toEqual([change('隐情', '阿礼来自北岸。', 'c7', { restricted: true, knownBy: ['ming'], manual: true })])
    const retroactive = await prepareProfileUpdate(db(), 'n', row, { section: '现状', content: '最初住在水岸。', effectiveFromChapterId: 'c1' })
    expect(retroactive.content).toContain('已经离开')
    expect(renderProfileAt([...base, ...retroactive.changes], orders, 1)).toContain('最初住在水岸')
  })

  it('merges an agent introduction or selected headings into a Markdown dossier, while the full editor can delete omitted sections', async () => {
    const history = [change('', '守门人。', null), change('人物设定', '左撇子。', null), change('当前处境', '被困。', 'c7')]
    const original = { ...row, content: renderProfileAt(history, orders) }
    const patch = await prepareProfileUpdate(db(history), 'n', original, { content: '修表师。\n\n## 当前处境\n\n已脱险。', mergeSections: true })
    expect(patch.content).toBe('修表师。\n\n## 人物设定\n\n左撇子。\n\n## 当前处境\n\n已脱险。')
    const edited = await prepareProfileUpdate(db(history), 'n', original, { content: '改用的简介。', manual: true })
    expect(edited.content).toBe('改用的简介。')
  })

  it('can restrict a fact to its author and reveal it in a later chapter', async () => {
    const restricted = await prepareProfileUpdate(db(base.slice(0, 3)), 'n', row,
      { section: '隐情', content: '灯已损坏。', effectiveFromChapterId: 'c7', knownBy: [] })
    const history = [...base.slice(0, 3), ...restricted.changes]
    expect(renderProfileAt(history, orders, 10, 'ming')).not.toContain('灯已损坏')
    const published = await prepareProfileUpdate(db(history), 'n', row,
      { section: '隐情', content: '灯已损坏。', effectiveFromChapterId: 'c40', knownBy: null })
    expect(renderProfileAt([...history, ...published.changes], orders, 40, 'ming')).toContain('灯已损坏')
    const corrected = [...history, change('隐情', '早先记错的秘密。', 'c7', { restricted: true, knownBy: ['ming'] }),
      change('隐情', '正确的秘密。', 'c7', { restricted: true, knownBy: [] })]
    expect(renderProfileAt(corrected, orders, 8, 'ming')).not.toContain('秘密')
  })

  it('functional projections ignore archived chapters, keep legacy titles, and exclude future aggregates', async () => {
    const legacy = { ...row, id: 'old', profileTracked: false, memoryType: 'worldbuilding' as const, sourceChapterId: 'c40', content: '后续设定' }
    const rollup = { ...legacy, id: 'rollup', memoryType: 'storyBible' as const, sourceChapterId: null }
    const removed = { ...legacy, id: 'gone', sourceChapterId: 'archived' }
    expect(await projectStoryMemoryAt(db([]), 'n', [legacy, rollup, removed], { atChapterOrder: 7 })).toEqual([])
    expect(await projectStoryMemoryAt(db([]), 'n', [legacy], { atChapterOrder: 40 })).toEqual([legacy])
    await expect(projectStoryMemoryAt(db([]), 'n', [legacy], { atChapterId: 'gone' })).rejects.toMatchObject({code:'MEMORY_SOURCE_REQUIRED'})
  })
})
