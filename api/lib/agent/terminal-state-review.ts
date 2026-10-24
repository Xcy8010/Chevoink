import { z } from 'zod'
import { createHash } from 'node:crypto'
import { terminalCandidateSchema, type TerminalCandidate } from './terminal-candidate-contract.js'
export { terminalCandidateSchema, type TerminalCandidate } from './terminal-candidate-contract.js'
import { continuitySourceSegments, locateUniqueContinuityQuote } from './continuity-review-context.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import { runtimeJson } from './runtime-common.js'
import { terminalEvidenceContextSchema, semanticCheckSchema, type TerminalCarriedFact, type TerminalEvidenceContext } from './terminal-evidence-context.js'
import { inspectTerminalCoverage, terminalCoverageGuidance, addressedTerminalDispositionSchema } from './terminal-fact-coverage.js'
import { terminalQuoteRange } from './terminal-quote-range.js'
import { terminalProofCatalog, readTerminalProofVerdicts, terminalProofVerdictSchema } from './terminal-proof-verdict.js'
import { terminalCandidateFacts, terminalFactId } from './terminal-fact-identity.js'
import { inspectTerminalProposalDispositions, readTerminalProposalInput, readTerminalProposalState, terminalProposalDispositionSchema, terminalProposalGuidance, type TerminalProposalChanges } from './terminal-proposal-review.js'
import { terminalVerdictSchema, inheritedTerminalVerdictSchema, sourcedTerminalVerdictSchema, terminalSpanVerdictSchema,
  terminalFactVerdictSchema, terminalJointFactVerdictSchema } from './terminal-review-shapes.js'
export { terminalVerdictSchema, inheritedTerminalVerdictSchema, sourcedTerminalVerdictSchema, terminalSpanVerdictSchema,
  terminalFactVerdictSchema, terminalJointFactVerdictSchema } from './terminal-review-shapes.js'
import { validContinuitySparseProjection } from './continuity-response-repair.js'
import { validEmptyOptionalProposalProjection } from './continuity-empty-proposal-projection.js'
import { bindTerminalCandidateAddresses, bindTerminalReviewAddresses, terminalReviewAddressInput, normalizeTerminalResponseRows } from './terminal-review-addresses.js'

/** Selection is a tool input only; saved candidates and paid audits retain their
 * original schema. A selected proof supplies identity, never a fresh verdict. */
export const terminalCandidateInputSchema = terminalCandidateSchema.extend({
  inheritedProofs: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(200).optional()
    .describe('从 chapter_bridge_get 的已验证事实目录中显式选择 proofHash；服务端还原原字段与原文事实，仍需独立判断本章未改变。不要改写旧事实或填写临时片段编号。'),
})
export type TerminalCandidateInput = z.infer<typeof terminalCandidateInputSchema>
const inheritedFieldSchema = z.enum(['knowledge', 'body', 'objects', 'relationships', 'openLoops'])

export function resolveTerminalCandidate(input: TerminalCandidateInput, carried: readonly TerminalCarriedFact[] | undefined, protocol?: 1 | 2):
  { ok: true; candidate: TerminalCandidate } | { ok: false; reason: string } {
  const { inheritedProofs, ...plain } = input
  const parsed = terminalCandidateSchema.safeParse(plain)
  if (!parsed.success) return { ok: false, reason: '终态候选格式无效；保留完整 exitState 与 lastUnfinishedAction 后重试。' }
  if (!inheritedProofs?.length) return { ok: true, candidate: parsed.data }
  if (protocol !== 2) return { ok: false, reason: '原任务未启用可继承事实证明；请使用原合同允许的正文候选，不升级旧任务协议。' }
  if (new Set(inheritedProofs).size !== inheritedProofs.length) return { ok: false, reason: 'inheritedProofs 包含重复 proofHash；每个证明只选择一次。' }
  const selected: Array<{ proofHash: string; field: z.infer<typeof inheritedFieldSchema>; claim: string }> = []
  for (const proofHash of inheritedProofs) {
    const matches = carried?.filter(fact => fact.proofHash === proofHash) ?? []
    const field = inheritedFieldSchema.safeParse(matches[0]?.field)
    if (matches.length !== 1 || !field.success || matches[0].depth >= 16) return { ok: false,
      reason: '所选 proofHash 已不可用、已过期或达到继承深度上限；请 chapter_bridge_get 读取当前目录后重新选择，不能猜测或删除未决事实绕过核验。' }
    selected.push({ proofHash, field: field.data, claim: matches[0].claim })
  }
  // Input ordering and transient tN addresses do not change the canonical set.
  // Typed claims remain intact, including conflicting or differently filed ones.
  for (const fact of selected.sort((a, b) => a.proofHash.localeCompare(b.proofHash))) {
    const values = parsed.data.exitState[fact.field]
    if (!values.includes(fact.claim)) values.push(fact.claim)
  }
  const candidate = terminalCandidateSchema.safeParse(parsed.data)
  return candidate.success ? { ok: true, candidate: candidate.data }
    : { ok: false, reason: '显式选择后的终态超出字段容量或事实长度上限；请核对候选与目录，不得静默截断或删除事实。' }
}

/** A proof-only tool call patches this original compilation's saved candidate;
 * it never makes the writer repeat all unrelated current claims. */
export function reviewTerminalSelection(explicit: TerminalCandidateInput | undefined, saved: TerminalCandidate | undefined, proofs?: string[]) {
  if (!explicit && proofs === undefined) return undefined
  const base = explicit ?? saved ?? terminalCandidateSchema.parse({ exitState: {} })
  return { ...base, ...(proofs !== undefined ? { inheritedProofs: [...(explicit?.inheritedProofs ?? []), ...proofs] } : {}) }
}
const inheritedVerdictResponseContract = JSON.stringify(z.toJSONSchema(z.array(inheritedTerminalVerdictSchema).max(200), { io: 'input' }))
const sourcedVerdictResponseContract = JSON.stringify(z.toJSONSchema(z.array(sourcedTerminalVerdictSchema.omit({ basis: true })).max(200), { io: 'input' }))
const spanVerdictResponseContract = JSON.stringify(z.toJSONSchema(z.array(terminalSpanVerdictSchema.omit({ basis: true })).max(200), { io: 'input' }))
const factVerdictResponseContract = JSON.stringify(z.toJSONSchema(z.array(terminalFactVerdictSchema).max(200), { io: 'input' }))
const jointFactVerdictResponseContract = JSON.stringify(z.toJSONSchema(z.array(terminalJointFactVerdictSchema).max(200), { io: 'input' }))

/** Shared fresh response shape; proof/decision semantics remain independently
 * checked after binding these mechanically addressed fields. */
export function terminalResponseFields(hasCandidate = true, version: 4 | 5 = 4, legalSegmentIds?: string[], proposalChanges?: TerminalProposalChanges) {
  // Use the request's frozen candidate. A body-only review has no terminal
  // claims; an explicit empty candidate still needs its exhaustive empty array.
  const keyed = semanticCheckSchema.omit({ kind: true }).extend({ kind: semanticCheckSchema.shape.kind.optional() }).strict()
  const addressed = legalSegmentIds ? terminalSpanVerdictSchema.extend({ sourceEvidence: z.array(
    terminalSpanVerdictSchema.shape.sourceEvidence.element.extend({ segmentId: legalSegmentIds.length
      ? z.enum(legalSegmentIds as [string, ...string[]]) : z.never() })).max(8) }) : null
  const scoped = addressed ? z.union([addressed.omit({ path: true }).extend({ factId: z.string().regex(/^[a-f0-9]{64}$/u),
    ...(version === 5 ? { path: addressed.shape.path.optional() } : {}) }).strict(), addressed]) : null
  const ordinary = z.array(scoped ?? (version === 5 ? terminalJointFactVerdictSchema : terminalFactVerdictSchema)).max(200)
  const proofs = z.array(terminalProofVerdictSchema).max(200)
  const dispositions = z.array(addressedTerminalDispositionSchema).max(200)
  return { semanticChecks: z.union([z.array(semanticCheckSchema).length(2), z.object({ action_direction: keyed, state_progression: keyed }).strict()]),
    terminalVerdicts: hasCandidate ? ordinary : ordinary.length(0).optional(),
    terminalProofVerdicts: (hasCandidate ? proofs : proofs.length(0)).optional(),
    terminalDispositions: (hasCandidate ? dispositions : dispositions.length(0)).optional(),
    ...(proposalChanges ? { proposalDispositions: z.array(terminalProposalDispositionSchema.extend({ id: z.enum(
      proposalChanges.proposals.map(item => item.id) as [string, ...string[]]) })).length(proposalChanges.proposals.length) } : {}) }
}

/** Source is encoded in server-owned addresses. This projection changes no
 * quote, verdict or attestation, and never upgrades a saved old contract. */
function readSourcedVerdicts(value: unknown, context: TerminalEvidenceContext, candidate?: TerminalCandidate, proofVerdicts?: unknown, content?: string) {
  if (context.verdictProtocol === undefined) return z.array(inheritedTerminalVerdictSchema).max(200).safeParse(value)
  let normalized = value
  if (context.verdictProtocol === 4 || context.verdictProtocol === 5) {
    const selected = z.array(context.verdictProtocol === 5 ? terminalJointFactVerdictSchema : terminalFactVerdictSchema).max(200).safeParse(value)
    if (!selected.success) return selected
    const facts = candidate ? terminalCandidateFacts(candidate) : []
    normalized = selected.data.map(item => {
      if (!('factId' in item)) return item
      const matches = facts.filter(fact => fact.id === item.factId)
      if (matches.length !== 1 || 'path' in item && item.path !== undefined && item.path !== matches[0].path) return null
      const { factId: _id, ...rest } = item
      return { ...rest, path: matches[0].path }
    })
  }
  const selections = context.verdictProtocol === 3 || context.verdictProtocol === 4 || context.verdictProtocol === 5 ? z.array(terminalSpanVerdictSchema).max(200).safeParse(normalized) : null
  if (selections && !selections.success) return selections
  // A fresh critic may select an existing server span rather than transcribe
  // its prose. Supplied quotes remain strict; no fuzzy or historical repair.
  const bound = selections?.success ? selections.data.map(item => ({ ...item, sourceEvidence: item.sourceEvidence.map(ref => ({ ...ref,
    quote: ref.quote ?? (ref.segmentId.startsWith('c') ? continuitySourceSegments({ previous: null, current: content ?? '' }) : context.previous?.segments ?? [])
      .find(part => part.segmentId === ref.segmentId)?.quote ?? '',
  })) })) : normalized
  const parsed = z.array(sourcedTerminalVerdictSchema).max(200).safeParse(bound)
  if (!parsed.success) return parsed
  const ordinary = parsed.data.map(item => ({ ...item,
    basis: !item.sourceEvidence.length ? undefined : item.sourceEvidence.some(ref => /^[pt]/u.test(ref.segmentId)) ? 'inherited' as const : 'current' as const }))
  if (context.verdictProtocol !== 3 && context.verdictProtocol !== 4 && context.verdictProtocol !== 5) return { success: true as const, data: ordinary }
  const proofs = candidate ? readTerminalProofVerdicts(proofVerdicts, candidate, context) : null
  if (!proofs || ordinary.some(item => proofs.verdicts.some(proof => proof.path === item.path))) return z.array(inheritedTerminalVerdictSchema).safeParse(undefined)
  return { success: true as const, data: [...ordinary, ...proofs.verdicts], proofChecks: proofs.checks,
    spanSelections: selections?.success ? selections.data.map(({ path, sourceEvidence }) => ({ path, sourceEvidence })) : [] }
}

export type TerminalQuoteAddressDiagnostic = { path: string; referenceIndex: number; originalSegmentId: string; actualSegmentId?: string;
  reason: 'relocated' | 'unknown_segment' | 'wrong_source' | 'quote_missing' | 'quote_ambiguous' | 'quote_not_in_single_segment' | 'carried_quote_mismatch' }
type TerminalQuoteRelocation = { verdictIndex: number; path: string; referenceIndex: number; source: 'previous' | 'current';
  originalSegmentId: string; actualSegmentId: string; quoteHash: string; range?: { start: number; end: number; segmentIds: string[] } }

function previousQuoteBlocks(previous: NonNullable<TerminalEvidenceContext['previous']>) {
  const blocks: Array<{ end: number; text: string }> = []
  for (const segment of [...previous.segments].sort((a, b) => a.start - b.start)) {
    if (segment.end - segment.start !== segment.quote.length || segment.start < previous.joinedStart || segment.end > previous.joinedEnd) return []
    const last = blocks.at(-1)
    if (last && segment.start < last.end) return []
    if (last?.end === segment.start) { last.text += segment.quote; last.end = segment.end }
    else blocks.push({ end: segment.end, text: segment.quote })
  }
  return blocks.map(block => block.text)
}

/** This only repairs addresses. The caller still verifies every reference and
 * the exhaustive semantic and inheritance judgments against the frozen scope. */
function canonicalTerminalQuoteAddresses(items: Array<Omit<z.infer<typeof inheritedTerminalVerdictSchema>, 'basis'> & { basis?: 'current' | 'inherited' }>, content: string, context: TerminalEvidenceContext) {
  const current = continuitySourceSegments({ previous: null, current: content })
  const previous = context.previous?.segments ?? [], previousBlocks = context.previous ? previousQuoteBlocks(context.previous) : []
  const diagnostics: TerminalQuoteAddressDiagnostic[] = [], relocations: TerminalQuoteRelocation[] = []
  const originalRefs = items.map((item, verdictIndex) => ({ verdictIndex, path: item.path, sourceEvidence: item.sourceEvidence }))
  const canonical = items.map((item, verdictIndex) => ({ ...item, sourceEvidence: item.sourceEvidence.map((ref, referenceIndex) => {
    const address = { path: item.path, referenceIndex, originalSegmentId: ref.segmentId }
    if (context.verdictProtocol !== 5 && (item.basis === 'current' ? !ref.segmentId.startsWith('c') : !/^[pt]/u.test(ref.segmentId))) {
      diagnostics.push({ ...address, reason: 'wrong_source' }); return ref
    }
    if (ref.segmentId.startsWith('t')) {
      const fact = context.previous?.carried?.find(part => part.segmentId === ref.segmentId)
      if (!fact) diagnostics.push({ ...address, reason: 'unknown_segment' })
      else if (!fact.anchors.some(anchor => anchor.quote.includes(ref.quote))) diagnostics.push({ ...address, reason: 'carried_quote_mismatch' })
      return ref
    }
    const source = context.verdictProtocol === 5 ? ref.segmentId.startsWith('c') ? 'current' : 'previous' : item.basis === 'current' ? 'current' : 'previous'
    const segments = source === 'current' ? current : previous
    const original = segments.find(segment => segment.segmentId === ref.segmentId)
    // Unlike the old parser4 contract, terminal relocation requires an existing
    // address in this source's legal set. Never rescue an unknown ID or a tN.
    if (!original) { diagnostics.push({ ...address, reason: 'unknown_segment' }); return ref }
    if (original.quote.includes(ref.quote)) return ref
    if (context.factCoverage?.version === 2) {
      const range = terminalQuoteRange(ref, segments)
      if (range) {
        const actualSegmentId = range.segmentIds[0]
        diagnostics.push({ ...address, reason: 'relocated', actualSegmentId })
        relocations.push({ ...address, verdictIndex, source,
          actualSegmentId, quoteHash: createHash('sha256').update(ref.quote).digest('hex'), range })
        return { ...ref, segmentId: actualSegmentId }
      }
    }
    const located = locateUniqueContinuityQuote(ref.quote, source === 'current' ? [content] : previousBlocks, segments)
    if (!located.valid) { diagnostics.push({ ...address, reason: located.reason }); return ref }
    diagnostics.push({ ...address, reason: 'relocated', actualSegmentId: located.segmentId })
    relocations.push({ ...address, verdictIndex, source,
      actualSegmentId: located.segmentId, quoteHash: located.quoteHash })
    return { ...ref, segmentId: located.segmentId }
  }) }))
  return { items: canonical, originalRefs, relocations, diagnostics }
}

/** Address-only diagnostics share the exact canonicalizer used for admission.
 * JSON/schema, transport and semantic failures retain their existing audits. */
export function terminalQuoteAddressDiagnostics(raw: string, content: string, context?: TerminalEvidenceContext, candidate?: TerminalCandidate, responseContract?: 3): TerminalQuoteAddressDiagnostic[] | undefined {
  if (context?.quoteAddressProtocol !== 1) return undefined
  try {
    if (!terminalEvidenceContextSchema.safeParse(context).success || context.current.contentHash !== runtimeJson({ content }).hash) return []
    let record = parseQualityJsonObject(raw, 'continuity', 3) as Record<string, unknown>
    if (responseContract === 3) record = normalizeTerminalResponseRows(record).record
    if (context.verdictProtocol === 6) {
      if (!candidate) return []
      const bound = bindTerminalReviewAddresses(record, candidate, context, responseContract)
      return bound.success ? terminalQuoteAddressDiagnostics(JSON.stringify(bound.record), content, { ...context, verdictProtocol: 5 }, candidate) : []
    }
    const parsed = readSourcedVerdicts(record.terminalVerdicts, context, candidate, record.terminalProofVerdicts, content)
    return parsed.success ? canonicalTerminalQuoteAddresses(parsed.data, content, context).diagnostics : []
  } catch { return [] }
}

/** Paths preserve subject, polarity and temporal wording; never normalize a claim
 * into a different fact. Empty values mean unknown, not a negative assertion. */
export function terminalClaims(candidate: TerminalCandidate) {
  return Object.entries(candidate.exitState).flatMap(([key, value]) => Array.isArray(value)
    ? value.map((claim, index) => ({ path: `exitState.${key}.${index}`, claim }))
    : value?.trim() ? [{ path: `exitState.${key}`, claim: value }] : [])
    .concat(candidate.lastUnfinishedAction.trim() ? [{ path: 'lastUnfinishedAction', claim: candidate.lastUnfinishedAction }] : [])
}

export function terminalReviewInput(candidate?: TerminalCandidate, context?: TerminalEvidenceContext): string {
  if (candidate && context?.verdictProtocol === 6) return `本次冻结复核目录：${JSON.stringify(terminalReviewAddressInput(candidate, context))}\n只使用目录的短整数地址，不返回或猜测内部hash。ordinary按claimIndex穷尽返回terminalVerdicts={claimIndex,verdict,sourceEvidence:[{segmentId,quote?}],inheritance?}；proofs按proofIndex穷尽返回terminalProofVerdicts={proofIndex,currentState,reason}，独立判断本章是否改变该已认证持续事实，unchanged须核对本章全文，changed/uncertain保持未知，不视为事实已结束。两表由服务端分组，不能串用地址。普通verdict仍为supported/unknown/planned/negated/attributed；当前动作、位置、时间、情绪和未完成动作只能用当前cN；knowledge/body/objects/relationships/openLoops持续事实可结合本章cN与紧邻前章pN，但完整主张与继承状态均须成立，按原证据规则给inheritance。指令、分工、打算、引用和推测不证明动作已完成，完整对象、持有者、时间和方位须一致。\nobligations是已验证事实，按obligationIndex穷尽返回terminalDispositions={obligationIndex,outcome,reason,sourceEvidence,candidateIndex?}，outcome仍为replaced/ended/unknown；替代只能指向本次独立supported的candidateIndex，ended须当前正文证据，未知保留。proposals是未证实旧提议，逐proposalIndex恰好返回proposalDispositions={proposalIndex,outcome,reason,sourceEvidence,candidateIndex?}，outcome为replaced/retracted/unknown；retracted须独立核对当前原文，不能因未提及、地址错误或为了清零而撤回，更不能解除obligations。sourceEvidence保持原cN/pN目录及逐字引文要求，段落地址不等于语义成立。所有地址只在本请求有效；没有条目的证明或持续事实表按schema返回空数组；本次没有proposals目录条目时必须省略proposalDispositions字段，不返回空数组，不能虚构条目。findings与两项semanticChecks仍完整核验，不因终态地址简化而减少独立判断。`
  return terminalReviewInputBase(candidate, context) + terminalProposalGuidance(context?.proposalChanges)
}

function terminalReviewInputBase(candidate?: TerminalCandidate, context?: TerminalEvidenceContext): string {
  if ((context?.verdictProtocol === 3 || context?.verdictProtocol === 4 || context?.verdictProtocol === 5) && candidate) {
    const catalog = terminalProofCatalog(candidate, context), selected = new Set(catalog.flatMap(item => item.paths))
    const ordinary = terminalClaims(candidate).filter(item => !selected.has(item.path)).map(item => ({ ...item,
      ...(context.verdictProtocol === 4 || context.verdictProtocol === 5 ? { factId: terminalCandidateFacts(candidate).find(fact => fact.path === item.path)!.id } : {}),
      ...(context.verdictProtocol === 5 && context.factCoverage?.version === 2 ? { sourcePolicy: /^exitState\.(knowledge|body|objects|relationships|openLoops)\./u.test(item.path)
        ? 'current_or_attested_persistent' : 'current_only' } : {}), inheritedSources: [] }))
    let addressedGuide = context.verdictProtocol === 5
      ? `普通项以 factId 唯一选择本次冻结的原字段和完整主张；path 可省略，同时给出时必须与 factId 精确指向同一项。不得用一个地址覆盖另一个冲突地址。sourceEvidence 可选择 cN 或紧邻前章 pN；组合主张可逐引用选择两章原文。包含 pN 的 supported 持续事实仍须明确 inheritance={priorEndState:"established",currentState:"unchanged"} 并独立核对 pN 承担的持续部分前章末成立且本章未改变，不得自动推断或省略。verdict 支持整个当前组合；cN 部分可以由本章新建立，不能冒称它前章已成立。保留事实的 replaced 可用 candidateFactId 选择本次 supported 候选；unknown 不自动通过，未解决义务不得删除。semanticChecks 可为 action_direction/state_progression 两键 map。已选择历史候选的稳定目标：${JSON.stringify(terminalCandidateFacts(candidate).filter(fact => selected.has(fact.path)).map(({ id, field, claim }) => ({ factId: id, field, claim })))}\n`
      : context.verdictProtocol === 4
      ? `普通项优先用 factId 代替 path，只引用本次显式候选的唯一精确字段与完整事实。保留事实的 replaced 处置可用 candidateFactId 选择本次 supported 候选；不要求旧待办已解决，整个尚未解决的义务被候选承接即可，仍须独立核对。unknown 不自动通过，不引用账本 ID 冒充候选或证明。sourceEvidence 可只选已有 cN，由服务端绑定原段；跨字段依然需要本章证据。semanticChecks 可为恰好 action_direction/state_progression 两键 map，kind 可由键唯一确定，其他字段和实际判断必须完整。已选择历史候选的稳定目标：${JSON.stringify(terminalCandidateFacts(candidate).filter(fact => selected.has(fact.path)).map(({ id, field, claim }) => ({ factId: id, field, claim })))}\n`
      : ''
    if (context.verdictProtocol === 5 && context.factCoverage?.version === 2) addressedGuide += 'sourcePolicy is server guidance, not a response field or evidence. For supported current_only claims, use current cN evidence; prior context cannot establish the current location, inside/outside position, action or whether a pending action has happened. Confirm every specific part of the candidate. If the text cannot support it, keep unknown rather than endorsing a convenient interpretation. For current_or_attested_persistent claims, any supported pN contribution requires the explicit established/unchanged judgment; current-only support must omit inheritance. Never invent those judgments or add sourcePolicy to the strict response.\n'
    const previous = context.previous ? { ...context.previous, carried: context.previous.carried?.map(({ segmentId, field, claim, anchors }) =>
      ({ segmentId, field, claim, quotes: anchors.map(anchor => anchor.quote) })) } : null
    return `${addressedGuide}待提交候选（写者主张，不是证据）：${JSON.stringify(ordinary)}\n冻结证据目录：${JSON.stringify({ ...context, previous })}\n已选择的已验证历史事实：${JSON.stringify(catalog.map(({fact}) => ({proofHash:fact.proofHash,field:fact.field,claim:fact.claim,priorEvidence:fact.anchors.map(anchor=>({chapterId:anchor.chapterId,revision:anchor.revision,quote:anchor.quote}))})))}\n本次两组核验穷尽且互斥。只对普通候选逐 ${context.verdictProtocol === 5 ? 'factId（或精确 path）' : 'path'} 返回 terminalVerdicts，verdict=supported/unknown/planned/negated/attributed，sourceEvidence 只需选择已有${context.verdictProtocol === 5 ? '逐引用对应来源的' : '同来源的'} cN/pN segmentId，quote 可省略，服务端绑定该段原文；若给 quote 则必须逐字存在，不能补引号或改写。核对整个主张，不能用相邻正确半句作证明，不改写正文凑候选。普通项来源由服务端按 sourceEvidence 判定，勿输出 basis；${context.verdictProtocol === 5 ? '仅用本章 cN' : '本章 cN'} 的 supported 不得带 inheritance。${context.verdictProtocol === 5 ? '含有紧邻前章 pN' : '紧邻前章 pN'} 的 supported 必须给 inheritance={priorEndState:"established",currentState:"unchanged"}，${context.verdictProtocol === 5 ? '独立核对 pN 支持的持续部分前章末成立且本章全文未解除、转移或否定；仅 pN 的主张须整体前章成立，混合 cN/pN 的 verdict 仍须支持整个当前组合；' : '独立核对前章末成立且本章全文未解除、转移或否定；'}只能继承 knowledge、body、objects、relationships、openLoops 中持续事实，位置、动作、时间、情绪和 lastUnfinishedAction 不能凭未提及延续。${context.verdictProtocol === 5 ? '完整组合主张可混用 cN/pN，逐引用核对各自原文和整个主张；不得混入 tN。' : '每项只用同一来源，禁止混用 cN/pN/tN；'}已选历史证明只走 terminalProofVerdicts，未选 tN 不替代普通项的 pN/cN 依据。旧桥遗漏但前章正文明确支持的未解决事项可继承，不要求本章重述；较早章、桥摘要、Scene Task、作者要求、计划、传言或猜测不能当事实。\n每个已选择的历史 proofHash 恰好返回一项 terminalProofVerdicts={proofHash,currentState,reason}，currentState=unchanged/changed/uncertain。原字段、完整主张、锚点和证明链已由服务端核实绑定；你须完整核对本章是否改变、解除、转移或否定它，不重拼 tN、quote、path。旧待办尚未解决但仍持续是 unchanged，不要求本章重新叙述或解决它；未提及本身不证明改变，真实冲突或确实无法判断时用 changed/uncertain，不凑通过。只有明确 unchanged 可继承支持；changed 不自动当作 ended/negated。${terminalCoverageGuidance(context.factCoverage)}\n历史同义表述仍按每个 obligation 独立 replaced 到本次 supported 候选，保留主体、极性、条件和未解决义务；同字段承接无需为旧事伪造本章引文。findings 只报告正文真实矛盾；semanticChecks 按原规则完整返回。\nterminalProofVerdicts JSON Schema: ${JSON.stringify(z.toJSONSchema(z.array(terminalProofVerdictSchema).max(200), {io:'input'}))}\n普通 terminalVerdicts JSON Schema: ${context.verdictProtocol === 5 ? jointFactVerdictResponseContract : context.verdictProtocol === 4 ? factVerdictResponseContract : spanVerdictResponseContract}`
  }
  const input = terminalReviewClaimsInput(candidate, context) + terminalCoverageGuidance(context?.factCoverage)
  if (context?.verdictProtocol === 2) return `${input}\nterminalVerdicts JSON Schema: ${sourcedVerdictResponseContract}\n来源由服务端根据 sourceEvidence 中的 cN（本章）或 pN/tN（前章/已核验提交证明）确定；不要返回 basis。单项不得混合两种来源。supported 的持续事实必须明确 inheritance={priorEndState:"established",currentState:"unchanged"}；本章 supported 不返回 inheritance。unknown 等非支持判断是完整结果，不补造证据或继承结论。`
  if (context?.factCoverage?.version === 2) return `${input}\nterminalVerdicts JSON Schema: ${inheritedVerdictResponseContract}\nbasis is a source enum (${inheritedTerminalVerdictSchema.shape.basis.options.join(' | ')}), never an explanation. Use current for cN; use inherited for pN/tN and supply the explicit inheritance judgment. Keep every original verdict, including unknown.`
  return input && context?.quoteAddressProtocol === 1
    ? `${input}\n引用地址策略：quote 必须逐字不变且完整落在单个合法片段；优先给出正确 cN/pN。服务器只可将已存在的同来源错误编号定位到唯一逐字引文所在片段，不跨来源、不补造编号、不修改 tN；重复、跨片段或不存在的引文不能修复。` : input
}

function terminalReviewClaimsInput(candidate?: TerminalCandidate, context?: TerminalEvidenceContext): string {
  if (!candidate) return ''
  if (context?.factCoverage?.version === 2) {
    const previous = context.previous ? { ...context.previous, carried: context.previous.carried?.map(({ segmentId, field, claim, anchors }) =>
      ({ segmentId, field, claim, quotes: anchors.map(anchor => anchor.quote) })) } : null
    const claims = terminalClaims(candidate).map(item => ({ ...item,
      inheritedSources: context.previous?.carried?.filter(fact => fact.field === item.path.split('.')[1] && fact.claim === item.claim).map(fact => fact.segmentId) ?? [] }))
    return `待提交候选（写者主张，不是证据）：${JSON.stringify(claims)}\n冻结证据目录：${JSON.stringify({ ...context, previous })}\n逐 path 恰好返回一项 terminalVerdicts={path,verdict,${context.verdictProtocol === 2 ? '' : 'basis,'}sourceEvidence:[{segmentId,quote}],inheritance?}。verdict=supported/unknown/planned/negated/attributed。本章新增或变化事实用 current/cN；持续事实可用 inherited/pN 或服务端已验证的 tN，须独立核对本章全文未解除、转移或否定，inheritance={priorEndState:"established",currentState:"unchanged"}。tN 只支持原字段和完整原主张，inheritedSources 是服务端精确匹配，不需重新拼接证明或要求正文重述历史。位置、动作、时间、情绪和 lastUnfinishedAction 不凭未提及继承。逐字 quote 可跨相邻的人为300字符片段，服务端在同一可用来源中确定唯一连续位置；不要为切段改写原文或主张，引用一个现有同来源编号即可。不得跨章、跨缺失范围或引用摘要/计划作事实。核对整个主张而非相邻半句，不添加原主张未声称的原因等条件。旧事项已由本章确实完成时判 negated，不强迫保留；unknown 保留待核，不删空凑通过。findings 只报告正文实际矛盾；semanticChecks 包含 action_direction/state_progression 两个完整 {kind,result,reason,findingIndexes}，conflict 仅引用有原文证据的 error 索引；其他结果索引为空。`
  }
  if (context?.protocol === 1) return `待提交终态候选（主写者主张，不是证据）：${JSON.stringify(terminalClaims(candidate))}\n服务端终态证据范围：${JSON.stringify(context)}\n除 findings 和 semanticChecks 外，输出 terminalVerdicts，每个 path 恰好一项：{path,verdict,basis,sourceEvidence:[{segmentId,quote}],inheritance?}。verdict 为 supported、unknown、planned、negated、attributed。同一正文片段可引用多个逐字短 quote，每条都须在所标 cN/pN 片段内分别定位。当前新增或改变事实 basis=current，只能引用本章 cN 及逐字短 quote；核对完整对象、持有者、方向、时刻及章末是否仍成立，不能以“朝某处走”证明已到达。basis=inherited 只能引用服务端 previous.segments 中紧邻前章 pN 及逐字短 quote，并给 inheritance={priorEndState:"established",currentState:"unchanged"}：独立核对前章末实际成立，且本章全文未解除、转移或否定。只能继承 knowledge、body、objects、relationships、openLoops 中持续事实；位置、动作、时间、情绪和 lastUnfinishedAction 不能凭未提及延续。旧桥遗漏但前章正文明确支持的未解决事项可继承，不要求本章重述；较早章、桥摘要、Scene Task、作者要求、计划、传言或猜测不能当事实。证据不足用 unknown 等相应判定，保留未知主张，不删除或清空来凑通过。无候选 terminalVerdicts=[]。`
  if (context) return `待提交终态候选（主写者主张，不是证据）：${JSON.stringify(terminalClaims(candidate))}\n服务端终态证据范围：${JSON.stringify(context)}\n除 findings 和 semanticChecks 外，输出 terminalVerdicts，每个 path 恰好一项：{path,verdict,basis,sourceEvidence:[{segmentId,quote}],inheritance?}。verdict 为 supported、unknown、planned、negated、attributed。同一正文片段可引用多个逐字短 quote，每条都须在所标 cN/pN 片段内分别定位。当前新增或改变事实 basis=current，只能引用本章 cN 及逐字短 quote；核对完整对象、持有者、方向、时刻及章末是否仍成立，不能以“朝某处走”证明已到达。basis=inherited 只能引用服务端 previous.segments 中紧邻前章 pN 或 previous.carried 中已提交证明 tN 及逐字短 quote；tN 只支持其 field 与完整 claim 精确相同的事实，证明链已由服务端重新核对原始正文锚点和各中间章，最多16级，断链或超限只能 unknown，并给 inheritance={priorEndState:"established",currentState:"unchanged"}：独立核对前章末实际成立（直接正文或服务端已核验的提交证明链），且本章全文未解除、转移或否定。只能继承 knowledge、body、objects、relationships、openLoops 中持续事实；位置、动作、时间、情绪和 lastUnfinishedAction 不能凭未提及延续。旧桥遗漏但前章正文明确支持的未解决事项可继承，不要求本章重述；较早章、桥摘要、Scene Task、作者要求、计划、传言或猜测不能当事实。证据不足用 unknown 等相应判定，保留未知主张，不删除或清空来凑通过。无候选 terminalVerdicts=[]。`
  return `待提交终态候选（仅是主写者的主张，绝非证据）：${JSON.stringify(terminalClaims(candidate))}\n除 findings 外必须输出 terminalVerdicts 数组，每个 path 恰好一项：{path,verdict,segmentIds}。verdict=supported 仅表示当前正文明确支持同一人物/物品、同一时刻的该完整状态；segmentIds 只选服务端 current 原文编号 c0、c1 等，不写 quote、不编造编号。计划/将来/假设用 planned，含糊推断或未记载用 unknown，正文否定该主张用 negated，仅他人传言/引用而未确证用 attributed。疼痛不等于骨裂，人物怀疑不等于人物知道；前章事实或 Scene Task 不能代替当前章终态。负面主张本身若被原文明确支持可 supported。某状态先发生后被解除，不是章末仍成立。未知项保留原主张及未确认判定，不静默删除或将空数组当全部通过。无候选事实时 terminalVerdicts=[]。`
}

/** A critic selects server-owned spans. It cannot supply or rewrite evidence.
 * Source existence is checked here; entailment is the independent critic's
 * explicit, exhaustive judgment, never inferred from a substring match. */
export type TerminalReviewDiagnostic = { code: string; path?: string; referenceIndex?: number; segmentId?: string; expectedFact?: { field: string; claim: string }; message?: string; expectedCount?: number; actualCount?: number }
export function inspectTerminalReview(candidate: TerminalCandidate, content: string, raw: string, complete: boolean, context?: TerminalEvidenceContext,
  diagnostics?: TerminalReviewDiagnostic[], options: { frozenCurrentMetadata?: true; responseContract?: 3 } = {}) {
  if (options.responseContract === 3 && context?.verdictProtocol !== 6) { diagnostics?.push({ code: 'response_contract_invalid' }); return null }
  if (context?.verdictProtocol !== 6 || !complete || !terminalEvidenceContextSchema.safeParse(context).success
    || context.current.contentHash !== runtimeJson({ content }).hash) return inspectTerminalReviewBound(candidate, content, raw, complete, context, diagnostics)
  try {
    const record = parseQualityJsonObject(raw, 'continuity', 3) as Record<string, unknown>
    const bound = bindTerminalReviewAddresses(record, candidate, context, options.responseContract)
    if (!bound.success) {
      const path = bound.issues[0]?.path.join('.')
      diagnostics?.push({ code: 'response_address_invalid', ...(path ? { path } : {}) })
      return null
    }
    const reviewed = inspectTerminalReviewBound(candidate, content, JSON.stringify(bound.record), complete, { ...context, verdictProtocol: 5 }, diagnostics, !options.frozenCurrentMetadata, options.responseContract)
    // Interpretation reuses the strict semantic contract; provenance always
    // identifies the actual provider response and its full frozen wire input.
    return reviewed ? { ...reviewed, responseHash: runtimeJson({ raw }).hash, evidenceContextHash: runtimeJson(context).hash } : null
  } catch {
    diagnostics?.push({ code: 'response_invalid' })
    return null
  }
}

/** Shared source/quote/inheritance/exhaustiveness checks. No disposition
 * result and no supported/complete report is produced by this helper. */
function inspectTerminalCandidateEvidenceBound(candidate: TerminalCandidate, content: string, raw: string, context?: TerminalEvidenceContext,
  diagnostics?: TerminalReviewDiagnostic[], allowCurrentMetadata = false, collectAll = false) {
  const invalid = (code: string, path?: string, referenceIndex?: number, segmentId?: string, expectedFact?: { field: string; claim: string }) => {
    diagnostics?.push({ code, ...(path ? { path } : {}), ...(referenceIndex !== undefined ? { referenceIndex } : {}), ...(segmentId ? { segmentId } : {}), ...(expectedFact ? { expectedFact } : {}) }); return null
  }
  try {
    const record = parseQualityJsonObject(raw, 'continuity', 3) as Record<string, unknown>
    if (context && (!terminalEvidenceContextSchema.safeParse(context).success || context.current.contentHash !== runtimeJson({ content }).hash)) return invalid('evidence_context_stale')
    const inherited = context ? readSourcedVerdicts(record.terminalVerdicts, context, candidate, record.terminalProofVerdicts, content) : null
    const addresses = inherited?.success && context?.quoteAddressProtocol === 1 ? canonicalTerminalQuoteAddresses(inherited.data, content, context) : null
    const inheritedItems = addresses?.items ?? (inherited?.success ? inherited.data : null)
    // Quote references remain intact and are each checked below. Only their
    // derived segment-address projection is a set; multiple quotes can share a span.
    const parsed = inheritedItems ? { success: true as const, data: inheritedItems.map(item => ({ ...item, segmentIds: [...new Set(item.sourceEvidence.flatMap(ref => {
      if (context?.factCoverage?.version !== 2 || ref.segmentId.startsWith('t')) return [ref.segmentId]
      const available = ref.segmentId.startsWith('c') ? continuitySourceSegments({ previous: null, current: content }) : context.previous?.segments ?? []
      return terminalQuoteRange(ref, available)?.segmentIds ?? [ref.segmentId]
    }))] })) }
      : context ? null : z.array(terminalVerdictSchema).max(200).safeParse(record.terminalVerdicts)
    if (!parsed?.success) {
      const issue = inherited && !inherited.success ? inherited.error.issues[0] : undefined
      return invalid('verdict_schema_invalid', context?.factCoverage?.version === 2 && issue
        ? ['terminalVerdicts', ...issue.path].join('.') : undefined)
    }
    const claims = terminalClaims(candidate), verdicts = parsed.data
    const segments = [...continuitySourceSegments({ previous: null, current: content }), ...(context?.previous?.segments ?? []),
      ...(context?.previous?.carried ?? []).map(fact => ({ segmentId: fact.segmentId, quote: fact.anchors.map(anchor => anchor.quote).join('\n') }))]
    const checkItem = (item: NonNullable<typeof inheritedItems>[number]) => {
      const supported = item.verdict === 'supported'
      if (item.basis === 'inherited' && ((context?.verdictProtocol === undefined || supported) && !/^exitState\.(knowledge|body|objects|relationships|openLoops)\./u.test(item.path)
        || supported && (item.inheritance?.priorEndState !== 'established' || item.inheritance.currentState !== 'unchanged'))) return invalid('inheritance_invalid', item.path)
      // In v6, source comes from the exact selected refs. Redundant optional
      // inheritance metadata cannot turn c-only evidence into a prior claim.
      // Frozen failed-audit replay and all older contracts retain their check.
      if (!allowCurrentMetadata && item.basis === 'current' && item.inheritance !== undefined && (context?.verdictProtocol === undefined || supported)) return invalid('inheritance_invalid', item.path)
      for (const [index, ref] of item.sourceEvidence.entries()) {
        if (context?.verdictProtocol !== 5 && (item.basis === 'current' ? !ref.segmentId.startsWith('c') : !/^[pt]/u.test(ref.segmentId))) return invalid('evidence_source_mismatch', item.path, index, ref.segmentId)
        if (ref.segmentId.startsWith('t')) {
          const fact = context?.previous?.carried?.find(part => part.segmentId === ref.segmentId)
          if (context?.protocol !== 2 || item.sourceEvidence.length !== 1 || !fact || supported && fact.depth >= 16) return invalid('carried_proof_unavailable', item.path, index, ref.segmentId)
          if (fact.field !== item.path.split('.')[1] || fact.claim !== claims.find(claim => claim.path === item.path)?.claim) return invalid('carried_fact_mismatch', item.path, index, ref.segmentId, { field: fact.field, claim: fact.claim })
          if (!fact.anchors.some(anchor => anchor.quote.includes(ref.quote))) return invalid('carried_quote_mismatch', item.path, index, ref.segmentId)
        }
        if (context?.factCoverage?.version === 2 && !ref.segmentId.startsWith('t') ? !terminalQuoteRange(ref, segments)
          : !segments.some(segment => segment.segmentId === ref.segmentId && segment.quote.includes(ref.quote))) return invalid('evidence_quote_invalid', item.path, index, ref.segmentId)
      }
      return undefined
    }
    if (collectAll) { if ((inheritedItems ?? []).map(checkItem).some(value => value === null)) return null }
    else for (const item of inheritedItems ?? []) if (checkItem(item) === null) return null
    if (verdicts.length !== claims.length || new Set(verdicts.map(item => item.path)).size !== verdicts.length
      || verdicts.some(item => !claims.some(claim => claim.path === item.path)
        || new Set(item.segmentIds).size !== item.segmentIds.length
        || item.verdict === 'supported' && item.segmentIds.length === 0
        || item.segmentIds.some(id => !segments.some(segment => segment.segmentId === id)))) return invalid('claim_coverage_invalid')
    return { record, inherited, addresses, verdicts, segments }
  } catch { return invalid('response_invalid') }
}

export function inspectTerminalCandidateEvidence(candidate: TerminalCandidate, content: string, record: Record<string, unknown>, context: TerminalEvidenceContext, diagnostics?: TerminalReviewDiagnostic[], collectAll = false) {
  if (context.verdictProtocol !== 6) return null
  const bound = bindTerminalCandidateAddresses(record, candidate, context)
  return bound ? inspectTerminalCandidateEvidenceBound(candidate, content, JSON.stringify(bound), { ...context, verdictProtocol: 5 }, diagnostics, true, collectAll) : null
}

function inspectTerminalReviewBound(candidate: TerminalCandidate, content: string, raw: string, complete: boolean, context?: TerminalEvidenceContext,
  diagnostics?: TerminalReviewDiagnostic[], allowCurrentMetadata = false, responseContract?: 3) {
  const invalid = (code: string, path?: string, referenceIndex?: number, segmentId?: string, expectedFact?: { field: string; claim: string }) => {
    diagnostics?.push({ code, ...(path ? { path } : {}), ...(referenceIndex !== undefined ? { referenceIndex } : {}), ...(segmentId ? { segmentId } : {}), ...(expectedFact ? { expectedFact } : {}) })
    return null
  }
  if (!complete) return invalid('response_incomplete')
  try {
    const evidence = inspectTerminalCandidateEvidenceBound(candidate, content, raw, context, diagnostics, allowCurrentMetadata)
    if (!evidence) return null
    const { record, inherited, addresses, verdicts, segments } = evidence
    const factCoverage = inspectTerminalCoverage(context?.factCoverage, record.terminalDispositions, candidate, verdicts, segments.filter(item => item.segmentId.startsWith('c')), context?.verdictProtocol === 4 || context?.verdictProtocol === 5, responseContract === 3 ? diagnostics : undefined)
    if (factCoverage === null) return invalid('fact_disposition_invalid')
    const proposalInput = context?.proposalChanges
    if (proposalInput && (proposalInput.chapterId !== context.current.id || proposalInput.bodyHash !== context.current.contentHash
      || proposalInput.sourceHash !== runtimeJson({ previous: context.previous }).hash)) return invalid('proposal_input_stale')
    const proposals = inspectTerminalProposalDispositions(proposalInput, record.proposalDispositions, candidate, verdicts, segments,
      [...(context?.factCoverage?.obligations.map(item => item.id) ?? []),
      ...(context?.previous?.carried?.map(item => terminalFactId(item.field, item.claim)) ?? [])])
    if (proposals === null) return invalid('proposal_disposition_invalid')
    return { version: context ? 2 : 1, ...(context ? { evidenceContextHash: runtimeJson(context).hash } : {}), ...(factCoverage ? { factCoverage } : {}), ...(proposals ? { proposals } : {}), candidate, contentHash: runtimeJson({ content }).hash,
      candidateHash: runtimeJson(candidate).hash, responseHash: runtimeJson({ raw }).hash,
      ...(addresses ? { originalRefs: addresses.originalRefs, relocations: addresses.relocations } : {}),
      supported: verdicts.every(item => item.verdict === 'supported') && factCoverage?.complete !== false && proposals?.complete !== false,
      ...(inherited?.success && 'proofChecks' in inherited ? { proofChecks: inherited.proofChecks } : {}),
      ...(inherited?.success && 'spanSelections' in inherited ? { spanSelections: inherited.spanSelections } : {}),
      verdicts: verdicts.map(item => ({ ...item, evidence: item.segmentIds.map(id => {
        if (id.startsWith('t')) {
          const fact = context!.previous!.carried!.find(part => part.segmentId === id)!
          return { segmentId: id, proofHash: fact.proofHash, anchors: fact.anchors }
        }
        const segment = segments.find(part => part.segmentId === id)!
        const start = 'start' in segment && typeof segment.start === 'number' ? segment.start : Number(id.slice(1)) * 300
        return { segmentId: id, start, end: start + segment.quote.length, hash: runtimeJson({ text: segment.quote }).hash }
      }) })) }
  } catch { return invalid('response_invalid') }
}

export function readTerminalCandidate(validation: unknown): TerminalCandidate | undefined {
  const record = validation && typeof validation === 'object' ? validation as Record<string, unknown> : {}
  const parsed = terminalCandidateSchema.safeParse(record.terminalCandidate)
  return parsed.success ? parsed.data : undefined
}

/** Reparse the saved independent response against today's body. A main-agent
 * supplied proof/quote is never accepted as a semantic attestation. */
export type TerminalDeliveryBinding = { taskId: string; preparedContext: unknown }
export type TerminalDeliveryEligibility = { version: 1; basis: 'fully_supported' | 'current_supported_with_preserved_drafts' | 'blocked';
  eligible: boolean; preservedUnknownProposalIds: string[] }

/** Delivery may preserve superseded, unverified transient drafts. This never
 * changes independent verdicts, resolves a proposal or discharges a real fact. */
function terminalDeliveryEligibility(review: NonNullable<ReturnType<typeof inspectTerminalReview>>, context?: TerminalEvidenceContext,
  binding?: TerminalDeliveryBinding): TerminalDeliveryEligibility {
  const unknown = review.proposals?.dispositions.filter(item => item.outcome === 'unknown') ?? []
  const preservedUnknownProposalIds = unknown.map(item => item.id)
  const result = (eligible: boolean, basis: TerminalDeliveryEligibility['basis']): TerminalDeliveryEligibility => ({ version: 1, basis, eligible, preservedUnknownProposalIds })
  if (review.supported) return result(true, 'fully_supported')
  const input = context?.proposalChanges
  if (!context || !binding || !input || !unknown.length || !terminalCandidateFacts(review.candidate).length
    || !review.verdicts.length || review.verdicts.some(item => item.verdict !== 'supported')
    || review.factCoverage?.version !== 2 || !review.factCoverage.complete) return result(false, 'blocked')
  try {
    const identity = { taskId: binding.taskId, chapterId: context.current.id, bodyHash: context.current.contentHash,
      sourceHash: runtimeJson({ previous: context.previous }).hash }
    const saved = readTerminalProposalInput(binding.preparedContext, identity, review.candidate)
    const state = readTerminalProposalState(binding.preparedContext, identity)
    if (!saved || !state || runtimeJson(saved).hash !== runtimeJson(input).hash) return result(false, 'blocked')
    const current = new Set(terminalCandidateFacts(review.candidate).map(item => item.id))
    const verified = new Set([...input.verifiedFactIds, ...(context.factCoverage?.obligations.map(item => item.id) ?? []),
      ...(context.previous?.carried?.map(item => terminalFactId(item.field, item.claim)) ?? [])])
    const eligible = unknown.every(item => {
      const proposal = input.proposals.find(proposal => proposal.id === item.id)
      return proposal && state.pending.some(pending => runtimeJson(pending).hash === runtimeJson(proposal).hash)
        && ['action', 'location', 'storyTime', 'emotion'].includes(proposal.field)
        && !current.has(proposal.id) && !verified.has(proposal.id)
        && proposal.origin.bodyHash === identity.bodyHash && proposal.origin.sourceHash === identity.sourceHash
    })
    return result(eligible, eligible ? 'current_supported_with_preserved_drafts' : 'blocked')
  } catch { return result(false, 'blocked') }
}

export function currentTerminalReview(validation: unknown, content: string, expectedContext?: TerminalEvidenceContext, binding?: TerminalDeliveryBinding) {
  const record = validation && typeof validation === 'object' ? validation as Record<string, unknown> : {}
  const candidate = readTerminalCandidate(validation)
  const audit = record.continuityCriticResponse as { parserVersion?: number; terminalEvidence?: unknown; terminalCandidate?: unknown; terminalContentHash?: unknown; rawResponse?: { content?: unknown; complete?: boolean }; responseContract?: unknown } | undefined
  const frozenCandidate = terminalCandidateSchema.safeParse(audit?.terminalCandidate)
  if (!validEmptyOptionalProposalProjection(audit, content, expectedContext) || !validContinuitySparseProjection(audit, content, expectedContext)) return null
  if (!candidate || !frozenCandidate.success || runtimeJson(candidate).hash !== runtimeJson(frozenCandidate.data).hash
    || audit?.terminalContentHash !== runtimeJson({ content }).hash
    || audit?.rawResponse?.complete !== true || typeof audit.rawResponse.content !== 'string') return null
  if (audit.parserVersion === 8 ? !expectedContext || runtimeJson(audit.terminalEvidence).hash !== runtimeJson(expectedContext).hash : expectedContext !== undefined) return null
  try {
    const raw: unknown = JSON.parse(audit.rawResponse.content)
    const review = typeof raw === 'string' && (audit.responseContract === undefined || audit.responseContract === 3) ? inspectTerminalReview(candidate, content, raw, record.independentCheck === 'complete', expectedContext, undefined, audit.responseContract === 3 ? { responseContract: 3 } : {}) : null
    return review ? { ...review, deliveryEligibility: terminalDeliveryEligibility(review, expectedContext, binding) } : null
  } catch { return null }
}

export function terminalReviewFailure(validation: unknown, content: string, context?: TerminalEvidenceContext,
  proseReport?: { errors: number; text: string }, binding?: TerminalDeliveryBinding) {
  if (!readTerminalCandidate(validation)) return null
  const review = currentTerminalReview(validation, content, context, binding)
  if (review?.deliveryEligibility.eligible) return null
  const diagnostics = (validation as { continuityCriticResponse?: { terminalReviewDiagnostics?: TerminalReviewDiagnostic[] } }).continuityCriticResponse?.terminalReviewDiagnostics
  if (review && (context?.factCoverage?.version === 2 || context?.verdictProtocol !== undefined)) {
    const claims = terminalClaims(review.candidate)
    const disputed = review.verdicts.filter(item => item.verdict !== 'supported').map(item => ({ path: item.path,
      claim: claims.find(claim => claim.path === item.path)?.claim ?? '', verdict: item.verdict,
      ...('sourceEvidence' in item ? { sourceEvidence: item.sourceEvidence } : {}) }))
    const unresolved = review.factCoverage?.dispositions.filter(item => item.outcome === 'unknown').map(item => ({ ...item,
      fact: context.factCoverage?.obligations.find(fact => fact.id === item.id) })) ?? []
    const proposals = review.proposals?.dispositions.filter(item => item.outcome === 'unknown').map(item => {
      const proposal = context.proposalChanges?.proposals.find(proposal => proposal.id === item.id)
      return { ...item, ...(proposal ? { field: proposal.field, claim: proposal.claim } : {}) }
    }) ?? []
    const selectable = context.previous?.carried?.filter(fact => fact.depth < 16
      && context.previous!.carried!.filter(other => other.proofHash === fact.proofHash).length === 1
      && context.previous!.carried!.filter(other => other.field === fact.field && other.claim === fact.claim && other.depth < 16).length === 1
      && (unresolved.some(item => item.fact?.field === fact.field && item.fact.claim === fact.claim)
      || disputed.some(item => item.path.split('.')[1] === fact.field && item.claim === fact.claim)))
      .map(({ proofHash, field, claim }) => ({ proofHash, field, claim })) ?? []
    const selection = selectable.length ? `\n可显式选择的当前有效证明：${JSON.stringify(selectable)}。保持同一 compilationId，可只传顶层 inheritedProofs=[所选proofHash]，服务端在本任务已保存候选上还原原字段与完整主张；这只是待核选择，仍须独立判断本章是否改变。不要复制临时编号或手拼旧事实。` : ''
    const updateGuidance = context.verdictProtocol === 4 || context.verdictProtocol === 5 || context.verdictProtocol === 6
      ? `按实际裁决用 terminalPatch={baseCandidateHash:${JSON.stringify(runtimeJson(review.candidate).hash)},removeFactIds:[],addFacts:[{field,claim}]} 只更新需要处理的候选，未指定项保留；当前事实地址：${JSON.stringify(terminalCandidateFacts(review.candidate).map(({ id, field, claim }) => ({ factId: id, field, claim })))}。也可提供完整 terminalState。更新后调用 continuity_validate；`
      : '按实际裁决更新 terminalState 后调用 continuity_validate；'
    return { outcome: 'failed' as const, failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED', reviewCompleted: true,
      summary: '终态候选尚未获独立证实',
      output: `${proseReport ? proseReport.text + '\n' : ''}本次检查尚未通过：独立正文报告已收到，但终态与持续事实尚未获证实，禁止称检查通过或提交。终态待处理候选或旧事实：${JSON.stringify({ disputed, unresolved, ...(proposals.length ? { proposals } : {}), ...('proofChecks' in review ? { proofChecks: review.proofChecks } : {}) })}。其余已支持项无需同义重写。以本章明确完成证据判为 negated 的旧待办，可据该裁决移除或更新；unknown 不能删空，持续事实请使用已有核验的原字段/原主张证明并核对本章是否变化，不要求正文重述历史。保留事实主体、条件和未解决义务，不把状态误改成已完成。${updateGuidance}同一版本检查通过再 chapter_bridge_commit，${proseReport?.errors ? '正文仍有真实错误，按完整报告、当前证据和原授权处理后复核；终态待核不覆盖这些错误。' : '无需为终态候选改正文或重跑已通过的质量检查。'}${selection}` }
  }
  return { outcome: 'failed' as const, failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED', reviewCompleted: !!review,
    summary: '终态候选尚未获正文证实',
    output: `正文与候选均保留，终态未提交；不把连续性 findings 为空当作终态通过。${review
      ? `逐项核验：${JSON.stringify(review.verdicts.map(item => ({ path: item.path, verdict: item.verdict, evidence: item.evidence })))}${review.factCoverage ? `；持续事实处置：${JSON.stringify(review.factCoverage.dispositions)}` : ''}`
      : `独立响应缺少完整逐项判定或有效 current 原文编号，不能补造证据。${diagnostics?.length ? `终态证据诊断：${JSON.stringify(diagnostics)}。` : ''}`}核对真实正文后，调用 continuity_validate，以 terminalState={exitState,lastUnfinishedAction} 传入完整准确候选重检。候选任何改动（含删除未知项）都须重新核验；重检通过后才可 chapter_bridge_commit，提交同一候选或省略状态复用。不得把计划、推断或转述改称实况，也不要清空已知状态绕过核验。` }
}
