import { createHash } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { planSaveTool } from '../../api/lib/agent/tools/write-tools.js'
import { planReadTool } from '../../api/lib/agent/tools/read-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

vi.mock('../../api/lib/prisma.js', () => ({ prisma: { agentArtifact: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn(), create: vi.fn() } },
  DataAccessError: class extends Error { constructor(public statusCode: number, public code: string, message: string) { super(message) } } }))
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const ctx = { userId: 'u', novelId: 'n', runId: 'r', signal: new AbortController().signal } as ToolContext
const original = { id: 'p', title: '原计划', content: '前文'.repeat(200), metadata: { savedAsPlan: true }, updatedAt: new Date(0) }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.agentArtifact.findFirst).mockResolvedValue(original as never)
  vi.mocked(prisma.agentArtifact.updateMany).mockResolvedValue({ count: 1 })
})
const args = () => planSaveTool.parameters.parse({ title: '原计划', planId: 'p', mode: 'append', expectedContentHash: hash(original.content), content: '下一节完整内容' })
it('preserves append guards through envelopes and never mistakes a version hash for content', () => {
  const { title, content, ...guard } = args()
  expect(planSaveTool.parameters.parse(planSaveTool.coerceArgs!({ ...guard, arguments: { title, content } }))).toEqual(args())
  expect(planSaveTool.parameters.safeParse(planSaveTool.coerceArgs!({ ...guard, title })).success).toBe(false)
})
it('appends one complete section with compare-and-set and returns the new content hash', async () => {
  const result = await planSaveTool.execute(ctx, args())
  const content = original.content + '\n\n下一节完整内容'
  expect(result.outcome).not.toBe('failed')
  expect(result.output).toContain(hash(content))
  expect(result.display).toMatchObject({ kind: 'planDiff', before: original.content, after: content })
  expect(prisma.agentArtifact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ run: { userId: 'u', novelId: 'n' } }) }))
  expect(prisma.agentArtifact.updateMany).toHaveBeenCalledWith({ where: { id: 'p', content: original.content, title: original.title, updatedAt: original.updatedAt }, data: { title: original.title, content, metadata: original.metadata } })
  expect(prisma.agentArtifact.create).not.toHaveBeenCalled()
})
it('rejects a stale replay without appending the section twice', async () => {
  vi.mocked(prisma.agentArtifact.findFirst).mockResolvedValue({ ...original, content: original.content + '\n\n下一节完整内容' } as never)
  expect((await planSaveTool.execute(ctx, args())).outcome).toBe('failed')
  expect(prisma.agentArtifact.updateMany).not.toHaveBeenCalled()
})
it('rejects a concurrent change after the read', async () => {
  vi.mocked(prisma.agentArtifact.updateMany).mockResolvedValue({ count: 0 })
  expect((await planSaveTool.execute(ctx, args())).outcome).toBe('failed')
  expect(prisma.agentArtifact.update).not.toHaveBeenCalled()
})
it.each([{ planId: undefined }, { expectedContentHash: undefined }])('requires explicit append target and version %j', async missing => {
  expect((await planSaveTool.execute(ctx, { ...args(), ...missing })).outcome).toBe('failed')
  expect(prisma.agentArtifact.findFirst).not.toHaveBeenCalled()
})
it('does not create a new plan when the append target is missing or foreign', async () => {
  vi.mocked(prisma.agentArtifact.findFirst).mockResolvedValue(null)
  expect((await planSaveTool.execute(ctx, args())).outcome).toBe('failed')
  expect(prisma.agentArtifact.create).not.toHaveBeenCalled()
})
it('preserves placeholder protection and cancellation', async () => {
  const refused = await planSaveTool.execute(ctx, { ...args(), content: 'placeholder' })
  expect(refused.outcome).toBe('failed')
  expect(refused.output).toContain('完整小节')
  expect(refused.output).not.toContain('必须一次传入完整')
  await expect(planSaveTool.execute({ ...ctx, signal: AbortSignal.abort() }, args())).rejects.toThrow()
  expect(prisma.agentArtifact.updateMany).not.toHaveBeenCalled()
})
it('also uses compare-and-set when replacement explicitly supplies a content hash', async () => {
  vi.mocked(prisma.agentArtifact.updateMany).mockResolvedValue({ count: 0 })
  const result = await planSaveTool.execute(ctx, { ...args(), mode: 'replace', content: '替换内容'.repeat(100) })
  expect(result.outcome).toBe('failed')
  expect(prisma.agentArtifact.update).not.toHaveBeenCalled()
})
it('returns a hash for read recovery and distinguishes an empty folder from a missing target', async () => {
  expect((await planReadTool.execute(ctx, { planId: 'p' })).output).toContain(hash(original.content))
  vi.mocked(prisma.agentArtifact.findFirst).mockResolvedValue(null)
  expect((await planReadTool.execute(ctx, {})).outcome).not.toBe('failed')
  expect((await planReadTool.execute(ctx, { planId: 'foreign' })).outcome).toBe('failed')
})
it('allows reading the saved tail of a long plan before retrying an append', async () => {
  const content = '甲'.repeat(8500) + '已保存的最后小节'
  vi.mocked(prisma.agentArtifact.findFirst).mockResolvedValue({ ...original, content } as never)
  const head = await planReadTool.execute(ctx, { planId: 'p' })
  expect(head.output).toContain('offset=8000')
  expect(head.output).not.toContain('已保存的最后小节')
  expect(head.observedState).toBeUndefined()
  const tail = await planReadTool.execute(ctx, { planId: 'p', offset: 8500 })
  expect(tail.output).toContain('已保存的最后小节')
  expect(tail.output).toContain(hash(content))
  expect(tail.observedState).toBeUndefined()
  const durable = await planReadTool.execute({ ...ctx, transaction: prisma }, { planId: 'p' })
  expect(durable.output).toContain('已保存的最后小节')
  expect(durable.observedState).toMatchObject({ kind: 'plan', id: 'p' })
  const partialDurable = await planReadTool.execute({ ...ctx, transaction: prisma }, { planId: 'p', limit: 100 })
  expect(partialDurable.observedState).toBeUndefined()
})
