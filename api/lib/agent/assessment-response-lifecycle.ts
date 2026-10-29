import { continuitySparseRepairRequest, applyContinuitySparseRepair, continuitySparseRepairDiagnostics } from './continuity-response-repair.js'
import { recoverExplicitSourceEvidence, sameExplicitSourceInput, validateStoredExplicitSourceProjection } from './continuity-explicit-source-projection.js'
import { recoverEmptyOptionalProposalTable, sameEmptyOptionalProposalInput, validEmptyOptionalProposalProjection } from './continuity-empty-proposal-projection.js'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { runtimeJson } from './runtime-common.js'
import { normalizeContinuityV4Projection, normalizeContinuityV4ProjectionV2, bindNormalizedContinuityV4Projection } from './continuity-review-v4.js'
import { isKnownTextRequestBilling, isKnownRejectedTextRequestAttempt } from './text-request-billing.js'
import { inspectContinuityResponse, continuityCandidateSchema } from './continuity-format-recovery.js'
import { continuitySourceCatalog, continuitySourceInput, type ContinuityBodies } from './continuity-review-context.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import type { ToolContext } from './tools/types.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { terminalCandidateSchema, terminalResponseFields, type TerminalCandidate } from './terminal-state-review.js'
import { terminalEvidenceContextSchema, type TerminalEvidenceContext } from './terminal-evidence-context.js'
import { continuitySourceScopeSchema, type ContinuitySourceScope } from './continuity-source-authority.js'
import { terminalAddressResponseFields } from './terminal-review-addresses.js'
import { continuityResponseContract, continuityResponseSystem, continuityResponseInput, fixedContinuityResponseFields, assertFixedContinuityResponseFields, continuityReassessmentDiagnostics, continuityReassessmentEnvelope, decisionSchema, continuityReassessmentCandidates } from './continuity-response-contract.js'
import { inspectAuthenticatedContinuityAssessment, isContinuityV4Inspection, assertLegacyContinuityInspection, type AuthenticatedContinuityInspection, type LegacyContinuityInspection } from './authenticated-continuity-assessment.js'
import { continuityReviewManifestSchema, continuityV4RepairRequest, applyContinuityV4Repair, failedContinuityV4Repair,
  type ContinuityReviewManifest } from './continuity-review-v4.js'
import { sameContinuitySubject } from './continuity-subject-identity.js'
import { readContinuityPhaseClaim, assertContinuityAssessmentSubject, continuityAssessmentPhase } from './continuity-coordinator.js'

type Inspection = AuthenticatedContinuityInspection
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const json = (raw: string) => ({ version: 1, encoding: 'json-string', content: JSON.stringify(raw), complete: true })
export type LegacyContinuityStage = 'first' | 'output_recovery' | 'reassessment'
export function legacyContinuityStageForAction(action: string): LegacyContinuityStage | null {
  return action === 'agent3ContinuityCritic' ? 'first' : action === 'agent3ContinuityCriticSecondPass' ? 'reassessment'
    : ['agent3ContinuityCriticOutputRecovery', 'agent3ContinuityCriticEmptyRecovery'].includes(action) ? 'output_recovery' : null
}
const assessmentContractMatches = (input: Record<string, unknown> | LegacyAssessmentInput | null, audit: Record<string, unknown> | null | Inspection['audit']) =>
  input?.parserVersion === 10 ? input.reassessmentProtocol === 7 && audit?.parserVersion === 10 && audit.responseContract === 5
    : input?.parserVersion === 9 ? input.reassessmentProtocol === 6 && audit?.parserVersion === 9 && audit.responseContract === 4
    : audit?.parserVersion !== 9 && audit?.parserVersion !== 10 && (input?.reassessmentProtocol === 3 || input?.reassessmentProtocol === 4 || input?.reassessmentProtocol === 5) === (audit?.responseContract === 3)
const knownAssessmentBilling = (row: Parameters<typeof isKnownRejectedTextRequestAttempt>[0]) =>
  isKnownRejectedTextRequestAttempt(row) || row.usageSource === 'reported' && isKnownTextRequestBilling(row)

/** Indices come only from a complete parsed provider array, including invalid
 * fields. An unparseable response has no reconstructed candidate identities. */
export { continuityReassessmentCandidates } from './continuity-response-contract.js'

export const continuityReassessmentRule = `本次是同一完整输入的一次完整复评，不改写正文。原回复只是待核数据，不能保持无依据的判断，也不能默默删除意见。
原候选能解析时，为每个原 index 恰好给一项 decisions：action 为 confirm、retract 或 replace，reason 说明核实原因，sourceEvidence 绑定本次真实原文。confirm 保持 signal/severity/evidence/suggestion 且 findingIndex 指向最终意见；replace 明确说明原判断为何不成立或需更正并指向替代意见；retract 说明撤回原因及原文依据，不给 findingIndex。原回复不能解析时 decisions 必须为空，不编造原意见编号。
完整复查全部输入，findings 是最终完整报告，可包含独立核实的新问题；每项继续遵守原 JSON 字段、真实引用、同一对象/时刻/维度及两处互斥证据规则。撤回候选不等于正文已改动。严格输出 {"decisions":[{"index":0,"action":"retract","reason":"原判断混淆先后事件，已核对实际原文。","sourceEvidence":[{"source":"current","segmentId":"c0"}]}],"findings":[]}。示例仅说明格式，不能照抄。`

export function continuityReassessmentRequest(system: string, input: string, original: Inspection, bodies: ContinuityBodies, legacyDiagnostics = false, reassessmentProtocol?: 2 | 3 | 4 | 5 | 6 | 7): { system: string; content: string } {
  if (reassessmentProtocol === 6 || reassessmentProtocol === 7) {
    if (!isContinuityV4Inspection(original)) throw Error('Frozen v4 repair lacks its original manifest')
    const request = continuityV4RepairRequest(original)
    if (!request) throw Error('No unambiguous invalid continuity rows remain')
    return request
  }
  assertLegacyContinuityInspection(original)
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

export function applyContinuityReassessment(original: Inspection, raw: string, bodies: ContinuityBodies, reassessmentProtocol?: 2 | 3 | 4 | 5 | 6 | 7): Inspection {
  if (reassessmentProtocol === 6 || reassessmentProtocol === 7) {
    if (!isContinuityV4Inspection(original)) throw Error('Continuity v4 repair cannot reinterpret a legacy response')
    return applyContinuityV4Repair(original, raw, true)
  }
  assertLegacyContinuityInspection(original)
  if (reassessmentProtocol === 4 || reassessmentProtocol === 5) {
    const repaired = applyContinuitySparseRepair(original, raw, bodies, reassessmentProtocol === 5 ? 2 : 1)
    if (!repaired) return applyContinuityReassessment(original, raw, bodies, 3)
    const result = inspectContinuityResponse(repaired.raw, bodies, true, 8, original.audit.terminalCandidate, original.audit.sourceScope, { responseContract: 3 })
    if (!result.complete) throw new Error('Sparse repair did not produce a valid full independent report')
    return { ...result, audit: { ...result.audit, responseProjection: repaired.projection, reassessment: { version: 1, kind: 'sparse_table_repair', original: original.audit,
      rawResponse: json(raw), frozenBodies: bodies, projection: repaired.projection } } as LegacyContinuityInspection['audit'] }
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
        fixedFields: Object.keys(fixed), fixedHash: runtimeJson(fixed).hash, rawResponse: json(raw) } } as LegacyContinuityInspection['audit'] }
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
  } } as LegacyContinuityInspection['audit'] }
}

export function failedContinuityReassessment(original: Inspection, raw: string, complete: boolean, bodies: ContinuityBodies, protocol?: 2 | 3 | 4 | 5 | 6 | 7): Inspection {
  if (isContinuityV4Inspection(original)) return failedContinuityV4Repair(original, raw, complete)
  const sparseDiagnostics = (protocol === 4 || protocol === 5) && complete ? continuitySparseRepairDiagnostics(original, raw, bodies, protocol === 5 ? 2 : 1) : null
  return { ...original, audit: { ...original.audit, reassessment: { version: 1,
    ...(sparseDiagnostics ? { kind: 'sparse_table_repair_failed', protocol } : {}),
    classification: complete ? 'invalid' : 'response_incomplete', rawResponse: { ...json(raw), complete },
    ...((protocol === 3 || protocol === 4 || protocol === 5) && complete ? { diagnostics: sparseDiagnostics ?? continuityReassessmentDiagnostics(original, raw, bodies) } : {}) } } as LegacyContinuityInspection['audit'] }
}

export type LegacyAssessmentInput = { chapterId: string; revision: number; bodies: ContinuityBodies; system: string; content: string; terminalCandidate?: TerminalCandidate; reassessmentProtocol?: 2 | 3 | 4 | 5 | 6 | 7;
  parserVersion?: 7 | 8 | 9 | 10; continuityManifest?: ContinuityReviewManifest; sourceScope?: ContinuitySourceScope; bindingHash?: string; targetType: 'chapter' | 'story_compilation'; targetId: string }
export type FrozenTerminalContract = Pick<TerminalEvidenceContext, 'verdictProtocol' | 'spanAddressProtocol' | 'proposalChanges'> & { coverageVersion: 1 | 2 }
export const legacyContinuityAssessmentKey = (ctx: Pick<ToolContext, 'runId' | 'callId'>, input: LegacyAssessmentInput) => runtimeJson({ runId: ctx.runId, callId: ctx.callId,
  input: { chapterId: input.chapterId, revision: input.revision, bodies: input.bodies, system: input.system, content: input.content, bindingHash: input.bindingHash ?? null,
    ...(input.parserVersion ? { parserVersion: input.parserVersion, sourceScope: input.sourceScope } : {}),
    ...(input.reassessmentProtocol ? { reassessmentProtocol: input.reassessmentProtocol } : {}),
    ...((input.parserVersion === 9 || input.parserVersion === 10) ? { continuityManifest: input.continuityManifest } : {}) } }).hash
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
    system: z.string(), content: z.string(), reassessmentProtocol: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)]).optional(), parserVersion: z.union([z.literal(7), z.literal(8), z.literal(9), z.literal(10)]).optional(),
    sourceScope: continuitySourceScopeSchema.optional(), continuityManifest: continuityReviewManifestSchema.optional(), terminalCandidate: terminalCandidateSchema.optional(), bindingHash: z.string().optional(),
    targetType: z.enum(['chapter', 'story_compilation']), targetId: z.string() }).strict().safeParse(meta.input)
  if (!parsed.success || (parsed.data.reassessmentProtocol === 3 || parsed.data.reassessmentProtocol === 4 || parsed.data.reassessmentProtocol === 5) && (parsed.data.parserVersion !== 8 || parsed.data.bodies.terminalEvidence?.verdictProtocol !== 6 || !parsed.data.terminalCandidate)
    || (parsed.data.parserVersion === 9 || parsed.data.parserVersion === 10) && (parsed.data.reassessmentProtocol !== (parsed.data.parserVersion === 10 ? 7 : 6) || !parsed.data.continuityManifest
      || !parsed.data.terminalCandidate && !(parsed.data.parserVersion === 10 && parsed.data.continuityManifest.candidateHash === null) || parsed.data.targetType !== 'story_compilation')
    || parsed.data.parserVersion !== 9 && parsed.data.parserVersion !== 10 && (parsed.data.reassessmentProtocol === 6 || parsed.data.reassessmentProtocol === 7 || parsed.data.continuityManifest !== undefined)
    || parsed.data.parserVersion && !parsed.data.sourceScope
    || meta.continuityAssessmentRequestKey !== assessmentKey(ctx, parsed.data)) throw invalid()
  const identity = (input: LegacyAssessmentInput) => {
    const copy = structuredClone(input)
    if (copy.bodies.terminalEvidence?.factCoverage) copy.bodies.terminalEvidence.factCoverage.version = 1
    return { chapterId: copy.chapterId, revision: copy.revision, bodies: copy.bodies, targetType: copy.targetType, targetId: copy.targetId,
      terminalCandidate: copy.terminalCandidate ?? null, bindingHash: copy.bindingHash ?? null, parserVersion: (parsed.data.parserVersion === 9 || parsed.data.parserVersion === 10) ? null : copy.parserVersion ?? null, sourceScope: copy.sourceScope ?? null }
  }
  const expected = recoverBodies ? { ...proposed, bodies: recoverBodies({ coverageVersion: parsed.data.bodies.terminalEvidence?.factCoverage?.version ?? 1,
    ...(parsed.data.bodies.terminalEvidence?.proposalChanges ? { proposalChanges: parsed.data.bodies.terminalEvidence.proposalChanges } : {}),
    ...(parsed.data.bodies.terminalEvidence?.spanAddressProtocol ? { spanAddressProtocol: parsed.data.bodies.terminalEvidence.spanAddressProtocol } : {}),
    ...(parsed.data.bodies.terminalEvidence?.verdictProtocol ? { verdictProtocol: parsed.data.bodies.terminalEvidence.verdictProtocol } : {}) }) } : proposed
  if (runtimeJson(identity(parsed.data)).hash !== runtimeJson(identity(expected)).hash) throw invalid()
  return parsed.data
}

export async function readLegacyContinuityAssessment(tx: Prisma.TransactionClient, ctx: ToolContext, input: LegacyAssessmentInput) {
  if (input.parserVersion === 9 || input.parserVersion === 10) {
    // jsonb reorders object keys; restore the producer's schema order before
    // rebuilding the exact repair request, without changing its frozen values.
    const parsed = legacyAssessmentInputSchema.safeParse(input)
    if (!parsed.success || runtimeJson(parsed.data).hash !== runtimeJson(input).hash)
      throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原完整检查冻结输入不能等价重建。')
    input = parsed.data
  }
  if (input.parserVersion === 10) {
    const plan = input.continuityManifest?.typedLineage?.phasePlan
    const phase = continuityAssessmentPhase(input)
    if (!plan || (phase === null ? await assertContinuityAssessmentSubject(tx, ctx, input) !== null
      : !await readContinuityPhaseClaim(tx, ctx, { plan, chapterId: input.chapterId, phase,
        operationRef: assessmentKey(ctx, input), inputHash: runtimeJson(input).hash })))
      throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '新完整报告缺少认证原任务阶段，未解释为成功。')
  }
  if ((input.parserVersion === 9 || input.parserVersion === 10)) {
    const manifest = input.continuityManifest, coverageTaskId = input.bodies.terminalEvidence?.factCoverage?.taskId
    if (!manifest || manifest.subject.userId !== ctx.userId || manifest.subject.novelId !== ctx.novelId
      || coverageTaskId !== undefined && manifest.subject.taskId !== coverageTaskId || manifest.subject.targetId !== input.targetId || manifest.subject.chapterId !== input.chapterId
      || manifest.subject.revision !== input.revision || input.targetType !== 'story_compilation')
      throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '四投影冻结材料不属于原作者任务和目标。')
  }
  const key = assessmentKey(ctx, input)
  const observations = await tx.agentArtifact.findMany({ where: { runId: ctx.runId, artifactType: 'continuityReview',
    metadata: { path: ['assessmentKey'], equals: key } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const frames = observations.map(row => object(row.metadata)!)
  if (frames.some(frame => {
    const audit = object(frame.audit), response = object(frame.response)
    if ((input.parserVersion === 9 || input.parserVersion === 10)) return !object(frame.input) || runtimeJson(frame.input).hash !== runtimeJson(input).hash
      || typeof response?.content === 'string' && !assessmentContractMatches(input, audit)
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
  const original = inspectAuthenticatedContinuityAssessment(JSON.parse(response.content) as string, input, response.transportComplete === true && response.finishReason === 'stop'
    && Array.isArray(response.toolCalls) && !response.toolCalls.length)
  if ((input.parserVersion === 9 || input.parserVersion === 10) && (!object(first.audit) || runtimeJson(original.audit).hash !== runtimeJson(first.audit).hash))
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原首份响应与冻结投影审计不一致。')
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
      catch { if (input.reassessmentProtocol === 3 || input.reassessmentProtocol === 4 || input.reassessmentProtocol === 5 || input.reassessmentProtocol === 6 || input.reassessmentProtocol === 7) inspected = failedContinuityReassessment(original, JSON.parse(secondResponse.content) as string, true, input.bodies, input.reassessmentProtocol) }
    }
  }
  const claimed = await tx.agentArtifact.findFirst({ where: { runId: ctx.runId, artifactType: 'continuityReview', metadata: { path: ['fullReassessmentKey'], equals: key } } })
  if ((input.parserVersion === 9 || input.parserVersion === 10) && (secondApplied || known && isContinuityV4Inspection(inspected) && inspected.audit.continuityV4.failedRepair)) {
    const observed = inspectAuthenticatedContinuityAssessment(JSON.parse(secondResponse!.content as string) as string, input, true)
    const meta = object(claimed?.metadata)
    const authenticSecond = second && object(second.audit) && runtimeJson(observed.audit).hash === runtimeJson(second.audit).hash
      && meta && runtimeJson(meta.input).hash === runtimeJson(input).hash && runtimeJson(meta.original).hash === runtimeJson(original.audit).hash
      && runtimeJson(meta.request).hash === runtimeJson(continuityReassessmentRequest(input.system, input.content, original, input.bodies, false, input.reassessmentProtocol)).hash
    if (secondApplied && !authenticSecond) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原局部修复与唯一请求槽、实际响应不一致。')
    if (known && authenticSecond && isContinuityV4Inspection(inspected) && !inspected.complete) {
      inspected = normalizeContinuityV4Projection(inspected, runtimeJson(input).hash)
      secondApplied = inspected.complete
    }
  }
  const completeFrame = (frame: Record<string, unknown> | null) => frame?.transportComplete === true && frame.finishReason === 'stop'
    && typeof frame.content === 'string' && Array.isArray(frame.toolCalls) && !frame.toolCalls.length
  if (!isContinuityV4Inspection(original) && !inspected.complete && known && completeFrame(response) && object(first.audit) && runtimeJson(original.audit).hash === runtimeJson(first.audit).hash
    && (claimed ? (input.reassessmentProtocol === 3 || input.reassessmentProtocol === 4 || input.reassessmentProtocol === 5)
      && completeFrame(secondResponse) && second && (() => {
      const meta = object(claimed.metadata)
      const observed = inspectContinuityResponse(JSON.parse(secondResponse!.content as string) as string, input.bodies, true,
        (input.parserVersion === 9 || input.parserVersion === 10) ? 8 : input.parserVersion ?? 6, input.terminalCandidate, input.sourceScope, { responseContract: 3 })
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
  // A current body report is separate from certification of an unapplied old
  // accusation. Keep the full paid final response and its failed retract proof
  // in versioned lineage; never use it to discharge a certified obligation.
  if (!isContinuityV4Inspection(original) && !inspected.complete && known && (input.parserVersion === 7 || input.parserVersion === 8)
    && (input.parserVersion === 8 && input.reassessmentProtocol === 2 || input.parserVersion === 7 && input.reassessmentProtocol === undefined)
    && !input.terminalCandidate && completeFrame(response)
    && object(first.audit) && runtimeJson(original.audit).hash === runtimeJson(first.audit).hash) {
    const originalTask = await readOriginalTaskRequest(tx, ctx), applicationRuns = await originalTaskRunIds(tx, ctx, originalTask)
    const applications = await tx.agentArtifact.findMany({ where: { runId: { in: applicationRuns }, artifactType: 'continuityReview',
      metadata: { path: ['assessmentApplicationKey'], equals: key } } })
    const reservations = await tx.agentArtifact.findMany({ where: { runId: ctx.runId, artifactType: 'continuityReview',
      metadata: { path: ['continuityAssessmentRequestKey'], equals: key } } })
    const reservation = reservations.length === 1 ? reservations[0] : null
    const boundReservation = reservation && object(reservation.metadata)?.callId === ctx.callId
      && runtimeJson(object(reservation.metadata)?.input).hash === runtimeJson(input).hash
    const secondBound = claimed ? input.parserVersion === 8 && input.reassessmentProtocol === 2 && completeFrame(secondResponse) && second && (() => {
      const meta = object(claimed.metadata)
      const observed = inspectAuthenticatedContinuityAssessment(JSON.parse(secondResponse!.content as string) as string, input, true)
      return meta && object(second.audit) && runtimeJson(observed.audit).hash === runtimeJson(second.audit).hash
        && runtimeJson(meta.input).hash === runtimeJson(input).hash && runtimeJson(meta.original).hash === runtimeJson(original.audit).hash
        && runtimeJson(meta.request).hash === runtimeJson(continuityReassessmentRequest(input.system, input.content, original, legacyAssessmentInputSchema.parse(input).bodies, false, 2)).hash
    })() : secondFrames.length === 0
    if (boundReservation && secondBound) {
      const projected = recoverExplicitSourceEvidence(original, input.bodies, claimed && second ? { audit: second.audit, protocol: 2 } : undefined)
      if (projected && applications.every(applied => object(applied.metadata)?.sourceProjectionHash
        === runtimeJson((projected.audit as Record<string, unknown>).sourceProjection).hash
        && object(applied.metadata)?.reservationId === reservation!.id)) {
        inspected = projected; secondApplied = !!claimed
      }
    }
  }
  // A newly interpretable primary cannot erase an already claimed second
  // request or its unknown fees. Require the actual complete final report.
  if (original.complete && claimed && !secondApplied || inspected.complete && !known) {
    throw new DataAccessError(409, 'CONTINUITY_REPORT_INCOMPLETE', '原复核仍有未确认请求、用量或无效终态报告；保留原始记录，未复用或重发。')
  }
  const recoveryReady = known && completeFrame(response) && (!claimed || completeFrame(secondResponse))
    && usage.filter(row => !isKnownRejectedTextRequestAttempt(row)).every(row => frames.some(frame =>
      Array.isArray(frame.usageIds) && frame.usageIds.includes(row.id) && completeFrame(object(frame.response))))
  if (input.parserVersion === 10 && recoveryReady && isContinuityV4Inspection(inspected)
    && inspected.complete && !inspected.audit.continuityV4.projectionNormalization
    && inspected.terminalReview?.factCoverage?.dispositions.some(item => item.outcome === 'unknown')) {
    const applications = await tx.agentArtifact.findMany({ where: { runId: ctx.runId, artifactType: 'continuityReview',
      metadata: { path: ['assessmentApplicationKey'], equals: key } } })
    if (applications.length) {
      const expected = bindLegacyContinuityAssessment(inspected, ctx, input, 2)
      const normalization = isContinuityV4Inspection(expected) ? expected.audit.continuityV4.projectionNormalization : undefined
      const reservations = await tx.agentArtifact.findMany({ where: { runId: ctx.runId, artifactType: 'continuityReview',
        metadata: { path: ['continuityAssessmentRequestKey'], equals: key } } })
      const reservation = reservations.length === 1 ? reservations[0] : null
      if (normalization?.version === 2 && reservation && object(reservation.metadata)?.callId === ctx.callId
        && runtimeJson(object(reservation.metadata)?.input).hash === runtimeJson(input).hash
        && applications.some(row => {
          const meta = object(row.metadata)
          return meta?.reservationId === reservation.id && Array.isArray(meta.usageIds) && object(meta.projectionNormalization)?.version === 2
            && runtimeJson([...new Set(meta.usageIds)].sort()).hash === runtimeJson([...ids].sort()).hash
            && runtimeJson(meta.projectionNormalization).hash === runtimeJson(normalization).hash
        })) inspected = normalizeContinuityV4ProjectionV2(inspected, runtimeJson(input).hash)
    }
  }
  return { inspected, recoveryReady, usageIds: ids, billingKnown: known, providerComplete: response.transportComplete === true && response.finishReason === 'stop'
    && Array.isArray(response.toolCalls) && !response.toolCalls.length, slotUsed: primary.some(row => row.stage === 'output_recovery') || !!claimed }
}

export function bindLegacyContinuityAssessment(inspected: Inspection, ctx: ToolContext, input: LegacyAssessmentInput, normalize: boolean | 2 = false): Inspection {
  if (!assessmentContractMatches(input, inspected.audit)) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '响应审计版本与原预约不一致。')
  const assessmentRequest = { version: 1, key: assessmentKey(ctx, input), inputHash: runtimeJson(input).hash }
  if (isContinuityV4Inspection(inspected)) {
    const bound = bindNormalizedContinuityV4Projection(inspected, { assessmentRequest }, runtimeJson(input).hash)
    return normalize === 2 ? normalizeContinuityV4ProjectionV2(bound, runtimeJson(input).hash) : normalize ? normalizeContinuityV4Projection(bound, runtimeJson(input).hash) : bound
  }
  const audit = { ...inspected.audit, assessmentRequest }
  return { ...inspected, audit }
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
  const explicitCompatible = reservations.find(row => row.runId === ctx.runId && sameExplicitSourceInput(object(row.metadata)?.input, input))
  const crossWire = reservations.find(row => {
    const frozen = object(object(row.metadata)?.input)
    return frozen && ((frozen.parserVersion === 9 || frozen.parserVersion === 10) || (input.parserVersion === 9 || input.parserVersion === 10)) && sameContinuitySubject(frozen, input)
      && runtimeJson({ bodies: frozen.bodies, candidate: frozen.terminalCandidate ?? null, bindingHash: frozen.bindingHash ?? null }).hash
        === runtimeJson({ bodies: input.bodies, candidate: input.terminalCandidate ?? null, bindingHash: input.bindingHash ?? null }).hash
  })
  const latest = crossWire ?? exact ?? compatible ?? explicitCompatible
  const meta = object(latest?.metadata)
  if (!latest || typeof meta?.callId !== 'string') return null
  const source = { ...ctx, runId: latest.runId, callId: meta.callId }
  try {
    const frozen = exact && latest === exact ? input : meta.input as LegacyAssessmentInput
    if ((latest !== exact) && meta.continuityAssessmentRequestKey !== assessmentKey(source, frozen)) return null
    const result = await readLegacyContinuityAssessment(tx, source, frozen)
    if (!result.billingKnown || !result.providerComplete || !result.inspected.complete) return null
    const projection = object((result.inspected.audit as Record<string, unknown>).formatProjection)
    const explicit = object((result.inspected.audit as Record<string, unknown>).sourceProjection)
    const validExplicit = explicit?.kind === 'explicit_source_evidence' && !!validateStoredExplicitSourceProjection(result.inspected.audit,
      input.bodies.current, input.bodies.terminalEvidence)
    if (latest !== exact && latest !== crossWire && (!result.recoveryReady || !validExplicit && (projection?.kind !== 'empty_optional_proposal_table' || projection.version !== 1
      || !validEmptyOptionalProposalProjection(result.inspected.audit, input.bodies.current, input.bodies.terminalEvidence)))) return null
    if (explicit && (!validExplicit || latest !== exact && explicitCompatible?.id !== latest.id)) return null
    if (projection?.kind === 'empty_optional_proposal_table' && (latest !== crossWire && compatible?.id !== latest.id
      || !validEmptyOptionalProposalProjection(result.inspected.audit, input.bodies.current, input.bodies.terminalEvidence))) return null
    return bindLegacyContinuityAssessment(result.inspected, source, frozen)
  } catch { return null }
}

export const legacyAssessmentInputSchema = z.object({ chapterId: z.string(), revision: z.number().int(),
  bodies: z.object({ previous: z.string().nullable(), current: z.string(), terminalEvidence: terminalEvidenceContextSchema.optional() }).strict(),
  system: z.string(), content: z.string(), reassessmentProtocol: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)]).optional(),
  parserVersion: z.union([z.literal(7), z.literal(8), z.literal(9), z.literal(10)]).optional(), continuityManifest: continuityReviewManifestSchema.optional(),
  sourceScope: continuitySourceScopeSchema.optional(), terminalCandidate: terminalCandidateSchema.optional(), bindingHash: z.string().optional(),
  targetType: z.enum(['chapter', 'story_compilation']), targetId: z.string() }).strict()
