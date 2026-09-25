import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import * as aiService from '../../api/lib/ai-service.js'
import * as review from '../../api/lib/agent/review-completion.js'
import { selectAutomaticQualityFindings, qualityAutoRepairPending } from '../../api/lib/agent/quality-report-contract.js'

import {
  humanityQualitySignalSchema,
  qualityFindingDispositionSchema,
  qualityFindingFeedbackSchema,
} from '../../shared/contracts/index.js'
import { analyzeDeterministicQuality, calibrateCriticFindings, resolveQualityChapterTarget, hasCommittedTaskChapter } from '../../api/lib/agent/humanity-quality.js'
import { allTools } from '../../api/lib/agent/tools/registry.js'
import { AGENT_TOOL_GOVERNANCE } from '../../api/lib/agent/tools/governance.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as humanityQuality from '../../api/lib/agent/humanity-quality.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { DataAccessError } from '../../api/lib/prisma.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

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
    expect(compilations).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u', novelId: 'n', status: 'active', run: { userId: 'u', novelId: 'n', taskRootId: 'root' } }, take: 2 }))
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
    await resolveQualityChapterTarget(input, db)
    expect(compilations).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ run: { id: 'r', userId: 'u', novelId: 'n' } }) }))
  })
  it('指定编译必须在当前运行作用域，不能失败后回退旧章节', async () => {
    const { db, compilations } = database([], null)
    await expect(resolveQualityChapterTarget({ ...input, compilationId: 'foreign' }, db)).rejects.toMatchObject({ code: 'QUALITY_TARGET_AMBIGUOUS' })
    expect(compilations).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u', novelId: 'n', status: 'active', run: { id: 'r', userId: 'u', novelId: 'n' }, id: 'foreign' } }))
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
    const content = Array.from({ length: 8 }, (_, index) => `证据${index}。`).join('')
    const chapter = { id: 'c', title: '本章', revision: 1, content, novel: { tagNames: [] } }
    const report = { id: 'q', runId: 'r', compilationId: null, chapterId: 'c', chapterRevision: 1, status: 'passed', repairRound: 0,
      criticVersion: humanityQuality.HUMANITY_CRITIC_VERSION, chapter, deterministicMetrics: { independentCheck: 'complete', contentHash: digest(content) },
      findings: Array.from({ length: 8 }, (_, index) => ({ id: `f${index}`, signal: 'emotion_grounding', severity: 'advisory', disposition: 'pending', authorFeedback: null,
        startOffset: index * 4, endOffset: index * 4 + 4, evidenceExcerpt: `证据${index}。`, explanation: '需要具体动作', suggestion: '局部补足' })) } as unknown as Awaited<ReturnType<typeof humanityQuality.getQualityReport>>
    vi.spyOn(humanityQuality, 'resolveQualityChapterTarget').mockResolvedValue('c')
    vi.spyOn(humanityQuality, 'buildHumanityQualityContext').mockResolvedValue({ chapter, compilation: null, charter: null, recentChapters: [], profiles: [], anchors: [], feedback: [] } as unknown as Awaited<ReturnType<typeof humanityQuality.buildHumanityQualityContext>>)
    vi.spyOn(humanityQuality, 'getLatestQualityReport').mockResolvedValue(cached ? report : null)
    vi.spyOn(humanityQuality, 'getQualityReport').mockImplementation(async () => report)
    vi.spyOn(humanityQuality, 'analyzeDeterministicQuality').mockReturnValue({ metrics: {}, findings: [] })
    vi.spyOn(humanityQuality, 'persistHumanityQualityReport').mockResolvedValue(report)
    const critic = vi.spyOn(review, 'generateReviewCompletion').mockResolvedValue('{"findings":[]}')
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
    return { ctx, report, critic, reserve, model, write }
  }
  it.each([false, true])('0关注8建议全部进入一次安全修订，缓存=%s', async cached => {
    const f = fixture(cached)
    expect(await qualityAnalyzeTool.execute(f.ctx, { chapterId: 'c' })).toMatchObject({ summary: '人类感质量检查 · 自动修订 8 处' })
    expect(f.critic).toHaveBeenCalledTimes(cached ? 0 : 1)
    expect(f.model).toHaveBeenCalledOnce()
    expect(f.write.mock.calls[0][0].replacements).toHaveLength(8)
    expect(f.report.findings.every(item => item.disposition === 'repaired')).toBe(true)
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
    if (behavior === 'stale') expect(result.outcome).toBe('failed')
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
  it('冻结十三类信号并把作者反馈与修订生命周期分离', () => {
    expect(humanityQualitySignalSchema.options).toHaveLength(13)
    expect(humanityQualitySignalSchema.options).toContain('punctuation_misuse')
    expect(qualityFindingDispositionSchema.parse('repaired')).toBe('repaired')
    expect(() => qualityFindingDispositionSchema.parse('accepted')).toThrow()
    expect(qualityFindingFeedbackSchema.parse('accepted')).toBe('accepted')
  })

  it('把包裹叙述过程的直角引号识别为符号误用，但不误伤人物短对白', () => {
    const source = '「别动。」\n他翻开记录本，看见上面写着「军卡进山那段（牛斗里人挤着人，一路穿过哨卡，最后拐进一扇铁门）」。'
    const findings = analyzeDeterministicQuality(source).findings.filter((finding) => finding.signal === 'punctuation_misuse')
    expect(findings).toHaveLength(1)
    expect(findings[0].evidence).toContain('军卡进山那段')
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

  it('只向主 Agent 暴露单次自动质量门，旧选择/修订工具保留治理但不再暴露', () => {
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
