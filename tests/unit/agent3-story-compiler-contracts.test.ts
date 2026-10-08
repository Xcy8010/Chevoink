import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../api/lib/prisma.js'
import { DataAccessError } from '../../api/lib/prisma.js'
import * as compiler from '../../api/lib/agent/story-compiler.js'
import * as quality from '../../api/lib/agent/humanity-quality.js'
import * as review from '../../api/lib/agent/review-completion.js'
import * as ai from '../../api/lib/ai-service.js'
import * as scope from '../../api/lib/agent/manuscript-scope.js'
import * as originalRequest from '../../api/lib/agent/original-request.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'
import * as novelTools from '../../api/lib/agent/tools/novel-tools.js'
import { continuityValidateTool, continuityReviewTail, continuityCriticSystem, chapterBridgeCommitTool, chapterBridgeGetTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

import { sceneTaskInputSchema, storyStateSchema } from '../../shared/contracts/index.js'
import { allTools } from '../../api/lib/agent/tools/registry.js'
import { buildTaskSpec, renderTaskSpec } from '../../api/lib/agent/task-spec.js'
import { normalizeBeatCandidates } from '../../api/lib/agent/story-compiler.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { normalizeToolInput } from '../../api/lib/agent/tools/input-validation.js'
import { qualityRevisionApplyTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'

describe('严谨创作落实连续性警告', () => {
  afterEach(() => vi.restoreAllMocks())
  function fixture(cached: boolean) {
    vi.spyOn(originalRequest, 'readOriginalTaskRequest').mockResolvedValue({ prompt: '写本章，人物寻找线索。', spec: null,
      taskId: 'task', sourceRunId: 'r', parentRunId: null })
    const chapter = { id: 'c', title: '本章', revision: 1, content: '原文', orderIndex: 1 }
    const findings = ['body', 'object', 'knowledge'].map(signal => ({ signal, severity: 'warning', evidence: '原文存在衔接风险', suggestion: '局部澄清' }))
    const validation = { independentCheck: 'complete', checkedRevision: 1, findings, errorCount: 0, warningCount: 3, autoRepairRounds: 0 }
    const compilation = { id: 'comp', createdAt: new Date(1), chapterId: 'c', chapter, bridge: { fromChapterId: null }, sceneTasks: [{ ordinal: 1 }], validation: cached ? validation : null, status: 'active' }
    Object.assign(validation, { coverage: compilerContinuityCoverage({ chapter, bridge: compilation.bridge, sceneTasks: compilation.sceneTasks, source: null }) })
    const findCompilation = vi.spyOn(prisma.storyCompilation, 'findFirst').mockImplementation(async args => args?.where?.createdAt
      ? null : compilation as unknown as Awaited<ReturnType<typeof prisma.storyCompilation.findFirst>>)
    vi.spyOn(prisma.storyCompilation, 'findMany').mockResolvedValue([compilation] as unknown as Awaited<ReturnType<typeof prisma.storyCompilation.findMany>>)
    vi.spyOn(quality, 'qualityCompilationScope').mockResolvedValue({ run: { id: 'r' } })
    const qualityReport = vi.spyOn(quality, 'getLatestQualityReport').mockResolvedValue(null)
    vi.spyOn(compiler, 'reserveContinuityCheck').mockResolvedValue(true)
    const reserve = vi.spyOn(compiler, 'reserveContinuityRepair').mockImplementation(async () => {
      if (validation.autoRepairRounds) return false
      validation.autoRepairRounds++
      return true
    })
    vi.spyOn(compiler, 'validateStoryContinuity').mockResolvedValue(validation as unknown as Awaited<ReturnType<typeof compiler.validateStoryContinuity>>)
    const critic = vi.spyOn(review, 'generateReviewCompletion').mockResolvedValue(JSON.stringify({ findings }))
    const repair = vi.spyOn(ai, 'generateTextCompletion').mockResolvedValue('{"patches":[{"oldText":"原文","newText":"新文"}]}')
    const write = vi.fn().mockResolvedValue({ count: 1 })
    const tx = { $queryRaw: vi.fn(), chapter: { updateMany: write, findUniqueOrThrow: vi.fn().mockResolvedValue({ ...chapter, revision: 2 }) }, storyCompilation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } } as unknown as Prisma.TransactionClient
    vi.spyOn(prisma, '$transaction').mockImplementation(async callback => (callback as (db: Prisma.TransactionClient) => Promise<unknown>)(tx))
    vi.spyOn(scope, 'assertAgentManuscriptCurrent').mockResolvedValue(undefined)
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockReturnValue(false)
    vi.spyOn(novelTools, 'recalcNovelStats').mockResolvedValue(undefined)
    const ctx: ToolContext = { userId: 'u', novelId: 'n', runId: 'r', sessionId: 's', callId: 'check', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', signal: new AbortController().signal, emit: () => {} }
    return { ctx, chapter, compilation, validation, qualityReport, reserve, critic, repair, write, findCompilation }
  }
  it.each([false, true])('0错误3警告仅保存检查意见并复用，不自动修订，缓存=%s', async cached => {
    const f = fixture(cached)
    expect(await continuityValidateTool.execute(f.ctx, { compilationId: 'comp' })).toMatchObject({ display: { errorCount: 0, warningCount: 3 } })
    expect(f.critic).toHaveBeenCalledTimes(cached ? 0 : 1)
    expect(f.repair).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
    expect(f.chapter).toMatchObject({ content: '原文', revision: 1 })
    await continuityValidateTool.execute(f.ctx, { compilationId: 'comp' })
    expect(f.repair).not.toHaveBeenCalled()
  })
  it('连续性判断取得前章已保存原文，桥接摘要不单独充当事实证据', async () => {
    const f = fixture(false)
    Object.assign(f.compilation.bridge, { fromChapterId: 'source', sourceRevision: 2 })
    vi.spyOn(prisma.chapter, 'findFirst').mockResolvedValue({ id: 'source', revision: 2, content: '合成前章：营火只为制造声势。他随后走向河边。' } as never)
    await continuityValidateTool.execute(f.ctx, { compilationId: 'comp' })
    expect(f.critic.mock.calls[0][1]).toContain('前章已保存原文（事实证据）：\n合成前章：营火只为制造声势。他随后走向河边。')
    expect(f.critic.mock.calls[0][1]).toContain('桥接摘要，需对照原文核实')
    expect(f.write).not.toHaveBeenCalled()
  })
  it.each([undefined, '模型自行添加的范围'])('a missing compilation reservation does not return stale findings or buy a check: %s', async focus => {
    const f = fixture(true)
    f.chapter.revision = 2
    f.validation.findings = [{ signal: 'object', severity: 'error', evidence: '仅属于旧版的矛盾', suggestion: '旧版最小修改建议' }]
    vi.mocked(compiler.reserveContinuityCheck).mockResolvedValue(false)
    const returned = await continuityValidateTool.execute(f.ctx, { compilationId: 'comp', focus })
    expect(returned).toMatchObject({ outcome: 'failed', failureCode: 'COMPILATION_NOT_FOUND', display: { phase: 'check', items: [] } })
    expect(returned.output).toContain('当前 r2')
    expect(returned.output).not.toContain('旧版最小修改建议')
    expect(returned.output).not.toContain('仅属于旧版的矛盾')
    expect(f.critic).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })
  it('chapter-only CHECK uses the verified writing compiler and persists exact coverage, including a reused post-quality report', async () => {
    const f = fixture(true)
    vi.spyOn(compiler, 'isWritingTaskContinuityCompiler').mockResolvedValue(true)
    f.ctx.creativeFreedom = 'stable'
    f.compilation.validation = f.validation
    await continuityValidateTool.execute(f.ctx, { chapterId: 'c' })
    expect(vi.mocked(compiler.isWritingTaskContinuityCompiler).mock.calls[0][1]).toMatchObject({ compilationId: 'comp', chapterId: 'c', runId: 'r' })
    expect(vi.mocked(compiler.validateStoryContinuity).mock.calls[0][0]).toMatchObject({ runId: 'r', compilationId: 'comp', expectedChapterRevision: 1,
      coverage: compilerContinuityCoverage({ chapter: f.chapter, bridge: f.compilation.bridge, sceneTasks: f.compilation.sceneTasks, source: null }) })
    expect(vi.mocked(compiler.validateStoryContinuity).mock.calls[0][0].signal).toBe(f.ctx.signal)
    expect(f.critic).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })
  it('a legacy CHECK after nine recorded checks still dispatches one critic without a manuscript or paid repair', async () => {
    const f = fixture(false)
    f.compilation.validation = { checkRounds: 9 } as never
    expect(await continuityValidateTool.execute(f.ctx, { compilationId: 'comp' })).toMatchObject({ summary: expect.stringContaining('连续性检查') })
    expect(compiler.reserveContinuityCheck).toHaveBeenCalledOnce()
    expect(f.critic).toHaveBeenCalledOnce()
    expect(f.repair).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
    expect(f.compilation.validation).toEqual({ checkRounds: 9 })
  })
  it.each(['current', 'stale', 'failed'] as const)('bridge reads show quality candidates only from an authentic %s current-body report', async scenario => {
    const f = fixture(false)
    vi.spyOn(prisma.agentRun, 'findFirst').mockResolvedValue({ taskRootId: null, runtimeProtocolVersion: 0, sessionId: f.ctx.sessionId,
      taskSpec: buildTaskSpec({ runId: f.ctx.runId, novelId: f.ctx.novelId, chapterId: f.chapter.id, prompt: '修改本章' }) } as never)
    const report = { id: 'report', userId: f.ctx.userId, novelId: f.ctx.novelId, chapterId: f.chapter.id, chapterRevision: scenario === 'stale' ? 0 : 1,
      status: scenario === 'failed' ? 'failed' : 'passed', deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(f.chapter.content).digest('hex') },
      findings: [{ id: 'candidate', severity: 'warning', disposition: 'pending', authorFeedback: null, evidenceExcerpt: '原文', explanation: '需要澄清真实动作', suggestion: '按作者授权处理' }] }
    Object.assign(f.compilation, { qualityReports: [report] })
    const result = await chapterBridgeGetTool.execute(f.ctx, { compilationId: f.compilation.id })
    expect(result.output).toContain('reportId=report')
    if (scenario === 'current') { expect(result.output).toContain('findingId=candidate'); expect(result.output).toContain('需要澄清真实动作') }
    else { expect(result.output).not.toContain('findingId=candidate'); expect(result.output).toContain('不能用旧候选证明当前版本通过') }
    expect(f.critic).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })
  it.each(['missing-coverage', 'different-scenes', 'different-focus'] as const)('%s cannot reuse a revision-only compiler report', async scenario => {
    const f = fixture(true)
    f.ctx.creativeFreedom = 'stable'
    if (scenario === 'missing-coverage') Object.assign(f.validation, { coverage: undefined })
    if (scenario === 'different-scenes') f.compilation.sceneTasks[0].ordinal = 2
    await continuityValidateTool.execute(f.ctx, { compilationId: 'comp', ...(scenario === 'different-focus' ? { focus: '人物知识' } : {}) })
    expect(f.critic).toHaveBeenCalledOnce()
    expect(f.write).not.toHaveBeenCalled()
  })
  it('allows bounded output recovery after reserving a check without mistaking bookkeeping for a body edit', async () => {
    const f = fixture(false)
    f.ctx.creativeFreedom = 'stable'
    // Real DB reads return independent snapshots, including our reservation write.
    let current = structuredClone(f.compilation)
    f.findCompilation.mockImplementation(async () => structuredClone(current) as never)
    vi.mocked(compiler.reserveContinuityCheck).mockImplementation(async () => {
      current = { ...current, validation: { checkRounds: 1 } } as typeof current
      Object.assign(current, { updatedAt: new Date() })
      return true
    })
    f.critic.mockRestore()
    f.repair.mockRejectedValueOnce(new DataAccessError(502, 'AI_PROVIDER_OUTPUT_LIMIT', 'output ceiling'))
      .mockResolvedValueOnce('{"findings":[]}')
    await continuityValidateTool.execute(f.ctx, { compilationId: 'comp' })
    expect(f.repair).toHaveBeenCalledTimes(2)
    expect(f.repair.mock.calls[1][2]).toMatchObject({ action: 'agent3ContinuityCriticOutputRecovery', boundedReview: true, maxOutputTokens: 32768 })
    expect(compiler.validateStoryContinuity).toHaveBeenCalledWith(expect.objectContaining({ independentCheck: 'complete', expectedChapterRevision: 1 }))
    expect(f.write).not.toHaveBeenCalled()
  })
  it.each(['chapter', 'bridge', 'scenes', 'removed', 'after-response'] as const)('rejects genuinely changed %s before recovery or applying the result', async change => {
    const f = fixture(false)
    let current: typeof f.compilation | null = structuredClone(f.compilation)
    f.findCompilation.mockImplementation(async () => structuredClone(current) as never)
    f.critic.mockImplementation(async (_system, _content, _options, beforeRecovery) => {
      if (change === 'chapter' || change === 'after-response') current!.chapter.revision++
      if (change === 'bridge') Object.assign(current!.bridge, { location: 'changed' })
      if (change === 'scenes') current!.sceneTasks[0].ordinal++
      if (change === 'removed') current = null
      if (change !== 'after-response') await beforeRecovery?.()
      return '{"findings":[]}'
    })
    await expect(continuityValidateTool.execute(f.ctx, { compilationId: 'comp' })).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
    expect(compiler.validateStoryContinuity).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })
  it.each(['stable', 'bold', 'protected', 'review', 'repaired-quality', 'checked-quality', 'budget', 'unsafe', 'cancelled', 'invalid-scenes'] as const)('%s 保留权限、版本与一次修订边界', async scenario => {
    const f = fixture(true)
    if (scenario === 'stable' || scenario === 'bold') f.ctx.creativeFreedom = scenario
    if (scenario === 'protected') f.ctx.protectedChapterIds = new Set(['c'])
    if (scenario === 'review') f.ctx.mode = 'review'
    if (scenario === 'budget') f.validation.autoRepairRounds = 1
    if (scenario === 'invalid-scenes') f.compilation.sceneTasks = []
    if (scenario === 'repaired-quality' || scenario === 'checked-quality') {
      const hash = createHash('sha256').update('原文').digest('hex')
      f.qualityReport.mockResolvedValue({ compilationId: 'comp', chapterRevision: 1, repairRound: scenario === 'repaired-quality' ? 1 : 0,
        status: scenario === 'repaired-quality' ? 'repaired' : 'passed', deterministicMetrics: { independentCheck: 'complete', contentHash: hash, repairedContentHash: hash } } as unknown as Awaited<ReturnType<typeof quality.getLatestQualityReport>>)
    }
    if (scenario === 'unsafe') f.repair.mockResolvedValue('{"patches":[{"oldText":"不存在","newText":"新文"}]}')
    if (scenario === 'cancelled') f.ctx.signal = AbortSignal.abort()
    const action = continuityValidateTool.execute(f.ctx, { compilationId: 'comp' })
    if (scenario === 'cancelled') await expect(action).rejects.toBeDefined()
    else await action
    expect(f.write).not.toHaveBeenCalled()
    expect(f.repair).not.toHaveBeenCalled()
    expect(f.chapter).toMatchObject({ content: '原文', revision: 1 })
  })
  it.each(['quality', 'continuity'] as const)('未修订的可选 %s 警告不强制增加正文工作', async family => {
    const f = fixture(true)
    vi.mocked(flags.isAgent2FeatureEnabled).mockReturnValue(true)
    f.qualityReport.mockResolvedValue({ id: 'q', chapterRevision: 1, repairRound: 0, status: 'passed', deterministicMetrics: { independentCheck: 'complete' },
      findings: family === 'quality' ? [{ severity: 'advisory', startOffset: 0, endOffset: 2 }] : [] } as unknown as Awaited<ReturnType<typeof quality.getLatestQualityReport>>)
    const commit = vi.spyOn(compiler, 'commitChapterBridge').mockResolvedValue({ compilationId: 'comp', chapterId: 'c', chapterRevision: 1, skippedMemoryCount: 0, retainedIssueCount: 0 })
    expect(await chapterBridgeCommitTool.execute(f.ctx, { compilationId: 'comp' })).toMatchObject({ summary: '提交章节桥与当前故事终态' })
    expect(commit).toHaveBeenCalledOnce()
    expect(f.write).not.toHaveBeenCalled()
  })
  it.each(['protected', 'cancelled', 'stale-revision', 'repair-limit', 'duplicate-patch', 'no-author-grant'] as const)('显式质量修订保留 %s 边界及正文', async scenario => {
    const f = fixture(false)
    const prompt = scenario === 'no-author-grant' ? '只检查当前章节，不要改写正文。' : '修复当前章节中已选择的质量问题。'
    const run = { id: 'r', userId: 'u', novelId: 'n', sessionId: 's', taskRootId: null, startRequest: { prompt },
      taskSpec: buildTaskSpec({ runId: 'r', novelId: 'n', chapterId: 'c', prompt }) }
    const sourceTx = { agentRun: { findFirst: vi.fn(async () => run), findFirstOrThrow: vi.fn(async () => run) },
      agentSession: { findFirst: vi.fn(async () => ({ spawnedFromRunId: null, spawnedFromSessionId: null })) },
      agentChildExecutionGrant: { findUnique: vi.fn(async () => null) } } as unknown as Prisma.TransactionClient
    vi.mocked(prisma.$transaction).mockImplementation(async work => Array.isArray(work)
      ? Promise.all(work) : (work as (tx: Prisma.TransactionClient) => Promise<unknown>)(sourceTx))
    const chapter = { ...f.chapter, revision: scenario === 'stale-revision' ? 2 : 1 }
    const report = { id: 'q', chapterId: 'c', chapterRevision: 1, chapter, repairRound: scenario === 'repair-limit' ? 1 : 0,
      findings: [{ id: 'finding', signal: 'emotion_grounding', disposition: 'selected', severity: 'warning', startOffset: 0, endOffset: 2,
        evidenceHash: createHash('sha256').update('原文').digest('hex'), evidenceExcerpt: '原文', explanation: '说明', suggestion: '局部修订' }] }
    vi.spyOn(prisma.chapterQualityReport, 'findFirst').mockImplementation(async args => args?.where?.id === 'q'
      && args.where.userId === 'u' && args.where.novelId === 'n' ? report as never : null)
    vi.spyOn(prisma.qualityFinding, 'updateMany').mockResolvedValue({ count: 1 })
    f.repair.mockResolvedValue(JSON.stringify({ patches: scenario === 'duplicate-patch'
      ? [{ findingId: 'finding', replacement: '新文' }, { findingId: 'finding', replacement: '另一新文' }]
      : [{ findingId: 'finding', replacement: '新文' }] }))
    if (scenario === 'protected') f.ctx.protectedChapterIds = new Set(['c'])
    if (scenario === 'cancelled') f.ctx.signal = AbortSignal.abort()
    const work = qualityRevisionApplyTool.execute(f.ctx, { reportId: 'q' })
    if (scenario === 'cancelled') await expect(work).rejects.toBeDefined()
    else if (scenario === 'stale-revision') await expect(work).rejects.toMatchObject({ code: 'QUALITY_REPORT_STALE' })
    else if (scenario === 'repair-limit') await expect(work).rejects.toMatchObject({ code: 'QUALITY_REPAIR_LIMIT' })
    else if (scenario === 'no-author-grant') await expect(work).rejects.toMatchObject({ code: 'REPAIR_NOT_AUTHORIZED' })
    else await work
    expect(f.write).not.toHaveBeenCalled()
    expect(chapter.content).toBe('原文')
    expect(f.repair).toHaveBeenCalledTimes(scenario === 'duplicate-patch' ? 2 : ['protected', 'no-author-grant'].includes(scenario) ? 0 : 1)
  })
})

describe('Agent 3.0 Story Compiler 契约', () => {
  it('完整字符串化场景数组按等价表示恢复，残文及超额场景仍拒绝', () => {
    const tool = allTools.find(item => item.name === 'scene_task_build')!
    const tasks = [{ goal: '守住城门' }, { goal: '护送百姓' }]
    expect(tool.parameters.parse(tool.coerceArgs!({ tasks: JSON.stringify(tasks) })))
      .toEqual(tool.parameters.parse(tool.coerceArgs!({ tasks })))
    expect(tool.parameters.parse(normalizeToolInput(tool, { tasks: JSON.stringify(JSON.stringify(tasks)) })))
      .toEqual(tool.parameters.parse(normalizeToolInput(tool, { tasks })))
    for (const value of ['[{"goal":"残文', JSON.stringify([...tasks, ...tasks, tasks[0]]), '{"goal":"非数组"}']) {
      expect(tool.parameters.safeParse(tool.coerceArgs!({ tasks: value })).success).toBe(false)
    }
  })
  it('malformed complete inner JSON keeps its original tokens and refuses effects instead of guessing a stray closing bracket', () => {
    const tool = allTools.find(item => item.name === 'scene_task_build')!
    const malformed = '[{"goal":"寻找钥匙","exitState":{"action":"转身"]}}]'
    const normalized = normalizeToolInput(tool, { tasks: malformed }) as { tasks: unknown }
    expect(normalized.tasks).toBe(malformed)
    const result = tool.parameters.safeParse(normalized)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0].message).toContain('原生 tasks 数组')
  })
  it('严谨规则保留可选只读检查及原始修复授权边界', () => {
    const text = renderTaskSpec(buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '写下一章', creativeFreedom: 'balanced' }))
    expect(text).toContain('写作交付先完成当前版本连续性与质量检查')
    expect(text).toContain('修订后只读复核当前版本两类检查，最后提交终态')
    expect(text).toContain('质量警告与审美建议，应与事实修法优先合并处理')
    expect(text).toContain('本任务冻结的新建目标章')
    expect(text).toContain('不能硬性限定只调用一次')
    expect(text).toContain('已有稿仍需原请求明确修复授权，明确禁止修改优先')
    expect(continuityReviewTail(null, 1, true)).toContain('最小事实补丁')
    expect(continuityReviewTail(null, 1, true)).toContain('警告保留待审')
    expect(continuityCriticSystem).toContain('先核对对象身份')
    expect(continuityCriticSystem).toContain('warning与审美意见保留待审')
    expect(continuityCriticSystem).toContain('章节桥是待核摘要')
    expect(continuityCriticSystem).toContain('虚张不表示')
    expect(continuityCriticSystem).toContain('同一时刻、同一对象、同一维度互斥')
    expect(continuityCriticSystem).toContain('修法困难不改变事实判定')
    expect(continuityReviewTail(null, 1, false)).toContain('不改写正文')
  })
  it.each([null, '遗漏的场景', 7, []])('场景列表保留无效项供校验拒绝，不静默丢弃：%j', invalid => {
    const tool = allTools.find(item => item.name === 'scene_task_build')!
    const normalized = tool.coerceArgs!({ tasks: [{ goal: '守住城门' }, invalid] }) as { tasks: unknown[] }
    expect(normalized.tasks).toHaveLength(2)
    expect(normalized.tasks[1]).toEqual(invalid)
    expect(tool.parameters.safeParse(normalized).success).toBe(false)
  })

  it('超过四个场景明确校验失败，不截掉后续场景后报成功', () => {
    const tool = allTools.find(item => item.name === 'scene_task_build')!
    const tasks = Array.from({ length: 5 }, (_, index) => ({ goal: `保留场景${index + 1}` }))
    const normalized = tool.coerceArgs!({ arguments: { tasks } }) as { tasks: Array<{ goal: string }> }
    expect(normalized.tasks.map(task => task.goal)).toEqual(tasks.map(task => task.goal))
    expect(tool.parameters.safeParse(normalized).success).toBe(false)
    expect(tool.parameters.safeParse(tool.coerceArgs!({ tasks: tasks.slice(0, 4) })).success).toBe(true)
  })

  it('场景缺省状态省略可选字段，严格JSON回执不因服务端注入undefined失败', () => {
    const tool = allTools.find(item => item.name === 'scene_task_build')!
    const parsed = tool.parameters.parse(tool.coerceArgs!({ arguments: { tasks: [{ goal: '守住城门' }] } })) as Record<string, unknown>
    const args = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined))
    expect(runtimeJson(args).value).toEqual(args)
    const task = (args.tasks as Array<{ entryState: unknown; exitState: unknown }>)[0]
    for (const state of [task.entryState, task.exitState]) {
      expect(state).not.toHaveProperty('action')
      expect(state).not.toHaveProperty('location')
      expect(state).not.toHaveProperty('storyTime')
    }
  })
  it('空的可选状态列表会被标准化，避免桥接出现 undefined 分支', () => {
    expect(storyStateSchema.parse({})).toEqual({ knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] })
  })

  it('Scene Task 强制目标、阻力、选择、代价、转折与风格预算', () => {
    expect(() => sceneTaskInputSchema.parse({ purpose: '推进剧情' })).toThrow()
  })

  it('完整章节管线工具全部注册且局部审阅模式不暴露写工具', () => {
    const names = new Set(allTools.map((tool) => tool.name))
    for (const name of ['story_charter_get', 'story_charter_save', 'reader_promise_save', 'reader_promise_update', 'story_compiler_prepare', 'scene_task_build', 'chapter_bridge_get', 'continuity_validate', 'chapter_bridge_commit']) {
      expect(names.has(name), `${name} 未注册`).toBe(true)
    }
    expect(allTools.find((tool) => tool.name === 'chapter_bridge_get')?.readOnly).toBe(true)
    expect(allTools.find((tool) => tool.name === 'chapter_bridge_commit')?.permission.review).toBe('deny')
  })

  it('精品模式与创作自由度分别进入任务契约，避免语义混用', () => {
    const spec = buildTaskSpec({ runId: 'run-premium', novelId: 'novel-1', chapterId: null, prompt: '写下一章', creativeFreedom: 'stable', qualityMode: 'premium' })
    expect(spec).toMatchObject({ creativeFreedom: 'stable', qualityMode: 'premium' })
  })

  it('默认精品且终态提交允许空参数，由服务端解析当前编译状态', () => {
    const defaultSpec = buildTaskSpec({ runId: 'run-default', novelId: 'novel-1', chapterId: null, prompt: '写下一章' })
    expect(defaultSpec).toMatchObject({ qualityMode: 'premium', creativeFreedom: 'balanced' })
    expect(renderTaskSpec(defaultSpec)).toContain('创作模式：严谨创作')
    const commit = allTools.find((tool) => tool.name === 'chapter_bridge_commit')
    expect(commit?.parameters.safeParse({}).success).toBe(true)
  })

  it('场景任务不再因精品候选元数据缺失而失败，服务端会补齐两项审计候选', () => {
    const task = sceneTaskInputSchema.parse({
      purpose: '让主角在限时撤离中识别内鬼。',
      entryState: {},
      goal: '抵达撤离点', obstacle: '队伍路线被泄露', choice: '改变路线并暴露自己的怀疑', cost: '失去队友信任',
      turn: '内鬼提前出现在新路线', exitState: {}, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' },
    })
    const tool = allTools.find((item) => item.name === 'scene_task_build')
    expect(tool?.parameters.safeParse({ tasks: [{ purpose: task.purpose, goal: task.goal, obstacle: task.obstacle, choice: task.choice, cost: task.cost, turn: task.turn }] }).success).toBe(true)
    expect(tool?.parameters.safeParse({ tasks: [task] }).success).toBe(true)
    const coerced = tool?.coerceArgs?.({
      scene_tasks: [{
        purpose: task.purpose, goal: task.goal, obstacle: task.obstacle, decision: task.choice,
        consequence: task.cost, twist: task.turn, entry_state: {}, exit_state: {}, style_budget: {},
      }],
      alternatives: null,
    })
    expect(tool?.parameters.safeParse(coerced).success).toBe(true)
    expect(normalizeBeatCandidates([task])).toHaveLength(2)
  })

  it('创作宪章兼容 arguments 包装、snake_case 和字符串列表', () => {
    const tool = allTools.find((item) => item.name === 'story_charter_save')
    const coerced = tool?.coerceArgs?.({
      arguments: JSON.stringify({
        one_line_promise: '一个普通人以记忆为代价拯救城市。',
        target_audience: '喜欢悬疑成长线的读者',
        target_platform: '番茄小说',
        protagonist_desire: '找回失踪的姐姐',
        protagonist_fear: '忘记所有重要的人',
        protagonist_misbelief: '独自承担才不会伤害别人',
        protagonist_non_negotiable: '不牺牲无辜者',
        conflict_engine: '每次使用能力都会失去一段私人记忆',
        relationship_engine: '主角必须逐步学会依赖队友',
        emotional_baseline: '克制、警惕',
        emotional_range: '从孤立到信任',
        genre_rules: '线索必须可回溯；能力必须付出代价',
        style_dna: '短句推进；对话留白',
      }),
    })
    const parsed = tool?.parameters.safeParse(coerced)
    expect(parsed?.success).toBe(true)
    if (parsed?.success) {
      expect(parsed.data.genreRules).toEqual(['线索必须可回溯', '能力必须付出代价'])
      expect(parsed.data.styleDna).toEqual(['短句推进', '对话留白'])
    }
  })
})
