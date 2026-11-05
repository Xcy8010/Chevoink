import { assertOriginalAuthorContext } from '../support/original-author-context.js'
import { invokeAfterReadonlyPolicy } from '../support/readonly-policy-tool.js'
import { toolFixtureLedgerWhere } from '../support/native-tool-test-state.js'
import { expectToolDenied } from '../support/expect-tool-denied.js'
import { createHash, randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
// Admission/domain fixtures stop before async execution; the native dispatcher has its own PG matrix.
vi.mock('../../api/lib/agent/runtime-bootstrap.js', async importOriginal => ({ ...await importOriginal<typeof import('../../api/lib/agent/runtime-bootstrap.js')>(), dispatchFreshDurableRun: vi.fn(async () => {}) }))
vi.mock('../../api/lib/agent/loop.js', () => ({ executeAgentRun: vi.fn(async () => {}) }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: vi.fn(async () => {}), getModelTierRuntime: vi.fn(async () => ({ reasoningEffort: 'high', multiplierBps: 10000 })) }))
vi.mock('../../api/lib/agent/writing-experiments.js', () => ({ recordSevenDayContinuation: vi.fn(async () => {}) }))
import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import { lockNovelActiveScope } from '../../api/lib/data/novel-write-lock.js'
import { chapterEditRangeTool, chapterWriteTool, chapterAppendTool, chapterCreateTool, chapterRenameTool, preflightChapterReviewWrite } from '../../api/lib/agent/tools/chapter-tools.js'
import { chapterBridgeGetTool, chapterBridgeCommitTool, storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { freezeWritingScope, readWritingScope, assertWritingTarget, writingScopeResolvesInput } from '../../api/lib/agent/writing-scope.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { frozenWritingScopeHash } from '../../api/lib/agent/writing-contract.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import { runCheckpointSchema } from '../../api/lib/agent/checkpoint.js'
import { directoryContinuationPrompt } from '../support/writing-target-prompt.js'
import { taskSpecSchema } from '../../shared/contracts/index.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { askUserTool } from '../../api/lib/agent/tools/interact-tools.js'
import * as questionPermissions from '../../api/lib/agent/permissions.js'
import { continueLoopRun, resolveLoopRunQuestion } from '../../api/lib/agent/run-service.js'
import { shortSceneRequest, firstChapterAnswer, placementQuestion } from '../support/writing-clarification-fixture.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { buildHumanityQualityContext, qualityReviewContextHash, persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { assertChapterReviewRevision, readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { persistCurrentContinuityReport } from '../support/current-continuity-report.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { terminalEvidenceContext, terminalQuoteAddressVersion } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterSplitTool, volumeUpdateTool, volumeCreateTool } from '../../api/lib/agent/tools/structure-tools.js'
import { novelCreateTool, novelUpdateMetaTool } from '../../api/lib/agent/tools/novel-tools.js'
import { ALL_NOVEL_TAGS } from '../../shared/contracts/novel-tags.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { inspectCriticResponse } from '../../api/lib/agent/quality-evidence.js'
import { terminalCoverageInput, readTerminalCoverageState } from '../../api/lib/agent/terminal-fact-coverage.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { taskScopeBindTool } from '../../api/lib/agent/tools/task-scope-tools.js'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'

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

async function fixture(prompt: string, work: (ctx: ToolContext, before: Awaited<ReturnType<typeof prisma.chapter.findMany>>) => Promise<void>, duplicate = false, targetBody = body,
  directory?: { singleVolume: boolean; editor: 'none' | 'first'; agentWriting?: true }) {
  const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID()
  try {
    vi.stubGlobal('fetch', vi.fn(() => { throw Error('No Provider allowed in synthetic admission test') }))
    await prisma.user.create({ data: { id: userId, nickname: 'synthetic-author-contract', passwordHash: 'test-only' } })
    await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '合成契约作品', slug: randomUUID(), summary: '' } })
    const volumes = []
    for (const orderIndex of [1, 2]) volumes.push(await prisma.volume.create({ data: { novelId, title: `合成卷${orderIndex}`, orderIndex } }))
    for (const orderIndex of [1, 2, 3, 4]) await prisma.chapter.create({ data: { novelId, authorId: userId,
      volumeId: volumes[directory?.singleVolume || orderIndex <= 2 ? 0 : 1].id, title: `合成章${orderIndex}`, orderIndex,
      orderInVolume: directory?.singleVolume || orderIndex <= 2 ? orderIndex : orderIndex - 2, revision: 4,
      content: orderIndex === 4 ? targetBody + (duplicate ? '又向右转。' : '') : `前章合成正文${orderIndex}。` } })
    const before = await prisma.chapter.findMany({ where: { novelId }, orderBy: { orderIndex: 'asc' } })
    const editor = directory?.editor === 'none' ? null : before[0].id
    await prisma.agentSession.create({ data: { id: sessionId, novelId, userId, title: '合成局部任务' } })
    const response = await request(app).post('/api/agent/runs')
      .set('Cookie', `chevoink_session=${buildSessionTokens(userId, 0).accessToken}`)
      .send({ novelId, sessionId, chapterId: editor, prompt, mode: 'build', ...(directory?.agentWriting ? { agentWritingProtocol: 1 } : {}) })
    expect(response.status).toBe(200)
    const runId = response.body.data.runId as string
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
    await work({ userId, novelId, sessionId, runId, chapterId: editor, callId: 'synthetic-contract', mode: 'build',
      creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal }, before)
    expect(await prisma.aiUsageLog.count({ where: { userId } })).toBe(0)
    expect(await prisma.creditLedgerEntry.count({ where: await toolFixtureLedgerWhere(userId, { userId }) })).toBe(0)
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

describe.skipIf(!available)('fresh independent reads and effect-scoped writes over HTTP and PostgreSQL', () => {
  it.each([false, true])('keeps new draft and volume handling after model interpretation, newVolume=%s', newVolume => fixture('接上后面的剧情，写好下一章。', async (ctx, before) => {
    await taskScopeBindTool.execute(ctx, taskScopeBindTool.parameters.parse({ intent: 'write', targets: [{ orderIndex: 5 }],
      allowNewTailVolume: newVolume, requiredChecks: [] }))
    const boundary = { previousChapterId: before[3].id, previousRevision: before[3].revision, quote: before[3].content,
      completedObjective: '当前长廊情节收束', nextConflict: '进入新的场所' }
    const proposal = { title: '后续卷', summary: '承接已保存的前章，推进新困局。', boundary }
    expect((await storyCompilerPrepareTool.execute({ ...ctx, callId: 'prepare-next' }, { targetOrderIndex: 5,
      intentSummary: '只写下一章，保留全部已有正文', volumeDecision: newVolume ? { kind: 'new_volume', reason: '前章已收束原目标', newVolume: proposal }
        : { kind: 'continue', reason: '本章继续当前卷' } })).outcome).not.toBe('failed')
    let volumeId = before[3].volumeId
    if (newVolume) {
      expect((await volumeCreateTool.execute({ ...ctx, callId: 'new-tail-volume' }, { ...proposal, targetOrderIndex: 5 })).outcome).not.toBe('failed')
      volumeId = (await prisma.volume.findFirstOrThrow({ where: { novelId: ctx.novelId, title: proposal.title } })).id
    }
    expect((await chapterCreateTool.execute({ ...ctx, callId: 'create-next' }, { title: '后续章', volumeId,
      positionInVolume: newVolume ? 1 : 5 })).outcome).not.toBe('failed')
    const chapter = await prisma.chapter.findFirstOrThrow({ where: { novelId: ctx.novelId, orderIndex: 5 } })
    expect((await chapterWriteTool.execute({ ...ctx, callId: 'write-next' }, { chapterId: chapter.id, content: '她走出长廊，来到下一处门口。' })).outcome).not.toBe('failed')
    expect(await prisma.chapter.findMany({ where: { id: { in: before.map(item => item.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    await expectToolDenied(chapterCreateTool.execute({ ...ctx, callId: 'deny-sixth' }, { title: '不获授权的再下一章', position: 6 }), { code: 'AUTHOR_CHAPTER_SCOPE' })
  }, false, body, { singleVolume: true, editor: 'first', agentWriting: true }))

  it('uses the main Agent interpretation for an ordinary editor request through prepare and actual body edit', () => fixture('这一页读着像播报，把说话的劲儿调自然一点，落到稿子里。', async (ctx, before) => {
    const chapterId = before[0].id
    const original = await prisma.$transaction(tx => readOriginalTaskRequest(tx, ctx)), originalHash = runtimeJson(original).hash
    expect(taskSpecSchema.parse(original.spec).scope).toMatchObject({ agentWritingProtocol: 1 })
    expect((await storyCompilerPrepareTool.execute(ctx, { chapterId, intentSummary: '准备原章节' })).outcome).not.toBe('failed')
    const args = taskScopeBindTool.parameters.parse({ intent: 'revise', targets: [{ chapterId }], requiredChecks: [] })
    await taskScopeBindTool.execute(ctx, args)
    await taskScopeBindTool.execute({ ...ctx, callId: 'same-binding' }, args)
    expect(await prisma.agentArtifact.count({ where: { runId: original.sourceRunId, metadata: { path: ['agentWritingScopeBinding'], equals: true } } })).toBe(1)
    expect((await storyCompilerPrepareTool.execute({ ...ctx, callId: 'prepare-bound' }, { chapterId, intentSummary: '按作者要求调整已有稿的人物表达' })).outcome).not.toBe('failed')
    await chapterReadTool.execute({ ...ctx, callId: 'read-current' }, { chapterId })
    expect((await chapterEditRangeTool.execute({ ...ctx, callId: 'edit-current' }, { chapterId, oldText: '合成正文', newText: '合成对话' })).outcome).not.toBe('failed')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })).toMatchObject({ content: before[0].content.replace('合成正文', '合成对话'), revision: 5 })
    await expectToolDenied(storyCompilerPrepareTool.execute({ ...ctx, callId: 'other-chapter' }, { chapterId: before[1].id, intentSummary: '不能扩展到别章' }), { code: 'AUTHOR_CHAPTER_SCOPE' })
    await expectToolDenied(taskScopeBindTool.execute(ctx, { ...args, targets: [{ chapterId: before[1].id, preserveText: [] }] }), { code: 'TASK_SCOPE_BIND_CONFLICT' })
    expect(runtimeJson(await prisma.$transaction(tx => readOriginalTaskRequest(tx, ctx))).hash).toBe(originalHash)
    expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(1).map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(1))
  }, false, body, { singleVolume: true, editor: 'first', agentWriting: true }))

  it('lets the main Agent locate a semantic local revision and enforces its actual patch and preserved text', () => fixture('收尾这一小段处理得自然些，钟声那句留着。', async (ctx, before) => {
    const chapterId = before[3].id
    await taskScopeBindTool.execute(ctx, taskScopeBindTool.parameters.parse({ intent: 'revise', targets: [{ chapterId, preserveText: ['钟声传来'] }], locality: 'local', requiredChecks: [] }))
    await chapterReadTool.execute({ ...ctx, callId: 'read-semantic' }, { chapterId })
    expect((await storyCompilerPrepareTool.execute(ctx, { chapterId, intentSummary: '读取后定位并精确修改末段' })).outcome).not.toBe('failed')
    await chapterEditRangeTool.execute({ ...ctx, callId: 'edit-semantic' }, { chapterId, oldText: '向右转', newText: '向左转' })
    await expectToolDenied(chapterWriteTool.execute(ctx, { chapterId, content: '不能借局部要求重写整章' }), { code: 'AUTHOR_LOCAL_SCOPE' })
    await expectToolDenied(chapterEditRangeTool.execute(ctx, { chapterId, oldText: '钟声传来', newText: '雨声传来' }), { code: 'AUTHOR_LOCAL_SCOPE' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })).toMatchObject({ content: before[3].content.replace('向右转', '向左转'), revision: 5 })
  }, false, body, { singleVolume: true, editor: 'none', agentWriting: true }))

  it('recovers an admitted old binder target through a read projection and genuine author continuation, preserving its frozen evidence', () => fixture('修改正文', async (ctx, before) => {
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { status: 'completed' } })
    const runId = randomUUID(), prompt = '人物表达太僵硬，全部重新写。', chapterId = before[0].id
    const startRequest = withHumanAdmission({ novelId: ctx.novelId, sessionId: ctx.sessionId, chapterId, prompt, mode: 'build' })
    const fresh = buildTaskSpec({ runId, novelId: ctx.novelId, chapterId, prompt, authorWritingProtocol: 2, localEditProtocol: 1, reviewProtocol: 1 })
    await prisma.agentRun.create({ data: { id: runId, userId: ctx.userId, novelId: ctx.novelId, sessionId: ctx.sessionId, chapterId,
      mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', runtimeProtocolVersion: 0,
      status: 'paused', taskSpec: runtimeJson(JSON.parse(JSON.stringify(fresh))).value, startRequest: runtimeJson(startRequest).value } })
    await prisma.agentMessage.create({ data: { runId, sessionId: ctx.sessionId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
    const subject = { ...ctx, runId, chapterId }
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, subject, fresh, prompt, 2))
    spec.scope.writing = { ...spec.scope.writing!, kind: 'needs_input', targets: [], repairAuthorized: false }
    for (const operation of spec.scope.writingActions!.operations) { operation.targets = []; operation.resolution = 'needs_input' }
    spec.scope.writingInterpretation!.reasons = ['TARGET_UNRESOLVED']
    spec.scope.writingInterpretation!.scopeHash = frozenWritingScopeHash(spec.scope)
    const frozen = runtimeJson(JSON.parse(JSON.stringify(taskSpecSchema.parse(spec)))), marker = { version: 1 as const, kind: 'writing_scope' as const, callId: 'old-scope-question' }
    const checkpoint = runCheckpointSchema.parse({ version: 2, controlPolicy: 'until_completion', origin: 'system_default', activeExecutionMs: 0,
      runStartedAt: Date.now(), resumeCount: 0, compactionCount: 0, maxTurns: 100, tokenBudget: 100000,
      writeProgress: 0, writeBaseline: 0, readProgress: 0, readBaseline: 0, progressSignatures: [], authorInputRequired: marker })
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, checkpoint }
    await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: frozen.value, usage: runtimeJson(usage).value } })
    await prisma.agentRunEvent.createMany({ data: [
      { runId, seq: 1, type: 'tool.result', payload: { callId: 'failed-prepare', toolName: 'story_compiler_prepare', failureCode: 'SCOPE_NEEDS_INPUT' } },
      { runId, seq: 2, type: 'tool.call', payload: { callId: marker.callId, toolName: 'ask_user', args: {
        question: '这次的「全部重新写」是指把第 1 章《合成章1》整章重写吗？',
        options: [{ label: '重写第1章整章', detail: '保留既有情节，重新处理对白。' },
          { label: '只修改会面这一段', detail: '其余原文不动。' },
          { label: '第1、2章一起重写', detail: '先处理第一章，随后处理第二章。' }] } } },
      { runId, seq: 3, type: 'run.paused', payload: {} },
    ] })
    const effective = await prisma.$transaction(tx => readWritingScope(tx, subject))
    expect(effective.targetCorrection).toMatchObject({ taskId: spec.id, chapterId })
    expect(effective.writing?.targets).toEqual([{ chapterId, orderIndex: 1 }])
    expect(await prisma.$transaction(tx => writingScopeResolvesInput(tx, subject, effective, marker))).toBe(true)
    expect(await prisma.$transaction(tx => writingScopeResolvesInput(tx, subject, effective, { ...marker, kind: 'local_edit_scope' }))).toBe(false)
    expect(await prisma.$transaction(tx => writingScopeResolvesInput(tx, subject, effective, { ...marker, callId: 'unrecorded-question' }))).toBe(false)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('paused')
    expect(await prisma.agentArtifact.count({ where: { runId } })).toBe(0)
    expect(runtimeJson((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).taskSpec).hash).toBe(frozen.hash)
    await prisma.agentRun.update({ where: { id: runId }, data: { usage: runtimeJson({ ...usage, checkpoint: { ...checkpoint, authorInputRequired: { ...marker, kind: 'local_edit_scope' } } }).value } })
    expect((await continueLoopRun(ctx.userId, runId)).runId).toBe(runId)
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'paused' } })
    await prisma.agentRun.update({ where: { id: runId }, data: { usage: runtimeJson(usage).value } })
    expect((await continueLoopRun(ctx.userId, runId)).runId).toBe(runId)
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
    expect((await storyCompilerPrepareTool.execute(subject, { chapterId, intentSummary: '按真实原请求准备已绑定合成章' })).outcome).not.toBe('failed')
    expect((await chapterEditRangeTool.execute(subject, { chapterId, oldText: '合成正文', newText: '修订正文' })).outcome).not.toBe('failed')
    await expectToolDenied(storyCompilerPrepareTool.execute({ ...subject, callId: 'deny-old-outside' },
      { chapterId: before[1].id, intentSummary: '不得更换原请求对象' }), { code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(1).map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(1))
    expect(runtimeJson((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).taskSpec).hash).toBe(frozen.hash)
    expect(await prisma.agentArtifact.count({ where: { runId, metadata: { path: ['writingScopeClarification'], equals: true } } })).toBe(0)
  }))
  it('reads an admitted semantic local target and edits a unique patch without accepting whole-body shortcuts', () => fixture('只修改第4章结尾。“钟声传来”保持不变。', async (ctx, before) => {
    const chapter = before[3], midpoint = Math.floor(chapter.content.length / 2)
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
    expect(spec.scope.localEditBoundary).toMatchObject({ version: 4, kind: 'semantic' })
    await chapterReadTool.execute(ctx, { chapterId: chapter.id })
    await expectToolDenied(chapterWriteTool.execute(ctx, { chapterId: chapter.id, content: '整章覆盖。' }), { code: 'AUTHOR_LOCAL_SCOPE' })
    await expectToolDenied(chapterEditRangeTool.execute(ctx, { chapterId: chapter.id, patches: [
      { oldText: chapter.content.slice(0, midpoint), newText: '前半。' }, { oldText: chapter.content.slice(midpoint), newText: '后半。' },
    ] }), { code: 'AUTHOR_LOCAL_SCOPE' })
    await expectToolDenied(chapterEditRangeTool.execute(ctx, { chapterId: chapter.id, oldText: '钟声传来', newText: '夜幕降临' }), { code: 'AUTHOR_LOCAL_SCOPE' })
    expect((await chapterEditRangeTool.execute(ctx, { chapterId: chapter.id, oldText: '门还没开', newText: '门依然紧闭' })).outcome).not.toBe('failed')
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).content).toBe(chapter.content.replace('门还没开', '门依然紧闭'))
    expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(0, 3).map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(0, 3))
  }))
  it.each(['修改正文', '整章重写', '修改并写入正文'])(
    'prepares and changes only the admitted editor chapter for %s', prompt => fixture(prompt, async (ctx, before) => {
      const admitted = await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })
      expect(taskSpecSchema.parse(admitted.taskSpec).scope.writing).toMatchObject({ kind: 'bounded', targets: [{ chapterId: before[0].id }] })
      expect((await storyCompilerPrepareTool.execute(ctx, { chapterId: before[0].id, intentSummary: '修改编辑器已绑定的合成章' })).outcome).not.toBe('failed')
      expect((await chapterEditRangeTool.execute({ ...ctx, callId: 'editor-body-change' },
        { chapterId: before[0].id, oldText: before[0].content, newText: '修改后的合成正文。' })).outcome).not.toBe('failed')
      await expectToolDenied(storyCompilerPrepareTool.execute({ ...ctx, callId: 'editor-outside' },
        { chapterId: before[1].id, intentSummary: '不得越到另一章' }), { code: 'AUTHOR_CHAPTER_SCOPE' })
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: before[0].id } })).content).toBe('修改后的合成正文。')
      expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(1).map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(1))
      expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(before.length)
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec).toEqual(admitted.taskSpec)
    }))
  it('keeps a proven same-chat chapter across ordinary discussion for the next affirmative revision', () => fixture('修改第4章正文', async (ctx, before) => {
    const source = await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })
    await prisma.agentRun.update({ where: { id: source.id }, data: { status: 'completed' } })
    const send = (prompt: string) => request(app).post('/api/agent/runs')
      .set('Cookie', `chevoink_session=${buildSessionTokens(ctx.userId, 0).accessToken}`)
      .send({ novelId: ctx.novelId, sessionId: ctx.sessionId, chapterId: null, prompt, mode: 'build' })
    const discussion = await send('气氛不错')
    expect(discussion.status).toBe(200)
    await prisma.agentRun.update({ where: { id: discussion.body.data.runId as string }, data: { status: 'completed' } })
    const followup = await send('按此修改')
    expect(followup.status).toBe(200)
    const next = { ...ctx, chapterId: null, runId: followup.body.data.runId as string }
    await prisma.agentRun.update({ where: { id: next.runId }, data: { status: 'running' } })
    expect(taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: next.runId } })).taskSpec).scope.writing)
      .toMatchObject({ kind: 'bounded', targets: [{ chapterId: before[3].id }] })
    expect((await storyCompilerPrepareTool.execute(next, { chapterId: before[3].id, intentSummary: '承接同聊真实对象' })).outcome).not.toBe('failed')
    await expectToolDenied(storyCompilerPrepareTool.execute({ ...next, callId: 'historical-outside' },
      { chapterId: before[0].id, intentSummary: '不得改成前章' }), { code: 'AUTHOR_CHAPTER_SCOPE' })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: source.id } })).taskSpec).toEqual(source.taskSpec)
  }))
  it('executes a local old-chapter revision and the separate new slot through the actual edit/create tools', () => fixture(
    '修改第4章首段，然后写下一章', async (ctx, before) => {
      const target = before[3]
      expect((await chapterEditRangeTool.execute({ ...ctx, callId: 'compound-local' },
        { chapterId: target.id, oldText: '窗边还留着灯。', newText: '窗边的灯熄灭了。' })).outcome).not.toBe('failed')
      await expectToolDenied(chapterEditRangeTool.execute({ ...ctx, callId: 'compound-outside' },
        { chapterId: target.id, oldText: '走廊无人。', newText: '越过首段改稿。' }), { code: 'AUTHOR_LOCAL_SCOPE' })
      expect((await storyCompilerPrepareTool.execute(ctx, { targetOrderIndex: 5, intentSummary: '独立的新章动作',
        volumeDecision: { kind: 'continue', reason: '当前卷承接' } })).outcome).not.toBe('failed')
      expect((await chapterCreateTool.execute({ ...ctx, callId: 'compound-create' },
        { title: '新章', content: '新章的合成正文。', position: 5 })).outcome).not.toBe('failed')
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: target.id } })).content)
        .toBe(target.content.replace('窗边还留着灯。', '窗边的灯熄灭了。'))
      expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(5)
      await expectToolDenied(chapterCreateTool.execute({ ...ctx, callId: 'compound-deny-six' }, { title: '不扩章', position: 6 }), { code: 'AUTHOR_CHAPTER_SCOPE' })
      expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(0, 3).map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } }))
        .toEqual(before.slice(0, 3))
    }, false, '窗边还留着灯。\n门开了。\n走廊无人。'))
  it.each(['不要写下一章', '不要新建'])('keeps a denied-action annotation while current read-only policy rejects creation: %s when a different action is clarified', denial => fixture(
    `修改。写下一章。${denial}`, async (ctx, before) => {
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })
      expect(taskSpecSchema.parse(run.taskSpec).scope.writingActions?.operations.find(operation => operation.kind === 'write')?.resolution).toBe('denied')
      await expectToolDenied(invokeAfterReadonlyPolicy(ctx, chapterCreateTool, { title: '被原请求禁止的新章', position: 5 }), { code: 'TOOL_NOT_AUTHORIZED' })
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    }))
  it('keeps a verified prior local object local when the next human simply authorizes another modification', () => fixture(
    '只修改第4章首段', async (ctx, before) => {
      const source = await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })
      await prisma.agentRun.update({ where: { id: source.id }, data: { status: 'completed' } })
      const response = await request(app).post('/api/agent/runs')
        .set('Cookie', `chevoink_session=${buildSessionTokens(ctx.userId, 0).accessToken}`)
        .send({ novelId: ctx.novelId, sessionId: ctx.sessionId, chapterId: before[0].id, prompt: '再修改', mode: 'build' })
      expect(response.status).toBe(200)
      const runId = response.body.data.runId as string, next = { ...ctx, runId }
      await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
      const frozen = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).taskSpec)
      expect(frozen.scope.localEditBoundary).toEqual(taskSpecSchema.parse(source.taskSpec).scope.localEditBoundary)
      expect((await chapterEditRangeTool.execute(next, { chapterId: before[3].id, oldText: '窗边还留着灯。', newText: '窗边灯已熄灭。' })).outcome)
        .not.toBe('failed')
      await expectToolDenied(chapterEditRangeTool.execute({ ...next, callId: 'continued-outside' },
        { chapterId: before[3].id, oldText: '走廊无人。', newText: '不得越出前轮对象。' }), { code: 'AUTHOR_LOCAL_SCOPE' })
      await expectToolDenied(chapterWriteTool.execute({ ...next, callId: 'continued-whole' }, { chapterId: before[3].id, content: '不得整章覆盖。' }), { code: 'AUTHOR_LOCAL_SCOPE' })
    }, false, '窗边还留着灯。\n门开了。\n走廊无人。'))
  it('routes pure continue-writing to the same unfinished task without a new root, input or usage identity', () => fixture(
    '修改第4章正文', async ctx => {
      const source = await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })
      if (source.runtimeProtocolVersion === 1 && source.taskRootId) await pauseDurableTask(ctx.userId, source.id)
      else {
        await prisma.agentRun.update({ where: { id: source.id }, data: { status: 'paused', usage: { totalTokens: 1234 } } })
        const last = await prisma.agentRunEvent.findFirst({ where: { runId: source.id }, orderBy: { seq: 'desc' }, select: { seq: true } })
        await prisma.agentRunEvent.create({ data: { runId: source.id, seq: (last?.seq ?? 0) + 1, type: 'run.paused', payload: {} } })
      }
      const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: source.id } })
      const identity = source.taskRootId ? await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: source.taskRootId },
        select: { inputHash: true, specSnapshot: true, requestSnapshot: true, sourceMessageId: true, budget: true, operations: true } }) : null
      const messages = await prisma.agentMessage.findMany({ where: { runId: source.id }, orderBy: { id: 'asc' } })
      const response = await request(app).post('/api/agent/runs')
        .set('Cookie', `chevoink_session=${buildSessionTokens(ctx.userId, 0).accessToken}`)
        .send({ novelId: ctx.novelId, sessionId: ctx.sessionId, prompt: '继续写', mode: 'build' })
      expect(response.status).toBe(200)
      const resumedId = response.body.data.runId as string
      if (!source.taskRootId) expect(resumedId).toBe(source.id)
      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: resumedId } })
      expect(after.taskRootId).toBe(before.taskRootId)
      expect(after.taskSpec).toEqual({ ...taskSpecSchema.parse(before.taskSpec), runId: resumedId })
      expect(after.startRequest).toEqual(before.startRequest)
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: source.id } })).usage).toEqual(before.usage)
      if (source.taskRootId) {
        expect(await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: source.taskRootId },
          select: { inputHash: true, specSnapshot: true, requestSnapshot: true, sourceMessageId: true, budget: true, operations: true } })).toEqual(identity)
        expect(await prisma.agentTaskRoot.count({ where: { sessionId: ctx.sessionId } })).toBe(1)
      } else expect(await prisma.agentRun.count({ where: { sessionId: ctx.sessionId } })).toBe(1)
      expect(await prisma.agentMessage.findMany({ where: { runId: source.id }, orderBy: { id: 'asc' } })).toEqual(messages)
      if (resumedId !== source.id) expect(await prisma.agentMessage.count({ where: { runId: resumedId, role: 'user' } })).toBe(0)
    }))
  it('preserves explicit novel and volume metadata operations with their original version checks', () => fixture(
    '请修改作品简介并更新第1卷标题。', async (ctx, before) => {
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec).toMatchObject({ scope: { authorEffects: { manuscript: false } } })
      expect((await novelUpdateMetaTool.execute(ctx, { summary: '合成简介。' })).outcome).not.toBe('failed')
      expect((await prisma.novel.findUniqueOrThrow({ where: { id: ctx.novelId } })).summary).toBe('合成简介。')
      const volume = await prisma.volume.findUniqueOrThrow({ where: { id: before[0].volumeId } })
      expect((await volumeUpdateTool.execute(ctx, { volumeId: volume.id, title: '合成新卷名', expectedRevision: volume.revision })).outcome).not.toBe('failed')
      await expectToolDenied(volumeUpdateTool.execute(ctx, { volumeId: volume.id, title: '旧版本不得覆盖', expectedRevision: volume.revision }), { code: 'VOLUME_REVISION_CONFLICT' })
      expect(await prisma.volume.findUniqueOrThrow({ where: { id: volume.id } })).toMatchObject({ title: '合成新卷名', revision: volume.revision + 1 })
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    }))
  it('keeps a chapter title operation bound to the requested chapter', () => fixture('请修改第1章标题。', async (ctx, before) => {
    expect((await chapterRenameTool.execute(ctx, { chapterId: before[0].id, title: '合成新章名' })).outcome).not.toBe('failed')
    await expectToolDenied(chapterRenameTool.execute(ctx, { chapterId: before[1].id, title: '未授权章名' }), { code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: before[0].id } })).toMatchObject({
      title: '合成新章名', revision: before[0].revision + 1, content: before[0].content })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: before[1].id } })).toEqual(before[1])
  }))
  it('returns a quality report with suggestions for an assessment-only request without reserving a repair', () => fixture(
    '检查本章是否需要润色。', async (ctx, before) => {
      const target = before[0]
      const bundle = await buildHumanityQualityContext(ctx.userId, ctx.novelId, target.id, ctx.runId)
      const inspected = inspectCriticResponse(JSON.stringify({ findings: [{ signal: 'causal_gap', severity: 'warning',
        quote: target.content, explanation: '合成的待审因果意见。', suggestion: '交作者决定是否补足。', confidence: 0.8 }] }))
      const report = await persistHumanityQualityReport({ ...ctx, chapterId: target.id, chapterRevision: target.revision,
        mode: 'premium', deterministicMetrics: {}, qualityContextHash: qualityReviewContextHash(bundle), deterministicFindings: [],
        criticFindings: inspected.findings, criticComplete: inspected.complete, criticResponseDiagnostic: inspected.diagnostic })
      expect(report.status).toBe('needs_repair')
      const result = await qualityAnalyzeTool.execute({ ...ctx, creativeFreedom: 'balanced' }, { chapterId: target.id })
      expect(result.outcome).not.toBe('failed')
      expect(result.display).toMatchObject({ kind: 'qualityReport', reportId: report.id })
      const saved = await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: report.id } })
      expect(saved.repairRound).toBe(0)
      expect(saved.deterministicMetrics).not.toHaveProperty('autoRepairAttempted')
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    }))
  it.each([
    '列出三个提升注意力的方法。',
    '我们讨论人物动机，不续写或修改任何作品正文。',
    '请读取第1章，整理人物关系，不改动任何正文。',
    '请搜索公开小说并研究语言风格，不创建或修改任何章节。',
    '请只审阅已提供的段落并列出问题，不修改或重写正文。',
    '请研究这本书，再把研究报告保存到计划文件。',
  ])('retains the original request and enforces explicit read-only session access: %s', prompt => fixture(prompt, async (ctx, before) => {
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })
    const spec = taskSpecSchema.parse(run.taskSpec)
    expect(spec.scope.authorEffects).toMatchObject({ manuscript: false, structure: false })
    expect(spec.scope.writing).toBeUndefined()
    expect((await chapterReadTool.execute({ ...ctx, callId: 'safe-independent-read' }, { chapterId: before[0].id })).output).toContain(before[0].content)
    await expectToolDenied(invokeAfterReadonlyPolicy({ ...ctx, callId: 'deny-body-proposal' }, chapterWriteTool, { chapterId: before[0].id, content: '未授权替换。' }), { code: 'TOOL_NOT_AUTHORIZED' })
    await expectToolDenied(invokeAfterReadonlyPolicy({ ...ctx, callId: 'deny-create-proposal' }, chapterCreateTool, { title: '未授权新章' }), { code: 'TOOL_NOT_AUTHORIZED' })
    await expectToolDenied(invokeAfterReadonlyPolicy({ ...ctx, callId: 'deny-structure-proposal' }, chapterSplitTool, { chapterId: before[0].id, splitOffset: 2, newChapterTitle: '未授权拆章', expectedRevision: before[0].revision }), { code: 'TOOL_NOT_AUTHORIZED' })
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec).toEqual(run.taskSpec)
  }))

  it.each([
    '先读取资料并总结结论，再修改正文。',
    '先解释一下限知视角，然后写下一段正文。',
    '先搜索公开小说并分析叙事手法，再修改正文。',
  ])('keeps mixed-request annotations while explicit read-only session access denies a write: %s', prompt => fixture(prompt, async (ctx, before) => {
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })
    const spec = taskSpecSchema.parse(run.taskSpec)
    expect(spec.scope.authorEffects).toMatchObject({ manuscript: true, structure: false })
    expect(spec.scope.writing?.kind).toBe('needs_input')
    expect(spec.intent).not.toBe('plan')
    expect((await chapterReadTool.execute({ ...ctx, callId: 'mixed-safe-read' }, { chapterId: before[0].id })).output).toContain(before[0].content)
    await expectToolDenied(invokeAfterReadonlyPolicy({ ...ctx, callId: 'mixed-deny-create' }, chapterCreateTool, { title: '不猜写入目标' }), { code: 'TOOL_NOT_AUTHORIZED' })
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec).toEqual(run.taskSpec)
  }, false, body, { singleVolume: true, editor: 'none' }))
})

describe.skipIf(!available)('unified fresh HTTP author contract with actual PostgreSQL writes', () => {
  it('prepares and edits only the explicitly spaced first-three-chapter list', () => fixture(
    '我授权你可以修改我正文1 2 3章的权利 你按照想法修改', async (ctx, before) => {
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })
      const frozen = taskSpecSchema.parse(run.taskSpec)
      expect(frozen).toMatchObject({ intent: 'revise', scope: { writing: { kind: 'bounded', repairAuthorized: true,
        targets: before.slice(0, 3).map(chapter => ({ orderIndex: chapter.orderIndex, chapterId: chapter.id })) } } })
      expect(frozen.scope.writing?.targets).toHaveLength(3)
      for (const chapter of before.slice(0, 3)) {
        expect((await storyCompilerPrepareTool.execute({ ...ctx, callId: 'prepare-spaced-' + chapter.orderIndex },
          { chapterId: chapter.id, intentSummary: '修订授权合成章' })).outcome).not.toBe('failed')
        expect((await chapterEditRangeTool.execute({ ...ctx, callId: 'edit-spaced-' + chapter.orderIndex },
          { chapterId: chapter.id, oldText: '合成正文', newText: '修订正文' })).outcome).not.toBe('failed')
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({
          content: chapter.content.replace('合成正文', '修订正文'), revision: chapter.revision + 1 })
      }
      await expectToolDenied(storyCompilerPrepareTool.execute({ ...ctx, callId: 'deny-spaced-prepare-four' },
        { chapterId: before[3].id, intentSummary: '未授权合成章' }), { code: 'AUTHOR_CHAPTER_SCOPE' })
      await expectToolDenied(chapterEditRangeTool.execute({ ...ctx, callId: 'deny-spaced-edit-four' },
        { chapterId: before[3].id, oldText: '钟声传来', newText: '未授权改稿' }), { code: 'AUTHOR_CHAPTER_SCOPE' })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })).toEqual(before[3])
      expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(4)
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec).toEqual(run.taskSpec)
    }))

  it('atomically rejects a seven-patch punctuation conflict and applies only the corrected current draft batch', () => fixture(directoryContinuationPrompt, async (ctx, before) => {
    await storyCompilerPrepareTool.execute(ctx, { targetOrderIndex: 5, intentSummary: '新章的合成编辑定位回归', volumeDecision: { kind: 'continue', reason: '原卷续写' } })
    const compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { runId: ctx.runId, status: 'active' } })
    await saveSceneTasks({ ...ctx, compilationId: compilation.id, tasks: [{ purpose: '定位回归', entryState: {}, goal: '核对', obstacle: '门锁',
      choice: '等候', cost: '时间', turn: '重新定位', exitState: {}, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const fragments = ['甲门锁着。', '乙灯亮着。', '「请稍等。」', '丙窗关着。', '丁箱封着。', '戊轮停着。', '己阀闭着。']
    const content = fragments.join('\n\n')
    expect((await chapterCreateTool.execute({ ...ctx, callId: 'seven-create' }, { title: '合成新章', content,
      volumeId: before[3].volumeId, positionInVolume: 5 })).outcome).not.toBe('failed')
    const chapter = await prisma.chapter.findFirstOrThrow({ where: { novelId: ctx.novelId, orderIndex: 5 } })
    const patches = fragments.map((oldText, index) => ({ oldText, newText: `修订${index + 1}。` }))
    patches[2].oldText = '「请稍等」。'
    const failed = await chapterEditRangeTool.execute({ ...ctx, callId: 'seven-bad-anchor' }, { chapterId: chapter.id, patches })
      .catch(error => ({ outcome: 'failed', failureCode: error.code }))
    expect(failed).toMatchObject({ outcome: 'failed', failureCode: 'CHAPTER_ANCHOR_CONFLICT' })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
    patches[2].oldText = fragments[2]
    expect((await chapterEditRangeTool.execute({ ...ctx, callId: 'seven-corrected-anchor' }, { chapterId: chapter.id, patches })).outcome).not.toBe('failed')
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).content).toBe(patches.map(item => item.newText).join('\n\n'))
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId, id: { in: before.map(item => item.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
  }, false, body, { singleVolume: true, editor: 'none' }))
  it('admits the complete compound continuation and only creates its proved fifth-chapter slot', () => fixture(directoryContinuationPrompt, async (ctx, before) => {
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })
    const frozen = taskSpecSchema.parse(run.taskSpec)
    expect(frozen).toMatchObject({ intent: 'write', scope: { writing: { kind: 'bounded', repairAuthorized: false,
      targets: [{ orderIndex: 5, chapterId: null, volumeId: before[3].volumeId, positionInVolume: 5 }] },
    writingInterpretation: { reasons: [], excludedChapterIds: expect.arrayContaining(before.map(chapter => chapter.id)) } } })
    expect(frozen.scope.writing?.targets).toHaveLength(1)
    expect(frozen.scope.localEditBoundary).toBeUndefined()
    expect((await storyCompilerPrepareTool.execute(ctx, { targetOrderIndex: 5, intentSummary: '续写合成第五章',
      volumeDecision: { kind: 'continue', reason: '作者指定第一卷' } })).outcome).not.toBe('failed')
    const compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { runId: ctx.runId, status: 'active' } })
    await saveSceneTasks({ ...ctx, compilationId: compilation.id, tasks: [{ purpose: '新章冲突', entryState: {}, goal: '前进', obstacle: '门关着',
      choice: '等候', cost: '时间', turn: '新声音', exitState: {}, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const created = await chapterCreateTool.execute({ ...ctx, callId: 'create-proved-five' }, { title: '合成新章', content: '新的合成冲突。',
      volumeId: before[3].volumeId, positionInVolume: 5 })
    expect(created.outcome).not.toBe('failed')
    const fifth = await prisma.chapter.findFirstOrThrow({ where: { novelId: ctx.novelId, orderIndex: 5 } })
    expect(fifth).toMatchObject({ volumeId: before[3].volumeId, orderInVolume: 5, content: '新的合成冲突。' })
    for (const chapter of before) await expect(prisma.$transaction(tx => assertWritingTarget(tx, ctx, { chapterId: chapter.id, effect: 'replace' })))
      .rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    await expect(prisma.$transaction(tx => assertWritingTarget(tx, ctx, { orderIndex: 6, effect: 'create' })))
      .rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId, id: { in: before.map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(5)
  }, false, body, { singleVolume: true, editor: 'none' }))
  it('retains an original frozen conflict instead of upgrading the old paused contract', () => fixture(directoryContinuationPrompt, async (ctx) => {
    const current = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
    const { frozenWritingScopeHash } = await import('../../api/lib/agent/writing-contract.js')
    const old = structuredClone(current)
    old.scope.writing = { ...old.scope.writing!, kind: 'needs_input', targets: [] }
    old.scope.writingInterpretation!.reasons = ['conflicting_targets', 'TARGET_UNRESOLVED']
    old.scope.writingInterpretation!.scopeHash = frozenWritingScopeHash(old.scope)
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: runtimeJson(old).value } })
    expect(await prisma.$transaction(tx => freezeWritingScope(tx, ctx, old, directoryContinuationPrompt, 2))).toEqual(old)
  }, false, body, { singleVolume: true, editor: 'none' }))
  it.each([directoryContinuationPrompt, '续写第二卷第3章。仅写第3章。不修改第1至4章。'])('rejects conflicting volume/book addresses without creating or changing rows: %s', prompt => fixture(prompt, async (ctx, before) => {
    const frozen = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
    expect(frozen.scope.writing).toMatchObject({ kind: 'needs_input', targets: [] })
    expect(frozen.scope.writingInterpretation?.reasons).toContain('conflicting_targets')
    await assertOriginalAuthorContext(ctx)
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
  }, false, body, { singleVolume: false, editor: 'none' }))
  it('preserves historical judgments while candidate omission cannot block current reports and delivery', () => fixture(
    '先读取第4章当前已存正文，完成本章检查和提交。请先做连续性与人类感检查；如有必要，只对本章做局部修订并复检。不新建章节，不修改前3章。', async (ctx, before) => {
      const original = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
      expect(original.scope.terminalCoverageProtocol).toBe(2)
      expect((await prepare(ctx)).outcome).not.toBe('failed')
      let compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { runId: ctx.runId, status: 'active' } })
      await saveSceneTasks({ ...ctx, compilationId: compilation.id, tasks: [{ purpose: '核对已存状态', entryState: {}, goal: '等待', obstacle: '门关着',
        choice: '等候', cost: '时间', turn: '仍等候', exitState: {}, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
      const chapter = before[3], complete = terminalCandidateSchema.parse({ exitState: { body: ['林舟右掌有伤'], emotion: ['林舟安心'] } })
      const empty = terminalCandidateSchema.parse({ exitState: {} })
      const assess = async (candidate: typeof complete, unknownDisposition = false) => {
        const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
        const source = await readCompilerContinuitySource(prisma, ctx, chapter, saved.bridge!.fromChapterId, 11)
        const obligations = terminalCoverageInput(original, saved.preparedContext, chapter, candidate)
        const evidence = terminalEvidenceContext(chapter, source, 2, 1, obligations)
        const response = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: '合成当前事实核对。', findingIndexes: [] })),
          terminalVerdicts: candidate.exitState.body.length ? [
            { path: 'exitState.body.0', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: '林舟右掌有伤' }] },
            { path: 'exitState.emotion.0', verdict: 'unknown', basis: 'current', sourceEvidence: [] },
          ] : [], ...(unknownDisposition ? { terminalDispositions: obligations!.obligations.map(item => ({ id: item.id, outcome: 'unknown', reason: '尚不能判定解除。', sourceEvidence: [] })) } : {}) })
        const inspected = inspectContinuityResponse(response, { previous: source?.content ?? null, current: chapter.content, terminalEvidence: evidence }, true, 8, candidate)
        await prisma.agentArtifact.create({ data: { id: randomUUID(), runId: ctx.runId, artifactType: 'continuityReview',
          title: '冻结历史判断', content: response, metadata: runtimeJson({ candidate, audit: inspected.audit }).value } })
        await persistCurrentContinuityReport({ ...ctx, compilationId: compilation.id, expectedChapterRevision: chapter.revision })
        return inspected
      }
      expect((await assess(complete)).complete).toBe(true)
      compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
      expect(readTerminalCoverageState(original, compilation.preparedContext, chapter.id)?.facts ?? []).toEqual([])
      expect((await assess(empty)).complete).toBe(true)
      expect((await assess(empty, true)).complete).toBe(true)
      const quality = await buildHumanityQualityContext(ctx.userId, ctx.novelId, chapter.id, ctx.runId)
      await prisma.chapterQualityReport.create({ data: { userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, compilationId: compilation.id,
        chapterId: chapter.id, chapterRevision: chapter.revision, status: 'passed', deterministicMetrics: { independentCheck: 'complete',
          contentHash: createHash('sha256').update(chapter.content).digest('hex'), qualityContextHash: qualityReviewContextHash(quality) } } })
      await expect(chapterBridgeCommitTool.execute(ctx, { compilationId: compilation.id, chapterSummary: '原文保留', exitState: empty.exitState,
        lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '等候', endingStructure: '未开门' }))
        .resolves.toMatchObject({ summary: '章节已提交' })
      const unchanged = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
      expect(unchanged.bridge?.committedAt).toBeInstanceOf(Date)
      const history = await prisma.agentArtifact.findMany({ where: { runId: ctx.runId, artifactType: 'continuityReview', title: '冻结历史判断' }, orderBy: { id: 'asc' } })
      expect(history).toHaveLength(3)
      expect(history.some(row => row.content.includes('"verdict":"unknown"'))).toBe(true)
      const pending = readTerminalCoverageState(original, unchanged.preparedContext, chapter.id)
      expect((await prepare(ctx)).outcome).not.toBe('failed')
      const next = await prisma.storyCompilation.findFirstOrThrow({ where: { runId: ctx.runId, status: 'active' } })
      expect(next.id).not.toBe(compilation.id)
      expect(readTerminalCoverageState(original, next.preparedContext, chapter.id)).toEqual(pending)
      expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, ctx, next.id)))
        .toMatchObject({ ready: false })
      await expect(chapterBridgeCommitTool.execute(ctx, { compilationId: next.id, chapterSummary: '不能以重准备清空义务', exitState: empty.exitState,
        lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '等候', endingStructure: '未开门' }))
        .resolves.toMatchObject({ summary: '章节已提交', output: expect.stringContaining('missing') })
      expect((await prisma.chapterBridge.findFirstOrThrow({ where: { compilationId: next.id } })).committedAt).toBeInstanceOf(Date)
      expect(await prisma.agentArtifact.findMany({ where: { id: { in: history.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(history)
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    }, false, body + '林舟右掌有伤。'))
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
    const pending = await preflightChapterReviewWrite(ctx, 'chapter_edit_range', { chapterId: before[3].id, oldText: '向左走', newText: '向右走' })
    expect(pending).toMatchObject({ kind: 'decision_required', code: 'AUTHOR_LOCAL_SCOPE', conditional: { state: 'checks_required' } })
    for (const chapterId of [before[3].id, before[0].id]) await expectToolDenied(chapterEditRangeTool.execute(ctx,
      { chapterId, oldText: chapterId === before[3].id ? '向左走' : before[0].content, newText: '未经证实' }), { code: 'AUTHOR_LOCAL_SCOPE' })
    await expectToolDenied(chapterWriteTool.execute(ctx, { chapterId: before[3].id, content: '整章覆盖' }), { code: 'AUTHOR_LOCAL_SCOPE' })
    await expect(prisma.$transaction(tx => assertChapterReviewRevision(tx, ctx, before[3])))
      .rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
  }))
  it.each(['不要修改本章。', '本章不得修改。', '不修改这章。', '本章保持不变。'])(
    'preserves the prohibition annotation and current read-only effect denial: %s', denial => fixture(reviewRequests[1] + denial, async (ctx, before) => {
      const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
      expect(spec.scope.writingInterpretation?.revisionDenied).toBe(true)
      expect(spec.scope.writing?.kind).toBe('needs_input')
      await expectToolDenied(invokeAfterReadonlyPolicy(ctx, storyCompilerPrepareTool, { targetOrderIndex: 4, intentSummary: '当前会话明确只读' }), { code: 'TOOL_NOT_AUTHORIZED' })
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    }))
  it.each([false, true])('completes current checks and real commit with conditional repair=%s, preserving prior chapters', repair => fixture(reviewRequests[0], async (ctx, before) => {
    expect((await prepare(ctx)).outcome).not.toBe('failed')
    const compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { runId: ctx.runId } })
    expect(await chapterBridgeGetTool.execute(ctx, {})).toMatchObject({ display: { title: '章节桥' } })
    await saveSceneTasks({ ...ctx, compilationId: compilation.id, tasks: [{ purpose: '核对现有场景', entryState: { location: '长廊' },
      goal: '等待门开', obstacle: '门关着', choice: '等候', cost: '时间流逝', turn: '听见指令', exitState: { location: '长廊' },
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const candidate = terminalCandidateSchema.parse({ exitState: { location: '长廊' }, lastUnfinishedAction: '' })
    const assess = async (finding: boolean) => {
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
      const source = await readCompilerContinuitySource(prisma, ctx, chapter, saved.bridge!.fromChapterId, 11)
      const original = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
      const evidence = terminalEvidenceContext(chapter, source, 2, terminalQuoteAddressVersion(original), terminalCoverageInput(original, saved.preparedContext, chapter, candidate))
      // Synthetic provider RESPONSE only; exercise the actual fresh producer /
      // parser / coverage / commit contract without a provider dispatch.
      const response = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear',
        reason: '不同人物的行动不构成同对象矛盾，两人仍在长廊。', findingIndexes: [] })),
      terminalVerdicts: [{ path: 'exitState.location', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: '两人留在长廊' }] }] })
      const inspected = inspectContinuityResponse(response, { previous: source?.content ?? null, current: chapter.content, terminalEvidence: evidence }, true, 8, candidate)
      expect(inspected.complete).toBe(true)
      const { validation } = await persistCurrentContinuityReport({ ...ctx, compilationId: compilation.id, expectedChapterRevision: chapter.revision })
      expect(validation).toMatchObject({ errorCount: 0 })
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation)
        .toMatchObject({ continuityReport: { version: 1, chapterId: chapter.id, revision: chapter.revision, complete: true } })
      if (chapter.content.includes('向左走')) {
        const preflight = await preflightChapterReviewWrite(ctx, 'chapter_edit_range', { chapterId: chapter.id, oldText: '向左走', newText: '向右走' })
        expect(preflight).toMatchObject({ kind: 'decision_required', conditional: { state: 'checks_required',
          requiredTools: [{ name: 'quality_analyze', args: { compilationId: compilation.id } }] } })
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
      }
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
      const mixed = { chapterId: before[3].id, patches: [{ oldText: '向左走', newText: '向右走' }, { oldText: '门还没开', newText: '门框新增了机械结构' }] }
      expect(await preflightChapterReviewWrite(ctx, 'chapter_edit_range', mixed)).toMatchObject({ kind: 'decision_required',
        conditional: { state: 'proposal_outside_evidence', unprovenPatchIndexes: [1] } })
      await expectToolDenied(chapterEditRangeTool.execute(ctx, mixed), { code: 'AUTHOR_LOCAL_SCOPE' })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })).toEqual(before[3])
      expect(await preflightChapterReviewWrite(ctx, 'chapter_edit_range', { chapterId: before[3].id, oldText: '向左走', newText: '向右走' }))
        .toMatchObject({ kind: 'allow' })
      const report = await prisma.chapterQualityReport.findFirstOrThrow({ where: { compilationId: compilation.id }, include: { findings: true } })
      const originalMetrics = report.deterministicMetrics as Record<string, string>
      for (const scenario of ['hash', 'context', 'failed', 'different-compilation'] as const) {
        await prisma.chapterQualityReport.update({ where: { id: report.id }, data: scenario === 'failed' ? { status: 'failed' }
          : scenario === 'different-compilation' ? { compilationId: null }
            : { deterministicMetrics: { ...originalMetrics, [scenario === 'hash' ? 'contentHash' : 'qualityContextHash']: '0'.repeat(64) } } })
        await expectToolDenied(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '向左走', newText: '向右走' }), { code: 'AUTHOR_LOCAL_SCOPE' })
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })).toEqual(before[3])
        await prisma.chapterQualityReport.update({ where: { id: report.id }, data: { status: report.status, deterministicMetrics: originalMetrics, compilationId: compilation.id } })
      }
      await prisma.qualityFinding.update({ where: { id: report.findings[0].id }, data: { evidenceHash: '0'.repeat(64) } })
      await expectToolDenied(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '向左走', newText: '向右走' }), { code: 'AUTHOR_LOCAL_SCOPE' })
      await prisma.qualityFinding.update({ where: { id: report.findings[0].id }, data: { evidenceHash: report.findings[0].evidenceHash } })
      await expectToolDenied(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '门还没开', newText: '门已打开' }), { code: 'AUTHOR_LOCAL_SCOPE' })
      expect((await chapterEditRangeTool.execute({ ...ctx, callId: 'conditional-actual-range' },
        { chapterId: before[3].id, oldText: '向左走', newText: '向右走' })).outcome).not.toBe('failed')
      await expectToolDenied(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '向右走', newText: '往右走' }), { code: 'AUTHOR_LOCAL_SCOPE' })
      await assess(false)
    }
    expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, ctx))).toMatchObject({ ready: true,
      continuity: 'complete', quality: 'complete', reviewBoundPlan: { state: 'no_proven_findings', anchors: [] } })
    const result = await chapterBridgeCommitTool.execute({ ...ctx, callId: 'conditional-real-commit' }, { compilationId: compilation.id,
      chapterSummary: '两人仍在长廊等待。', exitState: candidate.exitState, lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '',
      openingStructure: '钟声', endingStructure: '等待' })
    expect(result.outcome).not.toBe('failed')
    const final = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })
    expect(final).toMatchObject({ status: 'completed', stage: 'commit', bridge: { toChapterId: chapter.id, targetRevision: chapter.revision } })
    expect(final.bridge?.committedAt).toBeInstanceOf(Date)
    expect(await chapterBridgeGetTool.execute(ctx, {})).toMatchObject({ display: { title: '章节已提交' } })
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
    await expectToolDenied(chapterEditRangeTool.execute(ctx, { chapterId: current.id, oldText: '“向左走。”', newText: '「向左走。」' }), { code: 'AUTHOR_LOCAL_SCOPE' })
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
      await expectToolDenied(chapterWriteTool.execute(ctx, { chapterId: before[3].id, content: '不得扩大为整章替换。' }), { code: 'AUTHOR_LOCAL_SCOPE' })
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect((await chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '第二段', newText: '第二段修正' })).outcome).not.toBe('failed')
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })).content).toBe('第一段\n第二段修正\n第三段')
      expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(0, 3).map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(0, 3))
    }, false, '第一段\n第二段\n第三段'))
  it('uses only the authenticated source quote for a real local transform', () => fixture(
    '第二卷第2章正文，将“源短句”改为“新短句”。', async (ctx, before) => {
      const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
      expect(spec.scope.localEditBoundary).toMatchObject({ kind: 'bounded', regions: [{ chapterId: before[3].id, start: 3, end: 6 }] })
      await expectToolDenied(chapterWriteTool.execute(ctx, { chapterId: before[3].id, content: '不得扩大为全章。' }), { code: 'AUTHOR_LOCAL_SCOPE' })
      expect((await chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '源短句', newText: '新短句' })).outcome).not.toBe('failed')
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })).content).toBe('前段。新短句尾。后段。')
      expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(0, 3).map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(0, 3))
    }, false, '前段。源短句尾。后段。'))
  it.each(['禁止修订“源短句”。', '“源短句”，保持不变。', '“短句尾”，保持不变。', '不要修改第二段。'])(
    'preserves the full protected-source request for the main Agent: %s', protection => fixture(
      '第二卷第2章正文，将“源短句”改为“新短句”。' + protection, async (ctx, before) => {
      await assertOriginalAuthorContext(ctx, '第二卷第2章正文，将“源短句”改为“新短句”。' + protection)
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    }, false, '前段。源短句尾。后段。'))
  it.each(['修订“原短句', '修订"原短句', "修订'原短句", '修订“外“内”尾',
    '修订第4章的“原短句', '修改第4章“原短句', '修订第4章。将“原短句',
    '修订第4章参考文案中的“原短句', '修订第4章中的参考原文“原短句', '修订“尾”。禁止修订参考原文“保护句尾',
    '修订“尾”。禁止修订“保护句尾', '修订“尾”。禁止修订"保护句尾', "修订“尾”。禁止修订'保护句尾"])(
    'preserves unclosed quotes verbatim for the main Agent: %s', request => fixture(
      '第二卷第2章正文，' + request, async (ctx, before) => {
      await assertOriginalAuthorContext(ctx, '第二卷第2章正文，' + request)
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    }, false, '前段。原短。外“内”。保护句尾。后段。'))
  it.each(['修订第4章的“原短句”', '修订第4章参考文案中的“原短句”',
    '替换第4章中的“原短句”', '第4章中的“原短句”替换',
    '修订第4章。禁止修订“原短句”。', '修改第4章。“原短句”，保持不变。'])(
    'preserves unresolved and protected source words in actual Agent context: %s', request => fixture(
      '第二卷第2章正文，' + request, async (ctx, before) => {
      await assertOriginalAuthorContext(ctx, '第二卷第2章正文，' + request)
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    }, false, '前段。原短句。后段。'))
  it('preserves chapter and ambiguous local words in actual Agent context', () => fixture(requests[0] + concerns, async (ctx, before) => {
      await assertOriginalAuthorContext(ctx, requests[0] + concerns)
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    }, true))
  it.each(['完成第二卷第2章质量检查，判断是否需要局部修订。', '请阅读这句：“修改第二卷第2章”。'])(
    'presents review and quoted instructions verbatim to the main Agent: %s', prompt => fixture(prompt, async (ctx, before) => {
      await assertOriginalAuthorContext(ctx, prompt)
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    }))
  it.each(['检查是否需要修改第二段。', '只检查第4章是否需要修订正文。', '请勿再修改第4章。',
    '修订第4章正文。不得修改。'])(
    'preserves assessment and negative instructions through real HTTP context: %s', prompt => fixture(prompt, async (ctx, before) => {
      await assertOriginalAuthorContext(ctx, prompt)
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    }))
  it.each(['禁止修订“向左走。”。', '不调整“向左走。”。', '“向左走。”，保持不变。'])(
    'preserves protection and cited issue together in main Agent context: %s', protection => fixture(requests[0] + concerns + protection, async (ctx, before) => {
      await assertOriginalAuthorContext(ctx, requests[0] + concerns + protection)
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    }))
  it('preserves the author prohibition against chapter creation in main Agent context', () => fixture('续写下一章，不新建章节。', async (ctx, before) => {
      await assertOriginalAuthorContext(ctx, '续写下一章，不新建章节。')
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    }))
  it.each(['writing', 'localEditBoundary', 'writingInterpretation'] as const)(
    'rejects a partial frozen2 projection with missing %s before prepare or writes', field => fixture(requests[0] + concerns, async (ctx, before) => {
      const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
      delete spec.scope[field]
      await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: spec } })
      await expectToolDenied(prepare(ctx), { code: 'RUNTIME_RECEIPT_INVALID' })
      await expectToolDenied(chapterWriteTool.execute(ctx, { chapterId: before[3].id, content: '不应扩大为整章权限。' }), { code: 'RUNTIME_RECEIPT_INVALID' })
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    }))
  it.each([firstChapterAnswer, '第一章：启程（约600字）（主角进入车站，发现异常，章末留悬念）'])(
    'initializes an empty work then prepares and writes the genuinely confirmed first chapter: %s', async answer => {
    const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID()
    let restoreWait = () => {}
    try {
      vi.stubGlobal('fetch', vi.fn(() => { throw Error('No Provider allowed') }))
      await prisma.user.create({ data: { id: userId, nickname: 'synthetic-first-answer', passwordHash: 'test-only' } })
      await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '未命名作品', slug: randomUUID(), summary: '先创建一部作品，再继续完善简介、章节和封面。' } })
      await prisma.volume.create({ data: { novelId, title: '第一卷', orderIndex: 1 } })
      await prisma.agentSession.create({ data: { id: sessionId, userId, novelId, title: '合成澄清' } })
      const admitted = await request(app).post('/api/agent/runs')
        .set('Cookie', `chevoink_session=${buildSessionTokens(userId, 0).accessToken}`)
        .send({ novelId, sessionId, prompt: shortSceneRequest, mode: 'build' })
      expect(admitted.status).toBe(200)
      const runId = admitted.body.data.runId as string
      const frozen = (await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).taskSpec
      expect(frozen).toMatchObject({ scope: { writingTargetProtocol: 2, writingClarificationProtocol: 2, writing: { kind: 'needs_input' } } })
      await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
      const ctx: ToolContext = { userId, novelId, sessionId, runId, chapterId: null, callId: 'true-author-answer', mode: 'build',
        qualityMode: 'premium', creativeFreedom: 'balanced', signal: new AbortController().signal, emit: () => {} }
      expect((await novelCreateTool.execute(ctx, { title: '合成首章作品', summary: '用于校验首章确认与实际正文写入。', tags: [ALL_NOVEL_TAGS[0]] })).outcome).not.toBe('failed')
      await assertOriginalAuthorContext(ctx, shortSceneRequest)
      expect(await prisma.storyCompilation.count({ where: { runId } })).toBe(0)
      const wait = questionPermissions.waitForQuestionAnswer
      const waitingSpy = vi.spyOn(questionPermissions, 'waitForQuestionAnswer').mockImplementation((id, callId, timeout, signal) => {
        const pending = wait(id, callId, timeout, signal)
        return Promise.all([pending, resolveLoopRunQuestion(userId, id, callId, answer)]).then(([resolved]) => resolved)
      })
      restoreWait = () => { waitingSpy.mockRestore() }
      expect(await askUserTool.execute(ctx, placementQuestion)).toMatchObject({ semanticTransition: expect.anything(), display: { scopeResolution: 'accepted', answer } })
      expect((await storyCompilerPrepareTool.execute({ ...ctx, callId: 'after-answer-prepare' }, { targetOrderIndex: 1,
        intentSummary: '承接作者确认的第一章与附属要求', volumeDecision: { kind: 'continue', reason: '第一卷首章' } })).outcome).not.toBe('failed')
      const compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { runId, status: 'active' } })
      await saveSceneTasks({ ...ctx, compilationId: compilation.id, tasks: [{ purpose: '首章冲突', entryState: {}, goal: '入站', obstacle: '异常通知',
        choice: '继续等待', cost: '时间', turn: '发现异常', exitState: {}, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
      expect((await chapterCreateTool.execute({ ...ctx, callId: 'create-answered-first' }, { title: '合成第一章', volumeOrder: 1, positionInVolume: 1 })).outcome).not.toBe('failed')
      const chapter = await prisma.chapter.findFirstOrThrow({ where: { novelId, orderIndex: 1 } })
      expect((await chapterWriteTool.execute({ ...ctx, callId: 'write-answered-first' }, { chapterId: chapter.id, content: '她在门口等候。窗外天亮了。' })).outcome).not.toBe('failed')
      expect((await chapterEditRangeTool.execute({ ...ctx, callId: 'edit-answered-first' }, { chapterId: chapter.id, oldText: '窗外天亮了', newText: '窗外雨停了' })).outcome).not.toBe('failed')
      await expectToolDenied(chapterCreateTool.execute({ ...ctx, callId: 'deny-second-after-answer' }, { title: '不得扩成第二章', volumeOrder: 1, positionInVolume: 2 }), { code: 'AUTHOR_CHAPTER_SCOPE' })
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).taskSpec).toEqual(frozen)
      expect(await prisma.chapter.count({ where: { novelId } })).toBe(1)
      expect(await prisma.aiUsageLog.count({ where: { userId } })).toBe(0)
      expect(await prisma.creditLedgerEntry.count({ where: await toolFixtureLedgerWhere(userId, { userId }) })).toBe(0)
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
