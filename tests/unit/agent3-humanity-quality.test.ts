import { afterEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import * as aiService from '../../api/lib/ai-service.js'
import * as review from '../../api/lib/agent/review-completion.js'
import * as auxiliaryRuntime from '../../api/lib/agent/runtime-auxiliary-call.js'
import * as formatRecovery from '../../api/lib/agent/quality-format-recovery.js'
import * as repairAudit from '../../api/lib/agent/quality-repair-audit.js'
import { beginTextRequest } from '../../api/lib/text-request-trace.js'
import { selectAutomaticQualityFindings, qualityAutoRepairPending } from '../../api/lib/agent/quality-report-contract.js'

// 自动修订的准入守卫在事务里读真实表；本组用例只验证工具语义，按模块隔离守卫。
const guard = vi.hoisted(() => ({ probe: vi.fn(), assert: vi.fn(), channel: vi.fn(), guidance: vi.fn(),
  readiness: vi.fn().mockResolvedValue(null), decisions: vi.fn().mockReturnValue('当前报告须逐项写明保留原因。') }))
vi.mock('../../api/lib/agent/chapter-review-guard.js', () => ({
  createChapterReviewReadScope: () => ({ inheritanceScope: { identities: new Set(), authenticating: new Set(), authenticated: new Map() }, terminalDraftScope: new WeakMap() }),
  probeChapterReviewRevision: guard.probe, assertChapterReviewRevision: guard.assert,
  isChapterRevisionChannelOpen: guard.channel, readChapterReviewRevisionGuidance: guard.guidance,
  readChapterReviewReadiness: guard.readiness, chapterReviewDecisionGuidance: guard.decisions,
}))

import {
  humanityQualitySignalSchema,
  qualityFindingDispositionSchema,
  qualityFindingFeedbackSchema,
} from '../../shared/contracts/index.js'
import { analyzeDeterministicQuality, calibrateCriticFindings, resolveQualityChapterTarget, hasCommittedTaskChapter, prepareQualityFindings } from '../../api/lib/agent/humanity-quality.js'
import { allTools } from '../../api/lib/agent/tools/registry.js'
import { AGENT_TOOL_GOVERNANCE } from '../../api/lib/agent/tools/governance.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as humanityQuality from '../../api/lib/agent/humanity-quality.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { buildQualityEvidenceSources, coerceCriticFindings } from '../../api/lib/agent/quality-evidence.js'
import { DataAccessError, prisma } from '../../api/lib/prisma.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

describe('frozen source IDs through quality report preparation', () => {
  it('locates a repeated sentence at the selected exact source offset', () => {
    const content = '他关了门。他关了门。'
    const sources = buildQualityEvidenceSources({ userId: 'u', novelId: 'n', chapterId: 'c', chapterRevision: 7 }, content)
    const parsed = coerceCriticFindings({ findings: [{ sourceId: sources.entries[1].id, signal: 'explanation_echo', severity: 'advisory',
      explanation: '同一动作机械重复', suggestion: '删去重复动作' }] }, sources)!
    const prepared = prepareQualityFindings(content, [], parsed.findings, true, sources)
    expect(prepared.complete).toBe(true)
    expect(prepared.findings).toMatchObject([{ start: 5, end: 10, evidence: '他关了门。' }])
  })
  it('cannot turn a mixture of located and invalid source IDs into a complete persisted conclusion', () => {
    const content = '他关了门。他关了门。'
    const sources = buildQualityEvidenceSources({ userId: 'u', novelId: 'n', chapterId: 'c', chapterRevision: 7 }, content)
    const finding = { sourceId: sources.entries[1].id, quote: sources.entries[1].text, signal: 'explanation_echo' as const,
      severity: 'advisory' as const, explanation: '机械重复', suggestion: '删去重复', confidence: 0.8 }
    expect(prepareQualityFindings(content, [], [finding, { ...finding, sourceId: 'foreign' }], true, sources).complete).toBe(false)
    expect(prepareQualityFindings(content, [], [finding], true).complete).toBe(false)
  })
})

describe('next chapter delivery evidence', () => {
  const row = { status: 'completed', stage: 'commit', chapterId: 'c', chapter: { id: 'c', novelId: 'n', wordCount: 3000, revision: 4,
    archivedAt: null, volume: { novelId: 'n', archivedAt: null } }, bridge: { toChapterId: 'c', targetRevision: 4, committedAt: new Date() } }
  const makeDb = (rows: unknown[]) => {
    const findMany = vi.fn().mockResolvedValue(rows)
    return { findMany, db: { agentRun: { findFirst: vi.fn().mockResolvedValue({ taskRootId: 'root' }) }, storyCompilation: { findMany } } as unknown as Prisma.TransactionClient }
  }
  it('zero tool output or a completed todo list cannot certify a chapter', async () => {
    const { db, findMany } = makeDb([])
    expect(await hasCommittedTaskChapter(db, 'u', 'n', 'r')).toBe(false)
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u', novelId: 'n', run: { userId: 'u', novelId: 'n', taskRootId: 'root' }, status: { not: 'abandoned' } } }))
  })
  it('accepts a previously committed current revision after resume without requiring another rewrite', async () => {
    expect(await hasCommittedTaskChapter(makeDb([row]).db, 'u', 'n', 'r')).toBe(true)
  })
  it.each([
    { ...row, status: 'active' }, { ...row, stage: 'write' }, { ...row, chapter: null },
    { ...row, chapter: { ...row.chapter, wordCount: 0 } },
    { ...row, chapter: { ...row.chapter, novelId: 'foreign' } },
    { ...row, chapter: { ...row.chapter, archivedAt: new Date() } },
    { ...row, chapter: { ...row.chapter, volume: { novelId: 'n', archivedAt: new Date() } } },
    { ...row, chapter: { ...row.chapter, volume: { novelId: 'foreign', archivedAt: null } } },
    { ...row, bridge: null }, { ...row, bridge: { ...row.bridge, committedAt: null } },
    { ...row, bridge: { ...row.bridge, targetRevision: 3 } },
    { ...row, bridge: { ...row.bridge, toChapterId: 'another' } },
  ])('rejects missing, stale or mismatched evidence %#', async incomplete => {
    expect(await hasCommittedTaskChapter(makeDb([incomplete]).db, 'u', 'n', 'r')).toBe(false)
    expect(await hasCommittedTaskChapter(makeDb([row, incomplete]).db, 'u', 'n', 'r')).toBe(false)
  })
})

describe('质量检查默认目标', () => {
  const input = { userId: 'u', novelId: 'n', runId: 'r', fallbackChapterId: 'old-editor' }
  function database(chapters: Array<string | null>, taskRootId: string | null = 'root') {
    const run = vi.fn().mockResolvedValue({ taskRootId })
    const compilations = vi.fn().mockResolvedValue(chapters.map(chapterId => ({ chapterId })))
    return { run, compilations, db: { agentRun: { findFirst: run }, storyCompilation: { findMany: compilations } } as unknown as Prisma.TransactionClient }
  }
  it('无参数检查当前任务章节而非旧编辑页，并限制用户、作品及恢复任务根', async () => {
    const { db, run, compilations } = database(['new-chapter'])
    expect(await resolveQualityChapterTarget(input, db)).toBe('new-chapter')
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r', userId: 'u', novelId: 'n' } }))
    expect(compilations).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u', novelId: 'n', status: { in: ['active', 'completed'] }, run: { userId: 'u', novelId: 'n', taskRootId: 'root' } }, take: 2 }))
  })
  it('章节与编译编号配对校验，不能跨任务或混用对象身份', async () => {
    const { db } = database([])
    const findFirst = vi.fn().mockResolvedValue({ chapterId: 'target' })
    db.storyCompilation.findFirst = findFirst
    expect(await resolveQualityChapterTarget({ ...input, chapterId: 'target', compilationId: 'compiler' }, db)).toBe('target')
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'compiler', run: { userId: 'u', novelId: 'n', taskRootId: 'root' } }) }))
    await expect(resolveQualityChapterTarget({ ...input, chapterId: 'wrong', compilationId: 'compiler' }, db)).rejects.toMatchObject({ code: 'QUALITY_TARGET_AMBIGUOUS' })
    findFirst.mockResolvedValue(null)
    await expect(resolveQualityChapterTarget({ ...input, chapterId: 'target', compilationId: 'foreign' }, db)).rejects.toMatchObject({ code: 'QUALITY_TARGET_AMBIGUOUS' })
    await expect(resolveQualityChapterTarget({ ...input, runId: undefined, chapterId: 'target', compilationId: 'compiler' }, db)).rejects.toMatchObject({ code: 'QUALITY_RUN_SCOPE_INVALID' })
  })
  it('显式章节保持优先，无编译的普通审阅继续使用当前编辑章节', async () => {
    const { db, compilations } = database([])
    expect(await resolveQualityChapterTarget({ ...input, chapterId: 'explicit' }, db)).toBe('explicit')
    expect(compilations).not.toHaveBeenCalled()
    expect(await resolveQualityChapterTarget(input, db)).toBe('old-editor')
  })
  it('传统续跑按合同ID关联，只接受同会话同作品同用户的原任务', async () => {
    const { db, run, compilations } = database(['target'], null)
    const taskSpec = buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '写下一章' })
    const startedAt = new Date('2026-09-19T19:22:41Z')
    run.mockResolvedValue({ taskRootId: null, runtimeProtocolVersion: 0, sessionId: 's', taskSpec, createdAt: startedAt })
    expect(await resolveQualityChapterTarget(input, db)).toBe('target')
    expect(compilations).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ run: {
      userId: 'u', novelId: 'n', sessionId: 's', runtimeProtocolVersion: 0, taskRootId: null, taskSpec: { path: ['id'], equals: taskSpec.id },
    } }) }))
    expect(compilations).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({
      AND: [{ OR: [{ chapterId: null }, { chapter: { createdAt: { gte: startedAt } } }] }],
    }) }))
    run.mockResolvedValue({ taskRootId: null, runtimeProtocolVersion: 0, sessionId: 's', taskSpec: { ...taskSpec, runId: 'foreign' } })
    await expect(resolveQualityChapterTarget(input, db)).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
  })
  it('指定编译必须在当前运行作用域，不能失败后回退旧章节', async () => {
    const { db, compilations } = database([], null)
    await expect(resolveQualityChapterTarget({ ...input, compilationId: 'foreign' }, db)).rejects.toMatchObject({ code: 'QUALITY_TARGET_AMBIGUOUS' })
    expect(compilations).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u', novelId: 'n', status: { in: ['active', 'completed'] }, run: { id: 'r', userId: 'u', novelId: 'n' }, id: 'foreign' } }))
  })
  it.each([[null], ['a', 'b']])('未绑定或多个活跃章节要求明确目标，不猜测', async (...chapters) => {
    const { db } = database(chapters)
    await expect(resolveQualityChapterTarget(input, db)).rejects.toMatchObject({ code: 'QUALITY_TARGET_AMBIGUOUS' })
  })
  it('无效运行不得跨任务找编译，无运行只允许普通章节审阅', async () => {
    const { db, run, compilations } = database([])
    run.mockResolvedValue(null)
    await expect(resolveQualityChapterTarget(input, db)).rejects.toMatchObject({ code: 'QUALITY_RUN_SCOPE_INVALID' })
    expect(compilations).not.toHaveBeenCalled()
    expect(await resolveQualityChapterTarget({ ...input, runId: undefined }, db)).toBe('old-editor')
    await expect(resolveQualityChapterTarget({ ...input, runId: undefined, compilationId: 'c' }, db)).rejects.toMatchObject({ code: 'QUALITY_RUN_SCOPE_INVALID' })
  })
})

describe('质量检查工具与编号配对失败回执', () => {
  afterEach(() => { vi.restoreAllMocks() })
  const ctx: ToolContext = { userId: 'u', novelId: 'n', chapterId: 'editor-chapter', sessionId: 's', runId: 'r',
    callId: 'quality', mode: 'build', creativeFreedom: 'stable', qualityMode: 'balanced', emit: () => {}, signal: new AbortController().signal }
  it('章号与编译号不匹配保持失败回执，不把编号混用变成运行异常', async () => {
    const conflict = new DataAccessError(409, 'QUALITY_TARGET_AMBIGUOUS', 'chapterId 与 compilationId 不对应')
    const resolve = vi.spyOn(humanityQuality, 'resolveQualityChapterTarget').mockRejectedValue(conflict)
    expect(await qualityAnalyzeTool.execute(ctx, { chapterId: 'target', compilationId: 'compiler' })).toEqual({
      outcome: 'failed', summary: '质量检查目标不匹配', output: conflict.message,
    })
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u', novelId: 'n', runId: 'r',
      chapterId: 'target', compilationId: 'compiler', fallbackChapterId: 'editor-chapter' }))
  })
  it('运行作用域等真实错误保持上抛，不被失败回执吞掉', async () => {
    const failure = new DataAccessError(409, 'QUALITY_RUN_SCOPE_INVALID', '编译编号必须属于当前任务')
    vi.spyOn(humanityQuality, 'resolveQualityChapterTarget').mockRejectedValue(failure)
    await expect(qualityAnalyzeTool.execute(ctx, { chapterId: 'target', compilationId: 'compiler' })).rejects.toBe(failure)
  })
})

describe('严谨创作自动落实质量建议', () => {
  afterEach(() => vi.restoreAllMocks())
  const digest = (content: string) => createHash('sha256').update(content).digest('hex')
  function fixture(cached: boolean, behavior = 'apply') {
    const audit = vi.spyOn(repairAudit, 'persistQualityRepairAttemptAudit').mockImplementation(async () => {})
    guard.probe.mockReset().mockResolvedValue({ open: true })
    guard.readiness.mockReset().mockResolvedValue(null)
    guard.decisions.mockReset().mockReturnValue('当前报告须逐项写明保留原因。')
    // 付费前探测与写入守卫走同一准入；这里只验证工具语义，不连接真实事务。
    vi.spyOn(prisma, '$transaction').mockImplementation(async work => (work as (tx: Prisma.TransactionClient) => Promise<unknown>)({} as Prisma.TransactionClient))
    const content = Array.from({ length: 8 }, (_, index) => `证据${index}。`).join('')
    const chapter = { id: 'c', title: '本章', revision: 1, content, novel: { tagNames: [] } }
    const report = { id: 'q', runId: 'r', compilationId: null, chapterId: 'c', chapterRevision: 1, status: 'passed', repairRound: 0,
      criticVersion: humanityQuality.HUMANITY_CRITIC_VERSION, chapter, deterministicMetrics: { independentCheck: 'complete', contentHash: digest(content) },
      findings: Array.from({ length: 8 }, (_, index) => ({ id: `f${index}`, signal: 'emotion_grounding', severity: 'advisory', disposition: 'pending', authorFeedback: null,
        startOffset: index * 4, endOffset: index * 4 + 4, evidenceExcerpt: `证据${index}。`, explanation: '需要具体动作', suggestion: '局部补足' })) } as unknown as Awaited<ReturnType<typeof humanityQuality.getQualityReport>>
    vi.spyOn(humanityQuality, 'resolveQualityChapterTarget').mockResolvedValue('c')
    const bundle = { chapter, compilation: null, charter: null, recentChapters: [], profiles: [], anchors: [], feedback: [], originalRequest: '本次写都市异能爽文第一章；主角周砚，29岁，设备维护员；1800字；停在买主报价前；只输出标题与正文。', chapterWritingBackground: [] } as unknown as Awaited<ReturnType<typeof humanityQuality.buildHumanityQualityContext>>
    report.deterministicMetrics = { ...report.deterministicMetrics as Prisma.JsonObject, qualityContextHash: humanityQuality.qualityReviewContextHash(bundle) }
    vi.spyOn(humanityQuality, 'buildHumanityQualityContext').mockResolvedValue(bundle)
    vi.spyOn(humanityQuality, 'getLatestQualityReport').mockResolvedValue(cached ? report : null)
    vi.spyOn(humanityQuality, 'getQualityReport').mockImplementation(async () => report)
    vi.spyOn(humanityQuality, 'analyzeDeterministicQuality').mockReturnValue({ metrics: {}, findings: [] })
    vi.spyOn(humanityQuality, 'persistHumanityQualityReport').mockResolvedValue(report)
    const critic = vi.spyOn(review, 'generateReviewCompletion').mockImplementation(async (system, input, options) => options.action === 'agent3HumanityEvidenceCorrection' ? model(system, input, options) : '{"findings":[]}')
    vi.spyOn(auxiliaryRuntime, 'resolveReviewModelRuntime').mockResolvedValue({ tier: 'speed', provider: 'fixture', modelName: 'fixture',
      apiKey: 'fixture-only', reasoningEffort: 'low', reasoningEfforts: ['none', 'low'], multiplierBps: 10000, visionEnabled: false, contextWindowTokens: null })
    // This mock critic does not create settled usage. It cannot authorize a
    // recovery payment; real paid witnesses have separate PG coverage.
    vi.spyOn(formatRecovery, 'claimCurrentQualityFormatRecovery').mockResolvedValue(null)
    const reserve = vi.spyOn(humanityQuality, 'reserveQualityAutoRepair').mockImplementation(async () => {
      if (!qualityAutoRepairPending(report)) return false
      report.deterministicMetrics = { ...report.deterministicMetrics as Prisma.JsonObject, autoRepairAttempted: true }
      return true
    })
    vi.spyOn(humanityQuality, 'selectQualityFindings').mockResolvedValue(report)
    const model = vi.spyOn(aiService, 'generateTextCompletion').mockImplementation(async () => JSON.stringify({ patches: report.findings.flatMap(finding => {
      const patch = { findingId: finding.id, replacement: behavior === 'no-op' ? finding.evidenceExcerpt : '具体动作。' }
      return behavior === 'duplicate' ? [patch, patch] : [patch]
    }) }))
    const write = vi.spyOn(humanityQuality, 'applyQualityRepair').mockImplementation(async input => {
      if (behavior === 'stale') throw new DataAccessError(409, 'QUALITY_REPORT_STALE', '正文版本已变化')
      input.signal?.throwIfAborted()
      report.status = 'repaired'; report.repairRound = 1; report.chapterRevision = 2
      report.chapter = { ...report.chapter, revision: 2, content: '修订正文' }
      report.deterministicMetrics = { ...report.deterministicMetrics as Prisma.JsonObject, repairedContentHash: digest('修订正文') }
      report.findings.forEach(item => { item.disposition = 'repaired' })
      return { report, updated: report.chapter, before: content, after: '修订正文', repairedFindingIds: input.replacements.map(item => item.findingId) }
    })
    const ctx: ToolContext = { userId: 'u', novelId: 'n', chapterId: 'c', sessionId: 's', runId: 'r', callId: 'q', mode: 'build',
      creativeFreedom: 'balanced', qualityMode: 'premium', signal: new AbortController().signal, emit: () => {} }
    return { ctx, report, critic, reserve, model, write, bundle, audit }
  }
  it.each([true, false])('final verification retains new stylistic advice without another paid patch (cached=%s)', async cached => {
    const f = fixture(cached), before = structuredClone(f.report)
    guard.readiness.mockResolvedValue({ chapterId: 'c', ready: true, reviewCycle: { edited: true }, qualityPassRequired: false, mustPassPending: false })
    guard.decisions.mockReturnValueOnce('当前必要检查已保存，下一步调用一次 chapter_bridge_commit 提交当前版本。')
    const result = await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(result.output).toContain('修订后的核验意见保留供作者参考')
    expect(result.summary).toBe('质量核验完成 · 0 关注 8 建议')
    expect(result.summary).not.toContain('待决定')
    expect(result.output).toContain('无需为清零建议继续润色')
    expect(result.output).toContain('下一步调用一次 chapter_bridge_commit 提交当前版本')
    expect(result.output).not.toContain('不要为这些纯建议再调用正文写入工具')
    expect(result.output).not.toContain('当前阶段也不因此获得改文权限')
    expect(result.output).not.toContain('也不因此重开改文')
    expect(result.output).not.toContain('逐项写明保留原因')
    expect(result.output).not.toContain('修改后复查连续性与人类感，再提交章节')
    expect(f.reserve).not.toHaveBeenCalled()
    expect(f.model).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
    expect(f.report.chapterRevision).toBe(1)
    expect(f.report.findings.every(item => item.disposition === 'pending')).toBe(true)
    expect(f.report).toEqual(before)
  })
  it.each([true, false])('reports completed cached=%s advice counts without an author-approval summary', async cached => {
    const f = fixture(cached); f.ctx.creativeFreedom = 'stable'
    const before = JSON.stringify(f.report)
    const result = await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(result.summary).toBe('人类感质量检查完成' + (cached ? '（复用）' : '') + ' · 0 关注 8 建议')
    expect(result.summary).not.toContain('待决定')
    expect(result.output).toContain('8 个建议')
    expect(f.reserve).not.toHaveBeenCalled(); expect(f.model).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled()
    expect(JSON.stringify(f.report)).toBe(before)
  })
  it('does not waive a genuine error or explicit mandatory pass at final verification', async () => {
    const f = fixture(true)
    guard.readiness.mockResolvedValue({ chapterId: 'c', reviewCycle: { edited: true }, qualityPassRequired: true, mustPassPending: true })
    await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(f.reserve).toHaveBeenCalledOnce()
    expect(f.model).toHaveBeenCalledOnce()
    expect(f.write).toHaveBeenCalledOnce()
  })
  it('sends the complete author constraints to the critic without adding a repair call', async () => {
    const f = fixture(false)
    // 只验证 Critic 输入装配时用稳定模式隔离自动修订路径。
    f.ctx.creativeFreedom = 'stable'
    await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(f.critic.mock.calls[0][1]).toContain(JSON.stringify(f.bundle.originalRequest))
    expect(f.critic.mock.calls[0][1]).toContain('首章收益与情绪强度')
    expect(f.critic).toHaveBeenCalledOnce()
    expect(f.write).not.toHaveBeenCalled()
  })
  it('exposes the actual explanation and explicit retain without writing or retrying the pending warning', async () => {
    const f = fixture(true)
    f.report.status = 'needs_repair'
    f.report.findings[0].explanation = 'A valid quote can still have a mistaken explanation.'
    const retainedFindings = f.report.findings.map(item => ({ findingId: item.id, reason: `Keep ${item.id}: the original negation supports the fact.` }))
    f.model.mockResolvedValue(JSON.stringify({ patches: [], retainedFindings }))
    const result = await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(f.model).toHaveBeenCalledOnce()
    expect(f.write).not.toHaveBeenCalled()
    expect(result.semanticTransition).toBeUndefined()
    expect(result.output).toContain(f.report.findings[0].explanation)
    expect(result.output).toContain(retainedFindings[0].reason)
    expect(result.output).toContain('"findingId":"f0"')
    expect(result.output).toContain('"start":0')
    expect(f.report).toMatchObject({ status: 'needs_repair', chapterRevision: 1, repairRound: 0 })
    expect(f.report.findings.every(item => item.disposition === 'pending' && item.authorFeedback === null)).toBe(true)
    expect(f.audit.mock.calls.at(-1)![1]).toMatchObject({ classifications: ['valid_retain'], counts: { retained: 8, accepted: 0, missing: 0 } })
    await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(f.model).toHaveBeenCalledOnce()
  })
  it('applies only actual patches and forwards the explicit retain reasons through existing write admission', async () => {
    const f = fixture(true)
    const retainedFindings = f.report.findings.slice(1).map(item => ({ findingId: item.id, reason: `Specific reason for ${item.id}` }))
    f.model.mockResolvedValue(JSON.stringify({ patches: [{ findingId: 'f0', replacement: 'A concrete change.' }], retainedFindings }))
    const result = await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(f.model).toHaveBeenCalledOnce()
    expect(f.write).toHaveBeenCalledWith(expect.objectContaining({ replacements: [{ findingId: 'f0', replacement: 'A concrete change.' }],
      retainedFindings: retainedFindings.map(item => ({ source: 'quality', reportId: 'q', ...item })) }))
    expect(result.output).toContain(retainedFindings[0].reason)
    expect(f.audit.mock.calls.at(-1)![1]).toMatchObject({ classifications: ['valid_patch', 'valid_retain'], counts: { retained: 7, accepted: 1 } })
  })
  it('provides the patcher the original intent and read-only context, bound at write time', async () => {
    const f = fixture(true)
    const result = await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(result.display).toMatchObject({ kind: 'qualityReport', appliedBodyChange: { version: 1, chapterId: 'c',
      before: f.bundle.chapter.content, after: '修订正文', sourceRevision: 1, targetRevision: 2 } })
    expect(result.semanticTransition).toMatchObject({ targetId: 'chapter:c', beforeHash: expect.stringMatching(/^[a-f0-9]{64}$/u), afterHash: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(result.semanticTransition?.beforeHash).not.toBe(result.semanticTransition?.afterHash)
    expect(f.model.mock.calls[0][1]).toContain(f.bundle.originalRequest!)
    expect(f.model.mock.calls[0][1]).toContain('"before"')
    expect(f.write).toHaveBeenCalledWith(expect.objectContaining({ expectedContextHash: humanityQuality.qualityReviewContextHash(f.bundle) }))
    expect(f.model.mock.calls[0][2]).toMatchObject({ userId: 'u', novelId: 'n', agentRunId: 'r', action: 'agent3HumanityRevision', targetId: 'q' })
  })
  it('retains a patch that copies read-only neighbor prose without another paid repair attempt', async () => {
    const f = fixture(true)
    const before = '控制阀位于平台的西北角。', evidence = '她转身看了一眼。'
    f.report.chapter.content = before + evidence
    f.report.findings = [{ ...f.report.findings[0], startOffset: before.length, endOffset: before.length + evidence.length, evidenceExcerpt: evidence }]
    f.report.deterministicMetrics = { ...f.report.deterministicMetrics as Prisma.JsonObject, contentHash: digest(f.report.chapter.content), qualityContextHash: humanityQuality.qualityReviewContextHash(f.bundle) }
    f.model.mockResolvedValue(JSON.stringify({ patches: [{ findingId: f.report.findings[0].id, replacement: '控制阀位于平台的西北角，她低头看了一眼。' }] }))
    const result = await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(f.model).toHaveBeenCalledOnce()
    expect(f.write).not.toHaveBeenCalled()
    expect(result.semanticTransition).toBeUndefined()
    expect(result.output).toContain('正文未修改')
    expect(f.report.findings[0].disposition).toBe('pending')
    expect(f.audit.mock.calls.at(-1)![1]).toMatchObject({ state: 'returned', classifications: ['unsafe_patch'], counts: { unsafe: 1, accepted: 0 } })
  })
  it('attributes the critic and every bounded repair attempt to the executing run', async () => {
    const f = fixture(false, 'duplicate')
    await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(f.critic).toHaveBeenCalledOnce()
    expect(f.critic.mock.calls[0][2]).toMatchObject({ agentRunId: 'r', targetType: 'chapter', targetId: 'c' })
    expect(f.model).toHaveBeenCalledTimes(2)
    expect(f.model.mock.calls.map(call => call[2])).toEqual([
      expect.objectContaining({ agentRunId: 'r', action: 'agent3HumanityRevision', targetId: 'q' }),
      expect.objectContaining({ agentRunId: 'r', action: 'agent3HumanityRevisionRetry', targetId: 'q' }),
    ])
    expect(f.write).not.toHaveBeenCalled()
  })
  it.each(['parse_error', 'schema_error', 'missing_patch', 'no_op'] as const)('audits both returned repair responses and the exact %s retry cause without storing private text', async classification => {
    const f = fixture(true)
    const raw = classification === 'parse_error' ? '{"patches":[' : classification === 'schema_error' ? '{"patches":[{"findingId":1}]}'
      : JSON.stringify({ patches: [{ findingId: 'f0', replacement: classification === 'no_op' ? '证据0。' : '已补动作。' }] })
    f.model.mockResolvedValueOnce(raw)
    await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(f.model).toHaveBeenCalledTimes(2)
    const audits = f.audit.mock.calls.map(([, audit]) => structuredClone(audit))
    const first = audits.find(audit => audit.attempt === 1 && audit.state === 'returned')!
    const second = audits.find(audit => audit.attempt === 2 && audit.state === 'returned')!
    expect(first.classifications).toContain(classification)
    expect(first.response).toEqual({ contentHash: digest(raw), characterCount: raw.length })
    expect(second.trigger).toBe(classification === 'no_op' ? 'mixed_unresolved' : classification)
    expect(second).toMatchObject({ runId: 'r', callId: 'q', reportId: 'q', sourceRevision: 1, action: 'agent3HumanityRevisionRetry' })
    expect(JSON.stringify(audits)).not.toContain(f.bundle.originalRequest!)
    expect(JSON.stringify(audits)).not.toContain('已补动作')
    expect(JSON.stringify(audits)).not.toContain('fixture-only')
  })
  it('records unknown transport with its original billing reference and rethrows the identical error without retry', async () => {
    const f = fixture(true), error = new DataAccessError(504, 'AI_PROVIDER_TIMEOUT', 'private provider payload must not be stored')
    f.model.mockImplementation(async () => { const { record } = beginTextRequest('original-usage'); record.status = 'unknown'; throw error })
    await expect(qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })).rejects.toBe(error)
    expect(f.model).toHaveBeenCalledOnce(); expect(f.write).not.toHaveBeenCalled()
    const audit = f.audit.mock.calls.at(-1)![1]
    expect(audit).toMatchObject({ state: 'request_error', classifications: ['transport_unknown'], errorCode: 'AI_PROVIDER_TIMEOUT',
      requests: [{ usageId: 'original-usage', status: 'unknown', billingKnown: false }] })
    expect(JSON.stringify(audit)).not.toContain(error.message)
  })
  it('retains a returned format failure with unknown billing without dispatching a second paid request or changing prose', async () => {
    const f = fixture(true)
    f.model.mockImplementation(async () => { const { record } = beginTextRequest('unsettled-original'); record.status = 'unknown'; return '{"patches":[' })
    await expect(qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })).rejects.toMatchObject({ code: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    expect(f.model).toHaveBeenCalledOnce(); expect(f.write).not.toHaveBeenCalled()
    expect(f.audit.mock.calls.at(-1)![1]).toMatchObject({ state: 'returned', classifications: ['parse_error'],
      requests: [{ usageId: 'unsettled-original', status: 'unknown', billingKnown: false }] })
  })
  it('keeps a transport error and its prepared witness when saving the final audit also fails', async () => {
    const f = fixture(true), error = new DataAccessError(502, 'AI_PROVIDER_TRANSPORT', 'private payload')
    f.audit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('audit database unavailable'))
    f.model.mockRejectedValue(error)
    await expect(qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })).rejects.toBe(error)
    expect(f.model).toHaveBeenCalledOnce(); expect(f.write).not.toHaveBeenCalled(); expect(f.audit).toHaveBeenCalledTimes(2)
  })
  it('does not call a paid patcher after neighbor context changes during review', async () => {
    const f = fixture(true)
    vi.mocked(humanityQuality.buildHumanityQualityContext).mockResolvedValueOnce(f.bundle)
      .mockResolvedValue({ ...f.bundle, originalRequest: '已经改变的作者要求。' })
    const result = await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'QUALITY_SOURCE_STALE' })
    expect(f.model).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })
  it('separates a returned critic from its failed local finding save without claiming assessment success', async () => {
    const f = fixture(false)
    f.ctx.creativeFreedom = 'stable'
    vi.mocked(humanityQuality.persistHumanityQualityReport).mockRejectedValue(new Prisma.PrismaClientKnownRequestError('conflicting finding', {
      code: 'P2002', clientVersion: 'fixture', meta: { target: ['report_id', 'source', 'signal', 'evidence_hash'] },
    }))
    const result = await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'QUALITY_REPORT_SAVE_FAILED',
      reviewRequestFinished: { version: 1, chapterId: 'c', revision: 1, contentHash: digest(f.bundle.chapter.content) } })
    expect(result.display).toBeUndefined()
    expect(f.critic).toHaveBeenCalledOnce()
    expect(f.model).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })
  it.each(['other-constraint', 'not-returned', 'correction-interrupted'])('does not certify a finished request for %s', async scenario => {
    const f = fixture(false)
    f.ctx.creativeFreedom = 'stable'
    const error = new Prisma.PrismaClientKnownRequestError('conflicting finding', { code: 'P2002', clientVersion: 'fixture',
      meta: { target: scenario === 'other-constraint' ? ['id'] : ['report_id', 'source', 'signal', 'evidence_hash'] } })
    vi.mocked(humanityQuality.persistHumanityQualityReport).mockRejectedValue(error)
    const interruption = new Error('stream interrupted after partial evidence')
    if (scenario === 'not-returned') f.critic.mockRejectedValue(interruption)
    if (scenario === 'correction-interrupted') {
      f.critic.mockResolvedValueOnce(JSON.stringify({ findings: [{ sourceId: 'foreign', signal: 'emotion_grounding', severity: 'advisory',
        quote: '证据0。', explanation: '具体动作', suggestion: '保留', confidence: 0.8 }] }))
      f.model.mockRejectedValue(interruption)
    }
    await expect(qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })).rejects.toBe(scenario === 'correction-interrupted' ? interruption : error)
    expect(f.critic).toHaveBeenCalledTimes(scenario === 'correction-interrupted' ? 2 : 1)
    expect(f.write).not.toHaveBeenCalled()
  })
  it.each(['noise', 'ambiguous', 'foreign-source'] as const)('legacy critic %s keeps all judgments and only corrects invalid references', async scenario => {
    const f = fixture(false)
    f.ctx.creativeFreedom = 'stable'
    const valid = { signal: 'emotion_grounding', severity: 'advisory', quote: '证据0。', explanation: '具体动作', suggestion: '保留声音', confidence: 0.8 }
    const raw = scenario === 'noise' ? '参考 {"note":"not a report"}\n```json\n{"findings":[]}\n```\n{"note":"end"}'
      : scenario === 'ambiguous' ? '{"findings":[]}\n{"findings":[]}'
        : JSON.stringify({ findings: [valid, { ...valid, sourceId: 'foreign' }] })
    f.critic.mockResolvedValueOnce(raw)
    if (scenario !== 'noise') f.report.status = 'failed'
    const result = await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(humanityQuality.persistHumanityQualityReport).toHaveBeenCalledWith(expect.objectContaining({
      criticComplete: scenario === 'noise', criticDropped: 0,
      criticFindings: scenario === 'foreign-source' ? [valid, { ...valid, sourceId: 'foreign' }] : [],
      criticResponseDiagnostic: expect.objectContaining({ version: 1, contentHash: digest(raw), characterCount: raw.length,
        classification: scenario === 'noise' ? 'complete' : scenario === 'ambiguous' ? 'ambiguous_envelope' : 'source_invalid' }),
    }))
    if (scenario !== 'noise') expect(result).toMatchObject({ outcome: 'failed', failureCode: scenario === 'foreign-source' ? 'QUALITY_EVIDENCE_UNLOCATED' : 'QUALITY_REPORT_INCOMPLETE' })
    expect(f.critic).toHaveBeenCalledTimes(scenario === 'foreign-source' ? 2 : 1)
    if (scenario === 'foreign-source') {
      expect(f.model).toHaveBeenCalledOnce()
      expect(f.model.mock.calls[0][2]).toMatchObject({ action: 'agent3HumanityEvidenceCorrection', explicitModelSelection: true })
      expect(humanityQuality.persistHumanityQualityReport).toHaveBeenCalledWith(expect.objectContaining({
        criticResponseDiagnostic: expect.objectContaining({ evidenceCorrection: { returned: true, contentHash: expect.any(String), characterCount: expect.any(Number) } }),
      }))
    } else expect(f.model).not.toHaveBeenCalled()
    expect(f.reserve).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })
  it('does not reuse an otherwise valid report for a different original style request', async () => {
    const f = fixture(true)
    f.ctx.creativeFreedom = 'stable'
    f.bundle.originalRequest = '这次改写成慢热现实故事，不要爽文，仍停在买主报价前。'
    await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(f.critic).toHaveBeenCalledOnce()
    expect(f.critic.mock.calls[0][1]).toContain(JSON.stringify(f.bundle.originalRequest))
    expect(f.critic.mock.calls[0][1]).not.toContain('首章收益与情绪强度')
    expect(f.write).not.toHaveBeenCalled()
  })
  it('invalidates pre-context-v3 cache even for identical prose and author context, without repairing or editing it', async () => {
    const f = fixture(true)
    f.ctx.creativeFreedom = 'stable'
    const b = f.bundle
    const oldHash = digest(JSON.stringify({ contextProtocol: 2,
      chapter: { title: b.chapter.title, revision: b.chapter.revision, content: b.chapter.content, novel: b.chapter.novel },
      charter: b.charter, compiler: null, profiles: b.profiles, anchors: b.anchors, recentChapters: b.recentChapters,
      feedback: b.feedback, originalRequest: b.originalRequest, chapterWritingBackground: b.chapterWritingBackground }))
    f.report.deterministicMetrics = { ...f.report.deterministicMetrics as Prisma.JsonObject, qualityContextHash: oldHash, criticPromptProtocol: 'humanity-context.v2' }
    expect(humanityQuality.qualityReviewContextHash(b)).not.toBe(oldHash)
    await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(f.critic).toHaveBeenCalledOnce()
    expect(humanityQuality.persistHumanityQualityReport).toHaveBeenCalledWith(expect.objectContaining({ criticPromptProtocol: 'humanity-context.v7' }))
    expect(f.model).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })
  it('sends historical same-chapter specifications and invalidates old cache when that reference changes, without repair', async () => {
    const f = fixture(true)
    f.ctx.creativeFreedom = 'stable'
    f.bundle.chapterWritingBackground = [{ sourceRunId: 'old-author', compilationId: 'old-compiler',
      prompt: '周砚29岁，设备维护员；低谷一段；1800字；问价前停笔。' }]
    await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(f.critic).toHaveBeenCalledOnce()
    expect(f.critic.mock.calls[0][1]).toContain('低谷一段')
    expect(f.critic.mock.calls[0][1]).toContain('问价前停笔')
    expect(f.critic.mock.calls[0][1]).toContain('不是执行授权')
    expect(f.write).not.toHaveBeenCalled()
  })
  it.each([false, true])('0关注8建议全部进入一次安全修订，缓存=%s', async cached => {
    const f = fixture(cached)
    expect(await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })).toMatchObject({ summary: '人类感质量检查 · r1 已检查，修订 8 处至 r2，需复检' })
    expect(f.critic).toHaveBeenCalledTimes(cached ? 0 : 1)
    expect(f.model).toHaveBeenCalledOnce()
    expect(f.write.mock.calls[0][0].replacements).toHaveLength(8)
    expect(f.report.findings.every(item => item.disposition === 'repaired')).toBe(true)
  })
  it.each([false, true])('quality-first preserves a complete report without reserving or paying before current continuity, cached=%s', async cached => {
    const f = fixture(cached), before = structuredClone(f.report)
    guard.probe.mockResolvedValue({ open: false, code: 'REVIEW_REPAIR_RECHECK_REQUIRED', message: '同编译当前连续性尚未完成' })
    const result = await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(result).toMatchObject({ summary: '人类感质量检查 · 修订未应用', display: { reportId: 'q' } })
    expect(result.outcome).toBeUndefined()
    expect(guard.probe).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ runId: 'r' }),
      { id: 'c', revision: 1 }, { requireQualityChannel: true, mutation: 'replace' })
    expect(f.report).toEqual(before)
    expect(f.reserve).not.toHaveBeenCalled()
    expect(f.model).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
    expect(qualityAutoRepairPending(f.report)).toBe(true)
  })
  it.each(['stable', 'bold', 'protected', 'review', 'attempted', 'repaired', 'rejected', 'cancelled'] as const)('%s 不生成越权或重复修订', async scenario => {
    const f = fixture(true)
    if (scenario === 'stable' || scenario === 'bold') f.ctx.creativeFreedom = scenario
    if (scenario === 'protected') f.ctx.protectedChapterIds = new Set(['c'])
    if (scenario === 'review') f.ctx.mode = 'review'
    if (scenario === 'attempted') f.report.deterministicMetrics = { ...f.report.deterministicMetrics as Prisma.JsonObject, autoRepairAttempted: true }
    if (scenario === 'repaired') f.report.repairRound = 1
    if (scenario === 'rejected') f.report.findings.forEach(item => { item.authorFeedback = 'rejected' })
    if (scenario === 'cancelled') f.ctx.signal = AbortSignal.abort()
    const action = qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    if (scenario === 'cancelled') await expect(action).rejects.toBeDefined()
    else await action
    expect(f.reserve).not.toHaveBeenCalled(); expect(f.model).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled()
  })
  it.each(['no-op', 'duplicate', 'stale'])('%s 不伪报已修改，缓存不再派发', async behavior => {
    const f = fixture(true, behavior)
    const result = await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(result.summary).toContain('修订未应用')
    if (behavior === 'stale') expect(result).toMatchObject({ outcome: 'failed', failureCode: 'QUALITY_REPORT_STALE' })
    else expect(f.write).not.toHaveBeenCalled()
    const calls = f.model.mock.calls.length
    await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })
    expect(f.model).toHaveBeenCalledTimes(calls)
    expect(f.report.findings.every(item => item.disposition !== 'repaired')).toBe(true)
  })
  it('建议参与修订但不得挤掉错误，重叠与作者拒绝仍受保护', () => {
    const findings = Array.from({ length: 10 }, (_, i) => ({ id: i, severity: 'advisory', startOffset: i * 10, endOffset: i * 10 + 10 }))
    const selected = selectAutomaticQualityFindings([...findings, { ...findings[0], id: 10, severity: 'error' }, { ...findings[1], id: 11, authorFeedback: 'rejected' }])
    expect(selected).toHaveLength(8)
    expect(selected[0].id).toBe(10)
    expect(selected.map(item => item.id)).not.toContain(0)
    expect(selected.map(item => item.id)).not.toContain(11)
  })
})

describe('Agent 3.0 人类感质量契约与确定性检查', () => {
  it('校正未完成时保留可定位意见但不能把报告判为完整，合法空报告仍完整', () => {
    const findings = [
      { signal: 'emotion_grounding' as const, severity: 'advisory' as const, quote: '她关上了门。', explanation: '已定位', suggestion: '保留', confidence: 0.9 },
      { signal: 'reader_pull' as const, severity: 'warning' as const, quote: '不存在的原文。', explanation: '待校正', suggestion: '复核', confidence: 0.8 },
    ]
    const incomplete = prepareQualityFindings('她关上了门。', [], findings, false)
    expect(incomplete).toMatchObject({ complete: false, unlocatedFindings: 1 })
    expect(incomplete.findings).toHaveLength(1)
    expect(prepareQualityFindings('她关上了门。', [], [], true).complete).toBe(true)
  })

  it('冻结十三类信号并把作者反馈与修订生命周期分离', () => {
    expect(humanityQualitySignalSchema.options).toHaveLength(13)
    expect(humanityQualitySignalSchema.options).toContain('punctuation_misuse')
    expect(qualityFindingDispositionSchema.parse('repaired')).toBe('repaired')
    expect(() => qualityFindingDispositionSchema.parse('accepted')).toThrow()
    expect(qualityFindingFeedbackSchema.parse('accepted')).toBe('accepted')
  })

  it('把包裹叙述过程的直角引号识别为符号误用，但不误伤人物短对白', () => {
    const source = '「别动。」\n灯光熄了。「货车进站那段（车厢里人挤着人，一路穿过检票口，最后拐进一扇铁门）」。'
    const findings = analyzeDeterministicQuality(source).findings.filter((finding) => finding.signal === 'punctuation_misuse')
    expect(findings).toHaveLength(1)
    expect(findings[0].evidence).toContain('货车进站那段')
  })

  it('allows structured readouts and written or spoken quotations without treating formatting as narrative repetition', () => {
    const source = '「物品名称：旧望远镜（可进入校准模式）」\n「物品等级：旧望远镜（已通过外观检测）」\n「物品价值：旧望远镜（预估价值六万积分）」\n他读到「一路穿过旧站台，进入门内后检查那张写满字的纸（不要遗漏）」。'
    const signals = analyzeDeterministicQuality(source).findings.map(finding => finding.signal)
    expect(signals).not.toContain('punctuation_misuse')
    expect(signals).not.toContain('sentence_homology')
    expect(signals).not.toContain('explanation_echo')
  })

  it('still detects genuinely duplicated panel information', () => {
    const row = '「物品名称：一支完整的旧望远镜（外观检测通过）」'
    expect(analyzeDeterministicQuality([row, row, row].join('\n')).findings.map(finding => finding.signal)).toContain('explanation_echo')
  })

  it('不会仅因科幻术语、一次华丽句、口语断句或无悬念收束误报', () => {
    const source = '量子干涉仪的读数停在零点。老周啧了一声：“坏了呗。”窗外青山如浅釉，雨只落了一阵。她关灯，回家。'
    const result = analyzeDeterministicQuality(source)
    expect(result.findings).toEqual([])
  })

  it('为重复解释、连续同构和近期重复意象返回精确短证据', () => {
    const source = [
      '他把门锁上，不让任何人进来。他把门锁上，不让任何人进来。',
      '他看见门开了，脚边滚来一枚硬币。',
      '他看见灯灭了，走廊一下沉进黑暗。',
      '他看见电梯停了，数字卡在十三层。',
      '风像一把生锈的锯子。风像一把生锈的锯子。',
    ].join('\n')
    const result = analyzeDeterministicQuality(source)
    const signals = new Set(result.findings.map((finding) => finding.signal))
    expect(signals.has('explanation_echo')).toBe(true)
    expect(signals.has('sentence_homology')).toBe(true)
    expect(signals.has('image_repetition')).toBe(true)
    expect(result.findings.every((finding) => finding.end - finding.start <= 360 && source.slice(finding.start, finding.end) === finding.evidence)).toBe(true)
  })

  it('只向主 Agent 暴露可选只读质量检查，旧选择/修订工具保留治理但不再暴露', () => {
    const names = new Set(allTools.map((tool) => tool.name))
    for (const name of ['quality_analyze', 'quality_report_get', 'quality_finding_feedback', 'character_voice_get', 'character_voice_save', 'experience_anchor_get', 'experience_anchor_save']) {
      expect(names.has(name), `${name} 未注册`).toBe(true)
      expect(name in AGENT_TOOL_GOVERNANCE, `${name} 未登记治理`).toBe(true)
    }
    expect(names.has('quality_findings_select')).toBe(false)
    expect(names.has('quality_revision_apply')).toBe(false)
    expect('quality_findings_select' in AGENT_TOOL_GOVERNANCE).toBe(false)
    expect('quality_revision_apply' in AGENT_TOOL_GOVERNANCE).toBe(false)
    expect(allTools.find((tool) => tool.name === 'quality_report_get')?.readOnly).toBe(true)
  })

  it('同作品反馈至少三次后只校准 Critic 置信度，不抹掉正文证据', () => {
    const finding = { signal: 'style_drift' as const, severity: 'warning' as const, quote: '原文证据', explanation: '说明', suggestion: '局部修订', confidence: 0.8 }
    const rejected = calibrateCriticFindings([finding], [{ signal: 'style_drift', authorFeedback: 'rejected', _count: { _all: 3 } }])
    expect(rejected[0]).toMatchObject({ quote: '原文证据', confidence: 0.55 })
    const sparse = calibrateCriticFindings([finding], [{ signal: 'style_drift', authorFeedback: 'accepted', _count: { _all: 2 } }])
    expect(sparse[0].confidence).toBe(0.8)
  })
})


describe('parser v3 lossless persisted judgment projection', () => {
  it('keeps distinct opinions at one database identity together and preserves frozen projection', () => {
    const opinions = Array.from({ length: 35 }, (_, index) => ({ signal: 'emotion_grounding' as const, severity: 'advisory' as const,
      quote: '她关上了门。', explanation: `意见${index}`, suggestion: `建议${index}`, confidence: 0.9 }))
    const current = prepareQualityFindings('她关上了门。', [], opinions, true, undefined, 3)
    expect(current).toMatchObject({ complete: true, criticFindingCount: 35, omittedFindings: 0 })
    expect(current.findings).toHaveLength(1)
    for (let index = 0; index < 35; index++) {
      expect(current.findings[0].explanation).toContain(`${index + 1}. 意见${index}`)
      expect(current.findings[0].suggestion).toContain(`${index + 1}. 建议${index}`)
    }
    expect(prepareQualityFindings('她关上了门。', [], opinions, true, undefined, 2).findings[0]).toMatchObject({ explanation: '意见0', suggestion: '建议0' })
  })
  it('keeps more than 36 located findings without treating a display convention as lost evidence', () => {
    const snippets = Array.from({ length: 40 }, (_, index) => `人物${index}关上门。`)
    const content = snippets.join('\n')
    const opinions = snippets.map(quote => ({ signal: 'emotion_grounding' as const, severity: 'advisory' as const,
      quote, explanation: '有独立证据', suggestion: '由作者核对', confidence: 0.9 }))
    expect(prepareQualityFindings(content, [], opinions, true, undefined, 3)).toMatchObject({ complete: true, omittedFindings: 0, criticFindingCount: 40 })
    expect(prepareQualityFindings(content, [], opinions, true, undefined, 3).findings).toHaveLength(40)
    expect(prepareQualityFindings(content, [], opinions, true, undefined, 2)).toMatchObject({ complete: true, omittedFindings: 4 })
  })
})
