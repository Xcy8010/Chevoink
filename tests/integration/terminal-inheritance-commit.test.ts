import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks, validateStoryContinuity, commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import * as memory from '../../api/lib/agent/story-memory.js'

describe.runIf(available)('inherited terminal proof at the real PostgreSQL commit boundary', () => {
  it.each(['unchanged', 'current-resolved', 'previous-edit-same-revision', 'previous-revision', 'inserted', 'archived', 'reordered', 'same-prose-new-id', 'old-protocol'] as const)(
    'preserves exact evidence and rejects stale or unsupported inheritance: %s', scenario => fixture(async f => {
      vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
      const current = await prisma.chapter.update({ where: { id: f.chapterId }, data: { orderIndex: 10, orderInVolume: 10,
        content: scenario === 'current-resolved' ? '零件已经送到，过滤泵检修完毕。' : '她拆开封条，拿走清单。', revision: 3 } })
      const previous = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: current.volumeId,
        orderIndex: 8, orderInVolume: 8, title: '合成前章', content: '过滤泵仍需检修，必须等零件送到。', revision: 6 } })
      const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: '核对当前章状态' })
      const candidate = terminalCandidateSchema.parse({ exitState: { openLoops: ['过滤泵检修等零件'] } })
      const empty = terminalCandidateSchema.parse({ exitState: {} }).exitState
      await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: '取清单', entryState: empty, goal: '取清单', obstacle: '封条',
        choice: '拆开', cost: '时间', turn: '取走', exitState: empty, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
      // The bridge has no synthetic open-loop assertion. Actual predecessor
      // prose, independently rechecked now, supplies the missing fact.
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
      const source = await readCompilerContinuitySource(prisma, f, current, saved.bridge!.fromChapterId, 10)
      const terminalEvidence = terminalEvidenceContext(current, source)
      const coverage = compilerContinuityCoverage({ chapter: current, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source, terminalCandidate: candidate }, 10)
      const raw = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind,
        result: 'not_applicable', reason: '本例独立核对持续检修事项。', findingIndexes: [] })), terminalVerdicts: [{ path: 'exitState.openLoops.0',
        verdict: scenario === 'current-resolved' ? 'negated' : 'supported', basis: 'inherited', sourceEvidence: [{ segmentId: 'p0', quote: '过滤泵仍需检修' }],
        inheritance: { priorEndState: 'established', currentState: scenario === 'current-resolved' ? 'changed' : 'unchanged' } }] })
      const inspected = inspectContinuityResponse(raw, { previous: source!.content, current: current.content, terminalEvidence }, true, 8, candidate)
      expect(inspected.complete).toBe(true)
      const result = await validateStoryContinuity({ ...f, compilationId: compilation.id, findings: [], independentCheck: 'complete', coverage, terminalCandidate: candidate })
      await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: { ...result,
        continuityCriticResponse: scenario === 'old-protocol' ? { ...inspected.audit, parserVersion: 7 } : inspected.audit } } })
      await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: current.id, chapterRevision: 3, mode: 'balanced',
        criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
      if (scenario === 'previous-edit-same-revision') await prisma.chapter.update({ where: { id: previous.id }, data: { content: '过滤泵已经修复。' } })
      if (scenario === 'previous-revision') await prisma.chapter.update({ where: { id: previous.id }, data: { revision: { increment: 1 } } })
      if (scenario === 'archived') await prisma.chapter.update({ where: { id: previous.id }, data: { archivedAt: new Date() } })
      if (scenario === 'reordered') await prisma.chapter.update({ where: { id: previous.id }, data: { orderIndex: 11, orderInVolume: 11 } })
      if (scenario === 'same-prose-new-id') await prisma.chapter.update({ where: { id: previous.id }, data: { archivedAt: new Date() } })
      if (scenario === 'inserted' || scenario === 'same-prose-new-id') await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId,
        volumeId: current.volumeId, orderIndex: 9, orderInVolume: 9, title: '新邻接章', content: previous.content, revision: previous.revision } })
      const before = await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })
      const terminal = { ...f, compilationId: compilation.id, ...candidate, chapterSummary: '取走清单。', hookDecision: '', delayedHookReason: '', openingStructure: '拆封', endingStructure: '取走' }
      if (scenario === 'unchanged') {
        await commitChapterBridge(terminal)
        const after = await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })
        expect(after.openLoops).toEqual(candidate.exitState.openLoops)
        expect(after.committedAt).not.toBeNull()
        const count = await prisma.projectMemoryEntry.count({ where: { sourceChapterId: current.id } })
        await commitChapterBridge(terminal)
        expect(await prisma.projectMemoryEntry.count({ where: { sourceChapterId: current.id } })).toBe(count)
      } else {
        await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: expect.stringMatching(/CONTINUITY_|TERMINAL_STATE_|COMPILATION_/) })
        expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).toEqual(before)
        expect(await prisma.projectMemoryEntry.count({ where: { sourceChapterId: current.id } })).toBe(0)
      }
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: current.id } })).toEqual(current)
      expect(await prisma.aiUsageLog.count({ where: { agentRunId: f.runId } })).toBe(0)
    }, undefined, '修改本章', { continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 1 }))
})
