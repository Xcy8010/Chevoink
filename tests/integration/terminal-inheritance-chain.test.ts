import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks, commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { persistCurrentContinuityReport } from '../support/current-continuity-report.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import * as memory from '../../api/lib/agent/story-memory.js'

describe.runIf(available)('serial inherited terminal facts with real PostgreSQL receipts', () => {
  it.each(['unchanged', 'root-edited', 'middle-edited', 'middle-verdict', 'inserted', 'same-prose-new-id', 'bookkeeping', 'quote-address'] as const)(
    'checks actual preceding chapters and invalidates source changes without inherited fact certification: %s', scenario => fixture(async f => {
      vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
      const initial = await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 10, orderInVolume: 10,
        content: (scenario === 'quote-address' ? '场景。'.repeat(100) : '') + '过滤泵仍需检修，必须等零件送到。', revision: 3 } })
      const candidate = terminalCandidateSchema.parse({ exitState: { openLoops: ['过滤泵检修等零件'] } })
      const empty = terminalCandidateSchema.parse({ exitState: {} }).exitState
      const chapters = [initial], compilations: string[] = []
      const terminal = (compilationId: string) => ({ ...f, compilationId, ...candidate, chapterSummary: '本章行动已完成。', hookDecision: '',
        delayedHookReason: '', openingStructure: '行动', endingStructure: '离开' })
      for (let index = 0; index < 4; index++) {
        const chapter = index === 0 ? initial : await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId,
          volumeId: initial.volumeId, orderIndex: (index + 1) * 10, orderInVolume: (index + 1) * 10,
          title: `合成承接${index}`, content: index === 1 ? '她拆开封条，取走清单。' : '她把清单交给门卫，留下收条。', revision: 3 } })
        if (index > 0) chapters.push(chapter)
        const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: '推进本章并保留未解决事项' })
        compilations.push(compilation.id)
        await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: '推进', entryState: empty, goal: '办完本章行动', obstacle: '封条',
          choice: '行动', cost: '时间', turn: '完成', exitState: empty, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
        const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
        const source = await readCompilerContinuitySource(prisma, f, chapter, saved.bridge!.fromChapterId, 11)
        const evidence = terminalEvidenceContext(chapter, source, 2, scenario === 'quote-address' ? 1 : undefined)
        const raw = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'not_applicable',
          reason: '本合成例只核对持续未解决事项。', findingIndexes: [] })), terminalVerdicts: [{ path: 'exitState.openLoops.0', verdict: 'supported',
          basis: index === 0 ? 'current' : 'inherited', sourceEvidence: [{ segmentId: index === 0 ? 'c0' : 't0', quote: '过滤泵仍需检修' }],
          ...(index === 0 ? {} : { inheritance: { priorEndState: 'established', currentState: 'unchanged' } }) }] })
        const inspected = inspectContinuityResponse(raw, { previous: source?.content ?? null, current: chapter.content, terminalEvidence: evidence }, true, 8, candidate)
        if (index === 0) expect(inspected.complete).toBe(true)
        const historical = await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: '冻结旧继承回复',
          content: raw, metadata: runtimeJson({ candidate, audit: inspected.audit }).value } })
        const { snapshot } = await persistCurrentContinuityReport({ ...f, compilationId: compilation.id, expectedChapterRevision: chapter.revision })
        expect(snapshot.previous.map(row => row.id)).toEqual(chapters.slice(0, index).reverse().slice(0, 3).map(row => row.id))
        if (scenario === 'quote-address' && index === 0) expect(snapshot.sources[0].table.entries).toContainEqual(expect.objectContaining({ start: 300,
          text: expect.stringContaining('过滤泵仍需检修') }))
        await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision,
          mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
        if (index < 3) {
          await commitChapterBridge(terminal(compilation.id))
          const committed = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
          expect(committed.preparedContext).not.toHaveProperty('terminalFactProofs')
          expect(committed.preparedContext).toMatchObject({ terminalContentHash: runtimeJson({ content: chapter.content }).hash })
          expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(historical)
          if (scenario === 'bookkeeping' && index === 2) {
            const validation = committed.validation as Record<string, unknown>
            await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({ ...validation, checkedAt: new Date().toISOString(), checkRounds: 99 }).value } })
            await commitChapterBridge(terminal(compilation.id))
          }
          continue
        }
        const before = await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })
        if (scenario === 'root-edited') await prisma.chapter.update({ where: { id: initial.id }, data: { content: '过滤泵已经检修完毕。' } })
        if (scenario === 'middle-edited') await prisma.chapter.update({ where: { id: chapters[1].id }, data: { content: '零件送到，她修好了过滤泵。' } })
        if (scenario === 'middle-verdict') {
          const middle = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilations[1] } })
          await prisma.storyCompilation.update({ where: { id: middle.id }, data: { validation: runtimeJson({ ...middle.validation as object, terminalCandidate: terminalCandidateSchema.parse({ exitState: {} }) }).value } })
        }
        if (scenario === 'same-prose-new-id') await prisma.chapter.update({ where: { id: initial.id }, data: { archivedAt: new Date() } })
        if (scenario === 'inserted' || scenario === 'same-prose-new-id') await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId,
          volumeId: initial.volumeId, orderIndex: 15, orderInVolume: 15, title: '改变邻接', content: initial.content, revision: initial.revision } })
        if (scenario === 'unchanged' || scenario === 'bookkeeping' || scenario === 'quote-address' || scenario === 'middle-verdict') await commitChapterBridge(terminal(compilation.id))
        else {
          await expect(commitChapterBridge(terminal(compilation.id))).rejects.toMatchObject({ code: expect.stringMatching(/CONTINUITY_|TERMINAL_STATE_/) })
          expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).toEqual(before)
        }
        expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(historical)
      }
      expect(await prisma.aiUsageLog.count({ where: { agentRunId: f.runId } })).toBe(0)
    }, undefined, '授权自主创作全书，并修改已有章节及卷章结构。', { freezeWriting: true, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, ...(scenario === 'quote-address' ? { terminalQuoteAddressProtocol: 1 as const } : {}) }))
})
