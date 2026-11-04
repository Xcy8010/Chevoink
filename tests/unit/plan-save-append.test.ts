import { createHash } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { novelPlanHash } from '../../api/lib/agent/novel-plan-contract.js'
import { planSaveTool } from '../../api/lib/agent/tools/write-tools.js'
import { planReadTool } from '../../api/lib/agent/tools/read-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

vi.mock('../../api/lib/prisma.js', () => ({ prisma: { $transaction: vi.fn(), $queryRaw: vi.fn(), agentArtifact: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), create: vi.fn() } },
  DataAccessError: class extends Error { constructor(public statusCode: number, public code: string, message: string) { super(message) } } }))
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const ctx = { userId: 'u', novelId: 'n', runId: 'r', signal: new AbortController().signal } as ToolContext
const original = { id: 'p', title: '原计划', content: '前文'.repeat(200), metadata: { savedAsPlan: true }, updatedAt: new Date(0) }
beforeEach(() => {
  ctx.planContentHashes = undefined
  ctx.planSemanticHashes = undefined
  vi.clearAllMocks()
  vi.mocked(prisma.$transaction).mockImplementation((work: never) => (work as (tx: unknown) => Promise<unknown>)(prisma) as never)
  vi.mocked(prisma.$queryRaw).mockResolvedValue([{ id: 'n' }])
  vi.mocked(prisma.agentArtifact.create).mockResolvedValue({ id: 'new-plan' } as never)
  vi.mocked(prisma.agentArtifact.update).mockResolvedValue(original as never)
  vi.mocked(prisma.agentArtifact.findMany).mockResolvedValue([])
  vi.mocked(prisma.agentArtifact.findFirst).mockResolvedValue(original as never)
  vi.mocked(prisma.agentArtifact.updateMany).mockResolvedValue({ count: 1 })
})
it('uses only this execution’s observed version when the model omits a hash', async () => {
  ctx.planContentHashes = new Map()
  const withoutHash = { ...args(), expectedContentHash: undefined }
  expect((await planSaveTool.execute(ctx, withoutHash)).outcome).toBe('failed')
  await planReadTool.execute(ctx, { planId: 'p' })
  expect((await planSaveTool.execute(ctx, withoutHash)).outcome).not.toBe('failed')
  expect(ctx.planContentHashes.get('p')).toBe(hash(original.content + '\n\n下一节完整内容'))
})
it('does not use cached observations to override a stale explicit hash or a concurrent edit', async () => {
  ctx.planContentHashes = new Map([['p', hash(original.content)]])
  expect((await planSaveTool.execute(ctx, { ...args(), expectedContentHash: 'a'.repeat(64) })).outcome).toBe('failed')
  vi.mocked(prisma.agentArtifact.findFirst).mockResolvedValue({ ...original, content: original.content + '作者修改' } as never)
  expect((await planSaveTool.execute(ctx, { ...args(), expectedContentHash: undefined })).outcome).toBe('failed')
  expect(prisma.agentArtifact.updateMany).not.toHaveBeenCalled()
})
it('rejects a duplicate last section even with a fresh server observation', async () => {
  const content = original.content + '\n\n下一节完整内容'
  ctx.planContentHashes = new Map([['p', hash(content)]])
  vi.mocked(prisma.agentArtifact.findFirst).mockResolvedValue({ ...original, content } as never)
  expect((await planSaveTool.execute(ctx, { ...args(), expectedContentHash: undefined })).outcome).toBe('failed')
  expect(prisma.agentArtifact.updateMany).not.toHaveBeenCalled()
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

it('returns only real same-work plan candidates for an invalid explicit ID without reading a different body', async () => {
  vi.mocked(prisma.agentArtifact.findFirst).mockResolvedValue(null)
  vi.mocked(prisma.agentArtifact.findMany).mockResolvedValue([{ id: 'actual-plan', title: '实际计划' }] as never)
  const result = await planReadTool.execute(ctx, { planId: ': ' })
  expect(result).toMatchObject({ outcome: 'failed', summary: '指定计划不存在' })
  expect(result.output).toContain('actual-plan')
  expect(result.output).toContain('没有改读另一份计划')
  expect(result.observedState).toBeUndefined()
  expect(prisma.agentArtifact.findFirst).toHaveBeenCalledTimes(1)
  expect(prisma.agentArtifact.findMany).toHaveBeenCalledWith({
    where: { artifactType: 'chapterPlan', metadata: { path: ['savedAsPlan'], equals: true }, run: { userId: 'u', novelId: 'n' } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 5, select: { id: true, title: true },
  })
})
it('omits only whitespace optional plan IDs and never treats punctuation as empty', async () => {
  expect((await planReadTool.execute(ctx, { planId: '   ' })).outcome).not.toBe('failed')
  expect(prisma.agentArtifact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.not.objectContaining({ id: expect.anything() }) }))
  expect(prisma.agentArtifact.findMany).not.toHaveBeenCalled()
})

it('rejects a fresh missing planKind without reading or writing a guessed legacy identity', async () => {
  const result = await planSaveTool.execute(ctx, { title: '新计划', content: '本章人物取得钥匙。' })
  expect(result).toMatchObject({ outcome: 'failed', failureCode: 'PLAN_KIND_REQUIRED' })
  expect(prisma.agentArtifact.findFirst).not.toHaveBeenCalled()
  expect(prisma.agentArtifact.findMany).not.toHaveBeenCalled()
  expect(prisma.agentArtifact.create).not.toHaveBeenCalled()
  expect(prisma.agentArtifact.update).not.toHaveBeenCalled()
  expect(prisma.agentArtifact.updateMany).not.toHaveBeenCalled()
})
it.each(['outline', 'detail'] as const)('creates an explicitly typed %s without guessing from its title', async planKind => {
  const result = await planSaveTool.execute(ctx, { title: '同名计划', content: '本章人物取得钥匙。', planKind })
  expect(result.outcome).not.toBe('failed')
  expect(prisma.agentArtifact.create).toHaveBeenCalledWith({ data: expect.objectContaining({ metadata: expect.objectContaining({ planKind }) }) })
})
it('preserves an existing legacy plan when updating its explicit ID without a type', async () => {
  const result = await planSaveTool.execute(ctx, { title: original.title, content: original.content + '新增小节', planId: original.id })
  expect(result.outcome).not.toBe('failed')
  expect(prisma.agentArtifact.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ metadata: original.metadata }) }))
  expect(prisma.agentArtifact.create).not.toHaveBeenCalled()
})

it('appends consecutive typed sections using the server-observed semantic version without asking the model for a second hash', async () => {
  ctx.planContentHashes = new Map(); ctx.planSemanticHashes = new Map()
  const typed = { ...original, metadata: { savedAsPlan: true, planKind: 'outline' } }
  vi.mocked(prisma.agentArtifact.findFirst).mockImplementation(async () => typed as never)
  vi.mocked(prisma.agentArtifact.updateMany).mockImplementation(async ({ data }) => { Object.assign(typed, data); return { count: 1 } })
  await planReadTool.execute(ctx, { planId: 'p' })
  const first = await planSaveTool.execute(ctx, { title: typed.title, content: '第一份新增小节', planId: 'p', mode: 'append' })
  expect(first.outcome).not.toBe('failed')
  expect(ctx.planSemanticHashes.get('p')).toBe(novelPlanHash(typed))
  const second = await planSaveTool.execute(ctx, { title: typed.title, content: '第二份新增小节', planId: 'p', mode: 'append' })
  expect(second.outcome).not.toBe('failed')
  expect(typed.content).toContain('第一份新增小节\n\n第二份新增小节')
  expect(prisma.agentArtifact.updateMany).toHaveBeenCalledTimes(2)
})
it.each(['explicit-stale', 'metadata-only-concurrent'] as const)('never replaces an explicit stale semantic hash or ignores changed links: %s', async scenario => {
  ctx.planContentHashes = new Map(); ctx.planSemanticHashes = new Map()
  const typed = { ...original, metadata: { savedAsPlan: true, planKind: 'outline' } }
  vi.mocked(prisma.agentArtifact.findFirst).mockResolvedValue(typed as never)
  await planReadTool.execute(ctx, { planId: 'p' })
  if (scenario === 'metadata-only-concurrent') vi.mocked(prisma.agentArtifact.findFirst).mockResolvedValue({ ...typed, metadata: { savedAsPlan: true, planKind: 'detail', target: { kind: 'future', targetOrderIndex: 1 } } } as never)
  const operation = planSaveTool.execute(ctx, { title: typed.title, content: '新增小节', planId: 'p', mode: 'append',
    ...(scenario === 'explicit-stale' ? { expectedPlanHash: 'a'.repeat(64) } : {}) })
  await expect(operation).rejects.toMatchObject({ code: 'PLAN_REVISION_CONFLICT' })
  expect(prisma.agentArtifact.updateMany).not.toHaveBeenCalled()
})
