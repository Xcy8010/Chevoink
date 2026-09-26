import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../api/lib/prisma.js'
import * as compiler from '../../api/lib/agent/story-compiler.js'
import * as quality from '../../api/lib/agent/humanity-quality.js'
import * as review from '../../api/lib/agent/review-completion.js'
import * as ai from '../../api/lib/ai-service.js'
import * as scope from '../../api/lib/agent/manuscript-scope.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'
import * as novelTools from '../../api/lib/agent/tools/novel-tools.js'
import { continuityValidateTool, continuityReviewTail, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

import { sceneTaskInputSchema, storyStateSchema } from '../../shared/contracts/index.js'
import { allTools } from '../../api/lib/agent/tools/registry.js'
import { buildTaskSpec, renderTaskSpec } from '../../api/lib/agent/task-spec.js'
import { normalizeBeatCandidates } from '../../api/lib/agent/story-compiler.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

describe('严谨创作落实连续性警告', () => {
  afterEach(() => vi.restoreAllMocks())
  function fixture(cached: boolean) {
    const chapter = { id: 'c', title: '本章', revision: 1, content: '原文', orderIndex: 1 }
    const findings = ['body', 'object', 'knowledge'].map(signal => ({ signal, severity: 'warning', evidence: '原文存在衔接风险', suggestion: '局部澄清' }))
    const validation = { independentCheck: 'complete', checkedRevision: 1, findings, errorCount: 0, warningCount: 3, autoRepairRounds: 0 }
    const compilation = { id: 'comp', chapterId: 'c', chapter, bridge: { fromChapterId: null }, sceneTasks: [{ ordinal: 1 }], validation: cached ? validation : null, status: 'active' }
    vi.spyOn(prisma.storyCompilation, 'findFirst').mockResolvedValue(compilation as unknown as Awaited<ReturnType<typeof prisma.storyCompilation.findFirst>>)
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
    return { ctx, chapter, compilation, validation, qualityReport, reserve, critic, repair, write }
  }
  it.each([false, true])('0错误3警告执行一次集中修订，缓存=%s', async cached => {
    const f = fixture(cached)
    expect(await continuityValidateTool.execute(f.ctx, { compilationId: 'comp' })).toMatchObject({ summary: '连续性检查 · 自动修订 1 处' })
    expect(f.critic).toHaveBeenCalledTimes(cached ? 0 : 1)
    expect(f.repair).toHaveBeenCalledOnce()
    expect(f.repair.mock.calls[0][1]).toContain('[warning/body]')
    expect(f.write).toHaveBeenCalledOnce()
    expect(f.write.mock.calls[0][0].data.content).toBe('新文')
    await continuityValidateTool.execute(f.ctx, { compilationId: 'comp' })
    expect(f.repair).toHaveBeenCalledOnce()
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
    expect(f.write).toHaveBeenCalledTimes(scenario === 'checked-quality' ? 1 : 0)
    expect(f.repair).toHaveBeenCalledTimes(['checked-quality', 'unsafe'].includes(scenario) ? 1 : 0)
  })
  it.each(['quality', 'continuity'] as const)('提交前不能跳过尚未尝试的 %s 修订', async family => {
    const f = fixture(true)
    vi.mocked(flags.isAgent2FeatureEnabled).mockReturnValue(true)
    f.qualityReport.mockResolvedValue({ id: 'q', chapterRevision: 1, repairRound: 0, status: 'passed', deterministicMetrics: { independentCheck: 'complete' },
      findings: family === 'quality' ? [{ severity: 'advisory', startOffset: 0, endOffset: 2 }] : [] } as unknown as Awaited<ReturnType<typeof quality.getLatestQualityReport>>)
    const commit = vi.spyOn(compiler, 'commitChapterBridge')
    expect(await chapterBridgeCommitTool.execute(f.ctx, { compilationId: 'comp' })).toMatchObject({ outcome: 'failed', summary: family === 'quality' ? '等待质量建议处理' : '等待连续性警告处理' })
    expect(commit).not.toHaveBeenCalled()
  })
})

describe('Agent 3.0 Story Compiler 契约', () => {
  it('完整字符串化场景数组按等价表示恢复，残文及超额场景仍拒绝', () => {
    const tool = allTools.find(item => item.name === 'scene_task_build')!
    const tasks = [{ goal: '守住城门' }, { goal: '护送百姓' }]
    expect(tool.parameters.parse(tool.coerceArgs!({ tasks: JSON.stringify(tasks) })))
      .toEqual(tool.parameters.parse(tool.coerceArgs!({ tasks })))
    for (const value of ['[{"goal":"残文', JSON.stringify([...tasks, ...tasks, tasks[0]]), '{"goal":"非数组"}']) {
      expect(tool.parameters.safeParse(tool.coerceArgs!({ tasks: value })).success).toBe(false)
    }
  })
  it('严谨规则落实警告与建议但不授权只读或保护章写入', () => {
    const text = renderTaskSpec(buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '写下一章', creativeFreedom: 'balanced' }))
    expect(text).toContain('连续性错误与警告、人类感质量警告与建议都要落实')
    expect(text).toContain('各做一次集中修订')
    expect(text).toContain('独立只读审阅及受保护正文不因严谨模式获得写权限')
    expect(continuityReviewTail(null, 1, true)).toContain('错误与警告')
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
