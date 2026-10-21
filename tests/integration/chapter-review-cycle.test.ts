import { createHash } from 'node:crypto'
import { saveSyntheticTerminalReview } from '../support/terminal-review-fixture.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { describe, expect, it } from 'vitest'
import { fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { assertChapterManuscriptRevision, readChapterReviewReadiness, recordChapterReviewDecisions, readChapterReviewWriteAdmission } from '../../api/lib/agent/chapter-review-guard.js'
import { prepareStoryCompilation, recordStoryCompilerWrite, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'
import { readReviewCycle } from '../../api/lib/agent/review-cycle.js'
import { projectCurrentReviewNextStep } from '../../api/lib/agent/review-dispatch.js'
import { assertCompletedWritingDelivery, readCompletedWritingDelivery } from '../../api/lib/agent/writing-scope.js'
import { chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const sha = (content: string) => createHash('sha256').update(content).digest('hex')
// Mandatory PostgreSQL contracts: no skip/availability gate. Local unavailable
// PostgreSQL is not passing evidence; these run on the whole same-SHA CI gate.
describe('chapter review cycle persisted CAS and reprepare', () => {
  it.each(['legacy', 'durable'] as const)('delivers a retained final assessment after ordinary r4 to r7 edits, then preserves %s cycle on reprepare', async protocol => fixture(async f => {
    const chapterId = f.chapterId
    const body = '门锁仍在。屋里没有灯。她没有回答。'
    if (protocol === 'legacy') {
      const spec = structuredClone(f.spec); delete spec.scope.reviewProtocol
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0,
        taskSpec: JSON.parse(JSON.stringify(spec)), startRequest: { prompt: '修改第一章，只要标题和正文。' } } })
    }
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
    const originalBefore = await prisma.$transaction(tx => readOriginalTaskRequest(tx, f))
    const budgetBefore = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })
    const billingBefore = await prisma.aiUsageLog.count({ where: { agentRunId: f.runId } })
    await prisma.chapter.update({ where: { id: chapterId }, data: { content: body, revision: 4, wordCount: body.length } })
    const input = { ...f, chapterId, mode: 'balanced' as const, intentSummary: '修改本章' }
    const prepared = await prepareStoryCompilation(input)
    await saveSceneTasks({ ...f, compilationId: prepared.compilation.id, tasks: [{ purpose: '合成场景', entryState: { action: '进屋' },
      goal: '核对门锁', obstacle: '灯灭了', choice: '等她回应', cost: '失去时间', turn: '灯光亮起', exitState: { action: '等回应' },
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const assess = async (compilationId: string, evidence: string, signal = 'emotion_grounding') => {
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })
      await saveSyntheticTerminalReview(f, compilationId, terminalCandidateSchema.parse({ exitState: { action: '等待回应', location: '门口' }, lastUnfinishedAction: '等待她回应' }))
      await prisma.chapterQualityReport.create({ data: { ...{ userId: f.userId, novelId: f.novelId, runId: f.runId }, compilationId,
        chapterId, chapterRevision: chapter.revision, status: 'needs_repair', deterministicMetrics: { independentCheck: 'complete', contentHash: sha(chapter.content) },
        findings: { create: [{ userId: f.userId, novelId: f.novelId, signal, source: 'critic', severity: 'advisory',
          startOffset: chapter.content.indexOf(evidence), endOffset: chapter.content.indexOf(evidence) + evidence.length,
          evidenceExcerpt: evidence, evidenceHash: sha(evidence), explanation: '合成建议', suggestion: '考虑更多动作', confidence: 0.9 }] } } })
    }
    await assess(prepared.compilation.id, '屋里没有灯', 'description_load')
    const mutate = (revision: number, after: string, apply = true) => prisma.$transaction(async tx => {
      const before = await tx.chapter.findUniqueOrThrow({ where: { id: chapterId } })
      const changed = before.content !== after
      const callback = await assertChapterManuscriptRevision(tx, f, { id: chapterId, revision }, { mutation: 'replace', after })
      if (apply && changed) {
        const written = await tx.chapter.updateMany({ where: { id: chapterId, revision }, data: { content: after, revision: { increment: 1 } } })
        expect(written.count).toBe(1)
      }
      await callback?.()
      if (apply) expect((await tx.chapter.findUniqueOrThrow({ where: { id: chapterId } })).content).toBe(after)
      if (apply && changed) await recordStoryCompilerWrite({ ...f, chapterId, chapterOrderIndex: 1, chapterRevision: revision + 1 }, tx)
    })
    const compilationBefore = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })
    await expect(mutate(4, body + '未保存。', false)).rejects.toMatchObject({ code: 'CHAPTER_REVISION_CONFLICT' })
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })).preparedContext).toEqual(compilationBefore.preparedContext)
    await mutate(4, body.replace('屋里没有灯', '屋里灯亮着'))
    await mutate(5, body.replace('门锁仍在', '门锁还在').replace('屋里没有灯', '屋里灯亮着'))
    const finalBody = body.replace('门锁仍在', '门锁还在').replace('屋里没有灯', '灯光落在桌上')
    await mutate(6, finalBody)
    expect(finalBody).not.toContain('屋里没有灯')
    const original = await prisma.$transaction(tx => readOriginalTaskRequest(tx, f))
    const scope = { taskId: original.taskId, userId: f.userId, novelId: f.novelId, chapterId }
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })
    const cycle = readReviewCycle(saved.preparedContext, scope)!
    expect(cycle.baseline?.body.revision).toBe(4)
    expect(cycle.baseline?.findings[0]).toMatchObject({ explanation: expect.any(String), suggestion: expect.any(String) })
    expect(cycle.transitions.map(step => step.after.revision)).toEqual([5, 6, 7])
    await mutate(7, finalBody)
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })).preparedContext).toEqual(saved.preparedContext)
    await assess(prepared.compilation.id, '灯光落在桌上')
    const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f))
    expect(projectCurrentReviewNextStep(readiness!)).toMatchObject({ phase: 'verification', state: 'decision_required',
      reviewCycle: { findings: [expect.objectContaining({ relation: 'new_advisory' })] } })
    const ref = readiness!.requiredDecisions![0]
    // Real complete final reports close the original ordinary writing stage,
    // even when an old v1 snapshot lacks the newly explicit phase marker.
    await expect(mutate(7, finalBody.replace('灯光落在桌上', '灯光照着桌面'))).rejects.toMatchObject({ code: 'REVIEW_CYCLE_DECISION_REQUIRED' })
    await prisma.$transaction(async tx => {
      // Same transaction locking contract as terminal decisions.
      await tx.$queryRaw`SELECT id FROM story_compilations WHERE id = ${prepared.compilation.id} FOR UPDATE`
      await recordChapterReviewDecisions(tx, f, readiness!, [{ ...ref, reason: '保留灯光落点以呼应门口视线，不额外添加动作。' }])
    })
    expect((await prisma.$transaction(tx => readChapterReviewReadiness(tx, f)))?.decisionPending).toBe(false)
    // Retention alone is not delivery. Exercise the actual terminal tool and
    // current delivery proof; do not stop the lifecycle at decisionPending=false.
    expect(await prisma.$transaction(tx => readCompletedWritingDelivery(tx, f))).toBeNull()
    const finalReport = await prisma.chapterQualityReport.findFirstOrThrow({ where: { compilationId: prepared.compilation.id,
      chapterRevision: 7 }, include: { findings: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    const reportBeforeCommit = structuredClone(finalReport)
    const ctx: ToolContext = { userId: f.userId, novelId: f.novelId, runId: f.runId, sessionId: f.sessionId, chapterId,
      callId: `commit-${protocol}`, mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
      signal: new AbortController().signal, emit: () => {} }
    const committed = await chapterBridgeCommitTool.execute(ctx, { compilationId: prepared.compilation.id,
      chapterSummary: '她站在门口，灯光落在桌上，保持沉默。', lastUnfinishedAction: '等待她回应',
      exitState: { action: '等待回应', location: '门口', knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
      hookDecision: '', delayedHookReason: '', openingStructure: '核对门锁', endingStructure: '保留沉默' })
    expect(committed.outcome).not.toBe('failed')
    expect(committed.requiredResult).toMatchObject({ targetId: chapterId })
    expect(committed.display).toMatchObject({ kind: 'storyCompiler', phase: 'commit' })
    const terminal = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id }, include: { bridge: true } })
    expect(terminal).toMatchObject({ status: 'completed', stage: 'commit', bridge: { targetRevision: 7, toChapterId: chapterId } })
    expect(terminal.bridge?.committedAt).toBeInstanceOf(Date)
    expect(terminal.validation).toMatchObject({ independentCheck: 'complete', checkedRevision: 7, autoRepairRounds: 0,
      retainedReviewDecision: { revision: 7, findings: [{ ...ref, reason: '保留灯光落点以呼应门口视线，不额外添加动作。' }] } })
    expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: finalReport.id }, include: { findings: true } })).toEqual(reportBeforeCommit)
    expect(finalReport.status).toBe('needs_repair')
    expect(finalReport.repairRound).toBe(0)
    expect(finalReport.findings.every(item => item.disposition === 'pending')).toBe(true)
    const delivered = await prisma.$transaction(tx => readCompletedWritingDelivery(tx, f))
    expect(delivered).toMatchObject({ titleAndBodyOnly: true, chapters: [{ id: chapterId, revision: 7, content: finalBody }],
      text: `原章\n\n${finalBody}` })
    await prisma.$transaction(tx => assertCompletedWritingDelivery(tx, f, delivered!))
    expect(await prisma.chapterQualityReport.findMany({ where: { compilationId: prepared.compilation.id },
      select: { chapterRevision: true }, orderBy: { chapterRevision: 'asc' } })).toEqual([{ chapterRevision: 4 }, { chapterRevision: 7 }])
    expect(await prisma.$transaction(tx => readOriginalTaskRequest(tx, f))).toEqual(originalBefore)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } })).toEqual(budgetBefore)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: f.runId } })).toBe(billingBefore)
    const rePrepared = await prepareStoryCompilation(input)
    const carried = readReviewCycle(rePrepared.compilation.preparedContext, scope)!
    expect(carried.baseline).toEqual(cycle.baseline)
    expect(carried.transitions).toEqual(cycle.transitions)
    expect(carried.verificationStarted).toEqual(cycle.transitions.at(-1)!.after)
    expect(await prisma.$transaction(tx => readChapterReviewWriteAdmission(tx, f, { chapterId, revision: 7,
      after: finalBody.replace('灯光落在桌上', '灯光照着桌面') }))).toMatchObject({ kind: 'decision_required' })
    expect((await prisma.$transaction(tx => readChapterReviewReadiness(tx, f)))?.ready).toBe(false)
  }, undefined, '修改第一章，只要标题和正文。', { freezeWriting: true }))
  it('records exactly one concurrent CAS and preserves unrelated prepared context', async () => fixture(async f => {
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
    const prepared = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: '修改本章' })
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    // No report exists yet. Writers retain authority; no assessed baseline is
    // invented from the compilation or the winning write.
    const writes = await Promise.allSettled(['原文甲', '原文乙'].map(after => prisma.$transaction(async tx => {
      const callback = await assertChapterManuscriptRevision(tx, f, chapter, { mutation: 'replace', after })
      const saved = await tx.chapter.updateMany({ where: { id: chapter.id, revision: chapter.revision }, data: { content: after, revision: { increment: 1 } } })
      expect(saved.count).toBe(1)
      await callback?.()
    })))
    expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const failed = writes.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason).toMatchObject({ code: 'CHAPTER_REVISION_CONFLICT' })
    const current = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })
    expect(current.preparedContext).toEqual(prepared.compilation.preparedContext)
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).revision).toBe(chapter.revision + 1)
  }))
})
