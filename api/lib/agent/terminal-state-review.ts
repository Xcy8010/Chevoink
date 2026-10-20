import { z } from 'zod'
import { storyStateSchema } from '../../../shared/contracts/story-compiler-contracts.js'
import { continuitySourceSegments } from './continuity-review-context.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import { runtimeJson } from './runtime-common.js'

export const terminalCandidateSchema = z.object({
  exitState: storyStateSchema,
  lastUnfinishedAction: z.string().max(1000).default(''),
}).strict()
export type TerminalCandidate = z.infer<typeof terminalCandidateSchema>
export const terminalVerdictSchema = z.object({ path: z.string().max(100),
  verdict: z.enum(['supported', 'unknown', 'planned', 'negated', 'attributed']),
  segmentIds: z.array(z.string().regex(/^c[0-9]+$/)).max(8),
}).strict()

/** Paths preserve subject, polarity and temporal wording; never normalize a claim
 * into a different fact. Empty values mean unknown, not a negative assertion. */
export function terminalClaims(candidate: TerminalCandidate) {
  return Object.entries(candidate.exitState).flatMap(([key, value]) => Array.isArray(value)
    ? value.map((claim, index) => ({ path: `exitState.${key}.${index}`, claim }))
    : value?.trim() ? [{ path: `exitState.${key}`, claim: value }] : [])
    .concat(candidate.lastUnfinishedAction.trim() ? [{ path: 'lastUnfinishedAction', claim: candidate.lastUnfinishedAction }] : [])
}

export function terminalReviewInput(candidate?: TerminalCandidate) {
  if (!candidate) return ''
  return `待提交终态候选（仅是主写者的主张，绝非证据）：${JSON.stringify(terminalClaims(candidate))}\n除 findings 外必须输出 terminalVerdicts 数组，每个 path 恰好一项：{path,verdict,segmentIds}。verdict=supported 仅表示当前正文明确支持同一人物/物品、同一时刻的该完整状态；segmentIds 只选服务端 current 原文编号 c0、c1 等，不写 quote、不编造编号。计划/将来/假设用 planned，含糊推断或未记载用 unknown，正文否定该主张用 negated，仅他人传言/引用而未确证用 attributed。疼痛不等于骨裂，人物怀疑不等于人物知道；前章事实或 Scene Task 不能代替当前章终态。负面主张本身若被原文明确支持可 supported。某状态先发生后被解除，不是章末仍成立。未知项保留原主张及未确认判定，不静默删除或将空数组当全部通过。无候选事实时 terminalVerdicts=[]。`
}

/** A critic selects server-owned spans. It cannot supply or rewrite evidence.
 * Source existence is checked here; entailment is the independent critic's
 * explicit, exhaustive judgment, never inferred from a substring match. */
export function inspectTerminalReview(candidate: TerminalCandidate, content: string, raw: string, complete: boolean) {
  if (!complete) return null
  try {
    const record = parseQualityJsonObject(raw, 'continuity', 3) as Record<string, unknown>
    const parsed = z.array(terminalVerdictSchema).max(200).safeParse(record.terminalVerdicts)
    if (!parsed.success) return null
    const claims = terminalClaims(candidate), verdicts = parsed.data
    const segments = continuitySourceSegments({ previous: null, current: content })
    if (verdicts.length !== claims.length || new Set(verdicts.map(item => item.path)).size !== verdicts.length
      || verdicts.some(item => !claims.some(claim => claim.path === item.path)
        || new Set(item.segmentIds).size !== item.segmentIds.length
        || item.verdict === 'supported' && item.segmentIds.length === 0
        || item.segmentIds.some(id => !segments.some(segment => segment.segmentId === id)))) return null
    return { version: 1 as const, candidate, contentHash: runtimeJson({ content }).hash,
      candidateHash: runtimeJson(candidate).hash, responseHash: runtimeJson({ raw }).hash,
      supported: verdicts.every(item => item.verdict === 'supported'),
      verdicts: verdicts.map(item => ({ ...item, evidence: item.segmentIds.map(id => {
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
export function currentTerminalReview(validation: unknown, content: string) {
  const record = validation && typeof validation === 'object' ? validation as Record<string, unknown> : {}
  const candidate = readTerminalCandidate(validation)
  const audit = record.continuityCriticResponse as { terminalCandidate?: unknown; terminalContentHash?: unknown; rawResponse?: { content?: unknown; complete?: boolean } } | undefined
  const frozenCandidate = terminalCandidateSchema.safeParse(audit?.terminalCandidate)
  if (!candidate || !frozenCandidate.success || runtimeJson(candidate).hash !== runtimeJson(frozenCandidate.data).hash
    || audit?.terminalContentHash !== runtimeJson({ content }).hash
    || audit?.rawResponse?.complete !== true || typeof audit.rawResponse.content !== 'string') return null
  try {
    const raw: unknown = JSON.parse(audit.rawResponse.content)
    return typeof raw === 'string' ? inspectTerminalReview(candidate, content, raw, record.independentCheck === 'complete') : null
  } catch { return null }
}

export function terminalReviewFailure(validation: unknown, content: string) {
  if (!readTerminalCandidate(validation)) return null
  const review = currentTerminalReview(validation, content)
  if (review?.supported) return null
  return { outcome: 'failed' as const, failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED', summary: '终态候选尚未获正文证实',
    output: `正文与候选均保留，终态未提交；不把连续性 findings 为空当作终态通过。${review
      ? `逐项核验：${JSON.stringify(review.verdicts.map(item => ({ path: item.path, verdict: item.verdict, evidence: item.evidence })))}`
      : '独立响应缺少完整逐项判定或有效 current 原文编号，不能补造证据。'}核对真实正文后，调用 continuity_validate，以 terminalState={exitState,lastUnfinishedAction} 传入完整准确候选重检。候选任何改动（含删除未知项）都须重新核验；重检通过后才可 chapter_bridge_commit，提交同一候选或省略状态复用。不得把计划、推断或转述改称实况，也不要清空已知状态绕过核验。` }
}
