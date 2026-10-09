import { retainedFindings } from './chapter-arguments.js'
import { readChapterReviewReadiness, chapterReviewDecisionGuidance } from '../chapter-review-guard.js'
import { parseQualityJsonObject } from '../quality-evidence.js'
import { persistedContentHash } from '../semantic-progress.js'
import { continuityFindingText, continuitySourceInput, resolveContinuitySources, continuityRecheckInput, unconfirmedContinuityOutput, type ContinuityBodies } from '../continuity-review-context.js'
import { unlocatedContinuityEvidence } from '../continuity-finding-authority.js'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { auxiliaryTextModel } from '../auxiliary-text-model.js'
import { z } from 'zod'
import { writingVolumeDecisionSchema } from '../../../../shared/contracts/writing-volume-contracts.js'

import {
  continuityFindingInputSchema,
  readerPromiseInputSchema,
  sceneTaskInputSchema,
  storyCharterInputSchema,
  storyStateSchema,
} from '../../../../shared/contracts/index.js'
import { generateReviewCompletion, REVIEW_MAX_OUTPUT_TOKENS } from '../review-completion.js'
import { DataAccessError, prisma } from '../../prisma.js'
import { activeChapterScope } from '../../data/internal.js'
import { assertAgentManuscriptCurrent } from '../manuscript-scope.js'
import { qualityCompilationScope, resolveQualityChapterTarget } from '../humanity-quality.js'
import { compilerContinuityCoverage, compilerContinuityCoverageMatches } from '../compiler-continuity-contract.js'
import {
  commitChapterBridge,
  getStoryCharterBundle,
  prepareStoryCompilation,
  compilationRunScope,
  isWritingTaskContinuityCompiler,
  saveReaderPromise,
  saveSceneTasksWithMilestone,
  upsertStoryCharter,
  updateReaderPromise,
  validateStoryContinuity,
  reserveContinuityCheck,
} from '../story-compiler.js'
import { defineTool, type ToolContext } from './types.js'
import { readChapterReviewRevisionGuidance, continuityDecisionBinding } from '../chapter-review-guard.js'
import { readOriginalTaskRequest } from '../original-request.js'
import { coerceToolArgumentEnvelope, firstDefined } from './argument-coercion.js'
import { storyCharterHash } from './durable-metadata.js'
import { readWritingScope } from '../writing-scope.js'
import { qualityReportCheckedCurrentContent } from '../quality-report-contract.js'

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

const independentContinuityResultSchema = z.object({
  findings: z.array(continuityFindingInputSchema).max(30),
})

export function parseIndependentContinuityResult(content: string, parserVersion: 1 | 2 = 2, bodies?: ContinuityBodies): { findings: z.infer<typeof continuityFindingInputSchema>[]; structured: boolean } {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start === -1 || end <= start) return { findings: [], structured: false }
  try {
    const raw = parserVersion === 1 ? JSON.parse(content.slice(start, end + 1)) : parseQualityJsonObject(content, 'continuity', 2)
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    if (parserVersion === 2 && ['findings', 'issues', 'problems'].filter(key => Object.prototype.hasOwnProperty.call(record, key)).length !== 1) return { findings: [], structured: false }
    const findings = firstDefined(record, ['findings', 'issues', 'problems'])
    const candidate = { findings: parserVersion === 2 && Array.isArray(findings) ? findings.map(item => {
      item = bodies ? resolveContinuitySources(item, bodies) : item
      if (!item || typeof item !== 'object' || item.sourceEvidence !== undefined || typeof item.evidence !== 'string') return item
      const quotes = [...item.evidence.matchAll(/(前章已保存原文|当前正文)[:：]\s*(?:'([^']{2,360})'|“([^”]{2,360})”|"([^"]{2,360})")/gu)]
        .map(match => ({ source: match[1] === '前章已保存原文' ? 'previous' : 'current', quote: match[2] ?? match[3] ?? match[4] }))
      return quotes.length ? { ...item, sourceEvidence: quotes } : item
    }) : findings }
    const parsed = independentContinuityResultSchema.safeParse(candidate)
    return parsed.success ? { findings: parsed.data.findings, structured: true } : { findings: [], structured: false }
  } catch {
    return { findings: [], structured: false }
  }
}

const continuityRepairEnvelopeSchema = z.object({
  patches: z.array(z.object({ oldText: z.string().min(1).max(1800), newText: z.string().max(2200) })).max(10),
})

export const continuityCriticSystem = `你是独立的中文小说连续性编辑，只检查已保存原文中真实互斥的事实，不润色、不续写。
先核对对象身份和事件先后；只有同一时刻、同一对象、同一维度互斥才报 error。省略、换场、之后移动、现金与银行余额不同不等于矛盾；制造声势或虚张不表示外观数量不能增加。信息不足时不要猜测。
核账时先区分交易对象、收入/支出/报价/成交价/估值，以及现金与银行账户。前章期末余额已包含前章收支，不重复加收入或扣房租；本章新交易不能套用另一物品成交价。标价与估值、议价与最终成交不是同一金额性质。
原始作者硬要求与已保存原文优先。章节桥是待核摘要，Scene Task 是生成草案，不能单凭计划偏离报 error，不得把作者硬要求降级成草案。warning与审美意见保留待审，不驱动自动改稿；修法困难不改变事实判定。
完整读完再输出已确认结论。一个事实只报一次，不输出核查过程、“无互斥”推演或同一问题的不同说法。复检核对原问题是否已解决以及改动是否引入真实新冲突；不换角度反复追问已成立的事实。无问题返回 {"findings":[]}。
每项必须用 sourceEvidence 标明两处互斥事实的来源 previous/current，优先引用所给 segmentId，不抄写长原文。可以引用同章两处事实；同段冲突可附 quote 指定两句不同短引。不从旧报告复制引用。evidence 只用一句话说明冲突，suggestion 只给最小修法。signal 选 knowledge/location_time/body/object/relationship/emotion/hook/structure 之一，severity 选 error 或 warning，不把可选值串起来。
只输出完整 JSON 对象，首字符是 {，禁止把整个对象编码成带外层引号的字符串，不输出分析或 Markdown。合法结构示例：{"findings":[{"signal":"object","severity":"error","evidence":"同一枚钱币在同一时刻被描述为已售出和仍在手中。","suggestion":"根据真实事件统一钱币归属。","sourceEvidence":[{"source":"previous","segmentId":"p0"},{"source":"current","segmentId":"c1"}]}]}。示例不是实际意见，不得照抄。`

/** Revision-specific guidance is last, so unchanged facts/body prefixes remain cacheable. */
export function continuityReviewTail(validation: unknown, revision: number, allowRepair: boolean, focus?: string, currentContent?: string) {
  return [
    `当前版本：r${revision}。${allowRepair ? '对同一对象有原文互斥事实证据、可安全定位的错误集中附带最小事实补丁；警告保留待审，不编造改动，无法安全修改的项交作者决定。' : '本次只读复核，不生成补丁、不改写正文。'}`,
    focus ? `作者额外关注：${focus}` : '',
    continuityRecheckInput(validation, revision, currentContent),
    '每条 finding 附 sourceEvidence:[{source:"previous"或"current",segmentId:"所给段落编号"}]，两处互斥事实分别标注来源。不要将旧版报告、Scene Task 或桥接摘要的文字填作正文原文，不用省略号拼接。',
  ].filter(Boolean).join('\n')
}

/** Reject all ambiguous/overlapping proposals before mutation, never guess an anchor. */
export function parseContinuityPatches(content: string, before: string) {
  try {
    const start = content.indexOf('{'), end = content.lastIndexOf('}')
    const { patches } = continuityRepairEnvelopeSchema.parse(JSON.parse(content.slice(start, end + 1)))
    const ranges = patches.map(patch => ({ start: before.indexOf(patch.oldText), end: before.indexOf(patch.oldText) + patch.oldText.length }))
    if (patches.some((patch, i) => ranges[i].start < 0 || before.indexOf(patch.oldText, ranges[i].start + 1) >= 0
      || ranges.some((other, j) => i !== j && ranges[i].start < other.end && ranges[i].end > other.start))) return null
    return patches.filter(patch => patch.oldText !== patch.newText)
  } catch { return null }
}

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
    '创建或修订作品级 Story Charter。作者从一句题材描述开始规划新书、生成长纲或试制前三章时，应先收敛读者承诺、主角驱动力、持续冲突与题材边界后调用；不得把套路模板或未确认的真实事实写入。旧作局部编辑不要求补建。',
  parameters: storyCharterInputSchema,
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
    '新增完整章节、从章尾继续写较长场景、或按计划重写整章前的 PREPARE 步骤：召回 Story Charter、待兑现承诺、前章终态、故事记忆和近期首尾结构，并建立可追踪 Chapter Bridge。局部选区润色/纠错、改标题、调整元数据时禁止调用。新章节尚未创建时传目标全书序号，已有章节传 chapterId。',
  parameters: z.object({
    chapterId: z.string().min(1).optional(),
    targetOrderIndex: z.number().int().min(1).optional(),
    intentSummary: z.string().min(1).max(1000).describe('本轮写作意图的事实化摘要；服务端只保存其 SHA-256，不保存原提示词'),
    volumeDecision: writingVolumeDecisionSchema.optional().describe('每次续写都审视当前卷目标：continue说明未收束原因；new_volume须真实前章收束引用+下一主困局，不能按章数分卷。旧已绑定目标不迁移'),
  }),
  permission: BUILD_WRITE,
  readOnly: false,
  async execute(ctx, args) {
    if (args.chapterId && args.targetOrderIndex !== undefined) {
      const db = ctx.transaction ?? prisma
      const scope = await readWritingScope(db, ctx)
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
      volumeDecision: args.volumeDecision,
    }, ctx.transaction)
    const bridge = prepared.bridge
    const workflowMilestone = prepared.preparedFirstForTarget ? { version: 1 as const, userId: ctx.userId, novelId: ctx.novelId,
      runId: ctx.runId, targetOrderIndex: prepared.compilation.targetOrderIndex, phase: 'prepare' as const } : undefined
    const items = [
      `本章卷处理决定：${JSON.stringify((prepared.compilation.preparedContext as Record<string, unknown>).volumeDecision)}；当前卷与计划：${JSON.stringify((prepared.compilation.preparedContext as Record<string, unknown>).volumeContext)}。仅章数增加不能作为收束。若真实卷目标已完成，先重新PREPARE提交证据，再chapter_create传同一newVolume；没有权限或证据则延续当前卷。`,
      bridge.lastUnfinishedAction ? `未完成动作：${bridge.lastUnfinishedAction}` : '前章无明确未完成动作',
      bridge.location || bridge.storyTime ? `连续时空：${bridge.storyTime || '未标注'} · ${bridge.location || '未标注'}` : '时空状态待 Scene Task 明确',
      bridge.emotionAftermath.length ? `情绪余波：${bridge.emotionAftermath.join('；')}` : '情绪余波待 Scene Task 明确',
      bridge.recentOpenings.length ? `近期避免重复开篇：${bridge.recentOpenings.join(' / ')}` : '无近期开篇样本',
      bridge.openLoops.length ? `开放钩子：${bridge.openLoops.slice(0, 4).join('；')}` : '无已记录开放钩子',
    ]
    return {
      output: `PREPARE 完成，compilationId=${prepared.compilation.id}，chapterId=${prepared.compilation.chapterId ?? '尚未创建（写入后取真实编号）'}，目标全书第 ${prepared.compilation.targetOrderIndex} 章。章节编号与编译编号不可混用。${prepared.charter ? `已加载 Story Charter r${prepared.charter.revision}` : '当前无 Story Charter，旧作可继续，但新书长纲应先建立。'}下一步只调用一次 scene_task_build 生成 1–4 个 Scene Task，禁止直接跳到正文；精品候选取舍由服务端记录，不需要手工补 alternatives。\n${items.join('\n')}`,
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
    'Story Compiler 的 BEAT 步骤。一次提交本章完整的 1–4 个场景，不是正文。先遵从完整原请求的类型、情绪承诺、身份、剧情、篇幅与精确停笔位置；不能为场景模板扩写成交或打脸。cost 记录已设定代价或实际后果，可写无额外损失或本次收益，不强加能力惩罚；low rhetoric 控制修饰密度，不压低情绪。每个 purpose/goal/obstacle/choice/cost/turn 用一句短句（建议 60 字内）；entryState/exitState 只填本场景变化的字段，每个状态列表建议最多 3 项，勿复制人物档案。省略未变化状态、styleBudget、alternatives 和 compilationId 可显著缩短参数，服务端解析当前编译并补齐流程元数据。顶层直接传 tasks 数组，禁止套 arguments 信封或为了补元数据重复调用。',
  parameters: z.object({
    compilationId: z.string().min(1).optional(),
    tasks: z.array(sceneTaskInputSchema.extend({
      entryState: sceneTaskInputSchema.shape.entryState.prefault({}),
      exitState: sceneTaskInputSchema.shape.exitState.prefault({}),
      styleBudget: sceneTaskInputSchema.shape.styleBudget.default({ description: 'low', dialogue: 'medium', rhetoric: 'low' }),
    }), { error: issue => typeof issue.input === 'string'
      ? 'tasks 内层 JSON 不是有效数组；请改用原生 tasks 数组原样提交完整 1–4 个场景，不补闭合符或缺失业务内容。' : undefined }).min(1).max(4),
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
      const asText = (value: unknown, fallback: string) => {
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
      const normalized = next.tasks.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value
        const item = value as Record<string, unknown>
        const purpose = asText(item.purpose ?? item.intent ?? item.summary, `推进第 ${index + 1} 个场景`)
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
          goal: asText(item.goal ?? item.objective, purpose),
          obstacle: asText(item.obstacle ?? item.resistance ?? item.conflict, '目标受到具体阻力'),
          choice: asText(item.choice ?? item.decision, '人物必须作出选择'),
          cost: asText(item.cost ?? item.consequence, '按既有设定记录实际后果，可无额外损失'),
          turn: asText(item.turn ?? item.twist, '场景状态发生变化'),
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
        status: 'active',
        ...scope,
        ...(ctx.durableCompiler ? { id: ctx.durableCompiler.baseline?.id ?? '__missing__' } : args.compilationId ? { id: args.compilationId } : {}),
      },
      include: { sceneTasks: { orderBy: { ordinal: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
      take: 6,
    })
    const compilation = candidates[0]
    if (!compilation) return { outcome: 'failed' as const, failureCode: 'COMPILATION_NOT_FOUND', output: `未找到本任务指定的活跃 compilationId，章节编号与编译编号不可混用。${await missingCompilationGuidance(db, ctx, scope)}`, summary: '未找到场景编译状态' }
    if (!['prepare', 'beat'].includes(compilation.stage) && compilation.sceneTasks.length > 0) {
      return {
        output: `compilationId=${compilation.id} 已建立 ${compilation.sceneTasks.length} 个 Scene Task 并进入 ${compilation.stage} 阶段，无需重复构建。`,
        summary: `复用 ${compilation.sceneTasks.length} 个场景任务`,
        display: { kind: 'storyCompiler', compilationId: compilation.id, phase: compilation.stage, title: '场景任务已建立', detail: `${compilation.sceneTasks.length} 个场景`, items: compilation.sceneTasks.map((task) => `${task.ordinal}. ${task.purpose}｜转折：${task.turn}`) },
      }
    }
    const saved = await saveSceneTasksWithMilestone({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, compilationId: compilation.id, tasks: args.tasks, alternatives: args.alternatives }, ctx.transaction)
    const { tasks } = saved
    return {
      ...(saved.scenesFirstForTarget ? { workflowMilestone: { version: 1 as const, userId: ctx.userId, novelId: ctx.novelId,
        runId: ctx.runId, targetOrderIndex: saved.targetOrderIndex, phase: 'scenes' as const } } : {}),
      output: `BEAT 完成，已为 compilationId=${compilation.id} 建立 ${tasks.length} 个 Scene Task；精品候选取舍已由服务端记录。现在按顺序完成连贯正文，再提交章节终态。写作交付按原始作者请求完成当前版本连续性与质量检查，仅原始请求可明确跳过。相关安全事实与质量修法优先合并为 chapter_edit_range patches（每次最多8处），也可连续单片段替换或 chapter_write，不硬性限制为一次调用或要求每次覆盖全部候选。每次依据当前正文精确定位，不把报告当作额外权限；全部修改后只读复核最终版本两类检查，最后提交终态。不能安全落实的意见保留，可用 retainedFindings 绑定当前报告并说明原因；留置不冒充修复，不为清零意见循环改稿。付费检查、自动修订和未知调用保持既有保护。`,
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
    const db = ctx.transaction ?? prisma
    const scope = await compilationRunScope(db, ctx)
    const compilation = await db.storyCompilation.findFirst({
      where: { userId: ctx.userId, novelId: ctx.novelId, ...(args.compilationId ? { id: args.compilationId } : {}),
        ...scope },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } }, chapter: { select: { title: true, revision: true, content: true } }, qualityReports: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, include: { findings: true } } },
    })
    if (!compilation?.bridge) return { outcome: 'failed' as const, failureCode: 'COMPILATION_NOT_FOUND',
      output: `当前任务没有可读取的指定 Chapter Bridge，compilationId 不能使用章节或任务合同编号。${compilation ? '编译缺少章节桥，身份异常需核对，不能重建绕过。' : await missingCompilationGuidance(db, ctx, scope)}`, summary: '未找到章节编译状态' }
    const bridge = compilation.bridge
    const items = [
      bridge.lastUnfinishedAction ? `未完成动作：${bridge.lastUnfinishedAction}` : '未完成动作：无',
      `地点/时间：${bridge.location || '未标注'} / ${bridge.storyTime || '未标注'}`,
      `人物已知：${asStrings(bridge.knowledgeState).join('；') || '未记录'}`,
      `情绪余波：${asStrings(bridge.emotionAftermath).join('；') || '未记录'}`,
      `物品状态：${asStrings(bridge.objectState).join('；') || '未记录'}`,
      `开放钩子：${asStrings(bridge.openLoops).join('；') || '无'}`,
    ]
    const review = await readChapterReviewReadiness(db, ctx, compilation.id)
    const report = review?.qualityReportId ? await db.chapterQualityReport.findUnique({ where: { id: review.qualityReportId }, include: { findings: { orderBy: { startOffset: 'asc' } } } }) : compilation.qualityReports[0]
    const currentQuality = review?.qualityReportId === report?.id && report && compilation.chapter && report.userId === ctx.userId && report.novelId === ctx.novelId
      && report.chapterId === compilation.chapterId && qualityReportCheckedCurrentContent(report, compilation.chapter.revision, compilation.chapter.content)
    const qualityDetails = currentQuality
      ? `当前质量报告 reportId=${report.id}，r${report.chapterRevision}；下列原报告意见保留审计；已留置项不代表已修复，必需未处置项见末尾精确模板。\n${report.findings.filter(item => item.disposition !== 'repaired' && item.authorFeedback !== 'rejected')
        .map(item => `[findingId=${item.id}/${item.severity}/${review?.retainedDecisions?.some(saved => saved.source === 'quality' && saved.reportId === report.id && saved.findingId === item.id) ? '已明确留置' : item.disposition}] 「${item.evidenceExcerpt}」；原因：${item.explanation}；建议：${item.suggestion}`).join('\n') || '无剩余候选。'}`
      : report ? `质量报告 reportId=${report.id} 不属于当前完整正文检查，不能用旧候选证明当前版本通过。` : '当前质量报告尚未建立。'
    return {
      output: `compilationId=${compilation.id}，chapterId=${compilation.chapterId ?? '尚未创建'}，阶段=${compilation.stage}，状态=${compilation.status}，目标第 ${compilation.targetOrderIndex} 章。章节编号与编译编号不可混用。\n${items.join('\n')}\nScene Task：\n${compilation.sceneTasks.map((task) => `${task.ordinal}. ${task.purpose}｜目标 ${task.goal}｜阻力 ${task.obstacle}｜代价 ${task.cost}｜转折 ${task.turn}`).join('\n') || '尚未建立'}\n${qualityDetails}\n${review ? chapterReviewDecisionGuidance(review) : ''}`,
      summary: `读取第 ${compilation.targetOrderIndex} 章章节桥`,
      display: { kind: 'storyCompiler', compilationId: compilation.id, phase: compilation.stage, title: '章节桥', detail: `第 ${compilation.targetOrderIndex} 章 · ${compilation.stage}`, items },
    }
  },
})

/** 独立审阅只读取当前正文和真实前章，不创建场景任务、不接管旧任务的提交状态。 */
export async function buildStandaloneContinuityContext(ctx: Pick<ToolContext, 'userId' | 'novelId' | 'runId' | 'chapterId'>, chapterId?: string, db: Prisma.TransactionClient = prisma) {
  const targetId = await resolveQualityChapterTarget({ ...ctx, chapterId, fallbackChapterId: ctx.chapterId }, db)
  if (!targetId) throw new DataAccessError(400, 'CHAPTER_NOT_FOUND', '请从 chapter_read 或作品目录取得真实 chapterId；无需准备章节写作。')
  const chapter = await db.chapter.findFirst({ where: { id: targetId, authorId: ctx.userId, ...activeChapterScope(ctx.novelId) },
    select: { id: true, title: true, revision: true, content: true, orderIndex: true } })
  if (!chapter) throw new DataAccessError(404, 'CHAPTER_NOT_FOUND', 'chapterId 不是当前作品的有效章节编号；不要使用 compilationId 或猜测编号，请读取作品目录。')
  if (!chapter.content.trim()) throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '目标正文为空，未调用检查模型。')
  const preceding = await db.chapter.findMany({ where: { authorId: ctx.userId, ...activeChapterScope(ctx.novelId), orderIndex: { lt: chapter.orderIndex } },
    orderBy: { orderIndex: 'desc' }, take: 3, select: { id: true, title: true, revision: true, content: true, orderIndex: true } })
  const charter = await db.storyCharter.findUnique({ where: { novelId: ctx.novelId } })
  const contextHash = createHash('sha256').update(JSON.stringify({ chapter, preceding, charter })).digest('hex')
  const precedingBodies = [...preceding].reverse().map(item => item.content).join('\n\n')
  const criticInput = `独立连续性审阅；没有场景计划不构成错误，不要求补建编译或提交章节桥。仅审阅所给正文与前三章范围，不能声称验证未提供的全书。\n作品约定（不是已经发生的事实）：${JSON.stringify(charter)}\n目标章节 chapterId=${chapter.id}，《${chapter.title}》@r${chapter.revision}\n${continuitySourceInput({ previous: precedingBodies, current: chapter.content })}`
  return { chapter, contextHash, criticInput, precedingBodies }
}

function standaloneReviewKey(contextHash: string, focus?: string, protocol = 2) {
  return createHash('sha256').update(JSON.stringify({ protocol, contextHash, focus: focus ?? '' })).digest('hex')
}

export async function readStandaloneContinuityReport(ctx: ToolContext, contextHash: string, focus?: string, db: Prisma.TransactionClient = prisma, protocol = 2) {
  const artifact = await db.agentArtifact.findFirst({ where: { runId: ctx.runId, run: { userId: ctx.userId, novelId: ctx.novelId }, artifactType: 'continuityReview',
    metadata: { path: ['standaloneKey'], equals: standaloneReviewKey(contextHash, focus, protocol) } }, orderBy: { createdAt: 'desc' } })
  if (!artifact) return null
  const metadata = z.object({ findings: z.array(continuityFindingInputSchema) }).safeParse(artifact.metadata)
  return metadata.success ? { artifact, findings: metadata.data.findings } : null
}

export async function saveStandaloneContinuityReport(ctx: ToolContext, context: Pick<Awaited<ReturnType<typeof buildStandaloneContinuityContext>>, 'chapter' | 'contextHash' | 'criticInput'>, parsed: ReturnType<typeof parseIndependentContinuityResult>, db: Prisma.TransactionClient, focus?: string, allowSingleQuotes = true, requirePair = true): Promise<import('./types.js').ToolResult> {
  ctx.signal.throwIfAborted()
  await assertAgentManuscriptCurrent(db, ctx)
  await db.$queryRaw`SELECT id FROM chapters WHERE id = ${context.chapter.id} FOR UPDATE`
  const current = await buildStandaloneContinuityContext(ctx, context.chapter.id, db)
  if (current.contextHash !== context.contextHash) throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '正文、前章或作品约定已变化，本次报告未保存为当前版本结果；请重新读取。')
  ctx.signal.throwIfAborted()
  if (!parsed.structured) return { outcome: 'failed', failureCode: 'CONTINUITY_REPORT_INCOMPLETE', summary: '独立连续性复核未完成', output: '模型没有返回完整结构化报告，未判定通过；正文与章节桥均未修改。' }
  const cached = await readStandaloneContinuityReport(ctx, context.contextHash, focus, db, requirePair ? 2 : 1)
  const findings = cached?.findings ?? parsed.findings
  const unlocated = findings.some(item => unlocatedContinuityEvidence(item, { previous: current.precedingBodies, current: current.chapter.content }, true, allowSingleQuotes, requirePair))
  const errors = findings.filter(item => item.severity === 'error').length
  const warnings = findings.length - errors
  const output = `独立连续性检查《${context.chapter.title}》@r${context.chapter.revision}：${unlocated ? '候选未确认。' : `${errors} 错误、${warnings} 警告。`}${unlocated ? '引用未在对应正文中定位，结论未确认，不能判定通过或据此改稿。' : '仅完成审阅，正文未修改，不需要补建编译或提交章节桥。'}${unlocated ? '' : `\n${findings.map(item => `[${item.severity}/${item.signal}] ${continuityFindingText(item)}`).join('\n')}`}`
  const artifact = cached?.artifact ?? await db.agentArtifact.create({ data: { runId: ctx.runId, artifactType: 'continuityReview', title: `${context.chapter.title} · 连续性检查`, content: output,
    summary: unlocated ? '候选未确认' : `${errors} 错误、${warnings} 警告`, metadata: { standaloneContinuity: true, independentCheck: unlocated ? 'unavailable' : 'complete', standaloneKey: standaloneReviewKey(context.contextHash, focus, requirePair ? 2 : 1), chapterId: context.chapter.id, revision: context.chapter.revision, contextHash: context.contextHash, findings } } })
  ctx.signal.throwIfAborted()
  return { ...(unlocated ? { outcome: 'failed' as const, failureCode: 'CONTINUITY_EVIDENCE_UNLOCATED' } : {}),
    summary: unlocated ? '连续性引用待核对' : `独立连续性检查 · ${errors} 错误 ${warnings} 警告`, output: `artifactId=${artifact.id}\n${output}`, observedState: { kind: 'chapter', id: context.chapter.id, revision: context.chapter.revision } }
}

export const continuityValidateTool = defineTool({
  name: 'continuity_validate',
  title: '检查章节连续性',
  description:
    '检查章节连续性。独立审阅既有章：先读取目标章节，再传真实 chapterId，无需 story_compiler_prepare、scene_task_build 或提交章节桥；只保存检查报告，不改正文。原始写作任务已有本任务编译时，chapterId 会绑定该编译 CHECK；明确传 compilationId 最可靠。写作检查保留场景与版本校验，只保存发现，不自动修订正文。写作交付需完成当前版本检查；仅原始作者请求可明确跳过。缺少检查不等于已通过。chapterId 与 compilationId 是不同对象，禁止混用；不得由主写 Agent 自报 findings。',
  parameters: z.object({
    chapterId: z.string().min(1).optional().describe('既有章节的真实编号，从 chapter_read 或作品目录取得；不能填编译编号'),
    compilationId: z.string().min(1).optional().describe('仅检查当前写作流水线时传；独立审阅既有章节省略'),
    focus: z.string().max(500).optional().describe('作者明确要求额外关注的连续性范围；未指定时不传'),
  }),
  coerceArgs(raw) {
    const source = coerceToolArgumentEnvelope(raw)
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
    const record = source as Record<string, unknown>
    return {
      ...record,
      chapterId: firstDefined(record, ['chapterId', 'chapter_id']),
      compilationId: firstDefined(record, ['compilationId', 'compilation_id', 'compilerId', 'compiler_id']),
      focus: firstDefined(record, ['focus', 'scope', 'attention']),
    }
  },
  permission: ALL_READ,
  readOnly: true,
  async execute(ctx, args) {
    const compilation = await prisma.storyCompilation.findFirst({
      where: {
        userId: ctx.userId,
        novelId: ctx.novelId,
        status: { in: ['active', 'completed'] },
        ...await qualityCompilationScope(prisma, ctx.userId, ctx.novelId, ctx.runId),
        chapter: { authorId: ctx.userId, ...activeChapterScope(ctx.novelId) },
        ...(args.chapterId ? { chapterId: args.chapterId } : {}),
        ...(args.compilationId ? { id: args.compilationId } : {}),
      },
      include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } }, chapter: { select: { id: true, title: true, revision: true, content: true, orderIndex: true } } },
      orderBy: { updatedAt: 'desc' },
    })
    const chapterOnlyPipeline = !args.compilationId && !!args.chapterId && !!compilation?.chapter
      && await isWritingTaskContinuityCompiler(prisma, { userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, compilationId: compilation.id, chapterId: args.chapterId })
    if (!args.compilationId && (!compilation || args.chapterId && !chapterOnlyPipeline)) {
      const context = await buildStandaloneContinuityContext(ctx, args.chapterId)
      const cached = await readStandaloneContinuityReport(ctx, context.contextHash, args.focus)
      if (cached) return prisma.$transaction(tx => saveStandaloneContinuityReport(ctx, context, { structured: true, findings: cached.findings }, tx, args.focus))
      const assertCurrent = async () => {
        if ((await buildStandaloneContinuityContext(ctx, context.chapter.id)).contextHash !== context.contextHash) throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '检查资料已变化，请读取当前版本。')
      }
      const response = await generateReviewCompletion(continuityCriticSystem, `${context.criticInput}\n${continuityReviewTail(null, context.chapter.revision, false, args.focus)}`,
        { modelRuntime: auxiliaryTextModel(ctx.modelRuntime), signal: ctx.signal, userId: ctx.userId, action: 'agent3ContinuityCritic', novelId: ctx.novelId, chapterId: context.chapter.id, targetType: 'chapter', targetId: context.chapter.id, temperature: 0, reasoningEffort: 'low' }, assertCurrent)
      return prisma.$transaction(tx => saveStandaloneContinuityReport(ctx, context, parseIndependentContinuityResult(response, 2, { previous: context.precedingBodies, current: context.chapter.content }), tx, args.focus))
    }
    if (!compilation?.chapter || !compilation.bridge) return { outcome: 'failed' as const, summary: '本任务连续性检查未执行', output: '指定编译不属于本任务或尚未写入正文。独立检查既有章节请省略 compilationId、传真实 chapterId；不要为检查创建新章或接管旧编译。' }
    const chapter = compilation.chapter
    // Compare the review's actual inputs, not bookkeeping modified by our own
    // reserveContinuityCheck (validation.checkRounds / updatedAt).
    const reviewInput = (value: typeof compilation | null) => value && JSON.stringify({
      id: value.id, runId: value.runId, status: value.status,
      chapter: value.chapter, bridge: value.bridge, sceneTasks: value.sceneTasks,
    })
    const frozenReviewInput = reviewInput(compilation)
    const bridge = compilation.bridge
    const sourceChapter = bridge.fromChapterId ? await prisma.chapter.findFirst({ where: { id: bridge.fromChapterId, ...activeChapterScope(ctx.novelId) }, select: { id: true, revision: true, content: true } }) : null
    const coverage = compilerContinuityCoverage({ chapter, bridge, sceneTasks: compilation.sceneTasks, source: sourceChapter, focus: args.focus })
    const sourceUnchanged = !bridge.fromChapterId || sourceChapter?.revision === bridge.sourceRevision
    if (!sourceUnchanged || !chapter.content.trim() || compilation.sceneTasks.length < 1 || compilation.sceneTasks.length > 4) {
      return { outcome: 'failed' as const, summary: '连续性检查前置未满足',
        output: '本次未调用检查模型：前章版本已变化、正文为空或场景任务数量不合法。请读取章节桥并修复该前置状态，不要反复请求连续性检查；未判定通过。' }
    }
    const parsedCachedValidation = z.object({ independentCheck: z.literal('complete'), checkedRevision: z.number().int(), coverage: z.unknown().optional(),
      findings: z.array(continuityFindingInputSchema), errorCount: z.number().int().nonnegative().optional(), warningCount: z.number().int().nonnegative().optional() }).safeParse(compilation.validation)
    const cachedValidation = parsedCachedValidation.success ? parsedCachedValidation.data : null
    if (sourceUnchanged && cachedValidation?.independentCheck === 'complete' && cachedValidation.checkedRevision === chapter.revision && compilerContinuityCoverageMatches(cachedValidation.coverage, coverage)) {
      const findings = cachedValidation.findings ?? []
      const errorCount = cachedValidation.errorCount ?? findings.filter((item) => item.severity === 'error').length
      const warningCount = cachedValidation.warningCount ?? findings.filter((item) => item.severity === 'warning').length
      ctx.signal.throwIfAborted()
      const result = await validateStoryContinuity({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, compilationId: compilation.id, findings,
        expectedChapterRevision: chapter.revision, independentCheck: 'complete', coverage, focus: args.focus, signal: ctx.signal })
      if (result.independentCheck !== 'complete') return { outcome: 'failed' as const, failureCode: 'CONTINUITY_EVIDENCE_UNLOCATED',
        summary: '缓存连续性证据未确认', output: '本次只读复核发现缓存引用缺失或不属于当前对应正文，已保留未确认报告；未调用模型、未增加检查次数，不能宣称检查通过或据此改稿。原任务内仍可纠正真实问题，按原预算取得有效复核。' }
      const repairGuidance = errorCount > 0 ? await prisma.$transaction(tx => readChapterReviewRevisionGuidance(tx, ctx, chapter)) : ''
      return {
        output: `当前 r${chapter.revision} 已完成连续性检查，直接复用结果：${errorCount} 个错误、${warningCount} 个警告；${errorCount ? repairGuidance : '连续性检查已完成；警告保留待审，不自动改正文。'}\n留置绑定 reportId=${continuityDecisionBinding(compilation.id, chapter.revision, { ...cachedValidation, checkedChapterId: chapter.id })}；findingId 使用从0开始的编号。\n${findings.map((item, index) => `[${index}/${item.severity}/${item.signal}] ${continuityFindingText(item)}`).join('\n')}`,
        summary: `复用连续性检查 · ${errorCount} 错误 ${warningCount} 警告`,
        display: { kind: 'storyCompiler', compilationId: compilation.id, phase: errorCount > 0 ? 'repair' : 'check', title: '连续性检查', detail: `${errorCount} 错误 · ${warningCount} 警告 · 已复用`, items: findings.map((item) => `${item.severity === 'error' ? '错误' : '警告'}：${item.evidence}`), errorCount, warningCount },
      }
    }
    // A check reserves a monotonic audit count; its count is not a dispatch cap.
    if (!await reserveContinuityCheck(ctx.userId, ctx.novelId, compilation.id)) {
      return {
        outcome: 'failed' as const,
        failureCode: 'COMPILATION_NOT_FOUND',
        summary: '本任务连续性检查未执行',
        output: `当前编译已不存在或不可继续检查，未调用模型；当前 r${chapter.revision} 未获得新复核。请读取本任务章节桥核对真实状态，不使用旧报告宣称新版通过。`,
        display: { kind: 'storyCompiler', compilationId: compilation.id, phase: 'check', title: '连续性检查', detail: `编译状态需核对 · 当前 r${chapter.revision} 未复核`, items: [] },
      }
    }
    const allowRepair = false
    const originalRequest = await readOriginalTaskRequest(prisma, ctx)
    const criticInput = [
        `原始作者明确要求（硬要求优先，不能被生成场景计划推翻）：${originalRequest.prompt ?? '未提供，不臆造'}`,
        `章节：${chapter.title}`,
        `前章未完成动作（桥接摘要，需对照原文核实）：${bridge.lastUnfinishedAction || '无'}`,
        `连续时空：${bridge.storyTime || '未标注'} / ${bridge.location || '未标注'}`,
        `人物已知：${asStrings(bridge.knowledgeState).join('；') || '未记录'}`,
        `身体状态：${asStrings(bridge.bodyState).join('；') || '未记录'}`,
        `物品状态：${asStrings(bridge.objectState).join('；') || '未记录'}`,
        `关系状态：${asStrings(bridge.relationshipState).join('；') || '未记录'}`,
        `情绪余波：${asStrings(bridge.emotionAftermath).join('；') || '未记录'}`,
        `开放钩子：${asStrings(bridge.openLoops).join('；') || '无'}`,
        `近期首尾：${asStrings(bridge.recentOpenings).join(' / ')}；${asStrings(bridge.recentEndings).join(' / ')}`,
        `生成 Scene Task 草案（目标/代价/转折不是历史事实）：\n${compilation.sceneTasks.map((task) => `${task.ordinal}. 目标=${task.goal}；阻力=${task.obstacle}；选择=${task.choice}；代价=${task.cost}；转折=${task.turn}`).join('\n')}`,
        continuityReviewTail(compilation.validation, chapter.revision, allowRepair, args.focus, chapter.content),
        continuitySourceInput({ previous: sourceChapter?.content ?? null, current: chapter.content }),
      ].filter(Boolean).join('\n')
    const assertCurrent = async () => {
      const current = await prisma.storyCompilation.findFirst({
        where: { id: compilation.id, userId: ctx.userId, novelId: ctx.novelId, status: compilation.status,
          ...await qualityCompilationScope(prisma, ctx.userId, ctx.novelId, ctx.runId),
          chapter: { authorId: ctx.userId, ...activeChapterScope(ctx.novelId) } },
        include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } }, chapter: { select: { id: true, title: true, revision: true, content: true, orderIndex: true } } },
      })
      const source = bridge.fromChapterId ? await prisma.chapter.findFirst({ where: { id: bridge.fromChapterId, ...activeChapterScope(ctx.novelId) }, select: { revision: true } }) : null
      if (reviewInput(current) !== frozenReviewInput || source?.revision !== sourceChapter?.revision) {
        throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '正文或章节桥已变化，未应用或重发旧版本连续性检查，请读取当前版本。')
      }
    }
    await assertCurrent()
    const criticPrompts = [continuityCriticSystem]
    const criticResponses = await Promise.all(criticPrompts.map((systemPrompt, index) => generateReviewCompletion(
      systemPrompt,
      criticInput,
      { modelRuntime: auxiliaryTextModel(ctx.modelRuntime), signal: ctx.signal, userId: ctx.userId, action: index === 0 ? 'agent3ContinuityCritic' : 'agent3ContinuityCriticSecondPass', novelId: ctx.novelId, chapterId: chapter.id, targetType: 'story_compilation', targetId: compilation.id, temperature: 0, reasoningEffort: 'low' },
      assertCurrent,
    )))
    ctx.signal.throwIfAborted()
    await assertCurrent()
    const parsedCriticResponses = criticResponses.map(response => parseIndependentContinuityResult(response, 2, { previous: sourceChapter?.content ?? null, current: chapter.content }))
    const criticFallback = parsedCriticResponses.some((response) => !response.structured)
    const independentFindings = parsedCriticResponses
      .flatMap((response) => response.findings)
      .filter((finding, index, all) => all.findIndex((item) => item.signal === finding.signal && item.evidence === finding.evidence) === index)
    const result = await validateStoryContinuity({ userId: ctx.userId, novelId: ctx.novelId, compilationId: compilation.id, findings: independentFindings,
      runId: ctx.runId, expectedChapterRevision: chapter.revision, independentCheck: criticFallback ? 'unavailable' : 'complete', coverage, focus: args.focus, signal: ctx.signal })
    if (criticFallback || result.independentCheck !== 'complete') return {
      outcome: 'failed' as const,
      failureCode: criticFallback ? 'CONTINUITY_REPORT_INCOMPLETE' : 'CONTINUITY_EVIDENCE_UNLOCATED',
      output: unconfirmedContinuityOutput,
      summary: '独立连续性复核未完成',
    }
    const phase = result.errorCount > 0 ? 'repair' : 'check'
    const repairGuidance = result.errorCount > 0 ? await prisma.$transaction(tx => readChapterReviewRevisionGuidance(tx, ctx, chapter)) : ''
    return {
      output: (result.errorCount > 0
        ? `CHECK 发现 ${result.errorCount} 个错误、${result.warningCount} 个警告。${repairGuidance}\n留置绑定 reportId=${continuityDecisionBinding(compilation.id, chapter.revision, { ...result, coverage })}；findingId 使用下面从0开始的编号。\n${result.findings.map((item, index) => `${index}. [${item.severity}/${item.signal}] ${continuityFindingText(item)}`).join('\n')}`
        : `当前正文连续性检查完成：0 个错误、${result.warningCount} 个警告。正文未改动，警告保留待审；写作交付还须完成原请求要求的当前版本质量检查，再核对章节终态，禁止为追求零警告重复修订。${result.warningCount ? `\n${result.findings.map((item, index) => `${index + 1}. [警告/${item.signal}] ${item.evidence}`).join('\n')}` : ''}`),
      summary: `连续性检查${criticFallback ? '（确定性兜底）' : ''} · ${result.errorCount} 错误 ${result.warningCount} 警告`,
      display: {
        kind: 'storyCompiler', compilationId: compilation.id, phase, title: '连续性检查',
        detail: `${result.errorCount} 错误 · ${result.warningCount} 警告${criticFallback ? ' · 确定性兜底' : ''}`,
        items: result.findings.map((item) => `${item.severity === 'error' ? '错误' : '警告'}：${item.evidence}`),
        errorCount: result.errorCount, warningCount: result.warningCount,
      },
    }
  },
})

export const chapterBridgeCommitTool = defineTool({
  name: 'chapter_bridge_commit',
  title: '提交章节终态',
  description:
    'Story Compiler 的 COMMIT 步骤。用于提交当前已保存正文的终态；写作交付必须具有当前版本完整的连续性与质量检查，只有原始作者请求可明确跳过检查。缺少、失败或旧检查会返回下一步所需工具，不代表已完成。检查完成但有需处置意见时，用 retainedFindings 引用当前报告并逐项说明保留原因；chapter_bridge_get 提供精确引用模板。无待处置意见时所有参数都可省略：服务端会从当前 run/chapter 的活跃编译、最后一个 Scene Task 和章节状态安全补全，模型不得为补参数重复读取正文。重复调用会幂等返回。',
  parameters: z.object({
    compilationId: z.string().min(1).optional(),
    retainedFindings,
    chapterSummary: z.string().min(1).max(2000).optional(),
    exitState: storyStateSchema.optional(),
    lastUnfinishedAction: z.string().max(1000).optional(),
    hookDecision: z.string().max(1000).optional(),
    delayedHookReason: z.string().max(1000).optional(),
    openingStructure: z.string().min(1).max(300).optional(),
    endingStructure: z.string().min(1).max(300).optional(),
  }),
  coerceArgs(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const next = { ...(raw as Record<string, unknown>) }
    if (typeof next.retainedFindings === 'string') {
      try { next.retainedFindings = JSON.parse(next.retainedFindings) } catch { /* Keep invalid input for schema diagnostics. */ }
    }
    if (!next.compilationId && typeof next.compilation_id === 'string') next.compilationId = next.compilation_id
    for (const [key, value] of Object.entries(next)) if (value === null || value === '') delete next[key]
    return next
  },
  permission: BUILD_WRITE,
  readOnly: false,
  async execute(ctx, args) {
    const db = ctx.transaction ?? prisma
    const scope = await qualityCompilationScope(db, ctx.userId, ctx.novelId, ctx.runId)
    if (args.compilationId && ctx.durableCompiler?.baseline && args.compilationId !== ctx.durableCompiler.baseline.id) {
      return { outcome: 'failed' as const, failureCode: 'COMPILATION_IDENTITY_MISMATCH', output: '指定编译编号与本任务读取的编译身份不一致。compilationId 不能使用章节或任务合同编号；请用 chapter_bridge_get 核对本任务真实身份，不会替换显式编号提交。', summary: '章节编译身份不匹配' }
    }
    const targetId = ctx.durableCompiler?.baseline?.id ?? args.compilationId
    const candidates = await db.storyCompilation.findMany({
      where: {
        userId: ctx.userId,
        novelId: ctx.novelId,
        status: { in: ['active', 'completed'] },
        ...scope,
        ...(targetId ? { id: targetId } : {}),
      },
      include: { chapter: true, bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } },
      // Preparation establishes the current identity. An older active attempt
      // must not hide a newer completed compilation of this same logical task.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 2,
    })
    const compilation = candidates[0]
    if (!compilation) return { outcome: 'failed' as const, failureCode: 'COMPILATION_NOT_FOUND',
      output: `未找到当前任务指定的 compilationId，章节编号与编译编号不可混用，本次未提交。${await missingCompilationGuidance(db, ctx, scope)}`, summary: '未找到章节编译状态' }
    if (!compilation.bridge) return { outcome: 'failed' as const, failureCode: 'COMPILATION_NOT_FOUND', output: '当前编译缺少章节桥，身份异常需核对，不能重建绕过；本次未提交。', summary: '章节桥身份未核实' }
    if (!compilation.chapter) return { outcome: 'failed' as const, failureCode: 'COMPILATION_NOT_WRITTEN',
      output: `当前编译尚未保存章节正文，本次未提交。${compilationNextStep(compilation)}`, summary: '章节正文尚未保存' }
    if (compilation.status === 'active' && await db.storyCompilation.findFirst({ where: { userId: ctx.userId, novelId: ctx.novelId, ...scope,
      chapterId: compilation.chapterId, createdAt: { gt: compilation.createdAt } }, select: { id: true } })) {
      return { outcome: 'failed' as const, failureCode: 'COMPILATION_STAGE_CONFLICT', output: '该章节已有本任务后续准备的编译身份，旧编译不能覆盖它。请读取当前任务章节桥，保留已保存的正文、场景与检查记录。', summary: '章节编译已被后续准备替代' }
    }
    const firstTask = compilation.sceneTasks[0]
    const lastTask = compilation.sceneTasks.at(-1)
    // 终态状态逐层容错补全：模型传参/历史落库形状异常时降级到编译态推导，再降级到空状态，绝不让 COMMIT 因参数形状执行失败
    const derivedState = {
      action: lastTask?.turn || '', location: compilation.bridge.location, storyTime: compilation.bridge.storyTime,
      knowledge: asStrings(compilation.bridge.knowledgeState), emotion: asStrings(compilation.bridge.emotionAftermath), body: asStrings(compilation.bridge.bodyState),
      objects: asStrings(compilation.bridge.objectState), relationships: asStrings(compilation.bridge.relationshipState), openLoops: asStrings(compilation.bridge.openLoops),
    }
    const exitParse = storyStateSchema.safeParse(args.exitState ?? lastTask?.exitState ?? derivedState)
    const derivedParse = exitParse.success ? null : storyStateSchema.safeParse(derivedState)
    const lastExit = exitParse.success ? exitParse.data : (derivedParse?.success ? derivedParse.data : storyStateSchema.parse({}))
    const terminal = {
      compilationId: compilation.id,
      chapterSummary: args.chapterSummary?.trim() || compilation.sceneTasks.map((task) => `${task.purpose}；${task.turn}`).join('；').slice(0, 2000) || `${compilation.chapter.title}正文已完成。`,
      exitState: lastExit,
      lastUnfinishedAction: args.lastUnfinishedAction ?? lastExit.openLoops[0] ?? '',
      hookDecision: args.hookDecision ?? lastExit.openLoops[0] ?? '',
      delayedHookReason: args.delayedHookReason ?? '',
      openingStructure: args.openingStructure?.trim() || `从${(firstTask ? storyStateSchema.safeParse(firstTask.entryState) : null)?.data?.action || firstTask?.purpose || '前章终态'}进入`,
      endingStructure: args.endingStructure?.trim() || `以${lastTask?.turn || lastExit.action || '当前状态变化'}收束`,
    }
    try {
      const result = await commitChapterBridge({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, ...terminal, retainedFindings: args.retainedFindings, expectedChapterRevision: compilation.chapter.revision, expectedContentHash: createHash('sha256').update(compilation.chapter.content).digest('hex') }, ctx.transaction)
      const retained = result.retainedIssueCount ? `本次仍保留 ${result.retainedIssueCount} 条检查意见及其处置记录；留置不表示已修复，不能把建议数量当作检查失败。` : ''
      return {
        output: `COMMIT 完成，章节 ${result.chapterId}@r${result.chapterRevision} 的 Chapter Bridge 与 Scene Task 终态已提交。已按原任务核验当前版本所需检查；检查完成不代表所有意见已消除，关注意见仍保留待审。${retained}故事记忆仅提交候选，作者确认前不参与事实召回。${result.skippedMemoryCount ? `其中 ${result.skippedMemoryCount} 项记忆因作者已删除而跳过，未重建；不影响章节终态提交。` : ''}本任务仅在原请求范围内交付。`,
        requiredResult: { targetId: result.chapterId, contentHash: persistedContentHash(compilation.chapter.content) },
        summary: '提交章节桥与当前故事终态',
        display: {
          kind: 'storyCompiler', compilationId: result.compilationId, phase: 'commit', title: '章节终态已提交',
          detail: `r${result.chapterRevision}`, items: [terminal.chapterSummary, terminal.lastUnfinishedAction ? `未完成动作：${terminal.lastUnfinishedAction}` : '未留未完成动作', `结尾结构：${terminal.endingStructure}`, ...(result.retainedIssueCount ? [`保留 ${result.retainedIssueCount} 条已核验意见交作者决定`] : [])],
        },
      }
    } catch (error) {
      // 流程顺序类门槛（连续性未重检/仍有错）转成可执行引导：作者侧看到下一步该做什么，而不是「执行失败」
      if (
        error instanceof DataAccessError
        && (error.code === 'REVIEW_DECISION_REQUIRED' || error.code === 'CONTINUITY_CHECK_REQUIRED' || error.code === 'CONTINUITY_ERRORS_REMAIN' || error.code === 'COMPILATION_NOT_FOUND' || error.code === 'QUALITY_CHECK_REQUIRED')
      ) {
        if (error.code === 'REVIEW_DECISION_REQUIRED') return { outcome: 'failed' as const, failureCode: error.code,
          output: error.message, summary: '检查已完成 · 需明确当前意见处置' }
        if (error.code === 'QUALITY_CHECK_REQUIRED') return { outcome: 'failed' as const, failureCode: error.code,
          output: error.message, summary: '提交前置未满足 · 正文与意见已保留' }
        const checkedChapter = compilation.chapter
        const guidance = error.code === 'CONTINUITY_ERRORS_REMAIN'
          ? ctx.transaction ? await readChapterReviewRevisionGuidance(ctx.transaction, ctx, checkedChapter)
            : await prisma.$transaction(tx => readChapterReviewRevisionGuidance(tx, ctx, checkedChapter))
          : error.code === 'COMPILATION_NOT_FOUND' ? '请核对当前任务编译身份。'
            : '当前检查未完成，保留正文与报告，不把旧意见当作当前版本错误，不宣称检查通过。'
        return {
          outcome: 'failed' as const,
          failureCode: error.code,
          output: `${error.message}本次未提交：${guidance}`,
          summary: '提交前置未满足 · 正文与意见已保留',
        }
      }
      throw error
    }
  },
})
