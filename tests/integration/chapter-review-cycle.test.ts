import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { Prisma } from '@prisma/client'
import * as manuscriptScope from '../../api/lib/agent/manuscript-scope.js'
import * as featureFlags from '../../api/lib/agent2-feature-flags.js'
import { chapterWriteTool, chapterAppendTool, chapterEditRangeTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { createHash } from 'node:crypto'
import { saveSyntheticTerminalReview } from '../support/terminal-review-fixture.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { describe, expect, it, vi } from 'vitest'
import { fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { assertChapterManuscriptRevision, readChapterReviewReadiness, recordChapterReviewDecisions, readChapterReviewWriteAdmission } from '../../api/lib/agent/chapter-review-guard.js'
import { prepareStoryCompilation, recordStoryCompilerWrite, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'
import { beginReviewCycle, readReviewCycle } from '../../api/lib/agent/review-cycle.js'
import { projectCurrentReviewNextStep } from '../../api/lib/agent/review-dispatch.js'
import { assertCompletedWritingDelivery, readCompletedWritingDelivery, readRecoveredChapterDelivery } from '../../api/lib/agent/writing-scope.js'
import { chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const sha = (content: string) => createHash('sha256').update(content).digest('hex')
// Mandatory PostgreSQL contracts: no skip/availability gate. Local unavailable
// PostgreSQL is not passing evidence; these run on the whole same-SHA CI gate.
describe('chapter review cycle persisted CAS and reprepare', () => {
  it.each(['write', 'append', 'range', 'cancelled', 'changed-source'] as const)('keeps the author fence and one atomic %s body effect while old reports remain immutable', scenario => fixture(async f => {
    vi.spyOn(featureFlags, 'isAgent2FeatureEnabled').mockImplementation(name => name === 'storyCompiler')
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running', taskRootId: null, runtimeProtocolVersion: 0 } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 4, content: 'The guard waits at the door.', wordCount: 6 } })
    const previous = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId,
      title: 'Synthetic previous', content: 'The door remains closed.', revision: 2, orderIndex: 0, orderInVolume: 0 } })
    const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: 'Revise the synthetic current chapter.' })
    const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Wait', entryState: state, goal: 'Enter', obstacle: 'Door',
      choice: 'Wait', cost: 'Time', turn: 'Open', exitState: state, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    await saveSyntheticTerminalReview(f, compilation.id, terminalCandidateSchema.parse({ exitState: {} }))
    const quality = await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId, compilationId: compilation.id,
      chapterId: chapter.id, chapterRevision: chapter.revision, status: 'passed', deterministicMetrics: { independentCheck: 'complete', contentHash: sha(chapter.content) } } })
    const originalValidation = (await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation as Record<string, unknown>
    const fees = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
    const controller = new AbortController(), readFence = manuscriptScope.assertAgentManuscriptCurrent
    const scopes: unknown[] = [], elapsed: number[] = []
    const slow = ['write', 'append', 'range'].includes(scenario), writes = scenario !== 'cancelled'
    vi.spyOn(manuscriptScope, 'assertAgentManuscriptCurrent').mockImplementation(async (...args) => {
      expect(args[0]).not.toBe(prisma)
      scopes.push(args[0])
      if (scopes.length === 1) {
        const started = performance.now()
        if (slow) await args[0].$queryRaw`SELECT 1 FROM pg_sleep(5.1)`
        if (scenario === 'cancelled') controller.abort(new DOMException('Synthetic cancellation', 'AbortError'))
        if (scenario === 'changed-source') await prisma.chapter.update({ where: { id: previous.id }, data: { content: 'A changed source.', revision: { increment: 1 } } })
        elapsed.push(performance.now() - started)
      }
      return readFence(...args)
    })
    const provider = vi.fn(() => { throw Error('No provider is needed for a manuscript CAS') }); vi.stubGlobal('fetch', provider)
    const context: ToolContext = { ...f, callId: 'guarded-body-' + scenario, mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: controller.signal, emit: () => {} }
    const after = scenario === 'append' ? chapter.content + '\n\nThe door opens.' : 'The guard opens the door.'
    const effect = scenario === 'append' ? chapterAppendTool.execute(context, { chapterId: chapter.id, content: 'The door opens.' })
      : scenario === 'range' ? chapterEditRangeTool.execute(context, { chapterId: chapter.id, oldText: 'waits at', newText: 'opens' })
        : chapterWriteTool.execute(context, { chapterId: chapter.id, content: after })
    if (scenario === 'cancelled') await expect(effect).rejects.toThrow()
    else {
      expect(await effect).toMatchObject({ display: { before: chapter.content, after, revision: 5 } })
      if (slow) expect(elapsed[0]).toBeGreaterThan(5000)
      expect(scopes.length).toBeGreaterThanOrEqual(1)
      expect(scopes[0]).toBeDefined()
      expect(scopes.every(scope => scope === scopes[0])).toBe(true)
    }
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ content: writes ? after : chapter.content, revision: writes ? 5 : 4 })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
    expect((saved.validation as Record<string, unknown>).continuityReport).toEqual(originalValidation.continuityReport)
    expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: quality.id } })).toEqual(quality)
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(fees)
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(ledger)
    expect(await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })).toEqual(artifacts)
    if (scenario === 'cancelled') expect(saved.validation).toEqual(originalValidation)
    if (scenario === 'changed-source') {
      expect(await chapterBridgeCommitTool.execute({ ...context, callId: 'stale-source-cannot-commit' }, { compilationId: compilation.id }))
        .toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_CHECK_REQUIRED' })
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).committedAt).toBeNull()
    }
    expect(provider).not.toHaveBeenCalled()
  }, undefined, '修改第一章，只要标题和正文。', { freezeWriting: true }), 30000)

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
    await saveSceneTasks({ ...f, compilationId: prepared.compilation.id, tasks: [{ purpose: '合成场景', entryState: terminalCandidateSchema.parse({ exitState: { action: '进屋' } }).exitState,
      goal: '核对门锁', obstacle: '灯灭了', choice: '等她回应', cost: '失去时间', turn: '灯光亮起', exitState: terminalCandidateSchema.parse({ exitState: { action: '等回应' } }).exitState,
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
    // The report is complete; unresolved actual advice still fences delivery.
    // Ordinary author-owned edits retain their separate revision authority.
    expect(await chapterBridgeCommitTool.execute({ ...f, callId: 'pending-opinion-cannot-commit', mode: 'build',
      creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} },
    { compilationId: prepared.compilation.id })).toMatchObject({ outcome: 'failed' })
    expect(await prisma.$transaction(tx => readChapterReviewWriteAdmission(tx, f, { chapterId, revision: 7,
      after: finalBody.replace('灯光落在桌上', '灯光照着桌面') }))).toMatchObject({ kind: 'allow' })
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
    expect(committed.display).toMatchObject({ compilationId: prepared.compilation.id })
    expect(committed.display).toMatchObject({ kind: 'storyCompiler', phase: 'commit' })
    const terminal = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id }, include: { bridge: true } })
    expect(terminal).toMatchObject({ status: 'completed', stage: 'commit', bridge: { targetRevision: 7, toChapterId: chapterId } })
    expect(terminal.bridge?.committedAt).toBeInstanceOf(Date)
    expect(terminal.validation).toMatchObject({ independentCheck: 'complete', checkedRevision: 7,
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
    expect(carried.verificationStarted).toEqual(cycle.verificationStarted)
    expect(carried).toEqual(cycle)
    expect(await prisma.$transaction(tx => readChapterReviewWriteAdmission(tx, f, { chapterId, revision: 7,
      after: finalBody.replace('灯光落在桌上', '灯光照着桌面') }))).toMatchObject({ kind: 'allow' })
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


describe('retained quality binding survives real PostgreSQL row order', () => {
  it.each(['version2', 'version1-proven', 'version1-unproven'] as const)('preserves full commit and billing evidence under %s reordered reads', mode => fixture(async f => {
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
    const body = 'The guard waits at the door. The table remains dry.'
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body, revision: 4, wordCount: 10 } })
    const prepared = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: 'Modify this synthetic chapter.' })
    await saveSceneTasks({ ...f, compilationId: prepared.compilation.id, tasks: [{ purpose: 'Guard the door', entryState: terminalCandidateSchema.parse({ exitState: {} }).exitState, goal: 'Wait',
      obstacle: 'No reply', choice: 'Remain', cost: 'Time', turn: 'The room stays quiet', exitState: terminalCandidateSchema.parse({ exitState: {} }).exitState, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    await saveSyntheticTerminalReview(f, prepared.compilation.id, terminalCandidateSchema.parse({ exitState: {} }))
    const quality = await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId,
      compilationId: prepared.compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision, status: 'needs_repair',
      deterministicMetrics: { independentCheck: 'complete', contentHash: sha(body) }, findings: { create: [0, 4, 10].map((start, index) => ({
        userId: f.userId, novelId: f.novelId, source: 'critic', signal: 'emotion_grounding', severity: 'advisory', confidence: 0.9,
        evidenceExcerpt: body.slice(start, start + 8), evidenceHash: sha(body.slice(start, start + 8)), startOffset: start, endOffset: start + 8,
        explanation: 'Synthetic current advice ' + index, suggestion: 'Retain the deliberate voice', createdAt: new Date(1), updatedAt: new Date(1) })) } }, include: { findings: { orderBy: { id: 'asc' } } } })
    const current = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, prepared.compilation.id))
    expect(current).toMatchObject({ ready: true, decisionPending: true, decisionBinding: { qualityReportHashVersion: 2 } })
    const original = await prisma.$transaction(tx => readOriginalTaskRequest(tx, f))
    const scope = { taskId: original.taskId, userId: f.userId, novelId: f.novelId, chapterId: chapter.id }
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM story_compilations WHERE id = ${prepared.compilation.id} FOR UPDATE`
      await recordChapterReviewDecisions(tx, f, current!, current!.requiredDecisions!.map(ref => ({ ...ref, reason: 'Keep this synthetic current opinion.' })))
      if (mode !== 'version2') {
        const saved = await tx.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })
        const cycle = beginReviewCycle(scope, { compilationId: prepared.compilation.id, revision: chapter.revision, content: body, ready: true, binding: current!.decisionBinding!, required: { continuity: true, quality: true }, findings: current!.reviewCycleFindings! }), byId = new Map(quality.findings.map(row => [row.id, row]))
        const oldHash = runtimeJson(JSON.parse(JSON.stringify(cycle.baseline!.findings.filter(row => row.source === 'quality').map(ref => byId.get(ref.findingId))))).hash
        cycle.baseline!.binding.qualityReportHash = oldHash; delete cycle.baseline!.binding.qualityReportHashVersion
        const validation = saved.validation as Record<string, unknown>, decision = validation.retainedReviewDecision as Record<string, unknown>
        decision.qualityReportHash = oldHash; delete decision.qualityReportHashVersion
        await tx.storyCompilation.update({ where: { id: saved.id }, data: { validation: validation as Prisma.InputJsonValue,
          preparedContext: { ...(saved.preparedContext as Record<string, unknown>), reviewCycle: cycle } as Prisma.InputJsonValue } })
      }
    })
    const fees = await prisma.aiUsageLog.findMany({ where: { agentRunId: f.runId }, orderBy: { id: 'asc' } })
    const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
    const result = await chapterBridgeCommitTool.execute({ ...f, callId: 'order-commit', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
      signal: new AbortController().signal, emit: () => {} }, { compilationId: prepared.compilation.id })
    expect(result.outcome).not.toBe('failed')
    expect(result.display).toMatchObject({ kind: 'storyCompiler', phase: 'commit' })
    const committed = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id }, include: { bridge: true } })
    expect(committed).toMatchObject({ status: 'completed', stage: 'commit', bridge: { targetRevision: 4 } })
    expect(committed.bridge?.committedAt).toBeInstanceOf(Date)
    const originalCapture = await prisma.$transaction(tx => readRecoveredChapterDelivery(tx, f))
    expect(originalCapture).not.toBeNull()
    if (mode === 'version1-unproven') {
      const context = { ...(committed.preparedContext as Record<string, unknown>) }; delete context.reviewCycle
      await prisma.storyCompilation.update({ where: { id: committed.id }, data: { preparedContext: context as Prisma.InputJsonValue } })
    }
    let reordered = false
    const capture = await prisma.$transaction(tx => {
      const db = new Proxy(tx, { get(target, key, receiver) {
        if (key !== 'chapterQualityReport') return Reflect.get(target, key, receiver)
        return new Proxy(target.chapterQualityReport, { get(delegate, field, inner) {
          if (field !== 'findFirst') return Reflect.get(delegate, field, inner)
          return async (...args: Parameters<typeof tx.chapterQualityReport.findFirst>) => {
            const report = await tx.chapterQualityReport.findFirst(...args)
            if (!report || !('findings' in report) || !Array.isArray(report.findings)) return report
            const rows = report.findings, refs = current!.reviewCycleFindings!.filter(ref => ref.source === 'quality')
            const byId = new Map(rows.map(row => [(row as { id: string }).id, row]))
            reordered = true
            return { ...report, findings: [...refs].reverse().map(ref => byId.get(ref.findingId)) }
          }
        } })
      } })
      return (async () => {
        const observed = await readRecoveredChapterDelivery(db, f)
        if (mode === 'version1-unproven') await expect(assertCompletedWritingDelivery(db, f, originalCapture!)).rejects.toMatchObject({ code: 'WRITING_DELIVERY_STALE' })
        else await expect(assertCompletedWritingDelivery(db, f, originalCapture!)).resolves.toBeUndefined()
        return observed
      })()
    })
    expect(reordered).toBe(true)
    if (mode === 'version1-unproven') expect(capture).toBeNull()
    else expect(capture).toMatchObject({ chapters: [{ id: chapter.id, revision: 4, content: body }] })
    expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: quality.id }, include: { findings: { orderBy: { id: 'asc' } } } })).toEqual(quality)
    expect(await prisma.aiUsageLog.findMany({ where: { agentRunId: f.runId }, orderBy: { id: 'asc' } })).toEqual(fees)
    expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(ledger)
    expect(await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })).toEqual(artifacts)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ revision: 4, content: body })
  }, undefined, '修改第一章，只输出标题和正文。', { freezeWriting: true, reviewProtocol: 1 }), 30000)
})
