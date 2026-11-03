import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as original from '../../api/lib/agent/original-request.js'
import * as writing from '../../api/lib/agent/writing-scope.js'
import * as lock from '../../api/lib/data/novel-write-lock.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

afterEach(() => vi.restoreAllMocks())

describe('fresh whitespace-separated chapter authorization', () => {
  async function fixture(prompt: string) {
    const subject = { userId: 'u', novelId: 'n', runId: 'r' }
    const fresh = buildTaskSpec({ ...subject, chapterId: 'c2', prompt, mode: 'build', authorWritingProtocol: 2,
      reviewProtocol: 1, localEditProtocol: 1 })
    const admission = { prompt, spec: fresh, taskId: fresh.id, sourceRunId: 'r', parentRunId: null }
    vi.spyOn(original, 'readOriginalTaskRequest').mockImplementation(async () => structuredClone(admission))
    vi.spyOn(lock, 'lockNovelActiveScope').mockResolvedValue(undefined)
    const chapters = Array.from({ length: 188 }, (_, index) => ({ id: 'c' + (index + 1), revision: 4,
      orderIndex: index + 1, orderInVolume: index + 1, volumeId: 'v', volume: { orderIndex: 1 }, content: '合成正文。' }))
    const run = { id: 'r', chapterId: 'c2', manuscriptRevision: 0, writingBindings: null,
      session: { sandboxMode: 'workspace', spawnedFromRunId: null } }
    const tx = { $queryRaw: vi.fn(async () => []), agentGoalExecution: { findUnique: vi.fn(async () => null) },
      agentRun: { findFirst: vi.fn(async () => run), findFirstOrThrow: vi.fn(async () => run) },
      chapter: { findMany: vi.fn(async () => chapters) }, agentArtifact: { findMany: vi.fn(async () => []) },
    } as unknown as Prisma.TransactionClient
    const frozen = await writing.freezeWritingScope(tx, subject, fresh, prompt, 2)
    admission.spec = JSON.parse(JSON.stringify(frozen)) as typeof frozen
    return { subject, tx, frozen, admission }
  }

  it('freezes the first three existing IDs instead of creating three book-tail slots, then enforces that scope', async () => {
    const f = await fixture('我授权你可以修改我正文1 2 3章的权利 你按照想法修改')
    expect(f.frozen).toMatchObject({ intent: 'revise', scope: { chapterIds: ['c2'], writing: { kind: 'bounded',
      repairAuthorized: true, targets: [1, 2, 3].map(orderIndex => ({ orderIndex, chapterId: 'c' + orderIndex })) } } })
    expect(f.frozen.scope.writing?.targets).toHaveLength(3)
    expect(f.frozen.scope.localEditBoundary).toBeUndefined()
    const hash = runtimeJson(f.admission).hash
    for (const chapterId of ['c1', 'c2', 'c3']) {
      await expect(writing.assertWritingTarget(f.tx, f.subject, { chapterId, effect: 'range' })).resolves.toBeTruthy()
    }
    for (const chapterId of ['c4', 'c188', 'c189']) {
      await expect(writing.assertWritingTarget(f.tx, f.subject, { chapterId, effect: 'range' })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    }
    await expect(writing.assertWritingTarget(f.tx, f.subject, { orderIndex: 189, effect: 'create' }))
      .rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(runtimeJson(f.admission).hash).toBe(hash)
    expect(await writing.freezeWritingScope(f.tx, f.subject, f.frozen, '修改全书', 2)).toEqual(f.frozen)
  })

  it('removes every explicitly excluded spaced chapter from the fresh scope', async () => {
    const f = await fixture('修改第1至4章。不要修改1 2 3章。')
    expect(f.frozen.scope.writing?.targets).toEqual([{ orderIndex: 4, chapterId: 'c4' }])
    expect(f.frozen.scope.writingInterpretation?.excludedChapterIds).toEqual(['c1', 'c2', 'c3'])
    for (const chapterId of ['c1', 'c2', 'c3']) {
      await expect(writing.assertWritingTarget(f.tx, f.subject, { chapterId, effect: 'range' }))
        .rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    }
  })
})
