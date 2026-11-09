import { renderWritingPlanContext } from '../writing-plan-context.js'
import { reviewContinuity } from '../continuity-review.js'
import { readWritingContinuityReference, renderWritingContinuityReference } from '../writing-continuity-reference.js'
import type { ToolResult } from './types.js'
export { parseIndependentContinuityResult, continuityCriticSystem, continuityReviewTail, parseContinuityPatches, standaloneContinuityBindingHash } from '../continuity-history.js'
import { retainedFindings } from './chapter-arguments.js'
import { readChapterReviewReadiness, readAdvisoryChapterReviewReadiness, chapterReviewDecisionGuidance } from '../chapter-review-guard.js'
import { runtimeJson } from '../runtime-common.js'
import { persistedContentHash } from '../semantic-progress.js'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { writingVolumeDecisionSchema } from '../../../../shared/contracts/writing-volume-contracts.js'

import { readerPromiseInputSchema, sceneTaskInputSchema, storyCharterSaveInputSchema, storyStateSchema } from '../../../../shared/contracts/index.js'
import { REVIEW_MAX_OUTPUT_TOKENS } from '../review-completion.js'
import { DataAccessError, prisma } from '../../prisma.js'
import { activeChapterScope } from '../../data/internal.js'
import { commitChapterBridge, getStoryCharterBundle, prepareStoryCompilation, compilationRunScope, saveReaderPromise, saveSceneTasksWithMilestone, upsertStoryCharter, updateReaderPromise } from '../story-compiler.js'
import { defineTool, type ToolContext } from './types.js'
import { coerceToolArgumentEnvelope } from './argument-coercion.js'
import { storyCharterHash } from './durable-metadata.js'
import { readWritingScope } from '../writing-scope.js'

const ALL_READ = { plan: 'allow', build: 'allow', review: 'allow' } as const
const PLAN_BUILD_WRITE = { plan: 'allow', build: 'allow', review: 'deny' } as const
const BUILD_WRITE = { plan: 'deny', build: 'allow', review: 'deny' } as const

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function compilationNextStep(compilation: { id: string; chapterId: string | null; targetOrderIndex: number; sceneTasks: unknown[]; chapter: { content: string } | null }) {
  const next = !compilation.sceneTasks.length ? '下一步用该真实 compilationId 调用 scene_task_build，保留已保存的编译，不重复准备。'
    : !compilation.chapterId ? `下一步调用 chapter_create 创建原授权第 ${compilation.targetOrderIndex} 章，再用返回的 chapterId 调用 chapter_write 保存正文。`
      : !compilation.chapter?.content.trim() ? `下一步对 chapterId=${compilation.chapterId} 调用 chapter_write 保存正文。`
        : '保留已保存正文、场景和检查，按当前版本所需检查继续；不能用旧报告宣称提交完成。'
  return `本任务 compilationId=${compilation.id}，chapterId=${compilation.chapterId ?? '尚未创建'}，目标第 ${compilation.targetOrderIndex} 章。${next}`
}

async function missingCompilationGuidance(db: Prisma.TransactionClient, ctx: ToolContext, scope: Prisma.StoryCompilationWhereInput) {
  const current = await db.storyCompilation.findFirst({ where: { userId: ctx.userId, novelId: ctx.novelId, ...scope, status: { in: ['active', 'completed'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { sceneTasks: { orderBy: { ordinal: 'asc' } }, chapter: { select: { content: true } } } })
  if (current) return compilationNextStep(current)
  const original = await readWritingScope(db, ctx)
  const targets = original.writing?.kind === 'bounded' ? original.writing.targets.map(item => item.orderIndex).join('、') : null
  return `本任务尚未建立编译。仅在原完整章节写作授权内调用 story_compiler_prepare${targets ? `，原目标为第 ${targets} 章` : ''}；写下一章时省略编辑器旧 chapterId。不要恢复历史任务、猜测编号或把未产生的正文当成交付。`
}

// Thinking and final JSON share the provider's completion allowance. A full
// chapter review needs room for both; keep a finite tool-specific ceiling rather
// than inheriting the generic 8K text allowance. Confirmed truncation recovery
// is separately bounded by generateReviewCompletion.
export const CONTINUITY_MAX_OUTPUT_TOKENS = REVIEW_MAX_OUTPUT_TOKENS

export const storyCharterGetTool = defineTool({
  name: 'story_charter_get',
  title: '读取创作宪章',
  description:
    '读取当前作品的 Story Charter 与尚未兑现的读者承诺。仅在规划新书/长篇结构、准备新章节，或作者询问作品核心承诺时调用；局部润色、改名、查字数时禁止调用。',
  parameters: z.object({}),
  permission: ALL_READ,
  readOnly: true,
  async execute(ctx) {
    const bundle = await getStoryCharterBundle(ctx.userId, ctx.novelId, ctx.transaction, Boolean(ctx.transaction))
    if (ctx.transaction) return { output: JSON.stringify(bundle), summary: bundle.charter ? `读取创作宪章 r${bundle.charter.revision}` : '当前尚未建立创作宪章',
      observedState: { kind: 'charter' as const, id: ctx.novelId, hash: storyCharterHash(bundle) } }
    if (!bundle.charter) {
      return { output: '当前作品尚未建立 Story Charter。新书长纲或前三章试制前，应先调用 story_charter_save；旧作可在不阻塞局部编辑的情况下渐进补建。' }
    }
    const charter = bundle.charter
    return {
      output: [
        `Story Charter r${charter.revision}`,
        `一句话承诺：${charter.oneLinePromise}`,
        `目标读者：${charter.targetAudience}${charter.targetPlatform ? `；平台：${charter.targetPlatform}` : ''}`,
        `主角持续欲望：${charter.protagonistDesire}`,
        `恐惧/误信/不可退让：${charter.protagonistFear} / ${charter.protagonistMisbelief} / ${charter.protagonistNonNegotiable}`,
        `冲突引擎：${charter.conflictEngine}`,
        `关系引擎：${charter.relationshipEngine}`,
        `情绪范围：${charter.emotionalBaseline} → ${charter.emotionalRange}`,
        `题材规则：${asStrings(charter.genreRules).join('；') || '无'}`,
        `能力代价：${asStrings(charter.abilityCosts).join('；') || '无'}`,
        `风格 DNA：${asStrings(charter.styleDna).join('；') || '无'}`,
        `禁区：${asStrings(charter.forbiddenZones).join('；') || '无'}`,
        `待兑现承诺：${bundle.promises.map((item) => `${item.title}（promiseId=${item.id}，${item.payoffHorizon}）`).join('；') || '无'}`,
      ].join('\n'),
      summary: `读取创作宪章 r${charter.revision}`,
      display: {
        kind: 'storyCompiler', phase: 'charter', title: '创作宪章',
        detail: `r${charter.revision} · ${bundle.promises.length} 个待兑现承诺`,
        items: [charter.oneLinePromise, `冲突引擎：${charter.conflictEngine}`, `主角欲望：${charter.protagonistDesire}`],
      },
    }
  },
})

export const storyCharterSaveTool = defineTool({
  name: 'story_charter_save',
  title: '保存创作宪章',
  description:
    '创建或修订作品级 Story Charter。作者从一句题材描述开始规划新书、生成长纲或试制前三章时，应先收敛读者承诺、主角驱动力、持续冲突与题材边界后调用；不得把套路模板或未确认的真实事实写入。旧作局部编辑不要求补建。已有宪章只传需要修改的字段，未传字段保留；首次创建须提交完整必填字段。',
  parameters: storyCharterSaveInputSchema,
  coerceArgs(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const asRecord = (value: unknown): Record<string, unknown> | null => {
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
      if (typeof value !== 'string' || !value.trim().startsWith('{')) return null
      try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
      } catch { return null }
    }
    let source = raw as Record<string, unknown>
    for (const key of ['arguments', 'args', 'params', 'parameters', 'input', 'payload', 'tool_input', 'charter'] as const) {
      const wrapped = asRecord(source[key])
      if (wrapped && (wrapped.oneLinePromise !== undefined || wrapped.one_line_promise !== undefined || wrapped.targetAudience !== undefined)) {
        source = wrapped
        break
      }
    }
    const aliases: Record<string, string[]> = {
      oneLinePromise: ['one_line_promise', 'promise'], targetAudience: ['target_audience', 'audience'], targetPlatform: ['target_platform', 'platform'],
      protagonistDesire: ['protagonist_desire', 'desire'], protagonistFear: ['protagonist_fear', 'fear'], protagonistMisbelief: ['protagonist_misbelief', 'misbelief'],
      protagonistNonNegotiable: ['protagonist_non_negotiable', 'nonNegotiable', 'non_negotiable'], conflictEngine: ['conflict_engine'], relationshipEngine: ['relationship_engine'],
      genreRules: ['genre_rules'], abilityCosts: ['ability_costs'], realityBoundaries: ['reality_boundaries'], emotionalBaseline: ['emotional_baseline'], emotionalRange: ['emotional_range'],
      styleDna: ['style_dna', 'styleDNA'], forbiddenZones: ['forbidden_zones'], antiExamples: ['anti_examples'],
    }
    const result: Record<string, unknown> = { ...source }
    for (const [canonical, candidates] of Object.entries(aliases)) {
      if (result[canonical] !== undefined) continue
      const alias = candidates.find((candidate) => result[candidate] !== undefined)
      if (alias) result[canonical] = result[alias]
    }
    const listKeys = ['genreRules', 'abilityCosts', 'realityBoundaries', 'styleDna', 'forbiddenZones', 'antiExamples']
    for (const key of listKeys) {
      const value = result[key]
      if (typeof value === 'string') {
        result[key] = value.split(/[\n；;]+/).map((item) => item.trim()).filter(Boolean)
      } else if (!Array.isArray(value) && value !== undefined) {
        result[key] = [String(value)]
      }
    }
    return result
  },
  permission: PLAN_BUILD_WRITE,
  readOnly: false,
  async execute(ctx, args) {
    const charter = await upsertStoryCharter(ctx.userId, ctx.novelId, args, ctx.transaction)
    return {
      output: `已保存 Story Charter r${charter.revision}。后续大纲、Scene Task 与章节桥应以此版本为作品级约束；不要在回复正文重复整份宪章。`,
      summary: `保存创作宪章 r${charter.revision}`,
      display: {
        kind: 'storyCompiler', phase: 'charter', title: '创作宪章已更新',
        detail: `r${charter.revision}`,
        items: [charter.oneLinePromise, `冲突引擎：${charter.conflictEngine}`, `情绪底色：${charter.emotionalBaseline}`],
      },
    }
  },
})

export const readerPromiseSaveTool = defineTool({
  name: 'reader_promise_save',
  title: '记录读者承诺',
  description:
    '记录作品向读者明确许下、后续必须兑现的悬念/关系/成长承诺。仅在新书规划、卷规划或章节产生新的长期承诺时调用；普通场景目标不要滥写为作品级承诺。相同标题会就地更新。',
  parameters: readerPromiseInputSchema,
  permission: PLAN_BUILD_WRITE,
  readOnly: false,
  async execute(ctx, args) {
    const promise = await saveReaderPromise(ctx.userId, ctx.novelId, args, ctx.transaction)
    return {
      output: `已记录读者承诺「${promise.title}」，预计兑现窗口：${promise.payoffHorizon}。`,
      summary: `记录读者承诺「${promise.title}」`,
      display: { kind: 'storyCompiler', phase: 'charter', title: '读者承诺', detail: promise.payoffHorizon, items: [promise.promise] },
    }
  },
})

export const readerPromiseUpdateTool = defineTool({
  name: 'reader_promise_update',
  title: '更新读者承诺',
  description:
    '把已有读者承诺标记为已兑现、延期、放弃或重新开启。只有正文确实兑现时才能标记 paid，并记录全书章节序号；只在承诺状态发生变化时调用，禁止每章例行调用。promiseId 来自 story_charter_get。',
  parameters: z.object({
    promiseId: z.string().min(1),
    status: z.enum(['open', 'paid', 'deferred', 'abandoned']),
    paidAtChapter: z.number().int().min(1).optional(),
  }),
  permission: PLAN_BUILD_WRITE,
  readOnly: false,
  async execute(ctx, args) {
    const promise = await updateReaderPromise({ userId: ctx.userId, novelId: ctx.novelId, ...args }, ctx.transaction)
    const label = { open: '重新开启', paid: '已兑现', deferred: '已延期', abandoned: '已放弃' }[promise.status]
    return {
      output: `读者承诺「${promise.title}」已标记为${label}${promise.paidAtChapter ? `（第 ${promise.paidAtChapter} 章兑现）` : ''}。`,
      summary: `承诺「${promise.title}」${label}`,
      display: { kind: 'storyCompiler', phase: 'charter', title: '读者承诺状态', detail: label, items: [promise.promise] },
    }
  },
})

export const storyCompilerPrepareTool = defineTool({
  name: 'story_compiler_prepare',
  title: '准备章节写作',
  description:
    '读取前章、计划、故事记忆和章节桥作为可选写作上下文。已有章传chapterId，新章可传全书targetOrderIndex；intentSummary用一句话说明当前意图。普通正文和结构工具可直接使用，不要求先准备或固定步骤。',
  parameters: z.object({
    chapterId: z.string().min(1).optional(),
    targetOrderIndex: z.number().int().min(1).optional(),
    detailPlanId: z.string().min(1).optional().describe('该章存在多份细纲时明确选择已读取核对的细纲ID'),
    intentSummary: z.string().min(1).max(1000).describe('本轮写作意图的事实化摘要；服务端只保存其 SHA-256，不保存原提示词'),
    volumeDecision: writingVolumeDecisionSchema.optional().describe('每次续写都审视当前卷目标：continue说明未收束原因；new_volume须真实前章收束引用+下一主困局，不能按章数分卷。旧已绑定目标不迁移'),
  }),
  permission: BUILD_WRITE,
  readOnly: false,
  async execute(ctx, args) {
    const db = ctx.transaction ?? prisma
    const scope = await readWritingScope(db, ctx)
    if (args.chapterId && args.targetOrderIndex !== undefined) {
      const frozen = scope.writing?.kind === 'bounded' && scope.writing.targets.find(target => target.orderIndex === args.targetOrderIndex)
      const chapter = frozen ? await db.chapter.findFirst({ where: { id: args.chapterId, authorId: ctx.userId, ...activeChapterScope(ctx.novelId) },
        select: { orderIndex: true } }) : null
      if (chapter && chapter.orderIndex !== args.targetOrderIndex) return { outcome: 'failed' as const, failureCode: 'INVALID_ARGUMENTS',
        summary: '准备目标参数相互冲突', output: `本任务允许准备冻结的全书第 ${args.targetOrderIndex} 章；chapterId 指向已有第 ${chapter.orderIndex} 章，两者不是同一目标。前章只作参考，不得填作新章目标ID。本次没有建立编译或修改正文。请重新调用 story_compiler_prepare，保留 intentSummary、targetOrderIndex=${args.targetOrderIndex} 和原 volumeDecision，省略 chapterId；服务端会定位本任务新章或已绑定的目标，不扩大授权。` }
    }
    const prepared = await prepareStoryCompilation({
      userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId,
      chapterId: args.chapterId,
      fallbackChapterId: args.targetOrderIndex === undefined ? ctx.chapterId ?? undefined : undefined,
      targetOrderIndex: args.targetOrderIndex,
      mode: ctx.qualityMode,
      intentSummary: args.intentSummary,
      detailPlanId: args.detailPlanId,
      volumeDecision: args.volumeDecision,
    }, ctx.transaction)
    const bridge = prepared.bridge
    const workflowMilestone = prepared.preparedFirstForTarget ? { version: 1 as const, userId: ctx.userId, novelId: ctx.novelId,
      runId: ctx.runId, targetOrderIndex: prepared.compilation.targetOrderIndex, phase: 'prepare' as const } : undefined
    const items = [
      renderWritingPlanContext(prepared.compilation.preparedContext),
      `已记录的卷安排：${JSON.stringify((prepared.compilation.preparedContext as Record<string, unknown>).volumeDecision)}；卷上下文：${JSON.stringify((prepared.compilation.preparedContext as Record<string, unknown>).volumeContext)}。按作者要求和真实剧情决定后续工具。`,
      bridge.lastUnfinishedAction ? `未完成动作：${bridge.lastUnfinishedAction}` : '前章无明确未完成动作',
      bridge.location || bridge.storyTime ? `连续时空：${bridge.storyTime || '未标注'} · ${bridge.location || '未标注'}` : '时空状态待 Scene Task 明确',
      bridge.emotionAftermath.length ? `情绪余波：${bridge.emotionAftermath.join('；')}` : '情绪余波待 Scene Task 明确',
      bridge.recentOpenings.length ? `近期避免重复开篇：${bridge.recentOpenings.join(' / ')}` : '无近期开篇样本',
      bridge.openLoops.length ? `开放钩子：${bridge.openLoops.slice(0, 4).join('；')}` : '无已记录开放钩子',
    ]
    return {
      output: `上下文已准备，compilationId=${prepared.compilation.id}，chapterId=${prepared.compilation.chapterId ?? '尚未创建'}，目标全书第 ${prepared.compilation.targetOrderIndex} 章。根据原请求选择写入、场景记录或检查，不要求固定顺序。\n${items.join('\n')}\n${renderWritingContinuityReference(prepared.continuityReference) ?? ''}`,
      summary: `准备第 ${prepared.compilation.targetOrderIndex} 章写作`,
      ...(workflowMilestone ? { workflowMilestone } : {}),
      display: {
        kind: 'storyCompiler', compilationId: prepared.compilation.id, phase: 'prepare', title: '准备章节写作',
        detail: `第 ${prepared.compilation.targetOrderIndex} 章 · ${ctx.qualityMode === 'premium' ? '精品' : '平衡'}`, items,
      },
    }
  },
})

export const sceneTaskBuildTool = defineTool({
  name: 'scene_task_build',
  title: '构建场景任务',
  description:
    '保存或更新本章场景记录，用于辅助写作；场景数量和使用顺序由Agent按原请求决定。状态字段只填变化，省略未变化字段。cost记录实际后果，不额外强加损失。最小原生参数示例：{"tasks":[{"purpose":"概述本场景作用","goal":"人物当前目标","obstacle":"本场景阻力","choice":"人物本场景选择","cost":"已设定代价或本次实际结果","turn":"本场景状态变化"}]}',
  parameters: z.object({
    compilationId: z.string().min(1).optional(),
    tasks: z.array(sceneTaskInputSchema.extend({
      entryState: sceneTaskInputSchema.shape.entryState.prefault({}),
      exitState: sceneTaskInputSchema.shape.exitState.prefault({}),
      styleBudget: sceneTaskInputSchema.shape.styleBudget.default({ description: 'low', dialogue: 'medium', rhetoric: 'low' }),
    }), { error: issue => typeof issue.input === 'string'
      ? 'tasks 内层 JSON 不是有效数组；请改用原生 tasks 数组原样提交完整场景，不补闭合符或缺失业务内容。' : undefined }).min(1),
    alternatives: z.array(z.object({
      label: z.string().min(1).max(120).default('备选推进'),
      tradeoff: z.string().min(1).max(500).default('与当前 Scene Task 链相比的节奏和冲突取舍。'),
      rejectedReason: z.string().min(1).max(500).default('当前 Scene Task 链更符合本章目标。'),
    })).max(3).default([]).describe('可选；服务端会为精品模式补齐候选审计，不得因此重试'),
  }),
  coerceArgs(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    // 协议层兜底先行：模型偶发把参数包进 {"arguments": "<字符串化 JSON>"} 信封或 [{name,value}] 列表，
    // 不解包就会直接 zod 失败重试一轮（该工具的高频失败点）
    const unwrapped = coerceToolArgumentEnvelope(raw)
    let source = (unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)
      ? unwrapped
      : raw) as Record<string, unknown>
    for (const key of ['arguments', 'args', 'params', 'parameters'] as const) {
      const wrapped = source[key]
      if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
        const candidate = wrapped as Record<string, unknown>
        if (candidate.tasks !== undefined || candidate.sceneTasks !== undefined || candidate.scene_tasks !== undefined) {
          source = { ...candidate, compilationId: source.compilationId ?? candidate.compilationId }
          break
        }
      }
    }
    const next = { ...source }
    // Some OpenAI-compatible gateways encode the nested array once more.
    // Parse only complete JSON arrays; never repair truncation or drop scenes.
    if (typeof next.tasks === 'string') {
      try {
        let decoded: unknown = JSON.parse(next.tasks)
        if (typeof decoded === 'string') decoded = JSON.parse(decoded)
        if (Array.isArray(decoded)) next.tasks = decoded
      } catch { /* Keep the original for a field-level schema rejection. */ }
    }
    if (!next.compilationId && typeof next.compilation_id === 'string') next.compilationId = next.compilation_id
    if (!next.tasks && Array.isArray(next.sceneTasks)) next.tasks = next.sceneTasks
    if (!next.tasks && Array.isArray(next.scene_tasks)) next.tasks = next.scene_tasks
    if (!Array.isArray(next.tasks) && next.tasks && typeof next.tasks === 'object') next.tasks = [next.tasks]
    if (Array.isArray(next.tasks)) {
      const asText = (value: unknown, fallback?: string) => {
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 1000)
        if (typeof value === 'number' || typeof value === 'boolean') return String(value).slice(0, 1000)
        return fallback
      }
      const asList = (value: unknown) => Array.isArray(value)
        ? value.map((item) => asText(item, '')).filter(Boolean).slice(0, 30)
        : typeof value === 'string' && value.trim() ? [value.trim().slice(0, 300)] : []
      const asState = (value: unknown) => {
        const state = value && typeof value === 'object' && !Array.isArray(value)
          ? value as Record<string, unknown>
          : {}
        return Object.fromEntries(Object.entries({
          action: typeof state.action === 'string' ? state.action.slice(0, 500) : undefined,
          location: typeof state.location === 'string' ? state.location.slice(0, 160) : undefined,
          storyTime: typeof (state.storyTime ?? state.story_time) === 'string' ? String(state.storyTime ?? state.story_time).slice(0, 160) : undefined,
          knowledge: asList(state.knowledge), emotion: asList(state.emotion), body: asList(state.body),
          objects: asList(state.objects), relationships: asList(state.relationships), openLoops: asList(state.openLoops ?? state.open_loops),
        }).filter(([, item]) => item !== undefined))
      }
      const normalized = next.tasks.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value
        const item = value as Record<string, unknown>
        const purpose = asText(item.purpose ?? item.intent ?? item.summary)
        const normalizeBudget = (value: unknown) => {
          const budget = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
          const level = (candidate: unknown, fallback: 'low' | 'medium' | 'high') =>
            candidate === 'low' || candidate === 'medium' || candidate === 'high' ? candidate : fallback
          return { description: level(budget.description, 'low'), dialogue: level(budget.dialogue, 'medium'), rhetoric: level(budget.rhetoric, 'low') }
        }
        return {
          ...item,
          purpose,
          entryState: asState(item.entryState ?? item.entry_state),
          goal: asText(item.goal ?? item.objective),
          obstacle: asText(item.obstacle ?? item.resistance ?? item.conflict),
          choice: asText(item.choice ?? item.decision),
          cost: asText(item.cost ?? item.consequence),
          turn: asText(item.turn ?? item.twist),
          exitState: asState(item.exitState ?? item.exit_state),
          styleBudget: normalizeBudget(item.styleBudget ?? item.style_budget),
        }
      })
      // Repair representation, not the requested scene chain. Let the schema
      // reject invalid entries/overflow instead of silently dropping scenes
      // and reporting a successful but incomplete build.
      next.tasks = normalized
    }
    if (next.compilationId === null || next.compilationId === '') delete next.compilationId
    if (!Array.isArray(next.alternatives)) delete next.alternatives
    if (Array.isArray(next.alternatives)) {
      next.alternatives = next.alternatives.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value
        const item = value as Record<string, unknown>
        return {
          label: item.label ?? item.title ?? item.option,
          tradeoff: item.tradeoff ?? item.tradeOff ?? item.rationale,
          rejectedReason: item.rejectedReason ?? item.rejected_reason ?? item.reason,
        }
      })
    }
    return next
  },
  permission: BUILD_WRITE,
  readOnly: false,
  async execute(ctx, args) {
    const db = ctx.transaction ?? prisma
    if (args.compilationId && ctx.durableCompiler?.baseline && args.compilationId !== ctx.durableCompiler.baseline.id) {
      return { outcome: 'failed' as const, failureCode: 'COMPILATION_IDENTITY_MISMATCH', output: '指定编译编号与本任务读取的编译身份不一致。compilationId 不能使用章节或任务合同编号；请用 chapter_bridge_get 核对本任务真实身份，不替换显式编号执行。', summary: '场景编译身份不匹配' }
    }
    const scope = await compilationRunScope(db, ctx)
    const candidates = await db.storyCompilation.findMany({
      where: {
        userId: ctx.userId,
        novelId: ctx.novelId,
        status: { in: ['active', 'completed'] },
        ...scope,
        ...(ctx.durableCompiler ? { id: ctx.durableCompiler.baseline?.id ?? '__missing__' } : args.compilationId ? { id: args.compilationId } : {}),
      },
      include: { sceneTasks: { orderBy: { ordinal: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
      take: 6,
    })
    const compilation = candidates[0]
    if (!compilation) return { outcome: 'failed' as const, failureCode: 'COMPILATION_NOT_FOUND', output: `未找到本任务指定的 compilationId，章节编号与编译编号不可混用。${await missingCompilationGuidance(db, ctx, scope)}`, summary: '未找到场景编译记录' }
    const saved = await saveSceneTasksWithMilestone({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, compilationId: compilation.id, tasks: args.tasks, alternatives: args.alternatives }, ctx.transaction)
    const { tasks } = saved
    return {
      ...(saved.scenesFirstForTarget ? { workflowMilestone: { version: 1 as const, userId: ctx.userId, novelId: ctx.novelId,
        runId: ctx.runId, targetOrderIndex: saved.targetOrderIndex, phase: 'scenes' as const } } : {}),
      output: `已为 compilationId=${compilation.id} 保存 ${tasks.length} 个场景任务。根据原请求继续写作、修改或检查。正文保存与报告通过分别说明，不自动追加检查。`,
      summary: `建立 ${tasks.length} 个场景任务`,
      display: {
        kind: 'storyCompiler', compilationId: compilation.id, phase: 'beat', title: '场景任务',
        detail: `${tasks.length} 个场景`, items: tasks.map((task) => `${task.ordinal}. ${task.purpose}｜转折：${task.turn}`),
      },
    }
  },
})

export const chapterBridgeGetTool = defineTool({
  name: 'chapter_bridge_get',
  title: '读取章节桥',
  description:
    '只读取当前任务合同的 Chapter Bridge、Scene Task 与阶段状态，不接管同作品历史失败任务。没有本任务编译时先用 story_compiler_prepare 建立；写下一章不要将编辑器当前旧章当作目标。该工具只读。',
  parameters: z.object({ compilationId: z.string().min(1).optional() }),
  permission: ALL_READ,
  readOnly: true,
  async execute(ctx, args) {
    const db = ctx.transaction ?? prisma, scope = await compilationRunScope(db, ctx)
    const compilation = await db.storyCompilation.findFirst({ where: { userId: ctx.userId, novelId: ctx.novelId, ...scope,
      ...(args.compilationId ? { id: args.compilationId } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } }, chapter: true } })
    if (!compilation && !args.compilationId) return { output: `当前任务尚未建立章节桥。${await missingCompilationGuidance(db, ctx, scope)}`, summary: '本任务尚未建立章节桥' }
    if (!compilation?.bridge) return { outcome: 'failed' as const, failureCode: 'COMPILATION_NOT_FOUND', output: '没有当前作者任务可读取的章节桥。', summary: '未找到章节编译状态' }
    const continuityReference = await readWritingContinuityReference(db, ctx, compilation.targetOrderIndex)
    let review: Awaited<ReturnType<typeof readChapterReviewReadiness>> = null
    let planStale = false
    try { review = await readChapterReviewReadiness(db, ctx, compilation.id) } catch (error) {
      if (!(error instanceof DataAccessError) || error.code !== 'PLAN_CONTEXT_STALE') throw error
      planStale = true
    }
    const retained = review?.retainedDecisions ?? []
    const items = [`第 ${compilation.targetOrderIndex} 章；${review?.terminalCommitted ? '当前正文已提交' : '当前正文尚未提交'}`,
      `连续性报告：${planStale ? '待核（冻结计划已变化）' : review?.continuity ?? 'missing'}；人类感质量报告：${planStale ? '待核（冻结计划已变化）' : review?.quality ?? 'missing'}；提纲一致性：${planStale ? 'stale' : review?.planAlignment ?? '未绑定提纲'}`,
      `剩余意见 ${review?.decisionEntries?.length ?? 0} 条，已明确保留 ${retained.length} 条。保留意见不等于已修复。`]
    return { summary: `读取第 ${compilation.targetOrderIndex} 章章节桥`,
      ...(review?.decisionFeedback ? { reviewDecisionFeedback: review.decisionFeedback } : {}),
      output: `compilationId=${compilation.id}；chapterId=${compilation.chapterId ?? '尚未创建'}；revision=${compilation.chapter?.revision ?? '无正文'}\n${items.join('\n')}
${renderWritingPlanContext(compilation.preparedContext)}
${planStale ? '冻结计划已变化，以下保留原始历史报告，不能认证当前正文：' + JSON.stringify(compilation.validation) : ''}
原章节桥保存的前章来源：${JSON.stringify({ chapterId: compilation.bridge.fromChapterId, revision: compilation.bridge.sourceRevision })}
${renderWritingContinuityReference(continuityReference) ?? ''}
场景任务：${JSON.stringify(compilation.sceneTasks.map(task => ({ ordinal: task.ordinal, purpose: task.purpose, goal: task.goal, obstacle: task.obstacle, cost: task.cost, turn: task.turn })))}
当前报告意见：${JSON.stringify(review?.decisionDetails ?? [])}
明确保留意见：${JSON.stringify(retained)}\n${review ? chapterReviewDecisionGuidance(review) : ''}`,
      display: { kind: 'storyCompiler', compilationId: compilation.id, phase: compilation.stage, title: review?.terminalCommitted ? '章节已提交' : '章节桥', detail: items[1], items } }
},
})

export const continuityValidateTool = defineTool({
  name: 'continuity_validate', title: '检查章节连续性',
  description: '检查指定已保存章节及真实前文，返回完整连续性报告。严谨创作可在原授权范围内按已定位问题自动局部修订。只看不改或改后只读复核传 readOnly=true。报告完成与问题已解决分别说明。',
  parameters: z.object({ chapterId: z.string().min(1).optional(), compilationId: z.string().min(1).optional(), focus: z.string().max(500).optional(),
    readOnly: z.boolean().optional().describe('只保存检查报告，不执行正文修订') }).passthrough(),
  permission: ALL_READ, readOnly: true,
  coerceArgs(raw) {
    const value = coerceToolArgumentEnvelope(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const result = { ...value } as Record<string, unknown>
    const chapterId = result.chapterId ?? result.chapter_id ?? result.chapter
    const compilationId = result.compilationId ?? result.compilation_id ?? result.compilation
    if (chapterId !== undefined) result.chapterId = chapterId
    if (compilationId !== undefined) result.compilationId = compilationId
    return result
  },
  async execute(ctx, args): Promise<ToolResult> {
    if (ctx.durableCompiler) return (await import('./durable-continuity.js')).executeDurableContinuity(ctx, continuityValidateTool, args)
    return reviewContinuity(ctx, args)
  },
})

export const chapterBridgeCommitTool = defineTool({
  name: 'chapter_bridge_commit', title: '提交章节',
  description: '提交本任务当前已保存的章节版本。检查工具可根据作者请求独立调用；报告缺失、不完整或含建议不会阻止保存和提交，报告状态仍须如实说明，不能把提交称为检查通过。',
  parameters: z.object({ compilationId: z.string().min(1).optional(), chapterSummary: z.string().max(2000).optional(), retainedFindings }).passthrough(),
  permission: { plan: 'deny', build: 'allow', review: 'deny' } as const, readOnly: false,
  async execute(ctx, args): Promise<ToolResult> {
    const db = ctx.transaction ?? prisma
    const scope = await compilationRunScope(db, ctx)
    let compilation = await db.storyCompilation.findFirst({ where: { userId: ctx.userId, novelId: ctx.novelId, ...scope,
      ...(args.compilationId ? { id: args.compilationId } : {}), status: { in: ['active', 'completed'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { chapter: true, bridge: true } })
    if (!compilation?.chapter || !compilation.bridge) throw new DataAccessError(404, 'COMPILATION_NOT_FOUND', '没有本任务可提交的已保存章节。')
    if (compilation.status === 'active' && await db.storyCompilation.findFirst({ where: { userId: ctx.userId, novelId: ctx.novelId, ...scope,
      chapterId: compilation.chapterId, createdAt: { gt: compilation.createdAt } }, select: { id: true } }))
      return { outcome: 'failed', failureCode: 'COMPILATION_STAGE_CONFLICT', summary: '章节编译已被后续准备替代',
        output: '该章已有本任务后续准备的编译，请读取当前章节桥；本次未覆盖新编译或重复提交。' }
    compilation = await db.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { chapter: true, bridge: true } })
    const chapter = compilation.chapter!
    const contentHash = persistedContentHash(chapter.content)
    const prepared = compilation.preparedContext && typeof compilation.preparedContext === 'object' && !Array.isArray(compilation.preparedContext) ? compilation.preparedContext : {}
    const wasCommitted = Boolean(compilation.bridge?.committedAt && compilation.bridge.targetRevision === chapter.revision && prepared.terminalContentHash === contentHash)
    let result: Awaited<ReturnType<typeof commitChapterBridge>>
    try { result = await commitChapterBridge({ ...ctx, compilationId: compilation.id, chapterSummary: args.chapterSummary ?? chapter.content.slice(0, 600),
      exitState: storyStateSchema.parse({}), lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '',
      openingStructure: chapter.content.slice(0, 200), endingStructure: chapter.content.slice(-200), expectedChapterRevision: chapter.revision,
      expectedContentHash: persistedContentHash(chapter.content), retainedFindings: args.retainedFindings }, ctx.transaction) } catch (error) {
      if (!(error instanceof DataAccessError) || !['CONTINUITY_ERRORS_REMAIN', 'REVIEW_DECISION_REQUIRED', 'QUALITY_CHECK_REQUIRED', 'CONTINUITY_CHECK_REQUIRED', 'COMPILATION_STAGE_CONFLICT'].includes(error.code)) throw error
      const current = await readChapterReviewReadiness(db, ctx, compilation.id)
      return { outcome: 'failed', failureCode: error.code, summary: error.code === 'COMPILATION_STAGE_CONFLICT' ? '章节编译已被后续准备替代' : '章节尚未提交', output: `${error.message}\n${current ? chapterReviewDecisionGuidance(current) : ''}\n当前真实意见：${JSON.stringify(current?.decisionDetails ?? [])}\n需明确处置：${JSON.stringify(current?.requiredDecisions ?? [])}\n保留原文时请引用这些当前 source/reportId/findingId 并说明具体理由；真实硬通过要求不能以保留代替。` }
    }
    const final = await readAdvisoryChapterReviewReadiness(db, ctx, result.compilationId)
    const remaining = final?.decisionEntries?.length ?? 0, retainedCount = final?.retainedDecisions?.length ?? 0
    return { output: `当前正文已保存，章节已提交。连续性报告：${final?.continuity ?? '未核验'}；人类感质量报告：${final?.quality ?? '未核验'}。${remaining ? `当前仍有 ${remaining} 条报告意见，其中 ${retainedCount} 条已明确保留；保留不代表已修复。` : '提交不表示检查已完成或通过；检查结论以实际报告为准。'}`, summary: '章节已提交',
      semanticTransition: { targetId: result.compilationId,
        beforeHash: runtimeJson({ committed: wasCommitted, chapterId: chapter.id, chapterRevision: chapter.revision, contentHash }).hash,
        afterHash: runtimeJson({ committed: true, chapterId: chapter.id, chapterRevision: chapter.revision, contentHash }).hash },
      display: { kind: 'storyCompiler', compilationId: result.compilationId, phase: 'commit', title: '章节已提交', detail: 'r' + result.chapterRevision, items: [`保留意见 ${retainedCount} 条`] } }
  },
})
