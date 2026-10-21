import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as original from '../../api/lib/agent/original-request.js'
import * as writing from '../../api/lib/agent/writing-scope.js'
import * as manuscript from '../../api/lib/agent/manuscript-scope.js'
import * as lock from '../../api/lib/data/novel-write-lock.js'
import { recordWritingClarification } from '../../api/lib/agent/writing-clarification.js'
import { assertChapterManuscriptRevision } from '../../api/lib/agent/chapter-review-guard.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

afterEach(() => vi.restoreAllMocks())

describe('authenticated clarification at ordinary body-effect admission', () => {
  async function fixture(prompt: string) {
    const subject = { userId: 'u', novelId: 'n', runId: 'r' }
    const fresh = buildTaskSpec({ ...subject, prompt, mode: 'build', authorWritingProtocol: 2, reviewProtocol: 1, localEditProtocol: 1 })
    const admission = { prompt, spec: fresh, taskId: fresh.id, sourceRunId: 'r', parentRunId: null }
    vi.spyOn(original, 'readOriginalTaskRequest').mockImplementation(async () => structuredClone(admission))
    vi.spyOn(original, 'originalTaskRunIds').mockResolvedValue(['r'])
    vi.spyOn(writing, 'lockWritingRunLineage').mockResolvedValue(undefined)
    vi.spyOn(manuscript, 'assertAgentManuscriptCurrent').mockResolvedValue(undefined)
    vi.spyOn(lock, 'lockNovelActiveScope').mockResolvedValue(undefined)
    const chapter = { id: 'chapter-five', title: '合成章节', revision: 4, orderIndex: 5, orderInVolume: 5,
      volumeId: 'v', volume: { orderIndex: 1 }, content: '窗边还留着一盏灯。门开了。走廊无人。' }
    const run = { id: 'r', chapterId: null, manuscriptRevision: 0, writingBindings: null,
      session: { sandboxMode: 'workspace', spawnedFromRunId: null } }
    const artifacts: Array<{ metadata: unknown }> = []
    const create = vi.fn(async ({ data }: { data: { metadata: unknown } }) => { artifacts.push(data); return data })
    const tx = { $queryRaw: vi.fn(async () => []),
      agentRun: { findFirst: vi.fn(async () => run), findFirstOrThrow: vi.fn(async () => run) },
      chapter: { findMany: vi.fn(async () => [chapter]), findFirst: vi.fn(async () => chapter) },
      agentArtifact: { findMany: vi.fn(async () => artifacts), create },
      storyCompilation: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      chapterQualityReport: { findMany: vi.fn(async () => []) },
    } as unknown as Prisma.TransactionClient
    const frozen = await writing.freezeWritingScope(tx, subject, fresh, prompt, 2)
    admission.spec = JSON.parse(JSON.stringify(frozen)) as typeof frozen
    admission.taskId = frozen.id
    return { subject, chapter, run, artifacts, create, tx, admission, frozen }
  }

  it.each(['chapter', 'quote'] as const)('consumes a valid %s answer only for the body effect while preserving the frozen request', async scenario => {
    const f = await fixture(scenario === 'chapter' ? '修改那一章。' : '只修改第5章这句话。')
    const originalHash = runtimeJson(f.admission).hash
    const start = f.chapter.content.indexOf('门开了。'), end = start + '门开了。'.length
    const editRanges = [{ start, end, newText: '门悄然开了。' }]
    const after = f.chapter.content.slice(0, start) + editRanges[0].newText + f.chapter.content.slice(end)
    const options = { mutation: 'range' as const, after, editRanges }
    await expect(assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, options)).rejects.toMatchObject({
      code: scenario === 'chapter' ? 'REPAIR_NOT_AUTHORIZED' : 'AUTHOR_LOCAL_SCOPE',
    })
    expect(await recordWritingClarification(f.tx, f.subject, { callId: 'actual-author-answer', question: '请明确目标或原文',
      options: [{ label: '第5章' }, { label: '补充原文' }], answer: scenario === 'chapter' ? '第5章' : '原文是“门开了。”', source: 'legacy_question' })).toBeTruthy()
    await expect(assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, options)).resolves.toBeUndefined()
    expect(runtimeJson(f.admission).hash).toBe(originalHash)
    expect(f.create).toHaveBeenCalledOnce()
    if (scenario === 'quote') {
      await expect(assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation: 'replace', after })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
      await expect(assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, { mutation: 'range', after: '越界改动。',
        editRanges: [{ start: 0, end: 1, newText: '越' }] })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    }
    f.run.manuscriptRevision++
    await expect(assertChapterManuscriptRevision(f.tx, f.subject, f.chapter, options)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  })
})
