import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../api/lib/prisma.js', () => ({ prisma: { chapter: { findFirst: vi.fn() } } }))
import { prisma } from '../../api/lib/prisma.js'
import { readWritingLocalContext } from '../../api/lib/agent/writing-local-context.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'

function spec(chapterId: string | null = 'target') {
  const value = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'editor', prompt: '修改全书第四章' })
  value.scope.capabilityCatalog = { version: 1, requestHash: 'a'.repeat(64), kind: 'writing', names: ['chapter_read'] }
  value.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId, orderIndex: 4 }], titleAndBodyOnly: false, repairAuthorized: true }
  return value
}
afterEach(() => vi.resetAllMocks())
describe('bounded writing reading aid', () => {
  it('uses the frozen target and nearest preceding global chapter, never the editor or latest bridge', async () => {
    vi.mocked(prisma.chapter.findFirst).mockResolvedValueOnce({ id: 'target', title: '目标', orderIndex: 4, revision: 8, content: '正文'.repeat(2000) } as never)
      .mockResolvedValueOnce({ id: 'previous', title: '前章', orderIndex: 3, revision: 2, content: '前文'.repeat(1500) } as never)
    const text = await readWritingLocalContext('owner', 'novel', spec())
    expect(prisma.chapter.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: expect.objectContaining({ authorId: 'owner', novelId: 'novel', id: 'target', orderIndex: 4 }) }))
    expect(prisma.chapter.findFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: expect.objectContaining({ authorId: 'owner', novelId: 'novel', orderIndex: { lt: 4 } }), orderBy: { orderIndex: 'desc' } }))
    expect(text).toContain('chapterId=target，revision=8')
    expect(text).toContain('[0,3000)/全文4000')
    expect(text).toContain('[1000,3000)/全文3000')
    expect(text).toContain('仅为局部原文')
    expect(text).toContain('不是写入基线或复核通过证明')
    expect(text).not.toContain('chapterId=editor')
  })
  it('does not replace a missing target with the editor or fabricate a new chapter baseline', async () => {
    vi.mocked(prisma.chapter.findFirst).mockResolvedValue(null)
    expect(await readWritingLocalContext('owner', 'novel', spec())).toContain('冻结目标当前不可核实')
    vi.clearAllMocks()
    expect(await readWritingLocalContext('owner', 'novel', spec(null))).toContain('尚无冻结 chapterId')
    expect(prisma.chapter.findFirst).toHaveBeenCalledTimes(1)
  })
  it('never treats the first of multiple targets as all chapters', async () => {
    const value = spec()
    value.scope.writing!.targets.push({ chapterId: 'next', orderIndex: 5 })
    expect(await readWritingLocalContext('owner', 'novel', value)).toContain('逐章按本任务实际编译进度')
    expect(prisma.chapter.findFirst).not.toHaveBeenCalled()
  })
  it.each(['legacy', 'local', 'selection', 'research'] as const)('does not inject whole-chapter text into %s', async kind => {
    const value = spec()
    if (kind === 'legacy') delete value.scope.capabilityCatalog
    if (kind === 'local') value.scope.localEditBoundary = { version: 1, kind: 'bounded', regions: [] }
    if (kind === 'selection') value.scope.selection = { chapterId: 'target', start: 0, end: 2 }
    if (kind === 'research') value.scope.capabilityCatalog!.kind = 'research'
    expect(await readWritingLocalContext('owner', 'novel', value)).toBeNull()
    expect(prisma.chapter.findFirst).not.toHaveBeenCalled()
  })
})
