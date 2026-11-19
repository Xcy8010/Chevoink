import type { Prisma } from '@prisma/client'
import { expect, it, vi } from 'vitest'

import { normalizeToolInput } from '../../api/lib/agent/tools/input-validation.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { memorySaveTool } from '../../api/lib/agent/tools/write-tools.js'

vi.mock('../../api/lib/agent/goal-fence.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/goal-fence.js')>(),
  assertRunGoalFence: vi.fn(),
}))

it.each([
  ['omitted title', undefined],
  ['scene sentence as title', '十七号上午，在他的住处'],
])('writes only the identified card section with %s', async (_label, title) => {
  const original = {
    id: 'zhou-card', novelId: 'novel', memoryType: 'characterCard',
    title: '老周', content: '修钟人。\n\n## 人物设定\n\n谨慎守时。',
    profileTracked: false, identityKey: null, aliases: ['周师傅'], sourceChapterId: null,
    runId: null, reviewStatus: 'none', status: 'inferred', importance: 70, layer: 'L1', version: 1,
  }
  const updateCard = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...original, ...data }))
  const updateEntity = vi.fn(async () => ({ id: 'zhou-entity' }))
  const writeAliases = vi.fn()
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'novel' }]),
    novel: { findFirst: vi.fn().mockResolvedValue({ id: 'novel' }) },
    agentRun: { findFirst: vi.fn().mockResolvedValue({ manuscriptRevision: 1, novel: { authorId: 'author', manuscriptRevision: 1 } }) },
    projectMemoryEntry: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValueOnce(original).mockResolvedValue(null),
      update: updateCard,
      updateMany: vi.fn(),
    },
    storyProfileChange: { createMany: vi.fn() },
    memoryEvidence: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    memoryRevision: { create: vi.fn() },
    storyEntity: {
      findUnique: vi.fn(({ where }) => where.novelId_entityType_canonicalName.canonicalName === '老周' ? { id: 'zhou-entity' } : null),
      update: updateEntity,
      upsert: vi.fn().mockResolvedValue({ id: 'zhou-new-entity' }),
    },
    entityAlias: { createMany: writeAliases },
  }
  const ctx: ToolContext = {
    userId: 'author', novelId: 'novel', runId: 'run', chapterId: null, sessionId: 'session',
    callId: 'call', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium',
    signal: new AbortController().signal, emit: vi.fn(),
    transaction: tx as unknown as Prisma.TransactionClient,
  }
  const content = '十七号上午，在他的住处。他等来一封电报。'
  const args = memorySaveTool.parameters.parse(normalizeToolInput(memorySaveTool, {
    memoryType: 'characterCard', memoryId: original.id, title, section: '当前处境', content,
  }))
  const receipt = await memorySaveTool.execute(ctx, args)

  expect(updateCard).toHaveBeenCalledWith({
    where: { id: original.id },
    data: expect.objectContaining({ title: original.title, content: `${original.content}\n\n## 当前处境\n\n${content}`, aliases: original.aliases }),
  })
  expect(updateEntity).toHaveBeenCalledWith({ where: { id: 'zhou-entity' }, data: expect.objectContaining({ canonicalName: '老周' }) })
  expect(writeAliases).toHaveBeenCalledWith({
    data: [{ entityId: 'zhou-entity', alias: '老周', sourceId: 'run' }, { entityId: 'zhou-entity', alias: '周师傅', sourceId: 'run' }],
    skipDuplicates: true,
  })
  expect(receipt).toMatchObject({
    savedMemoryId: original.id, summary: '更新记忆「老周」', output: expect.stringContaining('老周（memoryId=zhou-card）'),
    display: { kind: 'memoryCard', memoryId: original.id, memoryType: original.memoryType, title: original.title },
  })
})
