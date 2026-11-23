import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMessagePart, AgentToolDisplayPayload } from '../../shared/contracts/index.js'
import { readSessionReadingMaterial } from '../../api/lib/agent/session-reading-material.js'
import { estimateChatMessagesTokens } from '../../api/lib/agent/context-budget.js'
import { prisma } from '../../api/lib/prisma.js'

vi.mock('../../api/lib/prisma.js', () => ({
  prisma: { chapter: { findMany: vi.fn() }, agentArtifact: { findMany: vi.fn() } },
}))
afterEach(() => vi.resetAllMocks())
const scope = { userId: 'author', novelId: 'novel', allowedReads: ['chapter_read', 'plan_read'], tokenBudget: 228000 }
function receipt(toolName: string, display: AgentToolDisplayPayload, args: unknown = {}): Extract<AgentMessagePart, { type: 'tool-call' }> {
  return { type: 'tool-call', callId: 'original', title: '工具', toolName, display, args, status: 'success' }
}
function chapter(start: number, end: number, revision = 4) {
  return receipt('chapter_read', { kind: 'chapterRef', chapterId: 'c', title: '雨声', wordCount: 160, revision, range: { start, end } })
}

it('merges only the ranges actually read at the current chapter revision under the active owner and novel', async () => {
  const content = 'ABCDEFGHIJ'
  vi.mocked(prisma.chapter.findMany).mockResolvedValue([{ id: 'c', title: '雨声', revision: 4, content }] as never)
  const got = await readSessionReadingMaterial({ ...scope, parts: [chapter(1, 3), chapter(2, 5), chapter(5, 6), chapter(8, 9), chapter(0, 10, 3)] })
  expect(got.map(m => String(m.content).split('\n').at(-1))).toEqual(['BCDEF', 'I'])
  expect(prisma.chapter.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
    authorId: 'author', novelId: 'novel', archivedAt: null, volume: { archivedAt: null, novelId: 'novel' }, id: { in: ['c'] },
  } }))
  expect(prisma.agentArtifact.findMany).not.toHaveBeenCalled()
})

it('uses matching plan versions, exact saved content and only the matching portion of legacy previews', async () => {
  const data = [
    { id: 'read', title: '分场', content: 'abcdefghij' },
    { id: 'saved', title: '细纲', content: '已保存版本' },
    { id: 'old', title: '旧版回执', content: '开头' + '线'.repeat(130) },
    { id: 'edited', title: '改过的计划', content: '新版私稿' },
  ]
  vi.mocked(prisma.agentArtifact.findMany).mockResolvedValue(data as never)
  const reads = (id: string, content: string) => receipt('plan_read', { kind: 'readSources', items: [{
    title: '计划', target: { kind: 'plan', id }, readingRange: { start: 1, end: 4, contentHash: createHash('sha256').update(content).digest('hex') },
  }] })
  const parts = [
    reads('read', data[0].content), reads('edited', '已过期的版本'),
    receipt('plan_save', { kind: 'planDiff', artifactId: 'saved', title: '细纲', beforeTitle: '旧', before: '旧版本', after: '已保存版本' }),
    receipt('plan_save', { kind: 'planFile', artifactId: 'edited', title: '旧', content: '不再有效' }),
    receipt('plan_read', { kind: 'readSources', items: [{ title: '旧', target: { kind: 'plan', id: 'old' }, preview: '线'.repeat(120) + '…' }] }, {offset: 2}),
  ]
  const got = await readSessionReadingMaterial({ ...scope, parts })
  expect(got.map(m => String(m.content).split('\n').at(-1))).toEqual(['bcd', '已保存版本', '线'.repeat(120)])
  expect(prisma.agentArtifact.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
    artifactType: 'chapterPlan', metadata: { path: ['savedAsPlan'], equals: true }, run: { userId: 'author', novelId: 'novel' },
  }) }))
})

it('does not query content for unavailable reads, failed calls, child calls or an empty budget', async () => {
  const call = chapter(0, 2)
  for (const input of [
    { ...scope, parts: [call], allowedReads: ['plan_read'] }, { ...scope, parts: [call], tokenBudget: 0 },
    { ...scope, parts: [{ ...call, status: 'failed' as const }, { ...call, subagentCallId: 'child' },
      receipt('chapter_read', { kind: 'chapterRef', chapterId: 'archived', title: '只见引用', wordCount: 100, revision: 4, range: { start: 0, end: 20 }, archiveOnly: true })] },
  ]) expect(await readSessionReadingMaterial(input)).toEqual([])
  expect(prisma.chapter.findMany).not.toHaveBeenCalled()
  expect(prisma.agentArtifact.findMany).not.toHaveBeenCalled()
})

it('retains a prefix of material under the actual remaining token budget including message overhead', async () => {
  const content = 'a字🌲'.repeat(1000)
  vi.mocked(prisma.chapter.findMany).mockResolvedValue([{ id: 'c', title: '合成章节', revision: 4, content }] as never)
  const got = await readSessionReadingMaterial({ ...scope, parts: [chapter(0, content.length)], tokenBudget: 100 })
  expect(estimateChatMessagesTokens(got)).toBeLessThanOrEqual(100)
  const shown = String(got[0].content).split('\n').at(-1)!
  expect(shown.length).toBeGreaterThan(1)
  expect(shown.length).toBeLessThan(content.length)
  expect(content.startsWith(shown)).toBe(true)
  expect(String(got[0].content)).toContain(`[0,${shown.length})`)
  expect(shown).not.toMatch(/[\uD800-\uDBFF]$/)
})
