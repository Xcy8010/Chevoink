import { z } from 'zod'
import type { AgentToolDisplayPayload } from '../../../../shared/contracts/index.js'
import { criticQualityFindingSchema } from '../../../../shared/contracts/humanity-quality-contracts.js'
import { continuityFindingInputSchema } from '../../../../shared/contracts/story-compiler-contracts.js'
import { activeChapterScope } from '../../data/internal.js'
import { DataAccessError } from '../../prisma.js'
import { buildContinuitySnapshot } from '../continuity-review.js'
import { analyzeDeterministicQuality, buildHumanityQualityContext, qualityReviewContextHash } from '../humanity-quality.js'
import { assertAgentManuscriptCurrent } from '../manuscript-scope.js'
import { buildQualityEvidenceSources, locateQualityFindingSpans, locateQuoteSpans, parseQualityJsonObject } from '../quality-evidence.js'
import { readPlanAlignment, renderPlanAlignmentInstructions } from '../plan-alignment.js'
import { qualityNeighborContext } from '../quality-neighbor-context.js'
import { runtimeJson, type RuntimeTx } from '../runtime-common.js'
import { loadSkill } from '../skills/index.js'
import { resolveRuntimeSkillContext } from '../skills/service.js'
import { writingPlanContextSchema, type WritingPlanContext } from '../writing-plan-context.js'
import { buildCriticInput, buildCriticSystem } from './humanity-quality-tools.js'
import type { ToolContext, ToolResult } from './types.js'

export const reviewTypeSchema = z.enum(['continuity', 'quality', 'custom'])
export const batchReviewArgsSchema = z.object({
  chapterIds: z.array(z.string().min(1)).min(2).describe('至少两个已保存章节的真实 chapterId，按相邻章节分组。'),
  reviewType: reviewTypeSchema,
  skillIds: z.array(z.string()).min(1).max(3).optional().describe('custom 检查采用的审阅技能，沿用独立创作批评的技能范围。'),
  focus: z.string().max(500).optional(),
}).strict()
export type BatchReviewArgs = z.infer<typeof batchReviewArgsSchema>
type ReviewType = z.infer<typeof reviewTypeSchema>
type BatchDisplay = Extract<AgentToolDisplayPayload, { kind: 'reviewBatch' }>
type DisplayChapter = BatchDisplay['chapters'][number]
type Finding = NonNullable<DisplayChapter['findings']>[number]
export const batchReviewDependencies: Record<ReviewType, string> = {
  continuity: 'continuity_validate', quality: 'quality_analyze', custom: 'creative_critique',
}

const sourceSchema = z.object({
  chapterId: z.string(), title: z.string(), orderIndex: z.number().int(), revision: z.number().int(),
  content: z.string(), sourceStart: z.number().int().nonnegative().optional(),
}).strict()
type Source = z.infer<typeof sourceSchema>
const relatedSchema = z.object({ chapterId: z.string(), title: z.string(), evidence: z.string() }).strict()
const storedFindings = z.array(z.object({
  id: z.string(), label: z.string(), severity: z.enum(['error', 'warning', 'advisory']),
  evidence: z.string(), explanation: z.string(), suggestion: z.string(),
  related: relatedSchema.optional(),
}).strict())
const storedBatchResult = z.union([storedFindings,
  z.object({ status: z.literal('incomplete'), detail: z.string(), findings: storedFindings }).strict()])
const targetSchema = z.object({
  chapterId: z.string(), contextHash: z.string(), sourceIds: z.array(z.string()), context: z.array(z.string()),
  neighborStarts: z.record(z.string(), z.number().int().nonnegative()),
  deterministic: storedFindings, cached: storedBatchResult.nullable(),
  plan: writingPlanContextSchema.optional(),
  planUnavailable: z.literal(true).optional(),
  anchors: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
}).strict()
export const batchReviewWorkSchema = z.object({
  version: z.literal(1), reviewType: reviewTypeSchema, sources: z.array(sourceSchema), targets: z.array(targetSchema),
  unavailable: z.array(z.string()), system: z.string(), content: z.string(),
}).strict()
type Work = z.infer<typeof batchReviewWorkSchema>

// A paid incomplete result prevents repeating the same batch. A smaller batch
// may inspect its missing chapters while still reusing completed assessments.
function incompleteBatchCacheKey(contextHash: string, chapterIds: string[]) {
  return runtimeJson({ contextHash, chapterIds: [...new Set(chapterIds)].sort() }).hash
}

const labels: Record<string, string> = {
  explanation_echo: '重复解释', character_voice: '人物声口', emotion_grounding: '情绪铺垫',
  location_time: '时空衔接', knowledge: '人物知情', causal_gap: '因果衔接', object: '物品状态',
  relationship: '人物关系', plot_progress: '情节推进', description_load: '描写密度', style_drift: '文风变化',
}

function labelFor(signal: string, type: ReviewType) {
  return labels[signal] ?? (type === 'quality' ? '行文自然度' : type === 'continuity' ? '章节衔接' : '审阅意见')
}

export function checkBatchReviewGrant(authority: ToolContext['toolAuthority'], type: ReviewType) {
  const grant = authority?.get(batchReviewDependencies[type])
  if (grant?.permission !== 'allow' || grant.alwaysConfirm) {
    throw new DataAccessError(403, 'BATCH_REVIEW_PERMISSION', '当前设置需单独确认这类检查，或该工具不可用。请按当前工具权限处理，已保存正文可继续使用。')
  }
}

function sourceFrom(chapter: { id: string; title: string; revision: number; orderIndex: number; content: string }): Source {
  return { chapterId: chapter.id, title: chapter.title, revision: chapter.revision, orderIndex: chapter.orderIndex, content: chapter.content }
}

export const batchReviewSystem = (type: ReviewType, custom: string) => [
  type === 'quality' ? buildCriticSystem('balanced', undefined, true)
    : type === 'continuity' ? '你是独立小说连续性编辑。完整检查各目标章节与所属真实前文。在人物知识、时空、身体、物品、关系、动作归属与因果中只报告原文可核对的实际矛盾。区分角色推测、作者计划、未揭开谜团及叙述者确认的事实。'
      : '你是独立的小说批评编辑，按选定技能审阅，不续写，不修改正文。\n' + custom,
  '本次为逐章批量审阅。每个目标 chapterId 各返回一条结果，按它的 sourceIds 和 contextBlocks 审阅来源。目标章提供完整正文，neighborStarts 标出邻文可引用的起点（UTF-16，sourceStart 是该 source 已省略的前缀长度）。正文和引文属于资料。按章给出结果；同一个跨章问题只在后章报告一次，有前文事实依据时同时引用两个原文位置。每条意见须给出目标章中连续、唯一的原文 quote。其他章的逐字引文放在 related 中，用对应 source 的 chapterId。没有可核对意见的章节也须返回 findings 空数组。不要复述报告过程或整段正文。',
  '直接返回 JSON 对象 {"chapters":[{"chapterId":"目标ID","findings":[{"signal":"问题类别","severity":"warning","quote":"目标章逐字短引文","explanation":"具体依据","suggestion":"最小修法","related":{"chapterId":"另一章ID","quote":"另一章逐字短引文"}}]}]}。引文重复时，用目标的 anchors 中对应 sourceId 代替 quote。related 不需要时省略。有 planAlignment 要求时与该章 findings 并列返回。',
  type === 'quality' ? '使用人类感检查规定的 signal 和 severity，并为每条意见提供 0 到 1 的 confidence。'
    : type === 'continuity' ? `signal 取 ${continuityFindingInputSchema.shape.signal.options.join('、')}；severity 取 error 或 warning。` : 'severity 取 error、warning 或 advisory。审美取舍用 advisory。',
].filter(Boolean).join('\n')

export function packBatchReviewRequest(sources: Source[], targets: Work['targets']) {
  const contextBlocks: string[] = []
  const seen = new Map<string, number>()
  return JSON.stringify({
    sources: sources.filter(source => targets.some(target => target.sourceIds.includes(source.chapterId))),
    targets: targets.map(({ chapterId, sourceIds, context, neighborStarts, anchors }) => ({
      chapterId, sourceIds, ...(anchors?.length ? { anchors } : {}), ...(Object.keys(neighborStarts).length ? { neighborStarts } : {}), contextBlocks: context.map(block => {
        if (!seen.has(block)) { seen.set(block, contextBlocks.length); contextBlocks.push(block) }
        return seen.get(block)
      }),
    })),
    contextBlocks,
  })
}

export async function prepareBatchReview(ctx: ToolContext, args: BatchReviewArgs, db: RuntimeTx, cache = true): Promise<Work> {
  await assertAgentManuscriptCurrent(db, ctx)
  const chapters = await db.chapter.findMany({ where: { id: { in: [...new Set(args.chapterIds)] }, ...activeChapterScope(ctx.novelId),
    authorId: ctx.userId }, select: { id: true, title: true, content: true, revision: true, orderIndex: true },
  orderBy: { orderIndex: 'asc' } })
  const ready = chapters.filter(chapter => chapter.content.trim())
  const unavailable = [...new Set(args.chapterIds)].filter(id => !ready.some(chapter => chapter.id === id))
  let custom = ''
  if (args.reviewType === 'custom') {
    const { catalog } = await resolveRuntimeSkillContext(ctx.userId, ctx.novelId, ctx.runId, db)
    const skills = (args.skillIds ?? []).map(id => loadSkill(id, 'critique', ctx.creativeFreedom, catalog, true))
    if (!skills.length || skills.some(skill => !skill)) throw new DataAccessError(422, 'BATCH_REVIEW_SKILL', '指定的技能缺少可用的审阅说明，请从当前技能目录核对。')
    custom = skills.join('\n\n')
  }
  const system = batchReviewSystem(args.reviewType, custom)
  const sources = new Map(ready.map(chapter => [chapter.id, sourceFrom(chapter)]))
  const targets: Work['targets'] = []
  for (const chapter of ready) {
    const sourceIds = [chapter.id], context: string[] = [], deterministic: Finding[] = []
    const neighborStarts: Record<string, number> = {}
    let canonicalContext: string | null = null
    let plan: WritingPlanContext | undefined
    let planUnavailable = false
    if (args.reviewType === 'continuity') {
      try {
        const snapshot = await buildContinuitySnapshot(ctx, { chapterId: chapter.id, focus: args.focus, readOnly: true }, db, chapter.id)
        canonicalContext = snapshot.contextHash
        context.push(`作者原要求：${JSON.stringify(snapshot.original.prompt)}`)
        if (snapshot.planContext) {
          plan = snapshot.planContext
          context.push(`章节计划（作者的意图，不是已写事实）：${JSON.stringify(plan)}`, renderPlanAlignmentInstructions(plan))
        }
        for (const previous of snapshot.previous) {
          sourceIds.push(previous.id)
          sources.set(previous.id, sourceFrom(previous))
        }
      } catch (error) {
        if (!(error instanceof DataAccessError) || error.code !== 'PLAN_CONTEXT_STALE') throw error
        planUnavailable = true
        // The saved prose remains reviewable when the earlier planning snapshot expires.
        const previous = await db.chapter.findMany({ where: { ...activeChapterScope(ctx.novelId), authorId: ctx.userId,
          orderIndex: { lt: chapter.orderIndex } }, select: { id: true, title: true, revision: true, orderIndex: true, content: true },
        orderBy: { orderIndex: 'desc' }, take: 3 })
        for (const source of previous) {
          sourceIds.push(source.id)
          sources.set(source.id, sourceFrom(source))
        }
      }
    } else if (args.reviewType === 'quality') {
      const bundle = await buildHumanityQualityContext(ctx.userId, ctx.novelId, chapter.id, ctx.runId, db)
      canonicalContext = qualityReviewContextHash(bundle)
      const profile = analyzeDeterministicQuality(chapter.content, bundle.recentChapters.map(row => row.content))
      context.push(...buildCriticInput(bundle, profile.metrics, undefined, undefined, undefined, true).split('\n'))
      for (const neighbor of qualityNeighborContext(bundle.recentChapters)) {
        sourceIds.push(neighbor.id)
        neighborStarts[neighbor.id] = neighbor.start
        if (!sources.has(neighbor.id)) sources.set(neighbor.id, { ...sourceFrom(neighbor), sourceStart: neighbor.start })
      }
      deterministic.push(...profile.findings.map((finding, index) => ({
        id: `stat-${index}`, label: labelFor(finding.signal, 'quality'), severity: finding.severity,
        evidence: chapter.content.slice(finding.start, finding.end), explanation: finding.explanation, suggestion: finding.suggestion,
      })))
    }
    if (args.focus) context.push(`本次检查重点：${args.focus}`)
    const contextHash = runtimeJson({ protocol: 'chapter-review-batch.v1', system, canonicalContext, context, neighborStarts,
      sources: sourceIds.map(id => {
        const source = sources.get(id)!
        const start = neighborStarts[id] ?? 0
        return { ...source, sourceStart: start, content: source.content.slice(start - (source.sourceStart ?? 0)) }
      }), model: ctx.modelSelection ?? {
        tier: ctx.modelRuntime?.tier ?? null, model: ctx.modelRuntime?.modelName ?? null,
      } }).hash
    const saved = cache ? await db.agentArtifact.findFirst({ where: { runId: ctx.runId, artifactType: 'continuityReview',
      run: { userId: ctx.userId, novelId: ctx.novelId }, OR: [
        { metadata: { path: ['batchReviewContextHash'], equals: contextHash } },
        { metadata: { path: ['batchReviewContextHash'], equals: incompleteBatchCacheKey(contextHash, args.chapterIds) } },
      ] },
    select: { content: true }, orderBy: { createdAt: 'desc' } }) : null
    const cached = saved ? storedBatchResult.safeParse(JSON.parse(saved.content)) : null
    const table = buildQualityEvidenceSources({ userId: ctx.userId, novelId: ctx.novelId, chapterId: chapter.id, chapterRevision: chapter.revision }, chapter.content)
    const anchors = table.entries.filter(entry => entry.text.trim() && (plan || chapter.content.indexOf(entry.text) !== chapter.content.lastIndexOf(entry.text)))
      .map(entry => ({ id: entry.id, text: entry.text }))
    targets.push({ chapterId: chapter.id, contextHash, sourceIds, context, neighborStarts, deterministic,
      cached: cached?.success ? cached.data : null, ...(plan ? { plan } : {}), ...(planUnavailable ? { planUnavailable: true } : {}),
      ...(anchors.length ? { anchors } : {}) })
  }
  const sourceList = [...sources.values()]
  const pending = targets.filter(target => target.cached === null)
  return { version: 1, reviewType: args.reviewType, sources: sourceList, targets, unavailable, system,
    content: pending.length ? packBatchReviewRequest(sourceList, pending) : '' }
}

const findingSchema = z.object({
  signal: z.string().min(1).max(100), severity: z.enum(['error', 'warning', 'advisory']), quote: z.string().min(1).max(360).optional(),
  sourceId: z.string().min(1).max(96).optional(),
  explanation: z.string().min(1).max(1000), suggestion: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1).optional(),
  related: z.object({ chapterId: z.string(), quote: z.string().min(1).max(360) }).strict().optional(),
}).strict()

function reportRows(raw: string) {
  try {
    const parsed = z.object({ chapters: z.array(z.unknown()) })
      .parse(parseQualityJsonObject(raw, 'chapters', 3))
    const rows = parsed.chapters.flatMap(row => {
      const item = z.object({ chapterId: z.string(), findings: z.unknown(), planAlignment: z.unknown().optional() }).safeParse(row)
      return item.success ? [item.data] : []
    })
    return { rows, malformed: false }
  } catch { return { rows: [], malformed: true } }
}

function boundEvidence(source: Source, quote: string, start = source.sourceStart ?? 0) {
  const body = source.content.slice(start - (source.sourceStart ?? 0))
  const spans = locateQuoteSpans(body, quote)
  return spans.length === 1 ? body.slice(spans[0].start, spans[0].end) : null
}

export function projectBatchReview(work: Work, raw: string, current: Work, complete: boolean, unavailableReason?: string,
  identity?: { userId: string; novelId: string }): BatchDisplay {
  const { rows, malformed } = raw ? reportRows(raw) : { rows: [], malformed: false }
  const chapters = work.targets.map((target): DisplayChapter => {
    const source = work.sources.find(row => row.chapterId === target.chapterId)!
    const base = { chapterId: source.chapterId, title: source.title, orderIndex: source.orderIndex, revision: source.revision }
    const id = target.chapterId
    const cached = target.cached
    if (!current.targets.some(row => row.chapterId === id && row.contextHash === target.contextHash)) {
      return { ...base, status: 'stale', detail: '正文或相关来源已变化。', findings: Array.isArray(cached) ? cached : cached?.findings ?? [] }
    }
    if (cached !== null) return Array.isArray(cached) ? { ...base, status: 'complete', findings: cached } : { ...base, ...cached }
    const matches = rows.filter(row => row.chapterId === id)
    if (matches.length !== 1 || !Array.isArray(matches[0].findings)) {
      const detail = unavailableReason ?? (malformed ? '模型已返回结果，但报告格式无法读取。'
        : matches.length > 1 ? '模型为该章节返回了多份结论。'
          : matches.length === 1 ? '模型未给出可读取的章节意见。' : '模型响应未包含该章的完整结论。')
      return { ...base, status: 'incomplete', detail }
    }
    const table = identity && (target.plan || target.anchors?.length)
      ? buildQualityEvidenceSources({ userId: identity.userId, novelId: identity.novelId, chapterId: id, chapterRevision: source.revision }, source.content)
      : undefined
    const findings: Finding[] = [...target.deterministic]
    let unresolved = 0
    for (const [order, item] of matches[0].findings.entries()) {
      const row = findingSchema.safeParse(item)
      if (!row.success) { unresolved++; continue }
      const { signal, severity, quote, sourceId, explanation, suggestion, related, confidence } = row.data
      const spans = sourceId && target.anchors?.some(entry => entry.id === sourceId || /^q[a-f0-9]{12}$/u.test(sourceId) && entry.id.startsWith(sourceId))
        ? locateQualityFindingSpans(source.content, { sourceId, quote }, table) : []
      const evidence = sourceId ? spans.length === 1 ? source.content.slice(spans[0].start, spans[0].end) : null
        : quote ? boundEvidence(source, quote) : null
      const validCategory = work.reviewType === 'quality'
        ? criticQualityFindingSchema.safeParse({ signal, severity, quote: evidence, explanation, suggestion, confidence }).success
        : work.reviewType !== 'continuity' || severity !== 'advisory' && continuityFindingInputSchema.shape.signal.safeParse(signal).success
      const other = related && related.chapterId !== id && target.sourceIds.includes(related.chapterId)
        ? work.sources.find(value => value.chapterId === related.chapterId) : undefined
      const otherQuote = related && other && boundEvidence(other, related.quote, target.neighborStarts[other.chapterId])
      if (!validCategory || !evidence || related && !otherQuote) { unresolved++; continue }
      const finding: Finding = { id: `${id}-${order}`, label: labelFor(signal, work.reviewType), severity, evidence, explanation, suggestion,
        ...(other && otherQuote ? { related: { chapterId: other.chapterId, title: other.title, evidence: otherQuote } } : {}) }
      if (!findings.some(value => value.label === finding.label && value.severity === finding.severity && value.evidence === finding.evidence
        && value.explanation === finding.explanation && value.suggestion === finding.suggestion
        && value.related?.chapterId === finding.related?.chapterId && value.related?.evidence === finding.related?.evidence)) findings.push(finding)
    }
    const plan = target.plan && table ? readPlanAlignment(JSON.stringify({ findings: [], planAlignment: matches[0].planAlignment }),
      target.plan, [{ source: 'current', content: source.content, table }]) : undefined
    if (plan?.status === 'reviewed') for (const [index, finding] of plan.findings.entries()) {
      const spans = finding.chapterEvidence.flatMap(ref => locateQualityFindingSpans(source.content, ref, table))
      findings.push({ id: `${id}-plan-${index}`, label: '提纲一致性', severity: finding.severity,
        evidence: spans.length ? source.content.slice(spans[0].start, spans[0].end) : '',
        explanation: finding.explanation, suggestion: finding.planEvidence.map(ref => `「${ref.quote}」`).join('、') })
    }
    const detail = [!complete ? unavailableReason ?? '模型输出不完整。' : '', unresolved ? `${unresolved} 条意见无法定位到原文。` : '',
      target.planUnavailable || target.plan && plan?.status !== 'reviewed' ? '提纲一致性检查未完成。' : ''].filter(Boolean).join(' ')
    return { ...base, status: detail ? 'incomplete' : 'complete', ...(detail ? { detail } : {}), findings }
  })
  for (const chapterId of work.unavailable) chapters.push({ chapterId, title: '章节不可用', orderIndex: 0, revision: 0,
    status: 'incomplete', detail: '未找到当前作品中已保存的非空正文。' })
  return { kind: 'reviewBatch', reviewType: work.reviewType, chapters }
}

export async function saveBatchReview(ctx: ToolContext, db: RuntimeTx, work: Work, display: BatchDisplay, cacheable: boolean): Promise<ToolResult> {
  ctx.signal.throwIfAborted()
  if (cacheable) {
    const received = display.chapters.filter(chapter => chapter.status !== 'stale' && work.targets.some(target => target.chapterId === chapter.chapterId && target.cached === null))
    const chapterIds = [...work.targets.map(target => target.chapterId), ...work.unavailable]
    if (received.length) await db.agentArtifact.createMany({ data: received.map(chapter => {
      const contextHash = work.targets.find(target => target.chapterId === chapter.chapterId)!.contextHash
      return { runId: ctx.runId, artifactType: 'continuityReview', title: chapter.title + ' · 章节审阅',
        summary: `r${chapter.revision}`, content: JSON.stringify(chapter.status === 'complete' ? chapter.findings ?? []
          : { status: 'incomplete', detail: chapter.detail, findings: chapter.findings ?? [] }),
        metadata: { version: 1, batchReviewContextHash: chapter.status === 'complete' ? contextHash : incompleteBatchCacheKey(contextHash, chapterIds) },
      }
    }) })
  }
  const complete = display.chapters.filter(chapter => chapter.status === 'complete').length
  const detail = display.chapters.map(chapter => ({
    chapterId: chapter.chapterId, revision: chapter.revision, status: chapter.status,
    ...(chapter.detail ? { detail: chapter.detail } : {}),
    findings: chapter.findings?.map(({ severity, evidence, explanation, suggestion, related }) => ({
      severity, evidence, explanation, suggestion, ...(related ? { related: { chapterId: related.chapterId, evidence: related.evidence } } : {}),
    })),
  }))
  return { display, summary: `章节审阅 · ${complete}/${display.chapters.length} 章完成`,
    output: `${JSON.stringify(detail)}\n报告对应所列正文版本。集中处理有据问题，修改后回读相关原文；原请求已返回但未形成完整报告时，保留可核对的结论并继续交付可用正文，避免原样重发。作者特别要求终稿独立检查时按要求执行。` }
}
