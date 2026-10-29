import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
// Admission/domain fixtures stop before async execution; the native dispatcher has its own PG matrix.
vi.mock('../../api/lib/agent/runtime-bootstrap.js', async importOriginal => ({ ...await importOriginal<typeof import('../../api/lib/agent/runtime-bootstrap.js')>(), dispatchFreshDurableRun: vi.fn(async () => {}) }))
vi.mock('../../api/lib/agent/loop.js', () => ({ executeAgentRun: vi.fn(async () => {}) }))
vi.mock('../../api/lib/agent/writing-experiments.js', () => ({ recordSevenDayContinuation: vi.fn(async () => {}) }))
import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import * as credits from '../../api/lib/credits.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { continuityValidateTool, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { taskSpecSchema } from '../../shared/contracts/index.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { readContinuedContinuityRecovery } from '../../api/lib/agent/legacy-continuity-recovery.js'
import { buildQualityEvidenceSources } from '../../api/lib/agent/quality-evidence.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(() => prisma.$disconnect())
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const runtime: NonNullable<ToolContext['modelRuntime']> = { tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
  baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-only', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'],
  reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }
const safeBody = '她在库门外等候。库门仍然关闭。'
const obsolete = '她用旧钥匙开门'
const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }

function sourceReviewResponse(scenario: string, round: number, ids: { current: string; previous: string }, continued: boolean) {
  const invalid = { signal: 'object', severity: 'error',
    explanation: `第3章却写“${obsolete}”，与前文熔毁事实矛盾。`, suggestion: '根据实际原文核对钥匙。',
    evidence: [{ sourceId: 'missing-historical-prompt' }] }
  const misattributed = { ...invalid, explanation: '第3章仍写“钥匙已经熔毁”，同时写“库门仍然关闭”，同一时刻互斥。',
    evidence: [{ sourceId: 'wrong-current-locator' }] }
  if (round === 1) return { findings: scenario === 'history-retracted' || scenario === 'changed-during-provider' ? []
    : scenario === 'real-conflict' ? [{ ...invalid, evidence: [{ sourceId: ids.previous }, { sourceId: ids.current }] }]
      : [scenario === 'previous-misattributed' ? misattributed : invalid] }
  return { corrections: scenario === 'history-confirm-rejected' && !continued ? []
    : [{ index: 0, evidence: [{ sourceId: scenario === 'previous-misattributed' ? ids.previous : ids.current }] }] }
}

describe.skipIf(!available)('HTTP admission and actual PostgreSQL current-source review', () => {
  it.each(['history-retracted', 'previous-misattributed', 'history-confirm-rejected', 'real-conflict', 'changed-during-provider'] as const)(
    'preserves source, hard-pass, fees and ownership: %s', async scenario => {
      const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID()
      try {
        await prisma.user.create({ data: { id: userId, nickname: 'synthetic-source-authority', passwordHash: 'test-only' } })
        await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '合成来源边界', slug: randomUUID(), summary: '' } })
        const volume = await prisma.volume.create({ data: { novelId, title: '合成卷', orderIndex: 1 } })
        const chapters = []
        for (const orderIndex of [1, 2, 3]) chapters.push(await prisma.chapter.create({ data: {
          novelId, authorId: userId, volumeId: volume.id, orderIndex, orderInVolume: orderIndex, title: `合成章${orderIndex}`, revision: 4,
          content: orderIndex === 1 ? '钥匙已经熔毁。库门只能用这把钥匙开启。' : orderIndex === 2 ? '她走到库门外。'
            : scenario === 'real-conflict' ? `${obsolete}。` : safeBody,
        } }))
        await prisma.agentSession.create({ data: { id: sessionId, userId, novelId, title: '合成来源检查' } })
        const window = credits.getCreditWindow()
        await prisma.creditAccount.create({ data: { userId, dailyAllowanceMilli: 1000000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
        vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
        const prompt = `仅修改第3章，不修改第1、2章。原先第3章写“${obsolete}”，请核对当前稿。连续性检查必须通过。不要人类感检查。`
        const admitted = await request(app).post('/api/agent/runs')
          .set('Cookie', `chevoink_session=${buildSessionTokens(userId, 0).accessToken}`)
          .send({ novelId, sessionId, chapterId: chapters[2].id, prompt, mode: 'build' })
        expect(admitted.status).toBe(200)
        const runId = admitted.body.data.runId as string
        const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
        expect(run).toMatchObject({ runtimeProtocolVersion: 0, taskRootId: null })
        expect(taskSpecSchema.parse(run.taskSpec).scope).toMatchObject({ continuityEvidenceProtocol: 1,
          continuityReportProtocol: 5,
          writing: { kind: 'bounded', targets: [{ chapterId: chapters[2].id, orderIndex: 3 }] } })
        await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
        const ownerSeq = ((await prisma.agentRunEvent.aggregate({ where: { runId }, _max: { seq: true } }))._max.seq ?? 0) + 1
        await prisma.agentRunEvent.create({ data: { runId, seq: ownerSeq, type: 'run.started', payload: { type: 'run.started', seq: ownerSeq } } })
        const ctx: ToolContext = { userId, novelId, sessionId, runId, chapterId: chapters[2].id, callId: 'source-check',
          continuityOwnerSeq: ownerSeq,
          mode: 'build', creativeFreedom: 'stable', qualityMode: 'balanced', modelRuntime: runtime,
          signal: new AbortController().signal, emit: () => {} }
        const { compilation } = await prepareStoryCompilation({ ...ctx, mode: 'balanced', intentSummary: '只检查第三章合成稿' })
        await saveSceneTasks({ ...ctx, compilationId: compilation.id, tasks: [{ purpose: '等候', entryState: state,
          goal: '通过库门', obstacle: '缺钥匙', choice: '等候', cost: '时间', turn: '停留', exitState: state,
          styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
        const lastSeq = (await prisma.agentRunEvent.aggregate({ where: { runId }, _max: { seq: true } }))._max.seq ?? 0
        await prisma.agentRunEvent.create({ data: { runId, seq: lastSeq + 1, type: 'tool.call',
          payload: { toolName: 'continuity_validate', callId: ctx.callId, args: { compilationId: compilation.id } } } })
        const sourceId = (chapter: typeof chapters[number]) => buildQualityEvidenceSources({ userId, novelId,
          chapterId: chapter.id, chapterRevision: chapter.revision }, chapter.content).entries[0].id.slice(0, 13)
        const ids = { current: sourceId(chapters[2]), previous: sourceId(chapters[0]) }
        let sends = 0, continuedRequest = false
        vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
          sends++
          const wire = JSON.parse(String(init.body))
          expect(wire.messages[0].content).toContain(sends === 1 ? '连续性编辑' : 'sourceId')
          const input = JSON.parse(wire.messages[1].content)
          if (sends === 1) {
            expect(input).toMatchObject({ authorRequest: prompt, currentChapter: chapters[2].id,
              sources: expect.arrayContaining([expect.objectContaining({ chapterId: chapters[2].id, revision: 4, source: 'current', content: chapters[2].content }),
                expect.objectContaining({ chapterId: chapters[0].id, revision: 4, source: 'previous', content: chapters[0].content })]) })
            expect(input.sources[0].evidence).toContain(ids.current)
          } else expect(input).toMatchObject({ invalid: [{ index: 0, opinion: { severity: 'error' } }] })
          if (scenario === 'changed-during-provider') await prisma.chapter.update({ where: { id: chapters[2].id },
            data: { content: safeBody + '后来收到消息。', revision: { increment: 1 } } })
          const content = JSON.stringify(sourceReviewResponse(scenario, sends, ids, continuedRequest))
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 24, completion_tokens: 12 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
        }))
        const result = await continuityValidateTool.execute(ctx, { compilationId: compilation.id })
          .catch(error => ({ outcome: 'failed', failureCode: error.code }))
        await prisma.agentRunEvent.create({ data: { runId, seq: lastSeq + 2, type: 'tool.result',
          payload: { toolName: 'continuity_validate', callId: ctx.callId, ok: result.outcome !== 'failed',
            ...('failureCode' in result ? { failureCode: result.failureCode } : {}) } } })
        expect(result.outcome === 'failed').toBe(['history-confirm-rejected', 'changed-during-provider'].includes(scenario))
        expect(sends).toBe(['real-conflict', 'changed-during-provider', 'history-retracted'].includes(scenario) ? 1 : 2)
        const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
        if (scenario !== 'changed-during-provider') expect(saved.validation).toMatchObject({
          checkedRevision: 4, continuityReport: { version: 1, revision: 4, rawResponses: expect.any(Array) },
          independentCheck: scenario === 'history-confirm-rejected' ? 'unavailable' : 'complete',
          ...(scenario === 'real-conflict' || scenario === 'previous-misattributed' ? { errorCount: 1 } : scenario === 'history-retracted' ? { errorCount: 0 } : {}),
        })
        if (scenario === 'real-conflict') {
          const commit = await chapterBridgeCommitTool.execute({ ...ctx, callId: 'must-pass-denial' }, { compilationId: compilation.id })
            .catch(error => ({ outcome: 'failed', failureCode: error.code }))
          expect(commit).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_ERRORS_REMAIN' })
          expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).committedAt).toBeNull()
        }
        const payments = await prisma.aiUsageLog.findMany({ where: { agentRunId: runId }, orderBy: { id: 'asc' } })
        const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId }, orderBy: { id: 'asc' } })
        expect(payments).toHaveLength(sends)
        expect(ledger).toHaveLength(sends)
        expect(payments.every(p => p.billingStatus === 'settled' && p.reservedCreditMilli === 0)).toBe(true)
        if (scenario !== 'changed-during-provider' && scenario !== 'history-confirm-rejected') {
          await continuityValidateTool.execute({ ...ctx, callId: 'repeat-same-state' }, { compilationId: compilation.id }).catch(() => {})
          expect(sends).toBe(scenario === 'real-conflict' || scenario === 'history-retracted' ? 1 : 2)
          expect(await prisma.aiUsageLog.findMany({ where: { agentRunId: runId }, orderBy: { id: 'asc' } })).toEqual(payments)
          expect(await prisma.creditLedgerEntry.findMany({ where: { userId }, orderBy: { id: 'asc' } })).toEqual(ledger)
        }
        if (scenario === 'history-confirm-rejected') {
          const pause = await prisma.agentRunEvent.create({ data: { runId, seq: lastSeq + 3, type: 'run.paused', payload: {} } })
          await prisma.agentRun.update({ where: { id: runId }, data: { status: 'paused' } })
          const continued = await request(app).post(`/api/agent/runs/${runId}/continue`)
            .set('Cookie', `chevoink_session=${buildSessionTokens(userId, 0).accessToken}`).send({})
          expect(continued.status).toBe(200)
          const admission = vi.mocked(executeAgentRun).mock.calls.at(-1)![0]
          expect(admission).toMatchObject({ runId, resume: true, authorContinue: { eventId: pause.id, afterSeq: lastSeq + 3 } })
          // Only the background loop is mocked: replay the actual HTTP-admitted
          // marker, then exercise the production recovery reader and tool.
          await prisma.agentRunEvent.create({ data: { runId, seq: lastSeq + 4, type: 'run.started',
            payload: { authorContinue: admission.authorContinue } } })
          ctx.continuityOwnerSeq = lastSeq + 4
          await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
          // A known source-address failure can recover on the same body; the
          // original paid bytes/opinion survive and no new critic is needed.
          expect(await prisma.$transaction(tx => readContinuedContinuityRecovery(tx, ctx))).toHaveLength(0)
          continuedRequest = true
          await expect(continuityValidateTool.execute({ ...ctx, callId: 'author-continued' }, { compilationId: compilation.id }))
            .resolves.toMatchObject({ reviewCompleted: true, display: { errorCount: 1 } })
          expect(sends).toBe(3)
          const recovered = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
          expect(recovered.validation).toMatchObject({ independentCheck: 'complete', continuityReport: {
            opinions: [expect.objectContaining({ explanation: `第3章却写“${obsolete}”，与前文熔毁事实矛盾。` })] } })
          expect(recovered.preparedContext).toEqual(saved.preparedContext)
          await expect(continuityValidateTool.execute({ ...ctx, callId: 'continued-repeat' }, { compilationId: compilation.id }))
            .resolves.toMatchObject({ reviewCompleted: true })
          expect(sends).toBe(3)
          expect(await prisma.aiUsageLog.findMany({ where: { id: { in: payments.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(payments)
          expect(await prisma.creditLedgerEntry.findMany({ where: { id: { in: ledger.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(ledger)
          expect(await prisma.aiUsageLog.count({ where: { agentRunId: runId } })).toBe(3)
        }
        for (const chapter of chapters.slice(0, 2)) {
          await expect(chapterWriteTool.execute({ ...ctx, callId: `deny-${chapter.id}` }, { chapterId: chapter.id, content: '未授权替换' }))
            .rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
          expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
        }
        if (scenario !== 'changed-during-provider') expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapters[2].id } })).toEqual(chapters[2])
      } finally {
        await prisma.memoryExtractionJob.deleteMany({ where: { novelId } })
        await prisma.projectMemoryEntry.deleteMany({ where: { novelId } })
        await prisma.aiUsageLog.deleteMany({ where: { userId } })
        await prisma.agentArtifact.deleteMany({ where: { run: { userId, novelId } } })
        await prisma.agentRun.deleteMany({ where: { userId } })
        await prisma.agentSession.deleteMany({ where: { userId } })
        await prisma.chapter.deleteMany({ where: { authorId: userId } })
        await prisma.novel.deleteMany({ where: { id: novelId, authorId: userId } })
        await prisma.user.deleteMany({ where: { id: userId } })
      }
    })
})
