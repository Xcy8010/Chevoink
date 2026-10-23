import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JSZip } from './novel-import-parser.fixtures.js'

const fixture = vi.hoisted(() => ({
  novel: { findFirst: vi.fn() }, chapter: { findMany: vi.fn() }, projectMemoryEntry: { findMany: vi.fn() },
  advice: vi.fn(), plans: vi.fn(),
}))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<typeof import('../../api/lib/prisma.js')>(), prisma: fixture }))
vi.mock('../../api/lib/ai-service.js', () => ({ generatePublishAdviceData: fixture.advice }))
vi.mock('../../api/lib/agent/plan-artifacts.js', () => ({ listNovelPlanArtifacts: fixture.plans }))
import { buildNovelExportZip } from '../../api/lib/export-service.js'

const onlyMemories = { includeMemories: true, includePlans: false, includeCatalog: false, includeInfo: false, includeChapters: false }
beforeEach(() => {
  vi.resetAllMocks()
  fixture.novel.findFirst.mockResolvedValue({ id: 'novel-a', title: '合成作品', displayTitle: null })
  fixture.chapter.findMany.mockResolvedValue([])
  fixture.projectMemoryEntry.findMany.mockResolvedValue([])
})

describe('novel export creative memories', () => {
  it('exports all effective cards beyond the UI page size, preserving every original content byte', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({ id: `m-${index}`, memoryType: index % 2 ? 'worldbuilding' : 'characterCard', title: '同名 / 非法\\标题:*?"<>|\u0000..', content: `  合成卡片${index}\r\n\n原文\t末尾  ` }))
    fixture.projectMemoryEntry.findMany.mockResolvedValue(rows)
    const result = await buildNovelExportZip('owner', 'novel-a', onlyMemories)
    const zip = await JSZip.loadAsync(result.buffer)
    const files = Object.values(zip.files).filter(entry => !entry.dir)
    expect(files).toHaveLength(25)
    expect(new Set(files.map(entry => entry.name.toLowerCase())).size).toBe(25)
    for (const [index, file] of files.entries()) {
      expect(file.name.split('/')).toHaveLength(3)
      expect(file.name).toMatch(/^合成作品\/创作记忆\/\d{4}-(characterCard|worldbuilding) /)
      expect(file.name).not.toMatch(/[\\:*?"<>|]/)
      expect(file.name.includes(String.fromCharCode(0))).toBe(false)
      expect(await file.async('nodebuffer')).toEqual(Buffer.from(rows[index].content, 'utf8'))
    }
    expect(result.summary).toBe('25 条创作记忆')
    expect(fixture.projectMemoryEntry.findMany).toHaveBeenCalledWith({
      where: { novelId: 'novel-a', novel: { authorId: 'owner' }, status: { in: ['confirmed', 'inferred'] }, reviewStatus: { not: 'rejected' } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], select: { id: true, memoryType: true, title: true, content: true },
    })
    expect(fixture.advice).not.toHaveBeenCalled()
    expect(fixture.plans).not.toHaveBeenCalled()
  })
  it('uses the current panel status filter and never includes another work or rejected/obsolete candidates', async () => {
    const rows = [
      { novelId: 'novel-a', status: 'confirmed', reviewStatus: 'accepted' },
      { novelId: 'novel-a', status: 'inferred', reviewStatus: 'pending' },
      ...['invalid', 'superseded', 'conflicted'].map(status => ({ novelId: 'novel-a', status, reviewStatus: 'none' })),
      { novelId: 'novel-a', status: 'confirmed', reviewStatus: 'rejected' },
      { novelId: 'other-work', status: 'confirmed', reviewStatus: 'accepted' },
    ]
    fixture.projectMemoryEntry.findMany.mockImplementation(async ({ where }) => rows.filter(row => row.novelId === where.novelId && where.status.in.includes(row.status) && row.reviewStatus !== where.reviewStatus.not).map((_, index) => ({ id: String(index), title: '卡片', memoryType: 'storyBible', content: `有效原文${index}` })))
    const zip = await JSZip.loadAsync((await buildNovelExportZip('owner', 'novel-a', onlyMemories)).buffer)
    expect(Object.values(zip.files).filter(entry => !entry.dir)).toHaveLength(2)
  })
  it.each([undefined, false])('does not query memories when the legacy option is %s', async includeMemories => {
    const result = await buildNovelExportZip('owner', 'novel-a', { ...onlyMemories, includeMemories, includeCatalog: true })
    expect(fixture.projectMemoryEntry.findMany).not.toHaveBeenCalled()
    const zip = await JSZip.loadAsync(result.buffer)
    expect(Object.keys(zip.files).some(name => name.includes('创作记忆'))).toBe(false)
  })
  it('rejects unauthorized access before any memory query and rejects an empty memory-only archive', async () => {
    await expect(buildNovelExportZip('owner', 'novel-a', onlyMemories)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    fixture.projectMemoryEntry.findMany.mockClear()
    fixture.novel.findFirst.mockResolvedValue(null)
    await expect(buildNovelExportZip('outsider', 'novel-a', onlyMemories)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(fixture.projectMemoryEntry.findMany).not.toHaveBeenCalled()
  })
  it('preserves both plan contents when different original titles sanitize to the same ZIP path', async () => {
    fixture.plans.mockResolvedValue({ items: [{ title: '同名/计划', content: '第一份原文' }, { title: '同名\\计划', content: '第二份原文' }] })
    const zip = await JSZip.loadAsync((await buildNovelExportZip('owner', 'novel-a', { ...onlyMemories, includeMemories: false, includePlans: true })).buffer)
    const files = Object.values(zip.files).filter(file => !file.dir)
    expect(files).toHaveLength(2)
    expect(new Set(files.map(file => file.name.toLowerCase())).size).toBe(2)
    expect(await Promise.all(files.map(file => file.async('string')))).toEqual(['第一份原文', '第二份原文'])
  })
  it('does not turn a dot-only work title into a parent path in the archive', async () => {
    fixture.novel.findFirst.mockResolvedValue({ id: 'novel-a', title: '..', displayTitle: null })
    const result = await buildNovelExportZip('owner', 'novel-a', { ...onlyMemories, includeMemories: false, includeCatalog: true })
    const zip = await JSZip.loadAsync(result.buffer)
    expect(result.fileName).toBe('未命名作品-一键导出.zip')
    expect(Object.keys(zip.files).every(name => !name.split('/').includes('..'))).toBe(true)
  })
})
