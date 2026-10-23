import { z } from 'zod'
import { DataAccessError } from '../prisma.js'
import { runtimeJson } from './runtime-common.js'
import type { TerminalCandidate, inspectTerminalReview } from './terminal-state-review.js'
import { terminalQuoteRange } from './terminal-quote-range.js'
import { terminalCandidateFacts, terminalFactId } from './terminal-fact-identity.js'
import type { readCompilerContinuitySource } from './compiler-continuity-source.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const field = z.enum(['knowledge', 'body', 'objects', 'relationships', 'openLoops'])
const fact = z.object({ id: hash, field, claim: z.string().min(1).max(1000) }).strict()
export const terminalCoverageInputSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), taskId: z.string(), chapterId: z.string(),
  obligations: z.array(fact).max(200), inheritedProofsHash: hash.optional(),
}).strict()
export type TerminalCoverageInput = z.infer<typeof terminalCoverageInputSchema>

export function terminalCoverageProofs(source: Awaited<ReturnType<typeof readCompilerContinuitySource>>, spanAddressProtocol?: 2) {
  return spanAddressProtocol === 2 && source && 'terminalInheritance' in source ? source.terminalInheritance : undefined
}
const stateSchema = z.object({ version: z.literal(1), taskId: z.string(), chapterId: z.string(), facts: z.array(fact).max(200),
  lastReview: z.object({ bodyHash: hash, candidateHash: hash, input: terminalCoverageInputSchema }).strict(),
}).strict()
export type TerminalCoverageState = z.infer<typeof stateSchema>
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const blocked = () => new DataAccessError(409, 'TERMINAL_STATE_REVIEW_REQUIRED', '持续事实覆盖记录缺失、损坏或超出有界容量；保留正文、原报告和未知结果，不能清空或重复检查绕过。')

/** Only new admissions opt in. Historical contracts, snapshots and audits stay immutable. */
export function hasTerminalCoverageProtocol(spec: unknown) {
  const version = object(object(spec).scope).terminalCoverageProtocol
  return version === 1 || version === 2
}

/** Read the response's own frozen operation contract, never today's default. */
export function terminalCoverageAuditVersion(validation: unknown): 1 | 2 | undefined {
  const audit = object(object(validation).continuityCriticResponse)
  const version = object(object(audit.terminalEvidence).factCoverage).version
  return audit.parserVersion === 8 && (version === 1 || version === 2) ? version : undefined
}

export function readTerminalCoverageState(spec: unknown, preparedContext: unknown, chapterId: string): TerminalCoverageState | undefined {
  if (!hasTerminalCoverageProtocol(spec)) return undefined
  const value = object(preparedContext).terminalFactCoverage
  if (value === undefined) return undefined
  const parsed = stateSchema.safeParse(value)
  if (!parsed.success || parsed.data.taskId !== object(spec).id || parsed.data.chapterId !== chapterId
    || object(object(spec).scope).terminalCoverageProtocol === 2 && parsed.data.lastReview.input.version !== 2
    || parsed.data.lastReview.input.taskId !== parsed.data.taskId || parsed.data.lastReview.input.chapterId !== chapterId
    || [parsed.data.facts, parsed.data.lastReview.input.obligations].some(items => new Set(items.map(item => item.id)).size !== items.length
      || items.some(item => item.id !== runtimeJson({ field: item.field, claim: item.claim }).hash))) throw blocked()
  return parsed.data
}

/** Exact included claims still need their ordinary independent verdict. Only
 * omissions add an explicit disposition; this never merges claims into state. */
export function terminalCoverageInput(spec: unknown, preparedContext: unknown, chapter: { id: string; content: string }, candidate?: TerminalCandidate,
  operationVersion?: 1 | 2, inherited?: ReadonlyArray<{ field: string; claim: string }>): TerminalCoverageInput | undefined {
  if (!hasTerminalCoverageProtocol(spec)) return undefined
  const saved = readTerminalCoverageState(spec, preparedContext, chapter.id)
  const version = operationVersion ?? (object(object(spec).scope).terminalCoverageProtocol === 2 ? 2 : 1)
  if (!candidate && !saved?.facts.length && version === 1) return undefined
  const normalized = candidate ?? { exitState: {}, lastUnfinishedAction: '' }
  // Only callers constructing the new frozen evidence scope supply these
  // server-verified predecessor proofs. Failed candidate claims are not facts.
  const priorFacts = (inherited ?? []).flatMap(item => {
    const kind = field.safeParse(item.field)
    if (!kind.success) return []
    const parsed = fact.safeParse({ id: terminalFactId(kind.data, item.claim), field: kind.data, claim: item.claim })
    if (!parsed.success) throw blocked()
    return [parsed.data]
  })
  const inheritedProofsHash = inherited === undefined ? undefined : runtimeJson([...new Set(priorFacts.map(item => item.id))].sort()).hash
  if (saved?.lastReview.input.version === version && saved.lastReview.bodyHash === runtimeJson({ content: chapter.content }).hash
    && saved.lastReview.candidateHash === runtimeJson(normalized).hash
    && (inherited === undefined || saved.lastReview.input.inheritedProofsHash === inheritedProofsHash)) return saved.lastReview.input
  const known = [...new Map([...(saved?.facts ?? []), ...priorFacts].map(item => [item.id, item])).values()]
  if (known.length > 200) throw blocked()
  const obligations = known.filter(item => !candidate
    || !candidate.exitState[item.field].includes(item.claim))
  return terminalCoverageInputSchema.parse({ version, taskId: object(spec).id, chapterId: chapter.id, obligations,
    ...(inheritedProofsHash ? { inheritedProofsHash } : {}) })
}

export const terminalDispositionSchema = z.object({ id: hash, outcome: z.enum(['replaced', 'ended', 'unknown']),
  reason: z.string().trim().min(1).max(1000), candidatePath: z.string().max(100).optional(),
  sourceEvidence: z.array(z.object({ segmentId: z.string().regex(/^c[0-9]+$/u), quote: z.string().min(2).max(300) }).strict()).max(8),
}).strict()
const addressedDisposition = terminalDispositionSchema.omit({ candidatePath: true, sourceEvidence: true }).extend({
  sourceEvidence: z.array(z.object({ segmentId: z.string().regex(/^c[0-9]+$/u), quote: z.string().min(2).max(300).optional() }).strict()).max(8),
})
export const addressedTerminalDispositionSchema = z.union([
  addressedDisposition.extend({ candidateFactId: hash.optional() }).strict(),
  addressedDisposition.extend({ candidatePath: z.string().max(100).optional() }).strict(),
])

/** Quoted source existence is mechanical; the fresh critic owns whether the
 * whole fact ended or is represented by a new independently supported claim. */
export function inspectTerminalCoverage(input: TerminalCoverageInput | undefined, raw: unknown,
  candidate: TerminalCandidate, verdicts: Array<{ path: string; verdict: string }>, segments: Array<{ segmentId: string; quote: string }>, addressed = false, diagnostics?: Array<{ code: string; path?: string }>) {
  if (!input) return undefined
  let normalized = raw ?? (input.obligations.length ? undefined : [])
  if (addressed) {
    const selected = z.array(addressedTerminalDispositionSchema).max(200).safeParse(normalized)
    if (!selected.success) { diagnostics?.push({ code: 'fact_disposition_schema_invalid', path: 'terminalDispositions' }); return null }
    const facts = terminalCandidateFacts(candidate)
    normalized = selected.data.map(item => {
      const { sourceEvidence, ...rest } = item
      const refs = sourceEvidence.map(ref => ({ ...ref, quote: ref.quote ?? segments.find(part => part.segmentId === ref.segmentId)?.quote ?? '' }))
      if ('candidateFactId' in rest && rest.candidateFactId !== undefined) {
        const matches = facts.filter(fact => fact.id === rest.candidateFactId)
        if (matches.length !== 1) return null
        const { candidateFactId: _id, ...value } = rest
        return { ...value, candidatePath: matches[0].path, sourceEvidence: refs }
      }
      return { ...rest, sourceEvidence: refs }
    })
  }
  const parsed = z.array(terminalDispositionSchema).max(200).safeParse(normalized)
  if (!parsed.success || parsed.data.length !== input.obligations.length
    || new Set(parsed.data.map(item => item.id)).size !== parsed.data.length) {
    diagnostics?.push({ code: 'fact_disposition_coverage_invalid', path: 'terminalDispositions' }); return null
  }
  if (parsed.data.some((item, index) => {
    const invalid = (code: string, suffix = '') => { diagnostics?.push({ code, path: `terminalDispositions.${index}${suffix}` }); return true }
    const obligation = input.obligations.find(fact => fact.id === item.id)
    if (!obligation) return invalid('fact_disposition_address_invalid', '.id')
    if (item.sourceEvidence.some(ref => input.version === 2 ? !terminalQuoteRange(ref, segments)
      : !segments.some(segment => segment.segmentId === ref.segmentId && segment.quote.includes(ref.quote)))) return invalid('fact_disposition_evidence_invalid', '.sourceEvidence')
    if (item.outcome === 'unknown') return item.candidatePath !== undefined && invalid('unknown_disposition_has_target', '.candidatePath')
    if (item.outcome === 'ended') return (item.candidatePath !== undefined || !item.sourceEvidence.length) && invalid('ended_disposition_invalid', '.sourceEvidence')
    const match = /^exitState\.(knowledge|body|objects|relationships|openLoops)\.([0-9]+)$/u.exec(item.candidatePath ?? '')
    if (!match || (match[1] !== obligation.field && (input.version !== 2 || !item.sourceEvidence.length))
      || !candidate.exitState[field.parse(match[1])][Number(match[2])]) return invalid('replacement_target_invalid', '.candidatePath')
    return !verdicts.some(verdict => verdict.path === item.candidatePath && verdict.verdict === 'supported')
      && invalid('replacement_target_not_supported', '.candidatePath')
  })) return null
  return { ...(input.version === 2 ? { version: 2 as const } : {}), complete: parsed.data.every(item => item.outcome !== 'unknown'), dispositions: parsed.data }
}

export function terminalCoverageGuidance(input: TerminalCoverageInput | undefined) {
  if (!input?.obligations.length) return ''
  if (input.version === 2) return '\n持续事实覆盖：仅对 factCoverage.obligations 中本次省略的事实逐 id 返回 terminalDispositions={id,outcome,reason,sourceEvidence:[{segmentId,quote}],candidatePath?} 数组。replaced 表示整个旧事实已被某条独立 supported 的持久候选完整承接；可指向 knowledge/body/objects/relationships/openLoops 任一字段，按事实本身核对对象、极性、条件及未解决义务，不因换字段或同义改写重复保留。跨字段需本章逐字证据。多条旧事实可分别明确指向同一候选。ended 只用于本章明确解除或完成且有逐字证据；unknown 保留旧义务且本次不能通过。不得把未提及当已结束，不得额外要求原主张未声称的原因；引用存在不等于整个事实获证实。无需调用新工具搬运旧表述，使用本次提供的冻结目录。'
  return '\n服务端factCoverage.obligations是此前独立证实但本候选省略的持续事实，仅作待核义务。输出terminalDispositions，每个id恰好一项：{id,outcome,reason,sourceEvidence:[{segmentId,quote}],candidatePath?}。核对全文和章末：同一事实的更新/等义表述用replaced，candidatePath指向同字段且本次supported的候选；明确解除/解决用ended及当前cN逐字证据；不能确定用unknown并保留阻碍。旧引文仍在不证明持续，未提及不证明解除；不得机械复制、清空状态或改稿证明候选。处置并入本次独立响应，不增加请求或预算。'
}

/** Called inside the original report transaction after reparsing its complete
 * independent audit. Unresolved facts survive; no main-model disposition exists. */
export function advanceTerminalCoverage(spec: unknown, preparedContext: unknown, chapter: { id: string; content: string },
  review: NonNullable<ReturnType<typeof inspectTerminalReview>>, frozenInput?: TerminalCoverageInput): TerminalCoverageState | undefined {
  if (!hasTerminalCoverageProtocol(spec)) return undefined
  // A resolved omission leaves the fact ledger. Preserve the exact reviewed
  // request so the next guard can still bind its disposition and proof scope.
  const input = frozenInput ?? terminalCoverageInput(spec, preparedContext, chapter, review.candidate, review.factCoverage?.version)
  if (!input) return undefined
  if (input.taskId !== object(spec).id || input.chapterId !== chapter.id
    || input.version !== (review.factCoverage?.version ?? 1)) throw blocked()
  const old = readTerminalCoverageState(spec, preparedContext, chapter.id)
  const resolved = new Set(review.factCoverage?.dispositions.filter(item => item.outcome !== 'unknown').map(item => item.id))
  const facts = new Map((old?.facts ?? []).filter(item => !resolved.has(item.id)).map(item => [item.id, item]))
  for (const item of review.verdicts) {
    const match = /^exitState\.(knowledge|body|objects|relationships|openLoops)\.([0-9]+)$/u.exec(item.path)
    if (item.verdict !== 'supported' || !match) continue
    const name = field.parse(match[1]), claim = review.candidate.exitState[name][Number(match[2])]
    const id = runtimeJson({ field: name, claim }).hash
    facts.set(id, { id, field: name, claim })
  }
  const parsed = stateSchema.safeParse({ version: 1, taskId: input.taskId, chapterId: chapter.id, facts: [...facts.values()],
    lastReview: { bodyHash: runtimeJson({ content: chapter.content }).hash, candidateHash: runtimeJson(review.candidate).hash, input } })
  if (!parsed.success) throw blocked()
  return parsed.data
}
