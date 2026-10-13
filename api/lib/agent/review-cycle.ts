import { z } from 'zod'
import { DataAccessError } from '../prisma.js'
import { runtimeJson } from './runtime-common.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const scopeSchema = z.object({ taskId: z.string().min(1), userId: z.string().min(1), novelId: z.string().min(1), chapterId: z.string().min(1) })
const refSchema = z.object({ source: z.enum(['continuity', 'quality']), reportId: z.string().min(1), findingId: z.string().min(1) })
const findingSchema = refSchema.extend({ signal: z.string(), severity: z.string(), evidence: z.string(),
  anchor: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), text: z.string().min(1) }).nullable() })
const bindingSchema = z.object({ contentHash: hash, continuityBinding: z.string(), qualityReportId: z.string().nullable(), qualityReportHash: hash.nullable() })
const bodySchema = z.object({ revision: z.number().int().nonnegative(), contentHash: hash })
const cycleSchema = z.object({ version: z.literal(1), scope: scopeSchema,
  baseline: z.object({ compilationId: z.string().min(1), body: bodySchema, binding: bindingSchema,
    required: z.object({ continuity: z.boolean(), quality: z.boolean() }), findings: z.array(findingSchema) }).nullable(),
  transitions: z.array(z.object({ before: bodySchema, after: bodySchema, contiguous: z.boolean(),
    ranges: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), newLength: z.number().int().nonnegative() })) })) })

export type ReviewCycle = z.infer<typeof cycleSchema>
export type ReviewCycleScope = z.infer<typeof scopeSchema>
export type ReviewCycleFinding = z.infer<typeof findingSchema>
export type ReviewCycleBinding = z.infer<typeof bindingSchema>
export type ReviewCyclePhase = 'assessment' | 'decisions' | 'verification' | 'resolution'
export type ReviewCycleRelation = 'initial' | 'same_issue' | 'new_advisory' | 'regression' | 'unknown'
/** Automatic style patches must not reopen final verification. Explicit
 * current decisions and ordinary author writing remain separate permissions. */
export function verificationQualityAdviceRequiresDecision(readiness: { reviewCycle?: { edited: boolean }; mustPassPending?: boolean; qualityPassRequired?: boolean } | null,
  candidates: ReadonlyArray<{ severity: string }>) {
  return readiness?.reviewCycle?.edited === true && !readiness.mustPassPending && !readiness.qualityPassRequired
    && candidates.length > 0 && candidates.every(item => item.severity !== 'error')
}
export const reviewCycleContentHash = (content: string) => runtimeJson({ content }).hash
const sameBody = (a: ReviewCycle['transitions'][number]['before'], b: typeof a) => a.revision === b.revision && a.contentHash === b.contentHash
const sameScope = (a: ReviewCycleScope, b: ReviewCycleScope) => Object.keys(a).every(key => a[key as keyof ReviewCycleScope] === b[key as keyof ReviewCycleScope])
const conflict = () => new DataAccessError(409, 'REVIEW_CYCLE_CONFLICT', '章节复查周期的任务、正文或历史转换无法核实；保留正文与真实报告，未重置周期或推断已完成。')

/** Server bookkeeping only. Missing historical evidence stays missing. */
export function readReviewCycle(context: unknown, scope: ReviewCycleScope): ReviewCycle | null {
  if (!context || typeof context !== 'object' || Array.isArray(context) || !('reviewCycle' in context)) return null
  const parsed = cycleSchema.safeParse(context.reviewCycle)
  if (!parsed.success || !sameScope(parsed.data.scope, scope)) throw conflict()
  const cycle = parsed.data
  if (cycle.baseline && (cycle.baseline.binding.contentHash !== cycle.baseline.body.contentHash
    || cycle.baseline.findings.some(item => item.anchor && (item.anchor.end <= item.anchor.start || item.anchor.end - item.anchor.start !== item.anchor.text.length)))) throw conflict()
  for (let i = 0; i < cycle.transitions.length; i++) {
    const step = cycle.transitions[i]
    if (step.after.revision !== step.before.revision + 1 || step.before.contentHash === step.after.contentHash
      || i > 0 && step.contiguous !== sameBody(cycle.transitions[i - 1].after, step.before)
      || step.ranges.some((range, index) => range.end < range.start || index > 0 && range.start < step.ranges[index - 1].end)) throw conflict()
  }
  if (cycle.baseline && cycle.transitions.length && cycle.transitions[0].contiguous !== sameBody(cycle.baseline.body, cycle.transitions[0].before)) throw conflict()
  return cycle
}

/** An anchor is evidence only when its exact body occurrence is unique. */
export function reviewCycleFinding(input: Omit<ReviewCycleFinding, 'anchor'> & { startOffset?: number | null; endOffset?: number | null }, content: string): ReviewCycleFinding {
  const { startOffset, endOffset, ...finding } = input
  const candidates = [finding.evidence, ...[...finding.evidence.matchAll(/[“「『"‘]([^”」』"’]{2,360})[”」』"’]/gu)].map(match => match[1])]
  const unique = [...new Set(candidates)].flatMap(text => {
    const start = content.indexOf(text)
    return text && start >= 0 && content.indexOf(text, start + 1) < 0 ? [{ start, end: start + text.length, text }] : []
  })
  const positioned = unique.filter(item => item.start === startOffset && item.end === endOffset)
  return { ...finding, anchor: positioned.length === 1 ? positioned[0] : unique.length === 1 ? unique[0] : null }
}

/** Capture only a genuine complete assessment; never derive it from a receipt. */
export function beginReviewCycle(scope: ReviewCycleScope, input: { compilationId: string; revision: number; content: string;
  ready: boolean; binding: ReviewCycleBinding; required: { continuity: boolean; quality: boolean }; findings: ReviewCycleFinding[] }): ReviewCycle {
  if (!input.ready || input.binding.contentHash !== reviewCycleContentHash(input.content)) throw conflict()
  return { version: 1, scope, baseline: { compilationId: input.compilationId, body: { revision: input.revision, contentHash: input.binding.contentHash },
    binding: input.binding, required: input.required, findings: input.findings }, transitions: [] }
}

/** Call after body CAS in its transaction. An unchanged body never advances it. */
export function advanceReviewCycle(cycle: ReviewCycle, input: { beforeRevision: number; before: string; afterRevision: number; after: string;
  ranges?: Array<{ start: number; end: number; newText: string }> }): ReviewCycle {
  if (input.before === input.after) return cycle
  const before = { revision: input.beforeRevision, contentHash: reviewCycleContentHash(input.before) }
  const after = { revision: input.afterRevision, contentHash: reviewCycleContentHash(input.after) }
  const previous = cycle.transitions.at(-1)?.after ?? cycle.baseline?.body
  if (after.revision !== before.revision + 1) throw conflict()
  let ranges = input.ranges?.filter(range => input.before.slice(range.start, range.end) !== range.newText)
  if (!ranges) {
    let start = 0, end = input.before.length, newEnd = input.after.length
    while (start < end && start < newEnd && input.before[start] === input.after[start]) start++
    while (end > start && newEnd > start && input.before[end - 1] === input.after[newEnd - 1]) { end--; newEnd-- }
    ranges = [{ start, end, newText: input.after.slice(start, newEnd) }]
  }
  ranges = [...ranges].sort((a, b) => a.start - b.start)
  if (ranges.some((range, index) => range.start < 0 || range.end < range.start || range.end > input.before.length
    || index > 0 && range.start < ranges[index - 1].end)) throw conflict()
  let rebuilt = input.before
  for (const range of [...ranges].reverse()) rebuilt = rebuilt.slice(0, range.start) + range.newText + rebuilt.slice(range.end)
  if (rebuilt !== input.after) throw conflict()
  return { ...cycle, transitions: [...cycle.transitions, { before, after, contiguous: !previous || sameBody(previous, before),
    ranges: ranges.map(({ start, end, newText }) => ({ start, end, newLength: newText.length })) }] }
}

function mappedAnchor(anchor: ReviewCycleFinding['anchor'], cycle: ReviewCycle) {
  if (!anchor) return null
  let current = { ...anchor }
  for (const step of cycle.transitions) {
    if (!step.contiguous) return null
    if (step.ranges.some(range => range.start < current.end && range.end > current.start
      || range.start === range.end && range.start > current.start && range.start < current.end)) return null
    const delta = step.ranges.filter(range => range.end <= current.start).reduce((sum, range) => sum + range.newLength - (range.end - range.start), 0)
    current = { ...current, start: current.start + delta, end: current.end + delta }
  }
  return current
}

/** Coordination phase and conservative issue lineage, never permission or pass. */
export function projectReviewCycle(cycle: ReviewCycle | null, input: { revision: number; contentHash: string; ready: boolean; pending: boolean; findings: ReviewCycleFinding[] }) {
  const last = cycle?.transitions.at(-1)?.after
  const verifiedTransition = !!cycle?.baseline && !!last && sameBody(last, { revision: input.revision, contentHash: input.contentHash })
  const phase: ReviewCyclePhase = !input.ready ? verifiedTransition ? 'verification' : 'assessment'
    : !input.pending ? 'resolution' : verifiedTransition ? 'verification' : 'decisions'
  const findings = input.findings.map(finding => {
    let relation: ReviewCycleRelation = verifiedTransition ? 'unknown' : 'initial'
    let baselineRef: Pick<ReviewCycleFinding, 'source' | 'reportId' | 'findingId'> | null = null
    if (verifiedTransition && finding.anchor && cycle!.transitions.every(step => step.contiguous)) {
      const same = cycle!.baseline!.findings.filter(old => {
        const mapped = mappedAnchor(old.anchor, cycle!)
        return old.source === finding.source && old.signal === finding.signal && mapped && mapped.start === finding.anchor!.start
          && mapped.end === finding.anchor!.end && mapped.text === finding.anchor!.text
      })
      if (same.length === 1) { const old = same[0]; relation = finding.severity === 'error' && old.severity !== 'error' ? 'regression' : 'same_issue';
        baselineRef = { source: old.source, reportId: old.reportId, findingId: old.findingId } }
      else if (same.length === 0 && !cycle!.baseline!.findings.some(old => old.source === finding.source && old.signal === finding.signal && !mappedAnchor(old.anchor, cycle!))) {
        // A new error is real, but its causal lineage is unknown without an
        // identified baseline issue. Mere absence from a prior report is not
        // proof that the writer introduced it.
        relation = finding.severity !== 'error' && finding.source === 'quality' ? 'new_advisory' : 'unknown'
      }
    }
    return { source: finding.source, reportId: finding.reportId, findingId: finding.findingId, relation, baselineRef }
  })
  return { version: 1 as const, phase, baselineRevision: cycle?.baseline?.body.revision ?? null,
    edited: verifiedTransition, transitionCount: cycle?.transitions.length ?? 0, findings }
}
