import { continuitySparseRepairRequest, applyContinuitySparseRepair, continuitySparseRepairDiagnostics } from './continuity-response-repair.js'
import { recoverEmptyOptionalProposalTable, sameEmptyOptionalProposalInput, validEmptyOptionalProposalProjection } from './continuity-empty-proposal-projection.js'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { runtimeJson } from './runtime-common.js'
import { isKnownTextRequestBilling, isKnownRejectedTextRequestAttempt } from './text-request-billing.js'
import { inspectContinuityResponse, continuityCandidateSchema } from './continuity-format-recovery.js'
import { continuitySourceCatalog, continuitySourceInput, type ContinuityBodies } from './continuity-review-context.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import type { ToolContext } from './tools/types.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { readQualityReviewAdmission } from './quality-review-admission.js'
import { readAuthorContinuedReviewUsageIds } from './continued-review-recovery.js'
import { markLegacyContinuityAssessmentApplied } from './continuity-response-correction.js'
import { terminalCandidateSchema, terminalResponseFields, type TerminalCandidate } from './terminal-state-review.js'
import { terminalEvidenceContextSchema, type TerminalEvidenceContext } from './terminal-evidence-context.js'
import { continuitySourceScopeSchema, type ContinuitySourceScope } from './continuity-source-authority.js'
import { terminalAddressResponseFields } from './terminal-review-addresses.js'
import { continuityResponseContract, continuityResponseSystem, continuityResponseInput, fixedContinuityResponseFields, assertFixedContinuityResponseFields, continuityReassessmentDiagnostics, continuityReassessmentEnvelope, decisionSchema, continuityReassessmentCandidates } from './continuity-response-contract.js'

type Inspection = ReturnType<typeof inspectContinuityResponse>
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const json = (raw: string) => ({ version: 1, encoding: 'json-string', content: JSON.stringify(raw), complete: true })
export type LegacyContinuityStage = 'first' | 'output_recovery' | 'reassessment'
export function legacyContinuityStageForAction(action: string): LegacyContinuityStage | null {
  return action === 'agent3ContinuityCritic' ? 'first' : action === 'agent3ContinuityCriticSecondPass' ? 'reassessment'
    : ['agent3ContinuityCriticOutputRecovery', 'agent3ContinuityCriticEmptyRecovery'].includes(action) ? 'output_recovery' : null
}
const knownAssessmentBilling = (row: Parameters<typeof isKnownRejectedTextRequestAttempt>[0]) =>
  isKnownRejectedTextRequestAttempt(row) || row.usageSource === 'reported' && isKnownTextRequestBilling(row)

/** Indices come only from a complete parsed provider array, including invalid
 * fields. An unparseable response has no reconstructed candidate identities. */
export { continuityReassessmentCandidates } from './continuity-response-contract.js'

export const continuityReassessmentRule = `本次是同一完整输入的一次完整复评，不改写正文。原回复只是待核数据，不能保持无依据的判断，也不能默默删除意见。
原候选能解析时，为每个原 index 恰好给一项 decisions：action 为 confirm、retract 或 replace，reason 说明核实原因，sourceEvidence 绑定本次真实原文。confirm 保持 signal/severity/evidence/suggestion 且 findingIndex 指向最终意见；replace 明确说明原判断为何不成立或需更正并指向替代意见；retract 说明撤回原因及原文依据，不给 findingIndex。原回复不能解析时 decisions 必须为空，不编造原意见编号。
完整复查全部输入，findings 是最终完整报告，可包含独立核实的新问题；每项继续遵守原 JSON 字段、真实引用、同一对象/时刻/维度及两处互斥证据规则。撤回候选不等于正文已改动。严格输出 {"decisions":[{"index":0,"action":"retract","reason":"原判断混淆先后事件，已核对实际原文。","sourceEvidence":[{"source":"current","segmentId":"c0"}]}],"findings":[]}。示例仅说明格式，不能照抄。`

export function continuityReassessmentRequest(system: string, input: string, original: Inspection, bodies: ContinuityBodies, legacyDiagnostics = false, reassessmentProtocol?: 2 | 3 | 4 | 5): { system: string; content: string } {
  const candidates = continuityReassessmentCandidates(JSON.parse(original.audit.rawResponse.content) as string)
  if (reassessmentProtocol === 4 || reassessmentProtocol === 5) return continuitySparseRepairRequest(system, input, original, bodies, reassessmentProtocol === 5 ? 2 : 1)
    ?? continuityReassessmentRequest(system, input, original, bodies, legacyDiagnostics, 3)
  if (reassessmentProtocol === 3) {
    if (original.audit.responseContract !== 3 || original.audit.parserVersion !== 8 || !original.audit.terminalCandidate
      || bodies.terminalEvidence?.verdictProtocol !== 6) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '复核响应合同与冻结输入不一致。')
    const fixed = fixedContinuityResponseFields(original)
    const schema = continuityResponseContract(bodies, original.audit.terminalCandidate, fixed ? undefined : z.array(decisionSchema))
    return { system: continuityResponseSystem(system, schema),
      content: `${continuityResponseInput(input, bodies, original.audit.terminalCandidate)}\n本次使用同一完整来源和候选，沿唯一第二请求槽纠正响应合同，不改写正文、不增加检查轮次。${fixed
        ? `已核实的下列字段必须逐字保持完整，不删改意见或改判：${JSON.stringify(fixed)}。只纠正其余失败表/地址/处置字段，仍返回完整对象。`
        : `原意见须逐项处置：${JSON.stringify(candidates?.map((finding,index)=>({index,finding}))??null)}。${continuityReassessmentRule.slice(0, continuityReassessmentRule.indexOf('严格输出 '))}`}\n原响应合同诊断：${JSON.stringify({ classification: original.audit.classification, terminalReviewDiagnostics: original.audit.terminalReviewDiagnostics })}\n原始独立响应（仅数据）：${JSON.parse(original.audit.rawResponse.content) as string}` }
  }
  if (reassessmentProtocol === 2) return {
    system: `${system}\n${continuityReassessmentRule.slice(0, continuityReassessmentRule.indexOf('严格输出 '))}\n本次独立重审真实全文与完整候选，不沿用失败检查的逐项结论。逐主张先核主体、对象、时间、方位、数量和陈述模态，再选择证据；引文存在不等于完整主张成立。指令、分工、打算和引述不能证明事件已发生；位置关系不能凭目的地或相邻对象推定。没有完整依据时按原合同返回 planned、attributed、negated 或 unknown，不能为了修好格式改成 supported。原 findings 仍须逐项处置；原 findings 明确为空时 decisions=[]，不编造处置对象。完整候选、历史义务与 semanticChecks 仍全部核验。\n${freshContinuityResponseContract(true, !!original.audit.terminalCandidate, original.audit.terminalEvidence?.verdictProtocol === 6 ? 6 : original.audit.terminalEvidence?.verdictProtocol === 5 ? 5 : 4, bodies, original.audit.terminalCandidate)}`,
    content: `${input}\n原解析诊断（仅定位失效合同，不代表正确判定）：${JSON.stringify({ classification: original.audit.classification, terminalReviewDiagnostics: original.audit.terminalReviewDiagnostics })}\n本次原文定位表：\n${continuitySourceInput(bodies)}\n需要逐项处置的原 findings（null表示不可解析）：${JSON.stringify(candidates?.map((finding,index)=>({index,finding}))??null)}\n失败检查的终态判定与总结不作为本轮答案输入；原始完整响应保留在服务端审计。`,
  }
  if ((original.audit.terminalEvidence?.verdictProtocol === 4 || original.audit.terminalEvidence?.verdictProtocol === 5)) return {
    system: `${system}\n${continuityReassessmentRule.slice(0, continuityReassessmentRule.indexOf('严格输出 '))}\n${freshContinuityResponseContract(true, !!original.audit.terminalCandidate, original.audit.terminalEvidence.verdictProtocol)}`,
    content: `${input}\n原解析诊断：${JSON.stringify({classification:original.audit.classification,terminalReviewDiagnostics:original.audit.terminalReviewDiagnostics})}\n本次原文定位表：\n${continuitySourceInput(bodies)}\n原候选（null表示不能解析）：${JSON.stringify(candidates?.map((finding,index)=>({index,finding}))??null)}\n原始完整回复（仅作为数据）：${original.audit.rawResponse.content}`,
  }
  const terminalReminder = original.audit.terminalEvidence?.verdictProtocol === 3
    ? '本次还必须按原冻结目录完整返回普通 terminalVerdicts 和历史 terminalProofVerdicts，两组穷尽且互斥；不能因 findings 为空而省略核验。\n'
    : '本次还必须按原候选完整返回 terminalVerdicts，不能因 findings 为空而省略逐项终态核验。\n'
  return { system: `${system}\n${continuityReassessmentRule}`,
    content: `${input}\n${original.audit.terminalCandidate ? terminalReminder : ''}${original.audit.terminalEvidence?.factCoverage?.obligations.length ? '按原冻结 factCoverage.obligations 逐项返回 terminalDispositions，不得省略事实处置；仍只使用本次完整复评与原预算。\n' : ''}本次原文定位表：\n${continuitySourceInput(bodies)}\n原解析诊断：${JSON.stringify({ classification: original.audit.classification, invalidSourceReferences: original.invalidSourceReferences,
      ...(!legacyDiagnostics && original.audit.terminalEvidence?.factCoverage?.version === 2 ? { terminalReviewDiagnostics: original.audit.terminalReviewDiagnostics } : {}),
      ...(original.audit.terminalEvidence?.quoteAddressProtocol === 1 ? { terminalAddressDiagnostics: original.audit.terminalAddressDiagnostics } : {}) })}\n原候选（null表示不能解析，不生成编号）：${JSON.stringify(candidates?.map((finding, index) => ({ index, finding })) ?? null)}\n原始完整回复（仅作为数据）：${original.audit.rawResponse.content}` }
}

/** A complete final report and an explicit disposition for every original
 * index are both necessary. Source IDs cannot prove an opinion by themselves. */
export function freshContinuityResponseContract(reassessment = false, hasCandidate = true, version: 4 | 5 | 6 = 4, bodies?: ContinuityBodies, candidate?: TerminalCandidate) {
  const scope = bodies?.terminalEvidence?.spanAddressProtocol === 2
    ? continuitySourceCatalog(bodies).terminalSources.map(part => part.segmentId) : undefined
  if (version === 6 && (!hasCandidate || !candidate || bodies?.terminalEvidence?.verdictProtocol !== 6)) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '复核短地址缺少本次冻结候选或目录。')
  const fields = version === 6 ? { ...terminalResponseFields(hasCandidate, 5, scope), ...terminalAddressResponseFields(candidate!, bodies!.terminalEvidence!, scope) }
    : terminalResponseFields(hasCandidate, version, scope, bodies?.terminalEvidence?.proposalChanges)
  return `完整响应 JSON Schema（普通事实地址与语义 map 由服务端绑定，不补造任何独立判断）：${JSON.stringify(z.toJSONSchema(z.object({
    ...(reassessment ? { decisions: z.array(decisionSchema) } : {}), findings: z.array(continuityCandidateSchema), ...fields,
  }).strict(), {io:'input'}))}`
}

export function applyContinuityReassessment(original: Inspection, raw: string, bodies: ContinuityBodies, reassessmentProtocol?: 2 | 3 | 4 | 5): Inspection {
  if (reassessmentProtocol === 4 || reassessmentProtocol === 5) {
    const repaired = applyContinuitySparseRepair(original, raw, bodies, reassessmentProtocol === 5 ? 2 : 1)
    if (!repaired) return applyContinuityReassessment(original, raw, bodies, 3)
    const result = inspectContinuityResponse(repaired.raw, bodies, true, 8, original.audit.terminalCandidate, original.audit.sourceScope, { responseContract: 3 })
    if (!result.complete) throw new Error('Sparse repair did not produce a valid full independent report')
    return { ...result, audit: { ...result.audit, responseProjection: repaired.projection, reassessment: { version: 1, kind: 'sparse_table_repair', original: original.audit,
      rawResponse: json(raw), frozenBodies: bodies, projection: repaired.projection } } as Inspection['audit'] }
  }
  if (reassessmentProtocol === 3) {
    if (original.audit.responseContract !== 3 || !original.audit.terminalCandidate || bodies.terminalEvidence?.verdictProtocol !== 6)
      throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '复核响应合同与原始审计不一致。')
    const fixed = fixedContinuityResponseFields(original)
    if (fixed) {
      const response = parseQualityJsonObject(raw, 'continuity', 3) as Record<string, unknown>
      assertFixedContinuityResponseFields(fixed, response)
      const result = inspectContinuityResponse(raw, bodies, true, 8, original.audit.terminalCandidate, original.audit.sourceScope, { responseContract: 3 })
      if (!result.complete) throw new Error('Continuity field repair final report is invalid')
      return { ...result, audit: { ...result.audit, reassessment: { version: 1, kind: 'field_repair', original: original.audit,
        fixedFields: Object.keys(fixed), fixedHash: runtimeJson(fixed).hash, rawResponse: json(raw) } } as Inspection['audit'] }
    }
    // Source-invalid findings still require the complete explicit disposition
    // protocol below; fixed-field recovery cannot silently drop them.
  }
  const { envelope, derivedEmptyDecisions } = continuityReassessmentEnvelope(original, raw, bodies, reassessmentProtocol)
  const result = inspectContinuityResponse(original.audit.terminalCandidate || original.audit.parserVersion === 8 ? raw : JSON.stringify({ findings: envelope.findings }), bodies, true, original.audit.parserVersion === 8 ? 8 : original.audit.parserVersion >= 7 ? 7 : 6, original.audit.terminalCandidate, original.audit.sourceScope, reassessmentProtocol === 3 ? { responseContract: 3 } : {})
  if (!result.complete) throw new Error('Reassessment final report is invalid')
  return { ...result, audit: { ...result.audit, reassessment: { version: 1, original: original.audit,
    decisions: envelope.decisions, rawResponse: json(raw),
    ...(derivedEmptyDecisions ? { mechanicalRecovery: { version: 1, kind: 'empty_original_dispositions',
      originalResponseHash: original.audit.contentHash, responseHash: createHash('sha256').update(raw).digest('hex'), derived: { decisions: [] } } } : {}),
  } } as Inspection['audit'] }
}

function failedContinuityReassessment(original: Inspection, raw: string, complete: boolean, bodies: ContinuityBodies, protocol?: 2 | 3 | 4 | 5): Inspection {
  const sparseDiagnostics = (protocol === 4 || protocol === 5) && complete ? continuitySparseRepairDiagnostics(original, raw, bodies, protocol === 5 ? 2 : 1) : null
  return { ...original, audit: { ...original.audit, reassessment: { version: 1,
    ...(sparseDiagnostics ? { kind: 'sparse_table_repair_failed', protocol } : {}),
    classification: complete ? 'invalid' : 'response_incomplete', rawResponse: { ...json(raw), complete },
    ...((protocol === 3 || protocol === 4 || protocol === 5) && complete ? { diagnostics: sparseDiagnostics ?? continuityReassessmentDiagnostics(original, raw, bodies) } : {}) } } as Inspection['audit'] }
}

export async function runContinuityReassessment(input: { original: Inspection; bodies: ContinuityBodies; system: string; content: string; reassessmentProtocol?: 2 | 3 | 4 | 5;
  billingKnown: boolean; providerComplete: boolean; slotUsed: boolean; signal: AbortSignal; assertCurrent: () => Promise<void>;
  claim: (request: { system: string; content: string }) => Promise<boolean>; dispatch: (request: { system: string; content: string }) => Promise<{ content: string; complete: boolean }>;
  notDispatched?: () => Promise<void>;
}): Promise<Inspection> {
  if ((input.reassessmentProtocol === 3 || input.reassessmentProtocol === 4 || input.reassessmentProtocol === 5) !== (input.original.audit.responseContract === 3)) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '复核阶段响应版本不一致。')
  if (input.original.complete || !input.billingKnown || !input.providerComplete || input.slotUsed || !input.original.audit.rawResponse.complete) return input.original
  input.signal.throwIfAborted(); await input.assertCurrent()
  input.signal.throwIfAborted()
  const formatOnly = recoverEmptyOptionalProposalTable(input.original, input.bodies)
  if (formatOnly) return formatOnly
  const request = continuityReassessmentRequest(input.system, input.content, input.original, input.bodies, false, input.reassessmentProtocol)
  if (!await input.claim(request)) return input.original
  try { input.signal.throwIfAborted(); await input.assertCurrent() } catch (error) {
    await input.notDispatched?.()
    throw error
  }
  const response = await input.dispatch(request)
  input.signal.throwIfAborted(); await input.assertCurrent()
  let result: Inspection | undefined
  if (response.complete) try { result = applyContinuityReassessment(input.original, response.content, input.bodies, input.reassessmentProtocol) } catch { /* Explicit invalid second result remains incomplete. */ }
  return result ?? failedContinuityReassessment(input.original, response.content, response.complete, input.bodies, input.reassessmentProtocol)
}

export type LegacyAssessmentInput = { chapterId: string; revision: number; bodies: ContinuityBodies; system: string; content: string; terminalCandidate?: TerminalCandidate; reassessmentProtocol?: 2 | 3 | 4 | 5;
  parserVersion?: 7 | 8; sourceScope?: ContinuitySourceScope; bindingHash?: string; targetType: 'chapter' | 'story_compilation'; targetId: string }
export type FrozenTerminalContract = Pick<TerminalEvidenceContext, 'verdictProtocol' | 'spanAddressProtocol' | 'proposalChanges'> & { coverageVersion: 1 | 2 }
export const legacyContinuityAssessmentKey = (ctx: Pick<ToolContext, 'runId' | 'callId'>, input: LegacyAssessmentInput) => runtimeJson({ runId: ctx.runId, callId: ctx.callId,
  input: { chapterId: input.chapterId, revision: input.revision, bodies: input.bodies, system: input.system, content: input.content, bindingHash: input.bindingHash ?? null,
    ...(input.parserVersion ? { parserVersion: input.parserVersion, sourceScope: input.sourceScope } : {}),
    ...(input.reassessmentProtocol ? { reassessmentProtocol: input.reassessmentProtocol } : {}) } }).hash
const assessmentKey = legacyContinuityAssessmentKey

/** Existing owned call identities always retain their whole request. Choosing a
 * newer response format cannot create a second reservation for the same call. */
export async function readFrozenLegacyContinuityInput(tx: Prisma.TransactionClient, ctx: ToolContext, proposed: LegacyAssessmentInput,
  recoverBodies?: (version: FrozenTerminalContract) => ContinuityBodies) {
  const rows = await tx.agentArtifact.findMany({ where: { runId: ctx.runId, run: { userId: ctx.userId, novelId: ctx.novelId },
    artifactType: 'continuityReview', metadata: { path: ['callId'], equals: ctx.callId } } })
  const reservations = rows.filter(row => typeof object(row.metadata)?.continuityAssessmentRequestKey === 'string')
  if (!reservations.length) return null
  const invalid = () => new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '原调用冻结输入不一致，未重放或重新派发检查。')
  if (reservations.length !== 1) throw invalid()
  const meta = object(reservations[0].metadata)!
  const parsed = z.object({ chapterId: z.string(), revision: z.number().int(),
    bodies: z.object({ previous: z.string().nullable(), current: z.string(), terminalEvidence: terminalEvidenceContextSchema.optional() }).strict(),
    system: z.string(), content: z.string(), reassessmentProtocol: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(), parserVersion: z.union([z.literal(7), z.literal(8)]).optional(),
    sourceScope: continuitySourceScopeSchema.optional(), terminalCandidate: terminalCandidateSchema.optional(), bindingHash: z.string().optional(),
    targetType: z.enum(['chapter', 'story_compilation']), targetId: z.string() }).strict().safeParse(meta.input)
  if (!parsed.success || (parsed.data.reassessmentProtocol === 3 || parsed.data.reassessmentProtocol === 4 || parsed.data.reassessmentProtocol === 5) && (parsed.data.parserVersion !== 8 || parsed.data.bodies.terminalEvidence?.verdictProtocol !== 6 || !parsed.data.terminalCandidate)
    || parsed.data.parserVersion && !parsed.data.sourceScope
    || meta.continuityAssessmentRequestKey !== assessmentKey(ctx, parsed.data)) throw invalid()
  const identity = (input: LegacyAssessmentInput) => {
    const copy = structuredClone(input)
    if (copy.bodies.terminalEvidence?.factCoverage) copy.bodies.terminalEvidence.factCoverage.version = 1
    return { chapterId: copy.chapterId, revision: copy.revision, bodies: copy.bodies, targetType: copy.targetType, targetId: copy.targetId,
      terminalCandidate: copy.terminalCandidate ?? null, bindingHash: copy.bindingHash ?? null, parserVersion: copy.parserVersion ?? null, sourceScope: copy.sourceScope ?? null }
  }
  const expected = recoverBodies ? { ...proposed, bodies: recoverBodies({ coverageVersion: parsed.data.bodies.terminalEvidence?.factCoverage?.version ?? 1,
    ...(parsed.data.bodies.terminalEvidence?.proposalChanges ? { proposalChanges: parsed.data.bodies.terminalEvidence.proposalChanges } : {}),
    ...(parsed.data.bodies.terminalEvidence?.spanAddressProtocol ? { spanAddressProtocol: parsed.data.bodies.terminalEvidence.spanAddressProtocol } : {}),
    ...(parsed.data.bodies.terminalEvidence?.verdictProtocol ? { verdictProtocol: parsed.data.bodies.terminalEvidence.verdictProtocol } : {}) }) } : proposed
  if (runtimeJson(identity(parsed.data)).hash !== runtimeJson(identity(expected)).hash) throw invalid()
  return parsed.data
}

/** One actual tool-call reservation. A new selector, body or worker restart
 * cannot retire an unknown request; only existing authenticated retirement can. */
export async function reserveLegacyContinuityAssessment(tx: Prisma.TransactionClient, ctx: ToolContext, input: LegacyAssessmentInput,
  assertCurrent: (tx: Prisma.TransactionClient) => Promise<void>) {
  ctx.signal.throwIfAborted(); await lockNovelActiveScope(tx, ctx.novelId); await assertAgentManuscriptCurrent(tx, ctx); await assertCurrent(tx)
  const task = await readOriginalTaskRequest(tx, ctx), runIds = await originalTaskRunIds(tx, ctx, task)
  const run = await tx.agentRun.findFirstOrThrow({ where: { id: ctx.runId, userId: ctx.userId, novelId: ctx.novelId } })
  const admission = await readQualityReviewAdmission(tx, run), key = assessmentKey(ctx, input)
  const reservations = await tx.agentArtifact.findMany({ where: { runId: { in: runIds }, artifactType: 'continuityReview',
    metadata: { path: ['assessmentChapterId'], equals: input.chapterId } } })
  const exact = reservations.find(row => object(row.metadata)?.continuityAssessmentRequestKey === key)
  if (exact) return 'replay' as const
  const retired = reservations.length ? await readAuthorContinuedReviewUsageIds(tx, ctx) : new Set<string>()
  for (const reservation of reservations) {
    const meta = object(reservation.metadata)
    if (typeof meta?.continuityAssessmentRequestKey !== 'string') continue
    if (await tx.agentArtifact.findFirst({ where: { runId: { in: runIds }, artifactType: 'continuityReview',
      metadata: { path: ['assessmentApplicationKey'], equals: meta.continuityAssessmentRequestKey } } })) continue
    const observations = await tx.agentArtifact.findMany({ where: { runId: reservation.runId, artifactType: 'continuityReview',
      metadata: { path: ['assessmentKey'], equals: meta.continuityAssessmentRequestKey } } })
    const links = await tx.agentArtifact.findMany({ where: { runId: reservation.runId, artifactType: 'continuityReview',
      metadata: { path: ['assessmentRequestOwnerKey'], equals: meta.continuityAssessmentRequestKey } } })
    const ids = [...new Set([...observations, ...links].flatMap(row => { const value = object(row.metadata)?.usageIds; return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [] }))]
    const claim = await tx.agentArtifact.findFirst({ where: { runId: reservation.runId, artifactType: 'continuityReview',
      metadata: { path: ['fullReassessmentKey'], equals: meta.continuityAssessmentRequestKey } } })
    const unseenSecond = claim && !observations.some(row => object(row.metadata)?.stage === 'reassessment')
    const unsent = unseenSecond && await tx.agentArtifact.findFirst({ where: { runId: reservation.runId, artifactType: 'continuityReview',
      metadata: { path: ['fullReassessmentNotDispatchedKey'], equals: meta.continuityAssessmentRequestKey } } })
    const usage = ids.length ? await tx.aiUsageLog.findMany({ where: { id: { in: ids }, userId: ctx.userId, novelId: ctx.novelId,
      chapterId: input.chapterId, action: { startsWith: 'agent3ContinuityCritic' } } }) : []
    const firstUnsent = await tx.agentArtifact.findFirst({ where: { runId: reservation.runId, artifactType: 'continuityReview',
      metadata: { path: ['firstAssessmentNotDispatchedKey'], equals: meta.continuityAssessmentRequestKey } } })
    const known = (!unseenSecond || !!unsent) && (ids.length > 0 || !!firstUnsent) && usage.length === new Set(ids).size
      && usage.every(row => knownAssessmentBilling(row) || isKnownTextRequestBilling(row) && row.billingStatus === 'not_dispatched')
    const explicitlyRetired = usage.length > 0 && usage.length === new Set(ids).size && (!unseenSecond || usage.some(row => retired.has(row.id)))
      && usage.every(row => knownAssessmentBilling(row) || retired.has(row.id))
    // A completed, paid failure belongs to its exact reviewed input, not every
    // later revision of the chapter. Changing focus/selectors/callId is not a
    // new subject. Unknown dispatches and unseen second passes stay fenced.
    const frozen = object(meta.input), frozenBodies = object(frozen?.bodies)
    const subjectChanged = frozen?.targetType === input.targetType && frozen.targetId === input.targetId
      && frozen.chapterId === input.chapterId && typeof frozenBodies?.current === 'string'
      && (frozenBodies.current !== input.bodies.current
        || runtimeJson({ terminalCandidate: frozen.terminalCandidate ?? null }).hash !== runtimeJson({ terminalCandidate: input.terminalCandidate ?? null }).hash)
    if (known && admission && meta.admissionId === admission.id && subjectChanged && typeof meta.callId === 'string') {
      // A primary response may be observed before the old chain claims its
      // second pass. Only its real terminal tool result closes that window.
      const events = await tx.agentRunEvent.findMany({ where: { runId: reservation.runId, type: { in: ['tool.call', 'tool.result'] },
        payload: { path: ['callId'], equals: meta.callId } } })
      const calls = events.filter(row => row.type === 'tool.call' && object(row.payload)?.toolName === 'continuity_validate')
      const results = events.filter(row => row.type === 'tool.result' && object(row.payload)?.toolName === 'continuity_validate' && object(row.payload)?.ok === false)
      const lastObservation = observations.reduce((date, row) => row.createdAt > date ? row.createdAt : date, reservation.createdAt)
      // Events flush asynchronously. Their database insertion time need not be
      // the call time; new events carry the server's canonical emission stamp.
      const emittedAt = (event: typeof events[number]) => {
        const payload = object(event.payload)
        if (payload?.seq !== undefined && payload.seq !== event.seq || payload?.type !== undefined && payload.type !== event.type) return null
        if (payload?.ts === undefined) return event.createdAt
        if (typeof payload.ts !== 'string') return null
        const at = new Date(payload.ts)
        return Number.isFinite(at.getTime()) && at.toISOString() === payload.ts ? at : null
      }
      const callAt = calls.length === 1 ? emittedAt(calls[0]) : null, resultAt = results.length === 1 ? emittedAt(results[0]) : null
      const finished = callAt && resultAt && callAt <= reservation.createdAt
        && results[0].seq > calls[0].seq && resultAt >= lastObservation
      const fullyObserved = observations.length > 0 && observations.every(row => {
        const frame = object(row.metadata), response = object(frame?.response)
        return response?.transportComplete === true && response.finishReason === 'stop'
          && Array.isArray(response.toolCalls) && response.toolCalls.length === 0 && typeof response.content === 'string'
          || response?.content === null && Array.isArray(frame?.usageIds) && frame.usageIds.length > 0
            && frame.usageIds.every(id => usage.some(row => row.id === id && isKnownRejectedTextRequestAttempt(row)))
      })
      if (finished && fullyObserved) {
        const prior = await readLegacyContinuityAssessment(tx, { ...ctx, runId: reservation.runId, callId: meta.callId }, frozen as LegacyAssessmentInput)
        if (prior.billingKnown && prior.providerComplete) continue
      }
    }
    const last = observations.reduce((date, row) => row.createdAt > date ? row.createdAt : date, reservation.createdAt)
    if ((!known && !explicitlyRetired) || !admission || meta.admissionId === admission.id || admission.at <= last) return 'blocked' as const
  }
  await tx.agentArtifact.create({ data: { runId: ctx.runId, artifactType: 'continuityReview', title: '连续性检查请求审计', content: '本次原工具检查已预约；未知请求不能重放。',
    metadata: runtimeJson({ version: 1, continuityAssessmentRequestKey: key, assessmentChapterId: input.chapterId,
      callId: ctx.callId, input, admissionId: admission?.id ?? null }).value } })
  return 'new' as const
}

export async function readLegacyContinuityAssessment(tx: Prisma.TransactionClient, ctx: ToolContext, input: LegacyAssessmentInput) {
  const key = assessmentKey(ctx, input)
  const observations = await tx.agentArtifact.findMany({ where: { runId: ctx.runId, artifactType: 'continuityReview',
    metadata: { path: ['assessmentKey'], equals: key } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const frames = observations.map(row => object(row.metadata)!)
  if (frames.some(frame => {
    const audit = object(frame.audit), response = object(frame.response)
    if (input.reassessmentProtocol !== 3 && input.reassessmentProtocol !== 4 && input.reassessmentProtocol !== 5 && audit?.responseContract !== 3) return false
    return !object(frame.input) || runtimeJson(frame.input).hash !== runtimeJson(input).hash
      || typeof response?.content === 'string' && (input.reassessmentProtocol === 3 || input.reassessmentProtocol === 4 || input.reassessmentProtocol === 5) !== (audit?.responseContract === 3)
  })) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原观察响应合同与完整冻结输入不一致，未重解释或重发。')
  const primary = frames.filter(row => row.stage === 'first' || row.stage === 'output_recovery')
  const first = primary.filter(row => typeof object(row.response)?.content === 'string').at(-1), response = object(first?.response)
  if (!first || !response || typeof response.content !== 'string') throw new DataAccessError(409, 'RUNTIME_RECONCILIATION_REQUIRED', '原检查未取得可复用响应，未重放请求。')
  const bindings = await tx.agentArtifact.findMany({ where: { runId: ctx.runId, artifactType: 'continuityReview',
    metadata: { path: ['assessmentRequestOwnerKey'], equals: key } } })
  const owners = bindings.map(row => object(row.metadata)!)
  const ids = [...new Set([...frames, ...owners].flatMap(row => Array.isArray(row.usageIds) ? row.usageIds.filter((id): id is string => typeof id === 'string') : []))]
  const usage = await tx.aiUsageLog.findMany({ where: { id: { in: ids }, userId: ctx.userId, novelId: ctx.novelId,
    agentRunId: ctx.runId, targetType: input.targetType, targetId: input.targetId, action: { startsWith: 'agent3ContinuityCritic' } } })
  const known = ids.length > 0 && usage.length === ids.length && usage.every(knownAssessmentBilling)
    && owners.every(owner => {
      const ids = owner.usageIds
      return Array.isArray(ids) && ids.length === 1
        && usage.some(row => ids.includes(row.id) && legacyContinuityStageForAction(row.action) === owner.stage)
    })
    && frames.every(frame => Array.isArray(frame.usageIds) && frame.usageIds.length > 0 && new Set(frame.usageIds).size === frame.usageIds.length && frame.usageIds.every(id => {
      const row = usage.find(item => item.id === id)
      return row && legacyContinuityStageForAction(row.action) === frame.stage
        && (!isKnownRejectedTextRequestAttempt(row) || object(frame.response)?.content === null)
    })) && (['first', 'output_recovery', 'reassessment'] as const).every(stage => usage.filter(row => legacyContinuityStageForAction(row.action) === stage
      && !isKnownRejectedTextRequestAttempt(row)).length <= 1)
  const original = inspectContinuityResponse(JSON.parse(response.content) as string, input.bodies, response.transportComplete === true && response.finishReason === 'stop'
    && Array.isArray(response.toolCalls) && !response.toolCalls.length, input.parserVersion ?? 6, input.terminalCandidate, input.sourceScope, input.reassessmentProtocol === 3 || input.reassessmentProtocol === 4 || input.reassessmentProtocol === 5 ? { responseContract: 3 } : {})
  const secondFrames = frames.filter(row => row.stage === 'reassessment')
  const second = secondFrames.filter(row => typeof object(row.response)?.content === 'string').at(-1), secondResponse = object(second?.response)
  let inspected = original
  let secondApplied = false
  if (secondResponse && typeof secondResponse.content === 'string' && secondResponse.transportComplete === true && secondResponse.finishReason === 'stop'
    && Array.isArray(secondResponse.toolCalls) && !secondResponse.toolCalls.length) {
    const secondIds = [...new Set(secondFrames.flatMap(row => Array.isArray(row.usageIds) ? row.usageIds as string[] : []))]
    const secondUsage = await tx.aiUsageLog.findMany({ where: { id: { in: secondIds }, userId: ctx.userId, novelId: ctx.novelId,
      agentRunId: ctx.runId, targetType: input.targetType, targetId: input.targetId, action: 'agent3ContinuityCriticSecondPass' } })
    if (secondUsage.length === new Set(secondIds).size && secondUsage.filter(row => !isKnownRejectedTextRequestAttempt(row)).length === 1
      && secondUsage.every(knownAssessmentBilling)) {
      try { inspected = applyContinuityReassessment(original, JSON.parse(secondResponse.content) as string, input.bodies, input.reassessmentProtocol); secondApplied = true }
      catch { if (input.reassessmentProtocol === 3 || input.reassessmentProtocol === 4 || input.reassessmentProtocol === 5) inspected = failedContinuityReassessment(original, JSON.parse(secondResponse.content) as string, true, input.bodies, input.reassessmentProtocol) }
    }
  }
  const claimed = await tx.agentArtifact.findFirst({ where: { runId: ctx.runId, artifactType: 'continuityReview', metadata: { path: ['fullReassessmentKey'], equals: key } } })
  const completeFrame = (frame: Record<string, unknown> | null) => frame?.transportComplete === true && frame.finishReason === 'stop'
    && typeof frame.content === 'string' && Array.isArray(frame.toolCalls) && !frame.toolCalls.length
  if (!inspected.complete && known && completeFrame(response) && object(first.audit) && runtimeJson(original.audit).hash === runtimeJson(first.audit).hash
    && (claimed ? (input.reassessmentProtocol === 3 || input.reassessmentProtocol === 4 || input.reassessmentProtocol === 5)
      && completeFrame(secondResponse) && second && (() => {
      const meta = object(claimed.metadata)
      const observed = inspectContinuityResponse(JSON.parse(secondResponse!.content as string) as string, input.bodies, true,
        input.parserVersion ?? 6, input.terminalCandidate, input.sourceScope, { responseContract: 3 })
      return meta && object(meta.input) && object(meta.original) && object(meta.request)
        && object(second.audit) && runtimeJson(observed.audit).hash === runtimeJson(second.audit).hash
        && runtimeJson(meta.input).hash === runtimeJson(input).hash && runtimeJson(meta.original).hash === runtimeJson(original.audit).hash
        && runtimeJson(meta.request).hash === runtimeJson(continuityReassessmentRequest(input.system, input.content, original, input.bodies, false, input.reassessmentProtocol)).hash
    })() : secondFrames.length === 0)) {
    const projected = recoverEmptyOptionalProposalTable(original, input.bodies, claimed && second
      && (input.reassessmentProtocol === 3 || input.reassessmentProtocol === 4 || input.reassessmentProtocol === 5)
      ? { audit: second.audit, protocol: input.reassessmentProtocol } : undefined)
    if (projected) { inspected = projected; secondApplied = !!claimed }
  }
  // A newly interpretable primary cannot erase an already claimed second
  // request or its unknown fees. Require the actual complete final report.
  if (original.complete && claimed && !secondApplied || inspected.complete && !known) {
    throw new DataAccessError(409, 'CONTINUITY_REPORT_INCOMPLETE', '原复核仍有未确认请求、用量或无效终态报告；保留原始记录，未复用或重发。')
  }
  const recoveryReady = known && completeFrame(response) && (!claimed || completeFrame(secondResponse))
    && usage.filter(row => !isKnownRejectedTextRequestAttempt(row)).every(row => frames.some(frame =>
      Array.isArray(frame.usageIds) && frame.usageIds.includes(row.id) && completeFrame(object(frame.response))))
  return { inspected, recoveryReady, usageIds: ids, billingKnown: known, providerComplete: response.transportComplete === true && response.finishReason === 'stop'
    && Array.isArray(response.toolCalls) && !response.toolCalls.length, slotUsed: primary.some(row => row.stage === 'output_recovery') || !!claimed }
}

/** Only the real report application transaction records this receipt. */
export async function markLegacyContinuityAssessmentApplication(tx: Prisma.TransactionClient, ctx: ToolContext, inspected: Inspection) {
  const application = object((inspected.audit as unknown as Record<string, unknown>).assessmentRequest)
  const task = await readOriginalTaskRequest(tx, ctx), runIds = await originalTaskRunIds(tx, ctx, task)
  const reservations = await tx.agentArtifact.findMany({ where: { runId: { in: runIds }, artifactType: 'continuityReview',
    metadata: { path: ['continuityAssessmentRequestKey'], equals: String(application?.key) } } })
  const reservation = reservations.length === 1 ? reservations[0] : null
  if (!reservation) return
  const meta = object(reservation.metadata)!, key = String(meta.continuityAssessmentRequestKey)
  const frozen = object(meta.input)
  if (!inspected.complete || application?.inputHash !== runtimeJson(frozen).hash
    || (frozen?.reassessmentProtocol === 3 || frozen?.reassessmentProtocol === 4 || frozen?.reassessmentProtocol === 5) !== (inspected.audit.responseContract === 3)) return
  const observations = await tx.agentArtifact.findMany({ where: { runId: reservation.runId, artifactType: 'continuityReview', metadata: { path: ['assessmentKey'], equals: key } } })
  const ids = observations.flatMap(row => { const value = object(row.metadata)?.usageIds; return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [] })
  const usage = await tx.aiUsageLog.findMany({ where: { id: { in: ids }, userId: ctx.userId, novelId: ctx.novelId, action: { startsWith: 'agent3ContinuityCritic' } } })
  if (!ids.length || usage.length !== new Set(ids).size || usage.some(row => !knownAssessmentBilling(row))) return
  if (typeof meta.callId !== 'string') return
  const received = await readLegacyContinuityAssessment(tx, { ...ctx, runId: reservation.runId, callId: meta.callId }, frozen as LegacyAssessmentInput)
  if (!received.billingKnown || !received.providerComplete || !received.inspected.complete) return
  if (observations.some(observation => {
    const meta = object(observation.metadata)
    return !Array.isArray(meta?.usageIds) || meta.usageIds.some(id => {
      const row = usage.find(item => item.id === id)
      return !row || legacyContinuityStageForAction(row.action) !== meta.stage
        || isKnownRejectedTextRequestAttempt(row) && object(meta.response)?.content !== null
    })
  })) return
  if (!await tx.agentArtifact.findFirst({ where: { runId: ctx.runId, artifactType: 'continuityReview', metadata: { path: ['assessmentApplicationKey'], equals: key } } })) {
    await tx.agentArtifact.create({ data: { runId: ctx.runId, artifactType: 'continuityReview', title: '连续性报告应用审计', content: '完整检查报告已应用到对应当前输入。',
      metadata: runtimeJson({ version: 1, assessmentApplicationKey: key, reservationId: reservation.id, usageIds: ids }).value } })
  }
  if (typeof meta.callId === 'string') await markLegacyContinuityAssessmentApplied(tx, { ...ctx, runId: reservation.runId, callId: meta.callId })
}

export function bindLegacyContinuityAssessment(inspected: Inspection, ctx: ToolContext, input: LegacyAssessmentInput): Inspection {
  if ((input.reassessmentProtocol === 3 || input.reassessmentProtocol === 4 || input.reassessmentProtocol === 5) !== (inspected.audit.responseContract === 3)) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '响应审计版本与原预约不一致。')
  return { ...inspected, audit: { ...inspected.audit, assessmentRequest: { version: 1, key: assessmentKey(ctx, input), inputHash: runtimeJson(input).hash } } as Inspection['audit'] }
}

export async function readReusableLegacyContinuityAssessment(tx: Prisma.TransactionClient, ctx: ToolContext, input: LegacyAssessmentInput) {
  const task = await readOriginalTaskRequest(tx, ctx), runIds = await originalTaskRunIds(tx, ctx, task)
  const reservations = await tx.agentArtifact.findMany({ where: { runId: { in: runIds }, artifactType: 'continuityReview',
    metadata: { path: ['assessmentChapterId'], equals: input.chapterId } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const exact = reservations.find(row => {
    const frozen = object(object(row.metadata)?.input)
    return frozen && runtimeJson(frozen).hash === runtimeJson(input).hash
  })
  // New rendered guidance cannot buy a second interpretation of this exact
  // settled report. Only this versioned projection has a content-only fallback;
  // ordinary reuse keeps its original whole-input equality rule.
  const compatible = reservations.find(row => row.runId === ctx.runId && sameEmptyOptionalProposalInput(object(row.metadata)?.input, input))
  const latest = exact ?? compatible
  const meta = object(latest?.metadata)
  if (!latest || typeof meta?.callId !== 'string') return null
  const source = { ...ctx, runId: latest.runId, callId: meta.callId }
  try {
    const frozen = exact ? input : meta.input as LegacyAssessmentInput
    if (!exact && meta.continuityAssessmentRequestKey !== assessmentKey(source, frozen)) return null
    const result = await readLegacyContinuityAssessment(tx, source, frozen)
    if (!result.billingKnown || !result.providerComplete || !result.inspected.complete) return null
    const projection = object((result.inspected.audit as Record<string, unknown>).formatProjection)
    if (!exact && (!result.recoveryReady || projection?.kind !== 'empty_optional_proposal_table' || projection.version !== 1
      || !validEmptyOptionalProposalProjection(result.inspected.audit, input.bodies.current, input.bodies.terminalEvidence))) return null
    if (projection?.kind === 'empty_optional_proposal_table' && compatible?.id !== latest.id) return null
    return bindLegacyContinuityAssessment(result.inspected, source, frozen)
  } catch { return null }
}

/** Independent observation transaction: it never checks current text or abort,
 * and never invents accounting. This survives any later application failure. */
export async function observeLegacyContinuityAssessment(tx: Prisma.TransactionClient, ctx: ToolContext, input: LegacyAssessmentInput,
  response: { content: string | null; finishReason: string | null; toolCalls: unknown[]; transportComplete?: false }, usageIds: string[], requestedStage: LegacyContinuityStage | 'primary') {
  const usage = usageIds.length ? await tx.aiUsageLog.findMany({ where: { id: { in: usageIds }, userId: ctx.userId, novelId: ctx.novelId,
    targetType: input.targetType, targetId: input.targetId, action: { startsWith: 'agent3ContinuityCritic' } } }) : []
  if (usage.length !== new Set(usageIds).size) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '检查观察缺少真实归属账目。')
  const stage = requestedStage === 'primary' ? legacyContinuityStageForAction(usage[0]?.action ?? '') : requestedStage
  if (!stage || usage.some(row => legacyContinuityStageForAction(row.action) !== stage)
    || response.content !== null && usage.filter(row => !isKnownRejectedTextRequestAttempt(row)).length !== 1) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '检查阶段与真实请求或响应归属不一致。')
  }
  const key = runtimeJson({ assessmentKey: assessmentKey(ctx, input), stage, usageIds: [...usageIds].sort() }).hash
  const prior = await tx.agentArtifact.findFirst({ where: { runId: ctx.runId, artifactType: 'continuityReview', metadata: { path: ['assessmentResponseKey'], equals: key } } })
  const frozenResponse = { content: response.content === null ? null : JSON.stringify(response.content), encoding: 'json-string',
    finishReason: response.finishReason, toolCalls: response.toolCalls, transportComplete: response.transportComplete !== false }
  if (prior) {
    if (runtimeJson({ input, response: frozenResponse }).hash !== runtimeJson({ input: object(prior.metadata)?.input, response: object(prior.metadata)?.response }).hash) {
      throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '已保存的真实检查响应不能替换。')
    }
    return prior.id
  }
  const inspected = response.content === null ? null : inspectContinuityResponse(response.content, input.bodies, response.transportComplete !== false && response.finishReason === 'stop' && !response.toolCalls.length, input.parserVersion ?? 6, input.terminalCandidate, input.sourceScope, input.reassessmentProtocol === 3 || input.reassessmentProtocol === 4 || input.reassessmentProtocol === 5 ? { responseContract: 3 } : {})
  const row = await tx.agentArtifact.create({ data: { runId: ctx.runId, artifactType: 'continuityReview', title: '连续性检查响应审计', content: '实际检查响应与冻结输入已保存；报告是否可用另行验证。',
    metadata: runtimeJson({ version: 1, assessmentResponseKey: key, assessmentKey: assessmentKey(ctx, input), callId: ctx.callId, stage,
      input, usageIds: usage.map(row => row.id), response: frozenResponse, audit: inspected?.audit ?? null }).value } })
  return row.id
}

export async function claimLegacyContinuityReassessment(tx: Prisma.TransactionClient, ctx: ToolContext, input: LegacyAssessmentInput,
  original: Inspection, usageIds: string[], request: { system: string; content: string }, assertCurrent: (tx: Prisma.TransactionClient) => Promise<void>) {
  ctx.signal.throwIfAborted(); await lockNovelActiveScope(tx, ctx.novelId); await assertAgentManuscriptCurrent(tx, ctx); await assertCurrent(tx)
  const usage = await tx.aiUsageLog.findMany({ where: { id: { in: usageIds }, userId: ctx.userId, novelId: ctx.novelId,
    targetType: input.targetType, targetId: input.targetId, action: { startsWith: 'agent3ContinuityCritic' } } })
  const semantic = usage.filter(row => !isKnownRejectedTextRequestAttempt(row))
  if (usage.length !== new Set(usageIds).size || semantic.length !== 1 || usage.some(row => !knownAssessmentBilling(row)
    || row.action !== 'agent3ContinuityCritic')) return false
  const key = assessmentKey(ctx, input)
  const first = await tx.agentArtifact.findMany({ where: { runId: ctx.runId, artifactType: 'continuityReview', AND: [
    { metadata: { path: ['assessmentKey'], equals: key } }, { metadata: { path: ['stage'], equals: 'first' } }] } })
  const received = first.filter(row => typeof object(object(row.metadata)?.response)?.content === 'string')
  const observedIds = [...new Set(first.flatMap(row => { const ids = object(row.metadata)?.usageIds; return Array.isArray(ids) ? ids : [] }))]
  if (received.length !== 1 || object(object(received[0].metadata)?.audit)?.contentHash !== original.audit.contentHash
    || runtimeJson([...observedIds].sort()).hash !== runtimeJson([...usageIds].sort()).hash) return false
  if (await tx.agentArtifact.findFirst({ where: { runId: ctx.runId, artifactType: 'continuityReview', metadata: { path: ['fullReassessmentKey'], equals: key } } })) return false
  await tx.agentArtifact.create({ data: { runId: ctx.runId, artifactType: 'continuityReview', title: '连续性复评请求审计', content: '本次原工具的一次完整复评已预约；不改写正文，不重复派发。',
    metadata: runtimeJson({ version: 1, fullReassessmentKey: key, callId: ctx.callId, input, original: original.audit, request, usageIds }).value } })
  return true
}

/** The caller has positively observed that its dispatch function was never
 * entered. Missing observations, provider throws and process crashes cannot use this path. */
export async function observeLegacyContinuityReassessmentNotDispatched(tx: Prisma.TransactionClient, ctx: ToolContext, input: LegacyAssessmentInput, usageIds: string[] = []) {
  await lockNovelActiveScope(tx, ctx.novelId)
  const key = assessmentKey(ctx, input)
  const claim = await tx.agentArtifact.findFirst({ where: { runId: ctx.runId, run: { userId: ctx.userId, novelId: ctx.novelId }, artifactType: 'continuityReview',
    metadata: { path: ['fullReassessmentKey'], equals: key } } })
  const links = await tx.agentArtifact.findMany({ where: { runId: ctx.runId, artifactType: 'continuityReview', AND: [
    { metadata: { path: ['assessmentRequestOwnerKey'], equals: key } }, { metadata: { path: ['stage'], equals: 'reassessment' } }] } })
  const linkedIds = links.flatMap(row => { const ids = object(row.metadata)?.usageIds; return Array.isArray(ids) ? ids as string[] : [] })
  const usage = usageIds.length ? await tx.aiUsageLog.findMany({ where: { id: { in: usageIds }, userId: ctx.userId, novelId: ctx.novelId, agentRunId: ctx.runId,
    targetType: input.targetType, targetId: input.targetId, action: 'agent3ContinuityCriticSecondPass' } }) : []
  if (!claim || linkedIds.some(id => !usageIds.includes(id)) || usage.length !== new Set(usageIds).size
    || usage.some(row => !isKnownTextRequestBilling(row) || row.billingStatus !== 'not_dispatched')) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '未派发观察与真实请求账目不一致。')
  // A stale-input guard can roll back its before-send ownership transaction.
  // The live request trace still proves these exact zero-spend IDs; preserve
  // their ownership without re-running that now-stale application guard.
  for (const usageId of usageIds.filter(id => !linkedIds.includes(id))) {
    await tx.agentArtifact.create({ data: { runId: ctx.runId, artifactType: 'continuityReview', title: '连续性未派发请求归属审计', content: '真实请求在发送前结束，保留其确切账目归属。',
      metadata: runtimeJson({ version: 1, assessmentRequestBindingKey: runtimeJson({ key, usageId }).hash, assessmentRequestOwnerKey: key,
        stage: 'reassessment', callId: ctx.callId, usageIds: [usageId], notDispatched: true }).value } })
  }
  if (!await tx.agentArtifact.findFirst({ where: { runId: ctx.runId, artifactType: 'continuityReview', metadata: { path: ['fullReassessmentNotDispatchedKey'], equals: key } } })) {
    await tx.agentArtifact.create({ data: { runId: ctx.runId, artifactType: 'continuityReview', title: '连续性复评未派发审计', content: '本实例在进入供应商请求前观察到取消或输入变化；未再次派发。',
      metadata: runtimeJson({ version: 1, fullReassessmentNotDispatchedKey: key, claimId: claim.id, callId: ctx.callId, usageIds, outcome: 'guard_failed_before_dispatch' }).value } })
  }
}

export async function bindLegacyContinuityRequest(tx: Prisma.TransactionClient, ctx: ToolContext, input: LegacyAssessmentInput,
  usageId: string, requestedStage: LegacyContinuityStage | 'primary', assertCurrent: (tx: Prisma.TransactionClient) => Promise<void>) {
  await lockNovelActiveScope(tx, ctx.novelId)
  await assertCurrent(tx)
  const usage = await tx.aiUsageLog.findFirst({ where: { id: usageId, userId: ctx.userId, novelId: ctx.novelId, agentRunId: ctx.runId,
    targetType: input.targetType, targetId: input.targetId, action: { startsWith: 'agent3ContinuityCritic' } } })
  const stage = usage ? legacyContinuityStageForAction(usage.action) : null
  if (!usage || !stage || (requestedStage === 'primary' ? stage === 'reassessment' : requestedStage !== stage)) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '检查账目不能绑定此真实请求。')
  const key = assessmentKey(ctx, input), binding = runtimeJson({ key, usageId }).hash
  const existing = await tx.agentArtifact.findFirst({ where: { runId: ctx.runId, artifactType: 'continuityReview', metadata: { path: ['assessmentRequestBindingKey'], equals: binding } } })
  if (existing) {
    if (object(existing.metadata)?.stage !== stage) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '已绑定检查阶段不能替换。')
    return stage
  }
  const links = await tx.agentArtifact.findMany({ where: { runId: ctx.runId, artifactType: 'continuityReview', AND: [
    { metadata: { path: ['assessmentRequestOwnerKey'], equals: key } }, { metadata: { path: ['stage'], equals: stage } }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const priorIds = [...new Set(links.flatMap(row => { const ids = object(row.metadata)?.usageIds; return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id !== usageId) : [] }))]
  if (priorIds.length) {
    const prior = await tx.aiUsageLog.findMany({ where: { id: { in: priorIds }, userId: ctx.userId, novelId: ctx.novelId,
      agentRunId: ctx.runId, targetType: input.targetType, targetId: input.targetId, action: usage.action } })
    if (prior.length !== priorIds.length || priorIds.length > 1 || prior.some(row => !isKnownRejectedTextRequestAttempt(row))) {
      throw new DataAccessError(409, 'RUNTIME_RECONCILIATION_REQUIRED', '同一检查阶段的原请求尚未确认零费用拒绝，未再次派发。')
    }
  }
  if (!await tx.agentArtifact.findFirst({ where: { runId: ctx.runId, artifactType: 'continuityReview', metadata: { path: ['assessmentRequestBindingKey'], equals: binding } } })) {
    await tx.agentArtifact.create({ data: { runId: ctx.runId, artifactType: 'continuityReview', title: '连续性请求归属审计', content: '供应商派发前已绑定本工具的真实请求账目。',
      metadata: runtimeJson({ version: 1, assessmentRequestBindingKey: binding, assessmentRequestOwnerKey: key, stage, usageIds: [usageId], callId: ctx.callId }).value } })
  }
  return stage
}

/** Called only after this live invocation positively observed no entry into
 * provider dispatch. A crash has no such receipt. */
export async function observeLegacyContinuityFirstNotDispatched(tx: Prisma.TransactionClient, ctx: ToolContext, input: LegacyAssessmentInput, usageIds: string[]) {
  await lockNovelActiveScope(tx, ctx.novelId)
  const key = assessmentKey(ctx, input)
  const usage = usageIds.length ? await tx.aiUsageLog.findMany({ where: { id: { in: usageIds }, userId: ctx.userId, novelId: ctx.novelId, agentRunId: ctx.runId } }) : []
  if (usage.length !== new Set(usageIds).size || usage.some(row => !isKnownTextRequestBilling(row) || row.billingStatus !== 'not_dispatched')) {
    throw new DataAccessError(409, 'RUNTIME_RECONCILIATION_REQUIRED', '原请求派发状态尚未确认，不能观察为未派发。')
  }
  if (!await tx.agentArtifact.findFirst({ where: { runId: ctx.runId, artifactType: 'continuityReview', metadata: { path: ['firstAssessmentNotDispatchedKey'], equals: key } } })) {
    await tx.agentArtifact.create({ data: { runId: ctx.runId, artifactType: 'continuityReview', title: '连续性检查未派发审计', content: '本实例确认在供应商派发前结束；原预约和真实账目保留。',
      metadata: runtimeJson({ version: 1, firstAssessmentNotDispatchedKey: key, callId: ctx.callId, usageIds, outcome: 'guard_failed_before_dispatch' }).value } })
  }
}
