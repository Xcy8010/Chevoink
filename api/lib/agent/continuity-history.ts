/** Frozen legacy report interpretation only. No provider, reservation or manuscript effects. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma, DataAccessError } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'
import { resolveQualityChapterTarget } from './humanity-quality.js'
import { continuityChapterProvenance, continuitySourceInput } from './continuity-review-context.js'
import { validateStoredExplicitSourceProjection } from './continuity-explicit-source-projection.js'
import type { AuthenticatedContinuityInspection } from './authenticated-continuity-assessment.js'
import type { ToolContext } from './tools/types.js'
import { continuityFindingInputSchema } from '../../../shared/contracts/story-compiler-contracts.js'
import { inspectContinuityResponse } from './continuity-format-recovery.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import { firstDefined } from './tools/argument-coercion.js'
import { resolveContinuitySources, continuityRecheckInput, type ContinuityBodies } from './continuity-review-context.js'
import { runtimeJson } from './runtime-common.js'
export const standaloneContinuityBindingHash = (contextHash: string, focus?: string) => runtimeJson({ contextHash, focus: focus ?? '', protocol: 2 }).hash

const independentContinuityResultSchema = z.object({
  findings: z.array(continuityFindingInputSchema).max(30),
})

export function parseIndependentContinuityResult(content: string, parserVersion: 1 | 2 | 3 | 4 | 5 | 5 = 3, bodies?: ContinuityBodies): { findings: z.infer<typeof continuityFindingInputSchema>[]; structured: boolean } {
  if (parserVersion >= 3) {
    const inspected = inspectContinuityResponse(content, bodies, true, parserVersion as 3 | 4 | 5)
    return { findings: inspected.findings, structured: parserVersion === 5 ? inspected.complete : inspected.structured }
  }
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
先核对对象身份和事件先后；普通状态冲突须同一时刻、同一对象、同一维度互斥才报 error。省略、换场、之后移动、现金与银行余额不同不等于矛盾；制造声势或虚张不表示外观数量不能增加。信息不足时不要猜测。
另须跨时刻核查原文已确立的持续约束：不可逆后果、资源上限、恢复必要条件、人物知识来源与规则性限制。前章明确“只有满足条件才能恢复/必须等待某事件/耗尽后无法再用”时，后章直接恢复或增加资源不能仅因时刻不同而豁免；核对两处原文与中间行动是否实际满足解除条件。后章若有已设规则允许的例外、实际补给/修复及代价、或可靠证据纠正前章人物的有限判断，则不误报；不能自行脑补解锁、凭新出现的设备名称视为条件已满足，也不机械要求增加解释旁白。事实桥接须在故事行动或已设规则中成立。已确认缺少必要因果桥时用两处定位证据按对象或结构类事实冲突报告，signal仍只用下列合法枚举；证据不足仅保留待核，不捏造错误。
核账时先区分交易对象、收入/支出/报价/成交价/估值，以及现金与银行账户。前章期末余额已包含前章收支，不重复加收入或扣房租；本章新交易不能套用另一物品成交价。标价与估值、议价与最终成交不是同一金额性质。
原始作者硬要求与已保存原文优先。章节桥是待核摘要，Scene Task 是生成草案，不能单凭计划偏离报 error，不得把作者硬要求降级成草案。warning与审美意见保留待审，不驱动自动改稿；修法困难不改变事实判定。
完整读完再输出已确认结论。一个事实只报一次，不输出核查过程、“无互斥”推演或同一问题的不同说法。复检核对原问题是否已解决以及改动是否引入真实新冲突；不换角度反复追问已成立的事实。无问题返回 {"findings":[]}。
每项必须用 sourceEvidence 标明两处互斥事实的来源 previous/current，优先引用所给 segmentId，不抄写长原文。可以引用同章两处事实；同段冲突可附 quote 指定两句不同短引。不从旧报告复制引用。evidence 只用一句话说明冲突，suggestion 只给最小修法。signal 选 knowledge/location_time/body/object/relationship/emotion/hook/structure 之一，severity 选 error 或 warning，不把可选值串起来。
只输出完整 JSON 对象，首字符是 {，禁止把整个对象编码成带外层引号的字符串，不输出分析或 Markdown。合法结构示例：{"findings":[{"signal":"object","severity":"error","evidence":"同一枚钱币在同一时刻被描述为已售出和仍在手中。","suggestion":"根据真实事件统一钱币归属。","sourceEvidence":[{"source":"previous","segmentId":"p0"},{"source":"current","segmentId":"c1"}]}]}。示例不是实际意见，不得照抄。`

export function continuityReviewTail(validation: unknown, revision: number, allowRepair: boolean, focus?: string, currentContent?: string) {
  return [
    `当前版本：r${revision}。${allowRepair ? '对同一对象有原文互斥事实证据、可安全定位的错误集中附带最小事实补丁；警告保留待审，不编造改动，无法安全修改的项交作者决定。' : '本次只读复核，不生成补丁、不改写正文。'}`,
    focus ? `作者额外关注：${focus}` : '',
    continuityRecheckInput(validation, revision, currentContent),
    '每条 finding 附 sourceEvidence:[{source:"previous"或"current",segmentId:"所给段落编号"}]，两处互斥事实分别标注来源。不要将旧版报告、Scene Task 或桥接摘要的文字填作正文原文，不用省略号拼接。',
  ].filter(Boolean).join('\n')
}

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


/** Read-only interpretation of an existing pre-refactor artifact. Never a current review authority. */
export async function readHistoricalStandaloneContinuityContext(ctx: Pick<ToolContext, 'userId' | 'novelId' | 'runId' | 'chapterId'>, chapterId?: string, db: Prisma.TransactionClient = prisma, protocol: 2 | 3 | 4 | 5 = 3) {
  const targetId = await resolveQualityChapterTarget({ ...ctx, chapterId, fallbackChapterId: ctx.chapterId }, db)
  if (!targetId) throw new DataAccessError(400, 'CHAPTER_NOT_FOUND', '请从 chapter_read 或作品目录取得真实 chapterId；无需准备章节写作。')
  const chapter = await db.chapter.findFirst({ where: { id: targetId, authorId: ctx.userId, ...activeChapterScope(ctx.novelId) },
    select: { id: true, title: true, revision: true, content: true, orderIndex: true } })
  if (!chapter) throw new DataAccessError(404, 'CHAPTER_NOT_FOUND', 'chapterId 不是当前作品的有效章节编号；不要使用 compilationId 或猜测编号，请读取作品目录。')
  if (!chapter.content.trim()) throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '目标正文为空，未调用检查模型。')
  const preceding = await db.chapter.findMany({ where: { authorId: ctx.userId, ...activeChapterScope(ctx.novelId), orderIndex: { lt: chapter.orderIndex } },
    orderBy: { orderIndex: 'desc' }, take: 3, select: { id: true, title: true, revision: true, content: true, orderIndex: true } })
  const charter = await db.storyCharter.findUnique({ where: { novelId: ctx.novelId } })
  const contextHash = createHash('sha256').update(JSON.stringify({ ...(protocol >= 3 ? { protocol } : {}), chapter, preceding, charter })).digest('hex')
  const precedingBodies = [...preceding].reverse().map(item => item.content).join('\n\n')
  const sourceProvenance = continuityChapterProvenance(chapter, preceding)
  const criticInput = `独立连续性审阅；没有场景计划不构成错误，不要求补建编译或提交章节桥。仅审阅所给正文与前三章范围，不能声称验证未提供的全书。\n作品约定（不是已经发生的事实）：${JSON.stringify(charter)}\n目标章节 chapterId=${chapter.id}，《${chapter.title}》@r${chapter.revision}\n${continuitySourceInput({ previous: precedingBodies, current: chapter.content })}`
  return { chapter, contextHash, criticInput: protocol >= 3
    ? `${criticInput}\n章节来源边界（UTF-16 offset，previous 按章节顺序拼接，空白分隔不是正文事实）：${JSON.stringify(sourceProvenance)}`
    : criticInput, precedingBodies, sourceProvenance,
    sourceScope: { currentOrderIndex: chapter.orderIndex, previous: sourceProvenance.previous.map(({ orderIndex, startOffset, endOffset }) => ({ orderIndex, startOffset, endOffset })) } }
}

function standaloneReviewKey(contextHash: string, focus?: string, protocol = 3) {
  return createHash('sha256').update(JSON.stringify({ protocol, contextHash, focus: focus ?? '' })).digest('hex')
}

export async function readHistoricalStandaloneContinuityReport(ctx: ToolContext, contextHash: string, focus?: string, db: Prisma.TransactionClient = prisma, protocol = 3) {
  const artifact = await db.agentArtifact.findFirst({ where: { runId: ctx.runId, run: { userId: ctx.userId, novelId: ctx.novelId }, artifactType: 'continuityReview',
    metadata: { path: ['standaloneKey'], equals: standaloneReviewKey(contextHash, focus, protocol) } }, orderBy: { createdAt: 'desc' } })
  if (!artifact) return null
  const metadata = z.object({ independentCheck: z.literal('complete'), findings: z.array(continuityFindingInputSchema) }).safeParse(artifact.metadata)
  const saved = artifact.metadata as Record<string, unknown> | null, audit = saved?.criticResponse as Record<string, unknown> | undefined
  const sourceProjected = audit && (audit.sourceProjection !== undefined || audit.sourceCheckPolicy !== undefined)
  if (sourceProjected) {
    const marker = audit.sourceProjection as { frozenBodies?: { current?: string; previous?: string | null } } | undefined
    if (!metadata.success || !validateStoredExplicitSourceProjection(audit, marker?.frozenBodies?.current ?? '')) return null
    const current = await readHistoricalStandaloneContinuityContext(ctx, String(saved?.chapterId), db, audit.parserVersion === 7 ? 4 : 3)
    const rebuilt = validateStoredExplicitSourceProjection(audit, current.chapter.content)
    if (current.contextHash !== contextHash || marker?.frozenBodies?.previous !== current.precedingBodies || !rebuilt || runtimeJson(rebuilt.findings).hash !== runtimeJson(metadata.success ? metadata.data.findings : []).hash) return null
  }
  return metadata.success ? { artifact, findings: metadata.data.findings,
    ...(sourceProjected ? { criticResponse: audit as AuthenticatedContinuityInspection['audit'] } : {}) } : null
}

/** Only physical closure of pre-refactor requests. Historical phase limits,
 * report validity and candidate decisions are not current tool admission. */
export async function readHistoricalContinuityBilling(db: Prisma.TransactionClient, ctx: Pick<ToolContext, 'userId' | 'novelId'>,
  scope: { runIds: string[]; chapter: { id: string } }) {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const rows = await db.agentArtifact.findMany({ where: { runId: { in: scope.runIds }, run: { userId: ctx.userId, novelId: ctx.novelId }, artifactType: 'continuityReview',
    OR: [{ metadata: { path: ['assessmentChapterId'], equals: scope.chapter.id } }, { metadata: { path: ['chapterId'], equals: scope.chapter.id } }] } })
  const lifecycle = await import('./assessment-response-lifecycle.js'), billing = await import('./text-request-billing.js')
  const usageIds = new Set<string>(), unresolved: Array<{ runId: string; callId: string; chapterId: string; revision: number; compilationId: string | null }> = []
  for (const row of rows) {
    const meta = object(row.metadata), key = meta.continuityAssessmentRequestKey
    if (typeof key === 'string') {
      const parsed = lifecycle.legacyAssessmentInputSchema.safeParse(meta.input)
      if (!parsed.success || parsed.data.chapterId !== scope.chapter.id || typeof meta.callId !== 'string'
        || lifecycle.legacyContinuityAssessmentKey({ runId: row.runId, callId: meta.callId }, parsed.data) !== key) return { known: false, hasRequest: true, usageIds: [...usageIds] }
      const input = parsed.data
      const records = await db.agentArtifact.findMany({ where: { runId: row.runId, artifactType: 'continuityReview', OR: [
        { metadata: { path: ['assessmentKey'], equals: key } }, { metadata: { path: ['assessmentRequestOwnerKey'], equals: key } },
        { metadata: { path: ['firstAssessmentNotDispatchedKey'], equals: key } }, { metadata: { path: ['fullReassessmentKey'], equals: key } },
        { metadata: { path: ['fullReassessmentNotDispatchedKey'], equals: key } }] } })
      const frames = records.map(record => object(record.metadata))
      const ids = [...new Set(frames.flatMap(frame => Array.isArray(frame.usageIds) ? frame.usageIds.filter((id): id is string => typeof id === 'string') : []))]
      const fees = ids.length ? await db.aiUsageLog.findMany({ where: { id: { in: ids }, userId: ctx.userId, novelId: ctx.novelId,
        agentRunId: row.runId, targetType: input.targetType, targetId: input.targetId, action: { startsWith: 'agent3Continuity' } } }) : []
      fees.forEach(fee => usageIds.add(fee.id))
      const unsent = (field: string) => frames.some(frame => frame[field] === key && frame.callId === meta.callId && frame.outcome === 'guard_failed_before_dispatch'
        && Array.isArray(frame.usageIds) && frame.usageIds.every(id => fees.some(fee => fee.id === id && fee.billingStatus === 'not_dispatched' && billing.isKnownTextRequestBilling(fee))))
      const unseenSecond = frames.some(frame => frame.fullReassessmentKey === key) && !frames.some(frame => frame.stage === 'reassessment' && frame.assessmentKey === key)
      if ((ids.length || unsent('firstAssessmentNotDispatchedKey')) && fees.length === ids.length && fees.every(billing.isKnownTextRequestBilling)
        && (!unseenSecond || unsent('fullReassessmentNotDispatchedKey'))) continue
      unresolved.push({ runId: row.runId, callId: meta.callId, chapterId: input.chapterId, revision: input.revision,
        compilationId: input.targetType === 'story_compilation' ? input.targetId : null })
    } else if (typeof meta.evidenceCorrectionKey === 'string' && meta.state === 'claimed') {
      const observed = await (await import('./continuity-response-correction.js')).readHistoricalContinuityCorrectionBilling(db, ctx, row, scope.runIds)
      if (observed) { observed.usageIds.forEach(id => usageIds.add(id)); continue }
      if (typeof meta.callId !== 'string' || !Number.isSafeInteger(meta.revision)) return { known: false, hasRequest: true, usageIds: [...usageIds] }
      unresolved.push({ runId: row.runId, callId: meta.callId, chapterId: scope.chapter.id, revision: Number(meta.revision),
        compilationId: meta.targetType === 'story_compilation' && typeof meta.targetId === 'string' ? meta.targetId : null })
    }
  }
  for (const request of unresolved) {
    const proof = await (await import('./review-request-recovery.js')).readReviewRequestRecoveryEvidence(db, { ...ctx, runId: request.runId },
      [{ toolName: 'continuity_validate', callId: request.callId, chapterId: request.chapterId, revision: request.revision, compilationId: request.compilationId }])
    const closed = proof.find(item => item.callId === request.callId)
    if (!closed) return { known: false, hasRequest: true, usageIds: [...usageIds] }
    closed.receipt.usageIds.forEach(id => usageIds.add(id))
  }
  return { known: true, hasRequest: rows.some(row => { const value = object(row.metadata); return typeof value.continuityAssessmentRequestKey === 'string' || typeof value.evidenceCorrectionKey === 'string' }), usageIds: [...usageIds] }
}
