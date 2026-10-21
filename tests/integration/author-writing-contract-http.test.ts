import { createHash, randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../api/lib/agent/loop.js', () => ({ executeAgentRun: vi.fn(async () => {}) }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: vi.fn(async () => {}), getModelTierRuntime: vi.fn(async () => ({ reasoningEffort: 'high' })) }))
vi.mock('../../api/lib/agent/writing-experiments.js', () => ({ recordSevenDayContinuation: vi.fn(async () => {}) }))
import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import { lockNovelActiveScope } from '../../api/lib/data/novel-write-lock.js'
import { chapterEditRangeTool, chapterWriteTool, chapterAppendTool, chapterCreateTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { chapterBridgeGetTool, chapterBridgeCommitTool, storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { freezeWritingScope, readWritingScope } from '../../api/lib/agent/writing-scope.js'
import { taskSpecSchema } from '../../shared/contracts/index.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { askUserTool } from '../../api/lib/agent/tools/interact-tools.js'
import * as questionPermissions from '../../api/lib/agent/permissions.js'
import { resolveLoopRunQuestion } from '../../api/lib/agent/run-service.js'
import { shortSceneRequest, firstChapterAnswer, placementQuestion } from '../support/writing-clarification-fixture.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { buildHumanityQualityContext, qualityReviewContextHash } from '../../api/lib/agent/humanity-quality.js'
import { assertChapterReviewRevision, readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { saveSceneTasks, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { terminalEvidenceContext, terminalQuoteAddressVersion } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(() => prisma.$disconnect())
afterEach(() => vi.unstubAllGlobals())
const body = '钟声传来。甲说：“向左走。”乙听后却向右转。两人留在长廊，门还没开。'
const concerns = '已确认本章有动作方向冲突：甲说“向左走。”，紧接着却写“向右转”。请以最小改动让指令与动作一致。不新增设定。“钟声传来”保持不变。完成正常连续性和人类感检查。'
const requests = [
  '请只对第二卷第2章当前已保存正文做一次局部修订，不续写、不新建章节，不修改第1、2、3章。',
  '第二卷第2章当前已存正文，请做一次局部修订。先读取第1章作为参考，不修改第1、2、3章。',
  '先通读前两章；对第二卷第2章的正文进行局部修订，不修改前3章，不新建章节。',
]

async function fixture(prompt: string, work: (ctx: ToolContext, before: Awaited<ReturnType<typeof prisma.chapter.findMany>>) => Promise<void>, duplicate = false, targetBody = body) {
  const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID()
  try {
    vi.stubGlobal('fetch', vi.fn(() => { throw Error('No Provider allowed in synthetic admission test') }))
    await prisma.user.create({ data: { id: userId, nickname: 'synthetic-author-contract', passwordHash: 'test-only' } })
    await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '合成契约作品', slug: randomUUID(), summary: '' } })
    const volumes = []
    for (const orderIndex of [1, 2]) volumes.push(await prisma.volume.create({ data: { novelId, title: `合成卷${orderIndex}`, orderIndex } }))
    for (const orderIndex of [1, 2, 3, 4]) await prisma.chapter.create({ data: { novelId, authorId: userId,
      volumeId: volumes[orderIndex <= 2 ? 0 : 1].id, title: `合成章${orderIndex}`, orderIndex,
      orderInVolume: orderIndex <= 2 ? orderIndex : orderIndex - 2, revision: 4,
      content: orderIndex === 4 ? targetBody + (duplicate ? '又向右转。' : '') : `前章合成正文${orderIndex}。` } })
    const before = await prisma.chapter.findMany({ where: { novelId }, orderBy: { orderIndex: 'asc' } })
    await prisma.agentSession.create({ data: { id: sessionId, novelId, userId, title: '合成局部任务' } })
    const response = await request(app).post('/api/agent/runs')
      .set('Cookie', `chevoink_session=${buildSessionTokens(userId, 0).accessToken}`)
      .send({ novelId, sessionId, chapterId: before[0].id, prompt, mode: 'build' })
    expect(response.status).toBe(200)
    const runId = response.body.data.runId as string
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
    await work({ userId, novelId, sessionId, runId, chapterId: before[0].id, callId: 'synthetic-contract', mode: 'build',
      creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal }, before)
    expect(await prisma.aiUsageLog.count({ where: { userId } })).toBe(0)
    expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    await prisma.$transaction(async tx => {
      await lockNovelActiveScope(tx, novelId)
      await tx.memoryExtractionJob.deleteMany({ where: { novelId } })
      await tx.projectMemoryEntry.deleteMany({ where: { novelId } })
      await tx.agentArtifact.deleteMany({ where: { run: { userId, novelId } } })
      await tx.agentRun.deleteMany({ where: { userId } })
      await tx.agentSession.deleteMany({ where: { userId } })
      await tx.chapter.deleteMany({ where: { novelId, authorId: userId } })
      await tx.novel.deleteMany({ where: { id: novelId, authorId: userId } })
      await tx.user.deleteMany({ where: { id: userId } })
    })
  }
}
const prepare = (ctx: ToolContext) => storyCompilerPrepareTool.execute(ctx, { targetOrderIndex: 4,
  intentSummary: '只对第四个已存合成章作作者指出的局部修订', volumeDecision: { kind: 'continue', reason: '原卷原章' } })

describe.skipIf(!available)('unified fresh HTTP author contract with actual PostgreSQL writes', () => {
  const reviewRequests = [
    '请读取《合成契约作品》第二卷第2章《合成章4》当前已保存正文并完成本章检查和提交，不续写、不新建章节、不修改第1至3章。当前指令已为“向左走”，无需还原旧句。请基于当前版本做完整连续性与人类感检查；如有确证问题，只对本章必要位置做局部修订并复检，保持其他情节。终态应对应两人留在长廊、门尚未打开；其余设定保持。最终以当前正文真实提交章节桥与故事终态，确认保存后自然结束。',
    '先读取第4章当前已存正文，完成本章检查和提交。请先做连续性与人类感检查；如有必要，只对本章做局部修订并复检。不新建章节，不修改前3章。',
    'Read chapter 4 and review current chapter. If review finds confirmed issues, revise current chapter passage. Do not create chapters or edit chapter 1 to 3.',
  ]
  it.each(reviewRequests)('admits review before findings exist while denying unproven edits: %s', prompt => fixture(prompt, async (ctx, before) => {
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
    expect(spec.scope.writing).toMatchObject({ kind: 'bounded', repairAuthorized: false, targets: [{ chapterId: before[3].id }] })
    expect(spec.scope.localEditBoundary).toMatchObject({ version: 3, kind: 'review_bound', regions: [{ chapterId: before[3].id, revision: 4 }] })
    expect(spec.scope.writing?.targets).toHaveLength(1)
    expect((await prepare(ctx)).outcome).not.toBe('failed')
    for (const chapterId of [before[3].id, before[0].id]) await expect(chapterEditRangeTool.execute(ctx,
      { chapterId, oldText: chapterId === before[3].id ? '向左走' : before[0].content, newText: '未经证实' }))
      .rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    await expect(chapterWriteTool.execute(ctx, { chapterId: before[3].id, content: '整章覆盖' })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    await expect(prisma.$transaction(tx => assertChapterReviewRevision(tx, ctx, before[3])))
      .rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
  }))
  it.each(['不要修改本章。', '本章不得修改。', '不修改这章。', '本章保持不变。'])(
    'preserves a resolved same-target prohibition without isolated exclusion reparsing: %s', denial => fixture(reviewRequests[1] + denial, async (ctx, before) => {
      const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
      expect(spec.scope.writingInterpretation?.revisionDenied).toBe(true)
      expect(spec.scope.writing?.kind).toBe('needs_input')
      await expect(prepare(ctx)).rejects.toMatchObject({ code: expect.stringMatching(/SCOPE_NEEDS_INPUT|AUTHOR_LOCAL_SCOPE/) })
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    }))
  it.each([false, true])('completes current checks and real commit with conditional repair=%s, preserving prior chapters', repair => fixture(reviewRequests[0], async (ctx, before) => {
    expect((await prepare(ctx)).outcome).not.toBe('failed')
    const compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { runId: ctx.runId } })
    expect(await chapterBridgeGetTool.execute(ctx, {})).toMatchObject({ display: { title: '章节桥 · 入章承接' } })
    await saveSceneTasks({ ...ctx, compilationId: compilation.id, tasks: [{ purpose: '核对现有场景', entryState: { location: '长廊' },
      goal: '等待门开', obstacle: '门关着', choice: '等候', cost: '时间流逝', turn: '听见指令', exitState: { location: '长廊' },
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const candidate = terminalCandidateSchema.parse({ exitState: { location: '长廊' }, lastUnfinishedAction: '' })
    const assess = async (finding: boolean) => {
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
      const source = await readCompilerContinuitySource(prisma, ctx, chapter, saved.bridge!.fromChapterId, 11)
      const original = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
      const evidence = terminalEvidenceContext(chapter, source, 2, terminalQuoteAddressVersion(original))
      // Synthetic provider RESPONSE only; exercise the actual fresh producer /
      // parser / coverage / commit contract without a provider dispatch.
      const response = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear',
        reason: '不同人物的行动不构成同对象矛盾，两人仍在长廊。', findingIndexes: [] })),
      terminalVerdicts: [{ path: 'exitState.location', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: '两人留在长廊' }] }] })
      const inspected = inspectContinuityResponse(response, { previous: source?.content ?? null, current: chapter.content, terminalEvidence: evidence }, true, 8, candidate)
      expect(inspected.complete).toBe(true)
      const coverage = compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source, terminalCandidate: candidate }, 11)
      const validation = await validateStoryContinuity({ ...ctx, compilationId: compilation.id, findings: [], independentCheck: 'complete', coverage, terminalCandidate: candidate })
      expect(validation.errorCount).toBe(0)
      await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({ ...validation, continuityCriticResponse: inspected.audit }).value } })
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation)
        .toMatchObject({ coverage: { protocolVersion: 11 }, continuityCriticResponse: { parserVersion: 8, terminalEvidence: { quoteAddressProtocol: 1 } } })
      const context = await buildHumanityQualityContext(ctx.userId, ctx.novelId, chapter.id, ctx.runId)
      const text = '向左走', start = chapter.content.indexOf(text)
      const sha = (content: string) => createHash('sha256').update(content).digest('hex')
      await prisma.chapterQualityReport.create({ data: { userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId,
        compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision, status: finding ? 'needs_repair' : 'passed',
        deterministicMetrics: { independentCheck: 'complete', contentHash: sha(chapter.content), qualityContextHash: qualityReviewContextHash(context) },
        ...(finding ? { findings: { create: [{ userId: ctx.userId, novelId: ctx.novelId, source: 'critic', signal: 'action_consistency', severity: 'error',
          startOffset: start, endOffset: start + text.length, evidenceExcerpt: text, evidenceHash: sha(text), explanation: '方向需统一', suggestion: '只改方向', confidence: 0.9 }] } } : {}) } })
    }
    await assess(repair)
    if (repair) {
      const report = await prisma.chapterQualityReport.findFirstOrThrow({ where: { compilationId: compilation.id }, include: { findings: true } })
      const originalMetrics = report.deterministicMetrics as Record<string, string>
      for (const scenario of ['hash', 'context', 'failed', 'different-compilation'] as const) {
        await prisma.chapterQualityReport.update({ where: { id: report.id }, data: scenario === 'failed' ? { status: 'failed' }
          : scenario === 'different-compilation' ? { compilationId: null }
            : { deterministicMetrics: { ...originalMetrics, [scenario === 'hash' ? 'contentHash' : 'qualityContextHash']: '0'.repeat(64) } } })
        await expect(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '向左走', newText: '向右走' }))
          .rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })).toEqual(before[3])
        await prisma.chapterQualityReport.update({ where: { id: report.id }, data: { status: report.status, deterministicMetrics: originalMetrics, compilationId: compilation.id } })
      }
      await prisma.qualityFinding.update({ where: { id: report.findings[0].id }, data: { evidenceHash: '0'.repeat(64) } })
      await expect(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '向左走', newText: '向右走' }))
        .rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
      await prisma.qualityFinding.update({ where: { id: report.findings[0].id }, data: { evidenceHash: report.findings[0].evidenceHash } })
      await expect(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '门还没开', newText: '门已打开' }))
        .rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
      expect((await chapterEditRangeTool.execute({ ...ctx, callId: 'conditional-actual-range' },
        { chapterId: before[3].id, oldText: '向左走', newText: '向右走' })).outcome).not.toBe('failed')
      await expect(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '向右走', newText: '往右走' }))
        .rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
      await assess(false)
    }
    expect((await prisma.$transaction(tx => readChapterReviewReadiness(tx, ctx)))?.ready).toBe(true)
    const result = await chapterBridgeCommitTool.execute({ ...ctx, callId: 'conditional-real-commit' }, { compilationId: compilation.id,
      chapterSummary: '两人仍在长廊等待。', exitState: candidate.exitState, lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '',
      openingStructure: '钟声', endingStructure: '等待' })
    expect(result.outcome).not.toBe('failed')
    const final = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })
    expect(final).toMatchObject({ status: 'completed', stage: 'commit', bridge: { toChapterId: chapter.id, targetRevision: chapter.revision } })
    expect(final.bridge?.committedAt).toBeInstanceOf(Date)
    expect(await chapterBridgeGetTool.execute(ctx, {})).toMatchObject({ display: { title: '章节桥 · 已提交终态' } })
    expect(chapter.content).toBe(repair ? body.replace('向左走', '向右走') : body)
    expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(0, 3).map(item => item.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(0, 3))
  }))
  it('reads an unprepared task as an explicit empty state without adopting a historical compilation', () => fixture(requests[0] + concerns, async (ctx, before) => {
    expect(await chapterBridgeGetTool.execute(ctx, {})).toMatchObject({ summary: '本任务尚未建立章节桥' })
    expect((await chapterBridgeGetTool.execute(ctx, {})).outcome).not.toBe('failed')
    expect(await chapterBridgeGetTool.execute(ctx, { compilationId: 'missing-explicit-id' }))
      .toMatchObject({ outcome: 'failed', failureCode: 'COMPILATION_NOT_FOUND' })
    expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    expect((await prepare(ctx)).outcome).not.toBe('failed')
  }))
  it.each(requests)('binds a qualified chapter and two local islands without touching read-context chapters: %s', start => fixture(start + concerns, async (ctx, before) => {
    const original = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
    expect(original).toMatchObject({ intent: 'revise', scope: { writingTargetProtocol: 2, terminalQuoteAddressProtocol: 1,
      writing: { kind: 'bounded', targets: [{ chapterId: before[3].id, orderIndex: 4, volumeId: before[3].volumeId, positionInVolume: 2 }] },
      writingInterpretation: { version: 2, intent: 'revise', excludedChapterIds: expect.arrayContaining(before.slice(0, 3).map(chapter => chapter.id)) },
      localEditBoundary: { version: 2, kind: 'bounded', regions: [{ text: '向左走。' }, { text: '向右转' }] } } })
    expect(original.scope.writing?.targets).toHaveLength(1)
    expect((await prepare(ctx)).outcome).not.toBe('failed')
    const first = await chapterEditRangeTool.execute({ ...ctx, callId: 'first-local-patch' },
      { chapterId: before[3].id, oldText: '向左走。', newText: '请向右走。' })
    expect(first.outcome).not.toBe('failed')
    const second = await chapterEditRangeTool.execute({ ...ctx, callId: 'second-local-patch' },
      { chapterId: before[3].id, oldText: '向右转', newText: '往右侧走' })
    expect(second.outcome).not.toBe('failed')
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })).content)
      .toBe(body.replace('向左走。', '请向右走。').replace('向右转', '往右侧走'))
    expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(0, 3).map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(0, 3))
    const saved = await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })
    expect(await prisma.$transaction(tx => freezeWritingScope(tx, ctx, original, '重写全书', 2))).toEqual(original)
    expect((await prisma.$transaction(tx => readWritingScope(tx, ctx))).writing).toEqual(original.scope.writing)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec).toEqual(saved.taskSpec)
  }))
  it.each(['cross-gap', 'whole', 'append', 'growth', 'prior', 'create'] as const)('denies %s without any partial chapter or compilation effect', kind => fixture(requests[0] + concerns, async (ctx, before) => {
    const target = before[3]
    const action = kind === 'whole' ? chapterWriteTool.execute(ctx, { chapterId: target.id, content: '替换全章。' })
      : kind === 'append' ? chapterAppendTool.execute(ctx, { chapterId: target.id, content: '新尾段。' })
      : kind === 'create' ? chapterCreateTool.execute(ctx, { title: '新第五章', volumeOrder: 2, positionInVolume: 3 })
      : chapterEditRangeTool.execute(ctx, { chapterId: kind === 'prior' ? before[0].id : target.id,
        oldText: kind === 'prior' ? before[0].content : kind === 'cross-gap' ? '向左走。”乙听后却向右转' : '向右转',
        newText: kind === 'growth' ? '整章内容'.repeat(300) : '未授权改动' })
    await expect(action).rejects.toMatchObject({ code: kind === 'create' ? 'AUTHOR_CHAPTER_SCOPE' : 'AUTHOR_LOCAL_SCOPE' })
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
  }))
  it.each(['“向左走。”', '甲说：“向左走。”乙听后却向右转。'])(
    'authenticates copied context while permitting only its actual frozen-island change: %s', oldText => fixture(requests[0] + concerns, async (ctx, before) => {
      await prepare(ctx)
      expect((await chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText, newText: oldText.replace('左', '右') })).outcome).not.toBe('failed')
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })).content).toBe(body.replace('左', '右'))
      expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(0, 3).map(c => c.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(0, 3))
    }))
  it('permits insertion and deletion inside a frozen quote without granting its enclosing punctuation', () => fixture(requests[0] + concerns, async (ctx, before) => {
    for (const [oldText, newText] of [['“向左走。”', '“请向左走。”'], ['“请向左走。”', '“向左走。”']]) {
      expect((await chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText, newText })).outcome).not.toBe('failed')
    }
    const current = await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })
    expect(current).toMatchObject({ content: body, revision: before[3].revision + 2 })
    await expect(chapterEditRangeTool.execute(ctx, { chapterId: current.id, oldText: '“向左走。”', newText: '「向左走。」' }))
      .rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: current.id } })).toEqual(current)
    expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(0, 3).map(c => c.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(0, 3))
  }))
  it.each(['insert', 'replace'] as const)('applies adjacent original anchors with one canonical local effect: %s', kind => fixture(requests[0] + concerns, async (ctx, before) => {
    expect((await chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, patches: [
      { oldText: '甲说：“向', newText: '甲说：“向请' },
      { oldText: '左走。”乙听后却向右转', newText: `${kind === 'insert' ? '右左' : '右'}走。”乙听后却向右转` },
    ] })).outcome).not.toBe('failed')
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })).content)
      .toBe(body.replace('向左走', kind === 'insert' ? '向请右左走' : '向请右走'))
    expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(0, 3).map(c => c.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(0, 3))
  }))
  it.each(['只补写第4章第二段', '只补齐第4章第二段', '请只补写第4章当前正文的第二段'])(
    'keeps write-family paragraph work local through actual HTTP admission: %s', prompt => fixture(prompt, async (ctx, before) => {
      const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
      expect(spec.scope.localEditBoundary).toMatchObject({ kind: 'bounded', regions: [{ chapterId: before[3].id, start: 4, end: 7 }] })
      await expect(chapterWriteTool.execute(ctx, { chapterId: before[3].id, content: '不得扩大为整章替换。' })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect((await chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '第二段', newText: '第二段修正' })).outcome).not.toBe('failed')
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })).content).toBe('第一段\n第二段修正\n第三段')
      expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(0, 3).map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(0, 3))
    }, false, '第一段\n第二段\n第三段'))
  it('uses only the authenticated source quote for a real local transform', () => fixture(
    '第二卷第2章正文，将“源短句”改为“新短句”。', async (ctx, before) => {
      const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
      expect(spec.scope.localEditBoundary).toMatchObject({ kind: 'bounded', regions: [{ chapterId: before[3].id, start: 3, end: 6 }] })
      await expect(chapterWriteTool.execute(ctx, { chapterId: before[3].id, content: '不得扩大为全章。' })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
      expect((await chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '源短句', newText: '新短句' })).outcome).not.toBe('failed')
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })).content).toBe('前段。新短句尾。后段。')
      expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(0, 3).map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(0, 3))
    }, false, '前段。源短句尾。后段。'))
  it.each(['禁止修订“源短句”。', '“源短句”，保持不变。', '“短句尾”，保持不变。', '不要修改第二段。'])(
    'preserves local protection during a real source transform: %s', protection => fixture(
      '第二卷第2章正文，将“源短句”改为“新短句”。' + protection, async (ctx, before) => {
        const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
        expect(spec.scope.localEditBoundary).toMatchObject({ kind: 'needs_input', regions: [] })
        await expect(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '源短句', newText: '新短句' })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
        expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
        expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
      }, false, '前段。源短句尾。后段。'))
  it.each(['修订“原短句', '修订"原短句', "修订'原短句", '修订“外“内”尾',
    '修订第4章的“原短句', '修改第4章“原短句', '修订第4章。将“原短句',
    '修订第4章参考文案中的“原短句', '修订第4章中的参考原文“原短句', '修订“尾”。禁止修订参考原文“保护句尾',
    '修订“尾”。禁止修订“保护句尾', '修订“尾”。禁止修订"保护句尾', "修订“尾”。禁止修订'保护句尾"])(
    'rejects unclosed source or protection without a shortened saved-body grant: %s', request => fixture(
      '第二卷第2章正文，' + request, async (ctx, before) => {
        const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
        expect(spec.scope.localEditBoundary).toMatchObject({ kind: 'needs_input', regions: [] })
        await expect(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: request.includes('保护') ? '尾' : request.includes('外') ? '外“内”' : '原短', newText: '不应执行' }))
          .rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
        expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
        expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
      }, false, '前段。原短。外“内”。保护句尾。后段。'))
  it.each(['修订第4章的“原短句”', '修订第4章参考文案中的“原短句”',
    '替换第4章中的“原短句”', '第4章中的“原短句”替换',
    '修订第4章。禁止修订“原短句”。', '修改第4章。“原短句”，保持不变。'])(
    'never discards an unresolved or protected source and retains whole-chapter authority: %s', request => fixture(
      '第二卷第2章正文，' + request, async (ctx, before) => {
        const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
        expect(spec.scope.localEditBoundary).toMatchObject({ kind: 'needs_input', regions: [] })
        await expect(chapterWriteTool.execute(ctx, { chapterId: before[3].id, content: '不能退为整章授权。' })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
        expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      }, false, '前段。原短句。后段。'))
  it('keeps the chapter identity when only its local quotation is ambiguous', () => fixture(requests[0] + concerns, async (ctx, before) => {
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
    expect(spec).toMatchObject({ ambiguity: 'must_ask', scope: { writing: { kind: 'bounded', targets: [{ chapterId: before[3].id }] },
      localEditBoundary: { kind: 'needs_input', regions: [] }, writingInterpretation: { reasons: expect.arrayContaining(['LOCAL_ANCHOR_UNRESOLVED']) } } })
    await expect(prepare(ctx)).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    await expect(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '向左走。', newText: '向右走。' }))
      .rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
  }, true))
  it.each(['完成第二卷第2章质量检查，判断是否需要局部修订。', '请阅读这句：“修改第二卷第2章”。'])(
    'does not promote review or quoted data into a chapter mutation: %s', prompt => fixture(prompt, async (ctx, before) => {
      await expect(chapterWriteTool.execute(ctx, { chapterId: before[3].id, content: '不能改写。' })).rejects.toBeTruthy()
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    }))
  it.each(['检查是否需要修改第二段。', '只检查第4章是否需要修订正文。', '请勿再修改第4章。',
    '修订第4章正文。不得修改。'])(
    'retains assessment and bare-denial boundaries through actual HTTP admission: %s', prompt => fixture(prompt, async (ctx, before) => {
      await expect(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '向右转', newText: '向左转' })).rejects.toBeTruthy()
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    }))
  it.each(['禁止修订“向左走。”。', '不调整“向左走。”。', '“向左走。”，保持不变。'])(
    'preserves a protected quotation even when the same text was cited as an issue: %s', protection => fixture(requests[0] + concerns + protection, async (ctx, before) => {
      const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
      expect(spec.scope.localEditBoundary).toMatchObject({ kind: 'needs_input', regions: [] })
      await expect(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '向左走。', newText: '向右走。' })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    }))
  it('does not create a relative next chapter when the same request forbids chapter creation', () => fixture('续写下一章，不新建章节。', async (ctx, before) => {
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
    expect(spec.scope).toMatchObject({ writing: { kind: 'needs_input', targets: [] }, writingInterpretation: { creationDenied: true } })
    await expect(chapterCreateTool.execute(ctx, { title: '不得创建', volumeOrder: 2, positionInVolume: 3 })).rejects.toMatchObject({ code: 'SCOPE_NEEDS_INPUT' })
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
  }))
  it.each(['writing', 'localEditBoundary', 'writingInterpretation'] as const)(
    'rejects a partial frozen2 projection with missing %s before prepare or writes', field => fixture(requests[0] + concerns, async (ctx, before) => {
      const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
      delete spec.scope[field]
      await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: spec } })
      await expect(prepare(ctx)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      await expect(chapterWriteTool.execute(ctx, { chapterId: before[3].id, content: '不应扩大为整章权限。' })).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    }))
  it('honors a genuine empty-book first-chapter answer without widening the frozen root', async () => {
    const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID()
    let restoreWait = () => {}
    try {
      vi.stubGlobal('fetch', vi.fn(() => { throw Error('No Provider allowed') }))
      await prisma.user.create({ data: { id: userId, nickname: 'synthetic-first-answer', passwordHash: 'test-only' } })
      await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '合成空书', slug: randomUUID(), summary: '' } })
      await prisma.volume.create({ data: { novelId, title: '第一卷', orderIndex: 1 } })
      await prisma.agentSession.create({ data: { id: sessionId, userId, novelId, title: '合成澄清' } })
      const admitted = await request(app).post('/api/agent/runs')
        .set('Cookie', `chevoink_session=${buildSessionTokens(userId, 0).accessToken}`)
        .send({ novelId, sessionId, prompt: shortSceneRequest, mode: 'build' })
      expect(admitted.status).toBe(200)
      const runId = admitted.body.data.runId as string
      const frozen = (await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).taskSpec
      expect(frozen).toMatchObject({ scope: { writingTargetProtocol: 2, writingClarificationProtocol: 1, writing: { kind: 'needs_input' } } })
      await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
      const ctx: ToolContext = { userId, novelId, sessionId, runId, chapterId: null, callId: 'true-author-answer', mode: 'build',
        qualityMode: 'premium', creativeFreedom: 'balanced', signal: new AbortController().signal, emit: () => {} }
      const wait = questionPermissions.waitForQuestionAnswer
      const waitingSpy = vi.spyOn(questionPermissions, 'waitForQuestionAnswer').mockImplementation((id, callId, timeout, signal) => {
        const pending = wait(id, callId, timeout, signal)
        return Promise.all([pending, resolveLoopRunQuestion(userId, id, callId, firstChapterAnswer)]).then(([answer]) => answer)
      })
      restoreWait = () => { waitingSpy.mockRestore() }
      expect((await askUserTool.execute(ctx, placementQuestion)).semanticTransition).toBeDefined()
      expect((await chapterCreateTool.execute({ ...ctx, callId: 'create-answered-first' }, { title: '合成第一章', volumeOrder: 1, positionInVolume: 1 })).outcome).not.toBe('failed')
      const chapter = await prisma.chapter.findFirstOrThrow({ where: { novelId, orderIndex: 1 } })
      expect((await chapterWriteTool.execute({ ...ctx, callId: 'write-answered-first' }, { chapterId: chapter.id, content: '她在门口等候。窗外天亮了。' })).outcome).not.toBe('failed')
      expect((await chapterEditRangeTool.execute({ ...ctx, callId: 'edit-answered-first' }, { chapterId: chapter.id, oldText: '窗外天亮了', newText: '窗外雨停了' })).outcome).not.toBe('failed')
      await expect(chapterCreateTool.execute({ ...ctx, callId: 'deny-second-after-answer' }, { title: '不得扩成第二章', volumeOrder: 1, positionInVolume: 2 })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).taskSpec).toEqual(frozen)
      expect(await prisma.chapter.count({ where: { novelId } })).toBe(1)
      expect(await prisma.aiUsageLog.count({ where: { userId } })).toBe(0)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      restoreWait()
      await prisma.$transaction(async tx => {
        await lockNovelActiveScope(tx, novelId)
        await tx.memoryExtractionJob.deleteMany({ where: { novelId } })
        await tx.projectMemoryEntry.deleteMany({ where: { novelId } })
        await tx.agentArtifact.deleteMany({ where: { run: { userId, novelId } } })
        await tx.agentRun.deleteMany({ where: { userId } })
        await tx.agentSession.deleteMany({ where: { userId } })
        await tx.chapter.deleteMany({ where: { novelId, authorId: userId } })
        await tx.novel.deleteMany({ where: { id: novelId, authorId: userId } })
        await tx.user.deleteMany({ where: { id: userId } })
      })
    }
  })
})
