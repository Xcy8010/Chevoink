import { z } from 'zod'
import { storyStateSchema } from '../../../shared/contracts/story-compiler-contracts.js'
import { continuitySourceSegments } from './continuity-review-context.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import { runtimeJson } from './runtime-common.js'
import { terminalEvidenceContextSchema, type TerminalEvidenceContext } from './terminal-evidence-context.js'

export const terminalCandidateSchema = z.object({
  exitState: storyStateSchema,
  lastUnfinishedAction: z.string().max(1000).default(''),
}).strict()
export type TerminalCandidate = z.infer<typeof terminalCandidateSchema>
export const terminalVerdictSchema = z.object({ path: z.string().max(100),
  verdict: z.enum(['supported', 'unknown', 'planned', 'negated', 'attributed']),
  segmentIds: z.array(z.string().regex(/^c[0-9]+$/)).max(8),
}).strict()
export const inheritedTerminalVerdictSchema = terminalVerdictSchema.omit({ segmentIds: true }).extend({
  basis: z.enum(['current', 'inherited']),
  sourceEvidence: z.array(z.object({ segmentId: z.string().regex(/^[cpt][0-9]+$/), quote: z.string().min(2).max(300) }).strict()).max(8),
  inheritance: z.object({ priorEndState: z.enum(['established', 'uncertain']), currentState: z.enum(['unchanged', 'changed', 'uncertain']) }).strict().optional(),
}).strict()

/** Paths preserve subject, polarity and temporal wording; never normalize a claim
 * into a different fact. Empty values mean unknown, not a negative assertion. */
export function terminalClaims(candidate: TerminalCandidate) {
  return Object.entries(candidate.exitState).flatMap(([key, value]) => Array.isArray(value)
    ? value.map((claim, index) => ({ path: `exitState.${key}.${index}`, claim }))
    : value?.trim() ? [{ path: `exitState.${key}`, claim: value }] : [])
    .concat(candidate.lastUnfinishedAction.trim() ? [{ path: 'lastUnfinishedAction', claim: candidate.lastUnfinishedAction }] : [])
}

export function terminalReviewInput(candidate?: TerminalCandidate, context?: TerminalEvidenceContext) {
  if (!candidate) return ''
  if (context?.protocol === 1) return `待提交终态候选（主写者主张，不是证据）：${JSON.stringify(terminalClaims(candidate))}\n服务端终态证据范围：${JSON.stringify(context)}\n除 findings 和 semanticChecks 外，输出 terminalVerdicts，每个 path 恰好一项：{path,verdict,basis,sourceEvidence:[{segmentId,quote}],inheritance?}。verdict 为 supported、unknown、planned、negated、attributed。当前新增或改变事实 basis=current，只能引用本章 cN 及逐字短 quote；核对完整对象、持有者、方向、时刻及章末是否仍成立，不能以“朝某处走”证明已到达。basis=inherited 只能引用服务端 previous.segments 中紧邻前章 pN 及逐字短 quote，并给 inheritance={priorEndState:"established",currentState:"unchanged"}：独立核对前章末实际成立，且本章全文未解除、转移或否定。只能继承 knowledge、body、objects、relationships、openLoops 中持续事实；位置、动作、时间、情绪和 lastUnfinishedAction 不能凭未提及延续。旧桥遗漏但前章正文明确支持的未解决事项可继承，不要求本章重述；较早章、桥摘要、Scene Task、作者要求、计划、传言或猜测不能当事实。证据不足用 unknown 等相应判定，保留未知主张，不删除或清空来凑通过。无候选 terminalVerdicts=[]。`
  if (context) return `待提交终态候选（主写者主张，不是证据）：${JSON.stringify(terminalClaims(candidate))}\n服务端终态证据范围：${JSON.stringify(context)}\n除 findings 和 semanticChecks 外，输出 terminalVerdicts，每个 path 恰好一项：{path,verdict,basis,sourceEvidence:[{segmentId,quote}],inheritance?}。verdict 为 supported、unknown、planned、negated、attributed。当前新增或改变事实 basis=current，只能引用本章 cN 及逐字短 quote；核对完整对象、持有者、方向、时刻及章末是否仍成立，不能以“朝某处走”证明已到达。basis=inherited 只能引用服务端 previous.segments 中紧邻前章 pN 或 previous.carried 中已提交证明 tN 及逐字短 quote；tN 只支持其 field 与完整 claim 精确相同的事实，证明链已由服务端重新核对原始正文锚点和各中间章，最多16级，断链或超限只能 unknown，并给 inheritance={priorEndState:"established",currentState:"unchanged"}：独立核对前章末实际成立（直接正文或服务端已核验的提交证明链），且本章全文未解除、转移或否定。只能继承 knowledge、body、objects、relationships、openLoops 中持续事实；位置、动作、时间、情绪和 lastUnfinishedAction 不能凭未提及延续。旧桥遗漏但前章正文明确支持的未解决事项可继承，不要求本章重述；较早章、桥摘要、Scene Task、作者要求、计划、传言或猜测不能当事实。证据不足用 unknown 等相应判定，保留未知主张，不删除或清空来凑通过。无候选 terminalVerdicts=[]。`
  return `待提交终态候选（仅是主写者的主张，绝非证据）：${JSON.stringify(terminalClaims(candidate))}\n除 findings 外必须输出 terminalVerdicts 数组，每个 path 恰好一项：{path,verdict,segmentIds}。verdict=supported 仅表示当前正文明确支持同一人物/物品、同一时刻的该完整状态；segmentIds 只选服务端 current 原文编号 c0、c1 等，不写 quote、不编造编号。计划/将来/假设用 planned，含糊推断或未记载用 unknown，正文否定该主张用 negated，仅他人传言/引用而未确证用 attributed。疼痛不等于骨裂，人物怀疑不等于人物知道；前章事实或 Scene Task 不能代替当前章终态。负面主张本身若被原文明确支持可 supported。某状态先发生后被解除，不是章末仍成立。未知项保留原主张及未确认判定，不静默删除或将空数组当全部通过。无候选事实时 terminalVerdicts=[]。`
}

/** A critic selects server-owned spans. It cannot supply or rewrite evidence.
 * Source existence is checked here; entailment is the independent critic's
 * explicit, exhaustive judgment, never inferred from a substring match. */
export function inspectTerminalReview(candidate: TerminalCandidate, content: string, raw: string, complete: boolean, context?: TerminalEvidenceContext) {
  if (!complete) return null
  try {
    const record = parseQualityJsonObject(raw, 'continuity', 3) as Record<string, unknown>
    if (context && (!terminalEvidenceContextSchema.safeParse(context).success || context.current.contentHash !== runtimeJson({ content }).hash)) return null
    const inherited = context ? z.array(inheritedTerminalVerdictSchema).max(200).safeParse(record.terminalVerdicts) : null
    const parsed = inherited?.success ? { success: true as const, data: inherited.data.map(item => ({ ...item, segmentIds: item.sourceEvidence.map(ref => ref.segmentId) })) }
      : context ? null : z.array(terminalVerdictSchema).max(200).safeParse(record.terminalVerdicts)
    if (!parsed?.success) return null
    const claims = terminalClaims(candidate), verdicts = parsed.data
    const segments = [...continuitySourceSegments({ previous: null, current: content }), ...(context?.previous?.segments ?? []),
      ...(context?.previous?.carried ?? []).map(fact => ({ segmentId: fact.segmentId, quote: fact.anchors.map(anchor => anchor.quote).join('\n') }))]
    if (inherited?.success && inherited.data.some(item => {
      const supported = item.verdict === 'supported'
      if (item.basis === 'inherited' && (!/^exitState\.(knowledge|body|objects|relationships|openLoops)\./u.test(item.path)
        || supported && (item.inheritance?.priorEndState !== 'established' || item.inheritance.currentState !== 'unchanged'))) return true
      if (item.basis === 'current' && item.inheritance !== undefined) return true
      return item.sourceEvidence.some(ref => {
        if (item.basis === 'current' ? !ref.segmentId.startsWith('c') : !/^[pt]/u.test(ref.segmentId)) return true
        if (ref.segmentId.startsWith('t')) {
          const fact = context?.previous?.carried?.find(part => part.segmentId === ref.segmentId)
          if (context?.protocol !== 2 || item.sourceEvidence.length !== 1 || !fact || supported && fact.depth >= 16
            || fact.field !== item.path.split('.')[1] || fact.claim !== claims.find(claim => claim.path === item.path)?.claim
            || !fact.anchors.some(anchor => anchor.quote.includes(ref.quote))) return true
        }
        return !segments.some(segment => segment.segmentId === ref.segmentId && segment.quote.includes(ref.quote))
      })
    })) return null
    if (verdicts.length !== claims.length || new Set(verdicts.map(item => item.path)).size !== verdicts.length
      || verdicts.some(item => !claims.some(claim => claim.path === item.path)
        || new Set(item.segmentIds).size !== item.segmentIds.length
        || item.verdict === 'supported' && item.segmentIds.length === 0
        || item.segmentIds.some(id => !segments.some(segment => segment.segmentId === id)))) return null
    return { version: context ? 2 : 1, ...(context ? { evidenceContextHash: runtimeJson(context).hash } : {}), candidate, contentHash: runtimeJson({ content }).hash,
      candidateHash: runtimeJson(candidate).hash, responseHash: runtimeJson({ raw }).hash,
      supported: verdicts.every(item => item.verdict === 'supported'),
      verdicts: verdicts.map(item => ({ ...item, evidence: item.segmentIds.map(id => {
        if (id.startsWith('t')) {
          const fact = context!.previous!.carried!.find(part => part.segmentId === id)!
          return { segmentId: id, proofHash: fact.proofHash, anchors: fact.anchors }
        }
        const segment = segments.find(part => part.segmentId === id)!
        const start = Number(id.slice(1)) * 300
        return { segmentId: id, start, end: start + segment.quote.length, hash: runtimeJson({ text: segment.quote }).hash }
      }) })) }
  } catch { return null }
}

export function readTerminalCandidate(validation: unknown): TerminalCandidate | undefined {
  const record = validation && typeof validation === 'object' ? validation as Record<string, unknown> : {}
  const parsed = terminalCandidateSchema.safeParse(record.terminalCandidate)
  return parsed.success ? parsed.data : undefined
}

/** Reparse the saved independent response against today's body. A main-agent
 * supplied proof/quote is never accepted as a semantic attestation. */
export function currentTerminalReview(validation: unknown, content: string, expectedContext?: TerminalEvidenceContext) {
  const record = validation && typeof validation === 'object' ? validation as Record<string, unknown> : {}
  const candidate = readTerminalCandidate(validation)
  const audit = record.continuityCriticResponse as { parserVersion?: number; terminalEvidence?: unknown; terminalCandidate?: unknown; terminalContentHash?: unknown; rawResponse?: { content?: unknown; complete?: boolean } } | undefined
  const frozenCandidate = terminalCandidateSchema.safeParse(audit?.terminalCandidate)
  if (!candidate || !frozenCandidate.success || runtimeJson(candidate).hash !== runtimeJson(frozenCandidate.data).hash
    || audit?.terminalContentHash !== runtimeJson({ content }).hash
    || audit?.rawResponse?.complete !== true || typeof audit.rawResponse.content !== 'string') return null
  if (audit.parserVersion === 8 ? !expectedContext || runtimeJson(audit.terminalEvidence).hash !== runtimeJson(expectedContext).hash : expectedContext !== undefined) return null
  try {
    const raw: unknown = JSON.parse(audit.rawResponse.content)
    return typeof raw === 'string' ? inspectTerminalReview(candidate, content, raw, record.independentCheck === 'complete', expectedContext) : null
  } catch { return null }
}

export function terminalReviewFailure(validation: unknown, content: string, context?: TerminalEvidenceContext) {
  if (!readTerminalCandidate(validation)) return null
  const review = currentTerminalReview(validation, content, context)
  if (review?.supported) return null
  return { outcome: 'failed' as const, failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED', summary: '终态候选尚未获正文证实',
    output: `正文与候选均保留，终态未提交；不把连续性 findings 为空当作终态通过。${review
      ? `逐项核验：${JSON.stringify(review.verdicts.map(item => ({ path: item.path, verdict: item.verdict, evidence: item.evidence })))}`
      : '独立响应缺少完整逐项判定或有效 current 原文编号，不能补造证据。'}核对真实正文后，调用 continuity_validate，以 terminalState={exitState,lastUnfinishedAction} 传入完整准确候选重检。候选任何改动（含删除未知项）都须重新核验；重检通过后才可 chapter_bridge_commit，提交同一候选或省略状态复用。不得把计划、推断或转述改称实况，也不要清空已知状态绕过核验。` }
}
