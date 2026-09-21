import { beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { resolveMemorySource } from '../../api/lib/agent/tools/memory-source.js'
import { memorySaveTool } from '../../api/lib/agent/tools/write-tools.js'
import { memoryEventSaveTool, memoryRelationSaveTool } from '../../api/lib/agent/tools/memory-tools.js'
import { saveStoryMemory } from '../../api/lib/agent/story-memory.js'
import { prisma } from '../../api/lib/prisma.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

vi.mock('../../api/lib/prisma.js', () => ({ prisma: { chapter: { findFirst: vi.fn() } },
  DataAccessError: class extends Error { constructor(public statusCode: number, public code: string, message: string) { super(message) } } }))
vi.mock('../../api/lib/agent/story-memory.js', () => ({ saveStoryMemory: vi.fn(), listMemoryReviewInbox: vi.fn() }))
const ctx = { userId: 'u', novelId: 'n', runId: 'r', sessionId: 's', signal: new AbortController().signal } as ToolContext
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.chapter.findFirst).mockResolvedValue({ id: 'c', revision: 2, content: '林舟把钥匙交给顾棠。' } as never)
  vi.mocked(saveStoryMemory).mockResolvedValue({ id: 'proposal', status: 'inferred', action: 'conflict' })
})
it('binds chapter scope/revision and validates literal quote', async () => {
  const evidence = await resolveMemorySource(ctx, { sourceChapterId: 'c', revision: 2, sourceQuote: '钥匙交给顾棠' })
  expect(prisma.chapter.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c', novelId: 'n', authorId: 'u' } }))
  expect(evidence).toMatchObject({ sourceType: 'chapter', revision: 2, span: { start: 3, end: 9, quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/) } })
})
it('binds whitespace-only quote differences to the exact original UTF16 span and hash', async () => {
  const content = '💡林舟把钥匙\r\n　交给顾棠。'
  vi.mocked(prisma.chapter.findFirst).mockResolvedValue({ id: 'c', revision: 2, content } as never)
  const evidence = await resolveMemorySource(ctx, { sourceChapterId: 'c', revision: 2, sourceQuote: '钥匙交给顾棠' })
  const original = '钥匙\r\n　交给顾棠'
  expect(evidence).toMatchObject({ span: { start: content.indexOf('钥匙'), end: content.indexOf('。'), quoteHash: createHash('sha256').update(original).digest('hex') } })
})
it.each([
  ['甲\n乙和甲 乙', '甲乙'],
  ['a b', 'ab'],
  ['钥匙交给顾棠。', '钥匙，交给顾棠。'],
])('refuses ambiguous layout matches or changed words/punctuation', async (content, sourceQuote) => {
  vi.mocked(prisma.chapter.findFirst).mockResolvedValue({ id: 'c', revision: 2, content } as never)
  await expect(resolveMemorySource(ctx, { sourceChapterId: 'c', sourceQuote })).rejects.toMatchObject({ code: 'MEMORY_EVIDENCE_MISMATCH' })
  expect(saveStoryMemory).not.toHaveBeenCalled()
})
it('rejects forged, cross-work, stale or missing evidence before a memory write', async () => {
  await expect(resolveMemorySource(ctx, { sourceChapterId: 'c', revision: 1 })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_REQUIRED' })
  await expect(resolveMemorySource(ctx, { sourceChapterId: 'c', sourceQuote: '钥匙已销毁' })).rejects.toMatchObject({ code: 'MEMORY_EVIDENCE_MISMATCH' })
  await expect(resolveMemorySource(ctx, { revision: 2 })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_REQUIRED' })
  vi.mocked(prisma.chapter.findFirst).mockResolvedValue(null)
  await expect(resolveMemorySource(ctx, { sourceChapterId: 'other' })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_REQUIRED' })
  expect(saveStoryMemory).not.toHaveBeenCalled()
})
it('does not pretend a run ID is an author message or honor model confirmation', async () => {
  expect(await resolveMemorySource(ctx, {})).toMatchObject({ sourceType: 'artifact', sourceId: 'r' })
  const result = await memorySaveTool.execute(ctx, memorySaveTool.parameters.parse({ memoryType: 'worldbuilding', title: '设定', content: '模型推断', importance: 70, overwrite: true }))
  expect(saveStoryMemory).toHaveBeenCalledWith(expect.objectContaining({ agentGenerated: true, status: 'inferred', evidence: expect.objectContaining({ sourceType: 'artifact' }) }), undefined)
  expect(result.output).toContain('尚未参与事实召回')
})
it('relationship and event tools use proposals, not immediate graph/timeline writes', async () => {
  await memoryRelationSaveTool.execute(ctx, memoryRelationSaveTool.parameters.parse({ fromName: '甲', toName: '乙', relationType: '朋友', confidence: 1 }))
  await memoryEventSaveTool.execute(ctx, memoryEventSaveTool.parameters.parse({ title: '事件', description: '可能到访', confidence: 1 }))
  expect(vi.mocked(saveStoryMemory).mock.calls).toHaveLength(2)
  for (const [input] of vi.mocked(saveStoryMemory).mock.calls) expect(input).toMatchObject({ agentGenerated: true, status: 'inferred' })
})
it('oversized memory text fails validation instead of silently truncating facts', () => {
  const raw = { memoryType: 'worldbuilding', title: '设定', content: '字'.repeat(4001), importance: 80 }
  expect(memorySaveTool.parameters.safeParse(memorySaveTool.coerceArgs!(raw)).success).toBe(false)
})
it.each(['setting', 'world_setting', 'world_building'])('normalizes equivalent worldbuilding type %s without changing facts', memoryType => {
  const raw = { memoryType, title: '设定', content: '待作者确认的设定', importance: 80 }
  expect(memorySaveTool.parameters.parse(memorySaveTool.coerceArgs!(raw))).toEqual({ ...raw, memoryType: 'worldbuilding' })
})
it('rejects unknown memory types and orphan quotes rather than fabricating evidence', async () => {
  expect(memorySaveTool.parameters.safeParse(memorySaveTool.coerceArgs!({ memoryType: 'invented', title: '设定', content: '内容' })).success).toBe(false)
  await expect(resolveMemorySource(ctx, { sourceQuote: '模型生成的引文' })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_REQUIRED' })
  expect(saveStoryMemory).not.toHaveBeenCalled()
})
