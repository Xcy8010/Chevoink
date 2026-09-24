import { auxiliaryTextModel } from '../auxiliary-text-model.js'
import { z } from 'zod'

import { env } from '../../../config/env.js'
import { generateTextCompletion } from '../../ai-service.js'
import { generateReviewCompletion, REVIEW_MAX_OUTPUT_TOKENS } from '../review-completion.js'
import { DataAccessError, prisma } from '../../prisma.js'
import {
  characterVoiceProfileInputSchema,
  criticQualityFindingSchema,
  experienceAnchorInputSchema,
  humanityQualitySignalSchema,
} from '../../../../shared/contracts/index.js'
import { recordChapterBaseline } from '../baseline.js'
import {
  analyzeDeterministicQuality,
  applyQualityRepair,
  buildHumanityQualityContext,
  calibrateCriticFindings,
  HUMANITY_CRITIC_VERSION,
  getLatestQualityReport,
  getQualityReport,
  listCharacterVoiceProfiles,
  listExperienceAnchors,
  persistHumanityQualityReport,
  recordQualityFindingFeedback,
  resolveQualityChapterTarget,
  renderQualityLearning,
  renderVoiceAndAnchorContext,
  saveCharacterVoiceProfile,
  saveExperienceAnchor,
  selectQualityFindings,
} from '../humanity-quality.js'
import { defineTool, type ToolContext } from './types.js'
import { coerceToolArgumentEnvelope, firstDefined } from './argument-coercion.js'
import { qualityReportMatchesContent } from '../quality-report-contract.js'
import { coerceCriticFindings, correctQualityEvidence, qualityEvidenceCorrectionSystem, unlocatedQualityEvidence } from '../quality-evidence.js'

const READ = { plan: 'allow', build: 'allow', review: 'allow' } as const
const WRITE = { plan: 'deny', build: 'allow', review: 'allow' } as const
const CONTENT_WRITE = { plan: 'deny', build: 'allow', review: 'deny' } as const

/** 自动修订阶段的可预期拦截码：命中时检查仍视为完成（报告交付、剩余交作者审阅），不把工具标成执行失败 */
const REPAIR_BLOCK_CODES = new Set([
  'QUALITY_REPAIR_LIMIT',
  'QUALITY_REPORT_STALE',
  'QUALITY_EVIDENCE_STALE',
  'QUALITY_PATCH_OVERLAP',
  'QUALITY_FINDING_SCOPE_INVALID',
  'QUALITY_REPAIR_NO_CHANGE',
])

const repairEnvelopeSchema = z.object({
  patches: z.array(z.object({ findingId: z.string().min(1), replacement: z.string().max(2_000) })).min(1).max(12),
})
const experienceAnchorToolSchema = experienceAnchorInputSchema
  .omit({ sourceId: true, sourceRevision: true })
  .extend({ sourceChapterId: z.string().min(1).optional(), sourceRevision: z.number().int().positive().optional() })
  .superRefine((value, refinement) => {
    if (value.sourceType === 'chapter' && (!value.sourceChapterId || !value.sourceRevision)) {
      refinement.addIssue({ code: 'custom', path: ['sourceChapterId'], message: '章节来源必须同时提供 sourceChapterId 和 sourceRevision' })
    }
  })

function parseJsonObject(raw: string): unknown {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象。')
  return JSON.parse(stripped.slice(start, end + 1))
}

function findingLabel(signal: string): string {
  return ({
    style_drift: '文风漂移', orphaned_sophistication: '孤立华丽', plot_progress: '剧情推进', description_load: '描写负载',
    emotion_grounding: '情绪落地', explanation_echo: '解释回声', sentence_homology: '句式同构', image_repetition: '意象重复',
    character_voice: '人物声口', causal_gap: '因果缺口', chapter_bridge: '章间承接', reader_pull: '读者拉力',
    punctuation_misuse: '符号误用',
  } as Record<string, string>)[signal] ?? signal
}

export function reportDisplay(report: Awaited<ReturnType<typeof getQualityReport>>) {
  return {
    kind: 'qualityReport' as const,
    reportId: report.id,
    chapterId: report.chapterId,
    chapterRevision: report.chapterRevision,
    status: report.status,
    repairRound: report.repairRound,
    findings: report.findings.map((finding) => ({
      id: finding.id,
      signal: finding.signal,
      label: findingLabel(finding.signal),
      severity: finding.severity,
      evidence: finding.evidenceExcerpt,
      explanation: finding.explanation,
      suggestion: finding.suggestion,
      disposition: finding.disposition,
      authorFeedback: finding.authorFeedback,
    })),
  }
}

export function buildCriticSystem(lens: 'balanced' | 'story' | 'style'): string {
  const lensRule = lens === 'story'
    ? '本轮优先审查 plot_progress、emotion_grounding、causal_gap、chapter_bridge、reader_pull、character_voice。'
    : lens === 'style'
      ? '本轮优先审查 style_drift、orphaned_sophistication、description_load、explanation_echo、sentence_homology、image_repetition、character_voice。'
      : '融合审查全部十三类信号，但没有证据的类别必须省略。'
  return `你是与正文 Writer 上下文隔离的中文网文质量编辑。${lensRule}
十三类 signal 及边界：style_drift=相邻段落声音突变；orphaned_sophistication=修辞缺少人物视角/意象链/语境支撑；plot_progress=场景没有改变动作/信息/关系/资源/风险；description_load=描写不服务当前场景；emotion_grounding=情绪缺少触发/选择/后果支撑；explanation_echo=动作或对白后重复解释；sentence_homology=非刻意的连续同构句；image_repetition=近期意象机械复用；character_voice=角色句长/词汇/回避方式/知识边界混同；causal_gap=转折缺少人物选择或已知条件；chapter_bridge=上章终态被忽略或机械复述；reader_pull=该章承担拉读功能却没有未完成动作/信息差/关系余波/价值变化；punctuation_misuse=把「」等引号当成圈重点符号包裹叙述、画面、纸面文字或转场过程，而不是人物直接话语或逐字引文。
只报告可以用正文逐字短引文证明、且存在最小修法的问题；quote 必须从正文原文中连续复制、逐字一致并保留原有标点、引号与换行（可跨段落），且全文唯一可定位；不得改写、缩写或用省略号拼接；若同一短语在正文多次出现，扩大到相邻上下文使整条引用唯一。
不得把词汇本身当问题：熵、量子、铁锈味、华丽句、口语、断句、留白、无悬念收束都可能合理。只有题材/人物/场景功能/局部频率/上下文铺垫共同提供证据时才提示。
不得要求每章固定钩子、固定对白比例或固定节奏；不得把作者的不规则声音清洗成统一白开水。
emotion_grounding 按“触发→解释→身体或注意→冲动→选择→后果”检查，但正文不必写全链，只要最有力的两三环成立即可。
severity 只能是 advisory 或 warning；审美意见绝不报 error。找不到问题返回空数组。最多24项，同一问题仅报告一次；quote最多360字符，explanation与suggestion各用一两句短句（最多1000字符）。完整检查全部维度，但不要复述无问题正文或输出审查过程，直接交付结构化结论，避免输出被截断。
严格只输出 JSON：{"findings":[{"signal":"style_drift|orphaned_sophistication|plot_progress|description_load|emotion_grounding|explanation_echo|sentence_homology|image_repetition|character_voice|causal_gap|chapter_bridge|reader_pull|punctuation_misuse","severity":"advisory|warning","quote":"正文逐字短引文","explanation":"为何在当前语境构成问题","suggestion":"不改变事实和作者声音的最小修法","confidence":0.0}]}`
}

type QualityReport = Awaited<ReturnType<typeof getQualityReport>>

function automaticRepairFindings(report: QualityReport, includeAdvisory = false) {
  const selected: QualityReport['findings'] = []
  for (const finding of report.findings) {
    if ((!includeAdvisory && finding.severity === 'advisory') || finding.disposition === 'repaired') continue
    if (selected.some((item) => finding.startOffset < item.endOffset && item.startOffset < finding.endOffset)) continue
    selected.push(finding)
    if (selected.length >= 8) break
  }
  return selected
}

async function applySelectedQualityRepairs(ctx: ToolContext, report: QualityReport, selected: QualityReport['findings']) {
  const selectedById = new Map(selected.map((finding) => [finding.id, finding]))
  const patches = new Map<string, { findingId: string; replacement: string }>()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = selected.filter((finding) => !patches.has(finding.id))
    if (remaining.length === 0) break
    let response = ''
    try {
      response = await generateTextCompletion(
        `你是与 Writer/Critic 上下文隔离的局部修订编辑。只替换每条 evidence 本身，不扩写相邻内容，不改变事实、情节结果、人物知识或作者刻意的口语与断句。删除优先于同义词替换；补写只补建议中缺失的具体动作、选择或后果。punctuation_misuse 只移除误用符号，保留人物直接话语和逐字引文。replacement 可以为空。严格只输出 JSON：{"patches":[{"findingId":"原 id","replacement":"只替换证据范围的文本"}]}。必须为每个输入 id 返回且只返回一次。`,
        remaining.map((finding) => `findingId=${finding.id}\nsignal=${finding.signal}\nevidence=「${finding.evidenceExcerpt}」\n原因=${finding.explanation}\n最小修法=${finding.suggestion}`).join('\n\n'),
        { modelRuntime: auxiliaryTextModel(ctx.modelRuntime), signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(env.aiTextTimeoutMs)]), userId: ctx.userId, action: attempt === 0 ? 'agent3HumanityRevision' : 'agent3HumanityRevisionRetry', novelId: ctx.novelId, chapterId: report.chapterId, targetType: 'quality_report', targetId: report.id, temperature: 0.3, reasoningEffort: 'low', maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS, boundedReview: true },
      )
    } catch (error) {
      ctx.signal.throwIfAborted()
      if (error instanceof DataAccessError) throw error
      // 修订器不可用时保留报告与正文，交回用户稍后重试，不把质量检查标成执行失败。
      continue
    }
    try {
      const parsedAttempt = repairEnvelopeSchema.parse(parseJsonObject(response))
      for (const patch of parsedAttempt.patches) {
        if (selectedById.has(patch.findingId)) patches.set(patch.findingId, patch)
      }
    } catch {
      // 第一次格式不完整时由第二次只重试缺失项；两次都失败才让工具明确失败。
    }
  }
  const replacements = [...patches.values()]
  ctx.signal.throwIfAborted()
  if (replacements.length === 0) return null
  // 模型若仍漏掉个别项，只应用已逐字绑定的安全补丁，并把漏项退回待审，不让整章修订归零。
  await selectQualityFindings(ctx.userId, ctx.novelId, report.id, replacements.map((patch) => patch.findingId))
  const result = await applyQualityRepair({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, reportId: report.id, replacements })
  recordChapterBaseline(ctx.runId, result.updated.id, result.updated.revision)
  return { result, patchCount: result.repairedFindingIds.length, missingCount: selected.length - result.repairedFindingIds.length, report: await getQualityReport(ctx.userId, ctx.novelId, report.id) }
}

export const qualityAnalyzeTool = defineTool({
  name: 'quality_analyze',
  title: '人类感质量检查',
  description: 'Humanity Quality Gate 的 CHECK 步骤。用于评估整章或完整长场景的人类感质量：当作者明确要求判断「有没有 AI 味 / 像不像 AI 写的」「文风是否自然、像真人」「要不要通篇精修润色」，或在整章写完要求深度审阅、或 Story Compiler 进入 CHECK 时，都必须调用本工具，而不是自己只读正文下结论。服务端先运行确定性统计，再启动与 Writer 隔离的 Critic；每条模型意见必须逐字定位正文才能保存。严谨创作会在同一次调用内有界自动修订，平衡延续与大胆探索只展示报告。标题、元数据、局部错字、单句润色、纯剧情/设定/写作建议等普通问答禁止触发。不得把科幻术语、华丽文风、口语或无悬念结尾按词表误判。',
  parameters: z.object({
    chapterId: z.string().min(1).optional().describe('目标章节编号，从 chapter_read 或作品目录取得；独立检查既有章只需本参数，不用准备章节'),
    compilationId: z.string().min(1).optional().describe('当前写作流水线的编译编号；独立审阅省略，不要把它当 chapterId'),
  }),
  permission: CONTENT_WRITE,
  readOnly: false,
  coerceArgs(raw) {
    const unwrapped = coerceToolArgumentEnvelope(raw)
    if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) return unwrapped
    const record = unwrapped as Record<string, unknown>
    return {
      chapterId: firstDefined(record, ['chapterId', 'chapter_id', 'chapter']),
      compilationId: firstDefined(record, ['compilationId', 'compilation_id', 'compilation']),
    }
  },
  async execute(ctx, args) {
    const chapterId = await resolveQualityChapterTarget({
      userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId,
      chapterId: args.chapterId, compilationId: args.compilationId, fallbackChapterId: ctx.chapterId,
    })
    if (!chapterId) return { output: '请先指定要检查的章节，或在章节查看器中打开目标章节。' }
    const bundle = await buildHumanityQualityContext(ctx.userId, ctx.novelId, chapterId, ctx.runId)
    if (args.compilationId && args.compilationId !== bundle.compilation?.id) return {
      outcome: 'failed' as const, output: '指定的编译不属于当前任务与章节的活跃状态；请核对章节桥。本次未调用质量模型，也不会改用其他任务的编译。', summary: '质量检查目标不匹配',
    }
    if (!bundle.chapter.content.trim()) return { output: '章节正文为空，无法执行人类感质量检查。', summary: '质量检查跳过空正文' }
    const existing = await getLatestQualityReport(ctx.userId, ctx.novelId, chapterId)
    if (existing && existing.compilationId === (bundle.compilation?.id ?? null) && existing.criticVersion === HUMANITY_CRITIC_VERSION && qualityReportMatchesContent(existing, bundle.chapter.revision, bundle.chapter.content)) {
      const hydrated = await getQualityReport(ctx.userId, ctx.novelId, existing.id)
      return { output: `当前 revision 已有质量报告 ${hydrated.id}，已直接复用；不会再次调用 Critic 或自动重试修订。`, summary: '复用当前质量报告', display: reportDisplay(hydrated) }
    }
    const deterministic = analyzeDeterministicQuality(bundle.chapter.content, bundle.recentChapters.map((chapter) => chapter.content))
    const charterContext = bundle.charter
      ? `题材边界=${JSON.stringify(bundle.charter.genreRules)}；风格 DNA=${JSON.stringify(bundle.charter.styleDna)}；禁区=${JSON.stringify(bundle.charter.forbiddenZones)}`
      : `作品分类=${bundle.chapter.novel.categoryName || '未设置'}；标签=${bundle.chapter.novel.tagNames.join('、') || '无'}`
    const storyContext = bundle.compilation
      ? `Scene Tasks=${bundle.compilation.sceneTasks.map((task) => `${task.purpose}→${task.turn}`).join('；')}；Chapter Bridge=${JSON.stringify(bundle.compilation.bridge ?? {})}`
      : '本章不在 Story Compiler 活跃编译中；不得臆造场景任务。'
    const userPrompt = `章节：《${bundle.chapter.title}》@r${bundle.chapter.revision}
${charterContext}
${storyContext}
${renderVoiceAndAnchorContext(bundle)}
${renderQualityLearning(bundle.feedback)}
确定性统计（只能作为线索，不能替代原文证据）：${JSON.stringify(deterministic.metrics)}
正文开始：
${bundle.chapter.content}
正文结束。`
    let rawCriticFindings: z.infer<typeof criticQualityFindingSchema>[] = []
    let criticFallback = false
    let droppedCriticFindings = 0
    let correctionError: unknown
    let attemptedEvidenceCorrection = false
    // Provider, credit and configuration failures retain their real error code.
    // Only malformed critic content belongs to the report's incomplete state.
    // 审核使用独立有界输出预算；只对供应商明确截断做一次扩大预算恢复，总超时与取消信号不重置。
    // 真实用户取消照常上抛；可修复的 provider/credit/config 失败(DataAccessError)保留错误码上抛；
    // 仅“超时/意外异常”降级为确定性兜底，保证检查一定终止并交付报告，根治长时间挂起导致的“分析不出”。
    let response = ''
    try {
      response = await generateReviewCompletion(
        buildCriticSystem('balanced'), userPrompt,
        { modelRuntime: auxiliaryTextModel(ctx.modelRuntime), signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(env.aiTextTimeoutMs)]), userId: ctx.userId, action: 'agent3HumanityCritic', novelId: ctx.novelId, chapterId, targetType: 'chapter', targetId: chapterId, temperature: 0.15, reasoningEffort: 'low' },
        async () => {
          const current = await buildHumanityQualityContext(ctx.userId, ctx.novelId, chapterId, ctx.runId)
          if (current.chapter.revision !== bundle.chapter.revision || current.chapter.content !== bundle.chapter.content
            || JSON.stringify(current.compilation) !== JSON.stringify(bundle.compilation)) {
            throw new DataAccessError(409, 'QUALITY_INPUT_STALE', '正文或当前任务已变化，未重发旧版本质量检查，请读取当前版本。')
          }
        },
      )
    } catch (error) {
      ctx.signal.throwIfAborted()
      if (error instanceof DataAccessError) throw error
      criticFallback = true
    }
    if (!criticFallback) {
      try {
        // 逐条容错：单项字段超界（如 confidence>1、quote>360）只降级该条，绝不因一处格式偏差把整份有效审查判成失败。
        const coerced = coerceCriticFindings(parseJsonObject(response))
        // 全部条目都不可用（或连 findings 信封都没有）才算格式不完整；空数组是合法的“未发现问题”。
        if (!coerced || (coerced.findings.length === 0 && coerced.dropped > 0)) criticFallback = true
        else {
          rawCriticFindings = coerced.findings
          droppedCriticFindings = coerced.dropped
        }
      } catch {
        ctx.signal.throwIfAborted()
        criticFallback = true
      }
    }
    if (!criticFallback) {
      const invalid = unlocatedQualityEvidence(bundle.chapter.content, rawCriticFindings)
      if (invalid.length > 0) {
        attemptedEvidenceCorrection = true
        // Correct only failed evidence bindings once. Keep every original judgment;
        // never regenerate the review, discard an issue, or alter the chapter here.
        let corrected = ''
        try {
          corrected = await generateTextCompletion(
          qualityEvidenceCorrectionSystem,
          `待定位意见：${JSON.stringify(invalid)}\n完整正文：\n${bundle.chapter.content}`,
          { modelRuntime: auxiliaryTextModel(ctx.modelRuntime), signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(env.aiTextTimeoutMs)]), userId: ctx.userId, action: 'agent3HumanityEvidenceCorrection', novelId: ctx.novelId, chapterId, targetType: 'chapter', targetId: chapterId, temperature: 0.15, reasoningEffort: 'low', maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS, boundedReview: true },
          )
        } catch (error) {
          ctx.signal.throwIfAborted()
          // Save the original, incomplete findings below before exposing the
          // provider/credit error. A failed correction must not erase paid work.
          correctionError = error
        }
        try {
          rawCriticFindings = correctQualityEvidence(bundle.chapter.content, rawCriticFindings, parseJsonObject(corrected))
        } catch { /* Remain incomplete; never reinterpret malformed corrections as success. */ }
      }
    }
    ctx.signal.throwIfAborted()
    const criticFindings = calibrateCriticFindings(rawCriticFindings, bundle.feedback)
    const created = await persistHumanityQualityReport({
      userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId,
      compilationId: args.compilationId ?? bundle.compilation?.id,
      chapterId, chapterRevision: bundle.chapter.revision, mode: ctx.qualityMode,
      deterministicMetrics: deterministic.metrics, deterministicFindings: deterministic.findings, criticFindings, criticComplete: !criticFallback,
      criticDropped: droppedCriticFindings,
    })
    if (created.compilationId) {
      await prisma.storyCompilation.updateMany({
        where: { id: created.compilationId, userId: ctx.userId, novelId: ctx.novelId, status: 'active' },
        data: { stage: created.status === 'needs_repair' ? 'repair' : 'check' },
      })
    }
    const report = await getQualityReport(ctx.userId, ctx.novelId, created.id)
    if (correctionError) throw correctionError
    if (report.status === 'failed') return { outcome: 'failed' as const,
      output: criticFallback
        ? '质量模型返回的报告格式不完整，不能判定质量通过。确定性报告和正文已保留；不得重复改写正文来解决格式错误。'
        : `质量模型返回的全部引用都无法在正文中逐字定位（可能审查了其他文本或引用严重变形），${attemptedEvidenceCorrection ? '已在本次调用内尝试一次引用校正，' : ''}仍不能判定质量通过。可对同一正文重试一次完整检查；若再次失败请交作者处理，禁止改写正文来凑通过。`,
      summary: criticFallback ? '质量报告格式不完整' : '质量证据定位未完成', display: reportDisplay(report) }
    const reportMetrics: Record<string, unknown> = report.deterministicMetrics && typeof report.deterministicMetrics === 'object' && !Array.isArray(report.deterministicMetrics) ? report.deterministicMetrics : {}
    const unlocatedCount = typeof reportMetrics.unlocatedFindings === 'number' ? reportMetrics.unlocatedFindings : 0
    const droppedCount = typeof reportMetrics.droppedFindings === 'number' ? reportMetrics.droppedFindings : 0
    const bindingNote = [
      unlocatedCount ? `${unlocatedCount} 条模型意见因引用无法逐字定位未纳入报告` : '',
      droppedCount ? `${droppedCount} 条因字段不完整未纳入报告` : '',
    ].filter(Boolean).join('；')
    const bindingSuffix = bindingNote ? `（${bindingNote}；已纳入意见均逐字绑定。）` : ''
    const warningCount = report.findings.filter((finding) => finding.severity === 'warning').length
    const advisoryCount = report.findings.filter((finding) => finding.severity === 'advisory').length
    const selected = ctx.creativeFreedom === 'balanced' && !ctx.protectedChapterIds?.has(report.chapterId)
      ? automaticRepairFindings(report)
      : []
    if (selected.length > 0) {
      try {
        await selectQualityFindings(ctx.userId, ctx.novelId, report.id, selected.map((finding) => finding.id))
        const repaired = await applySelectedQualityRepairs(ctx, report, selected)
        if (repaired) {
          return {
            output: `严谨创作质量检查完成：一次融合审查定位 ${report.findings.length} 项证据，已自动原子修订 ${repaired.patchCount} 处${repaired.missingCount ? `，另有 ${repaired.missingCount} 项因无法安全定位保留待审` : ''}。质量报告已绑定修订后的 r${repaired.result.updated.revision}，无需再次质量检查或选择；正文已变化，提交章节终态前必须调用 continuity_validate 只读复核当前版本，不能沿用旧连续性报告。${bindingSuffix}`,
            summary: `人类感质量检查 · 自动修订 ${repaired.patchCount} 处`,
            display: reportDisplay(repaired.report),
            snapshot: { target: 'chapter', targetId: repaired.result.updated.id, field: 'content', previousValue: repaired.result.before },
          }
        }
        return {
          output: `质量检查已完成并保留报告：发现 ${warningCount} 个需关注问题、${advisoryCount} 个审美建议；局部修订器本次未返回可安全验证的补丁，正文保持不变。后续再次检查会直接复用本报告，不会循环重试。${bindingSuffix}`,
          summary: `人类感质量检查${criticFallback ? '（确定性兜底）' : ''} · 修订未应用`,
          display: reportDisplay(report),
        }
      } catch (error) {
        // 修订轮次保护/证据过期等可预期拦截：检查本身已完成，报告照常交付，剩余问题交作者审阅；
        // 绝不能把 CHECK 步骤标成「执行失败」挡住后续提交链路。
        if (!(error instanceof DataAccessError) || !REPAIR_BLOCK_CODES.has(error.code)) throw error
        return {
          output: `质量检查完成：一次融合审查定位 ${report.findings.length} 项证据（${warningCount} 个需关注、${advisoryCount} 个审美建议）。自动局部修订被轮次保护拦截（${error.message}）正文保持 r${report.chapterRevision} 不变，剩余问题保留在报告中交作者审阅。检查视为已完成：禁止再次调用 quality_analyze，可直接继续后续流程。${bindingSuffix}`,
          summary: `人类感质量检查 · 剩余问题交作者审阅`,
          display: reportDisplay(report),
        }
      }
    }
    return {
      output: report.findings.length
        ? `质量检查完成：${warningCount} 个需关注问题、${advisoryCount} 个审美建议。当前模式仅展示报告，或章节受作者保护，因此未自动改动；本轮不会重复检查或要求选择。${bindingSuffix}`
        : criticFallback
          ? `质量报告 ${report.id} 已完成确定性检查兜底；独立 Critic 本次未返回结构化内容，正文保持不变，可继续当前任务。`
          : `质量报告 ${report.id} 通过：确定性检查与独立 Critic 均未发现有证据的问题。${bindingSuffix}`,
      summary: `人类感质量检查${criticFallback ? '（确定性兜底）' : ''} · ${warningCount} 关注 ${advisoryCount} 建议`,
      display: reportDisplay(report),
    }
  },
})

export const qualityReportGetTool = defineTool({
  name: 'quality_report_get', title: '读取质量报告',
  description: '读取指定质量报告及作者反馈状态。只在继续修订、作者询问证据或报告卡需要恢复时调用；禁止每轮例行读取。',
  parameters: z.object({ reportId: z.string().min(1) }), permission: READ, readOnly: true,
  async execute(ctx, args) {
    const report = await getQualityReport(ctx.userId, ctx.novelId, args.reportId, ctx.transaction)
    return { output: report.findings.map((finding) => `[${finding.id}/${findingLabel(finding.signal)}/${finding.disposition}] 「${finding.evidenceExcerpt}」→${finding.suggestion}`).join('\n') || '报告没有 finding。', summary: '读取质量报告', display: reportDisplay(report) }
  },
})

export const qualityFindingsSelectTool = defineTool({
  name: 'quality_findings_select', title: '选择质量修订项',
  description: '兼容旧任务的内部工具；新任务由 quality_analyze 自动选择并修订，主 Agent 禁止主动调用。只改变选择状态，不写正文。',
  parameters: z.object({ reportId: z.string().min(1), findingIds: z.array(z.string().min(1)).min(1).max(12) }),
  permission: WRITE, readOnly: false,
  async execute(ctx, args) {
    const report = await selectQualityFindings(ctx.userId, ctx.novelId, args.reportId, args.findingIds)
    return { output: `已选择 ${args.findingIds.length} 项，章节未改动。下一步调用 quality_revision_apply 生成并原子应用局部修订。`, summary: `选择 ${args.findingIds.length} 个质量问题`, display: reportDisplay(report) }
  },
})

export const qualityRevisionApplyTool = defineTool({
  name: 'quality_revision_apply', title: '应用局部质量修订',
  description: '兼容旧任务的内部工具；新任务由 quality_analyze 在同一次调用内完成。主 Agent 禁止主动调用，且改后不得重复质量检查。',
  parameters: z.object({ reportId: z.string().min(1) }), permission: CONTENT_WRITE, readOnly: false,
  async execute(ctx, args) {
    const report = await getQualityReport(ctx.userId, ctx.novelId, args.reportId)
    if (ctx.protectedChapterIds?.has(report.chapterId)) return { output: '作者要求保持前文不变，该章节被保护，禁止质量修订。' }
    const selected = report.findings.filter((finding) => finding.disposition === 'selected')
    if (selected.length === 0) return { output: '报告中没有已选择的 finding，请先调用 quality_findings_select。' }
    const repaired = await applySelectedQualityRepairs(ctx, report, selected)
    if (!repaired) return { output: '局部修订器本次未返回可验证补丁，正文保持不变，可稍后重试。', summary: '局部质量修订 · 正文未改动', display: reportDisplay(report) }
    return {
      output: `已原子应用 ${repaired.patchCount} 个局部修订并绑定 r${repaired.result.updated.revision}，无需再次质量检查；正文已变化，提交章节终态前必须调用 continuity_validate 只读复核当前版本。`,
      summary: `局部质量修订 · ${repaired.patchCount} 处`,
      display: { kind: 'chapterDiff', chapterId: repaired.result.updated.id, chapterTitle: repaired.result.updated.title, before: repaired.result.before, after: repaired.result.after, appliedDirectly: true, revision: repaired.result.updated.revision },
      snapshot: { target: 'chapter', targetId: repaired.result.updated.id, field: 'content', previousValue: repaired.result.before },
    }
  },
})

export const qualityFindingFeedbackTool = defineTool({
  name: 'quality_finding_feedback', title: '记录质量反馈',
  description: '仅当作者明确接受或拒绝某条质量 finding 时记录反馈，用于后续同作品置信度校准；不得由 Agent 代替作者表态。',
  parameters: z.object({ findingId: z.string().min(1), accepted: z.boolean(), reason: z.string().max(500).optional() }),
  permission: WRITE, readOnly: false,
  async execute(ctx, args) {
    const finding = await recordQualityFindingFeedback({ userId: ctx.userId, ...args })
    return { output: `已记录作者${args.accepted ? '接受' : '拒绝'} ${findingLabel(finding.signal)} finding；只影响后续置信度，不覆盖正文证据。`, summary: '记录质量反馈' }
  },
})

export const characterVoiceGetTool = defineTool({
  name: 'character_voice_get', title: '读取人物声口',
  description: '仅在写含该人物的对白、审查人物声音或作者询问角色声口时读取确认版 Voice DNA；普通叙述和无对白任务不调用。',
  parameters: z.object({ characterName: z.string().max(128).optional() }), permission: READ, readOnly: true,
  async execute(ctx, args) {
    const profiles = (await listCharacterVoiceProfiles(ctx.userId, ctx.novelId, ctx.transaction)).filter((profile) => !args.characterName || profile.characterName === args.characterName)
    return { output: profiles.map((profile) => `${profile.characterName}@r${profile.revision} [${profile.status}]：词汇=${profile.vocabularyLevel}；压力反应=${profile.pressureResponse}；关注=${JSON.stringify(profile.attentionBias)}；禁知=${JSON.stringify(profile.forbiddenKnowledge)}`).join('\n') || '没有匹配的 Voice DNA。不得临时编造为确认设定。', summary: `人物声口 · ${profiles.length} 项` }
  },
})

export const characterVoiceSaveTool = defineTool({
  name: 'character_voice_save', title: '保存人物声口',
  description: '保存 Character Voice DNA。仅在作者明确提供/确认声口规则，或从作者确认章节逐字引用 1–10 条短样本时使用；Agent 自行推断只能存 draft，禁止冒充确认。confirmed=true 时每条样本必须带 chapterId/revision 且逐字存在。',
  parameters: characterVoiceProfileInputSchema, permission: WRITE, readOnly: false,
  async execute(ctx, args) {
    const profile = await saveCharacterVoiceProfile(ctx.userId, ctx.novelId, args)
    return { output: `${profile.characterName} Voice DNA 已保存为 ${profile.status} r${profile.revision}。${profile.status === 'draft' ? '草稿不会进入质量 Critic，需作者确认后再启用。' : '后续相关对白只召回这份确认版短画像。'}`, summary: `保存人物声口 · ${profile.characterName}` }
  },
})

export const experienceAnchorGetTool = defineTool({
  name: 'experience_anchor_get', title: '读取经历锚点',
  description: '只在情绪场景涉及指定人物时按需读取 1–3 个确认经历锚点；普通场景禁止加载整份人物经历。',
  parameters: z.object({ characterName: z.string().min(1).max(128) }), permission: READ, readOnly: true,
  async execute(ctx, args) {
    const anchors = (await listExperienceAnchors(ctx.userId, ctx.novelId, args.characterName, ctx.transaction)).slice(0, 3)
    return { output: anchors.map((anchor) => `${anchor.title}：${anchor.concreteDetail}；触发=${anchor.triggerEvent}；习惯反应=${anchor.habitualResponse}；情感含义=${anchor.emotionalMeaning}`).join('\n') || '没有确认经历锚点；不得用攥拳、颤抖、眼眶发热等模板反应补位。', summary: `经历锚点 · ${anchors.length} 项` }
  },
})

export const experienceAnchorSaveTool = defineTool({
  name: 'experience_anchor_save', title: '保存经历锚点',
  description: '仅保存作者明确确认的经历，或指定章节 revision 中逐字存在的具体细节。章节证据必须可验证；临时试写和模型臆测禁止沉淀。',
  parameters: experienceAnchorToolSchema, permission: WRITE, readOnly: false,
  async execute(ctx, args) {
    const anchor = await saveExperienceAnchor(ctx.userId, ctx.novelId, {
      characterName: args.characterName, title: args.title, triggerEvent: args.triggerEvent, concreteDetail: args.concreteDetail,
      sensoryCue: args.sensoryCue, habitualResponse: args.habitualResponse, emotionalMeaning: args.emotionalMeaning,
      sourceType: args.sourceType, sourceId: args.sourceType === 'chapter' ? args.sourceChapterId! : ctx.runId,
      sourceRevision: args.sourceType === 'chapter' ? args.sourceRevision : undefined,
    })
    return { output: `已保存 ${anchor.characterName} 的经历锚点「${anchor.title}」，来源=${anchor.sourceType}:${anchor.sourceId}${anchor.sourceRevision ? `@r${anchor.sourceRevision}` : ''}。`, summary: `保存经历锚点 · ${anchor.title}` }
  },
})

export const qualitySignals = humanityQualitySignalSchema.options
