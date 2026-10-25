import { z } from 'zod'
import { runtimeJson } from './runtime-common.js'
import { continuitySourceCatalog, resolveContinuitySources, type ContinuityBodies } from './continuity-review-context.js'
import { invalidContinuitySourceClaim } from './continuity-source-authority.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
export const manualReviewRepairManifestSchema = z.object({ version: z.literal(1), originalTaskId: z.string().min(1),
  operationId: z.string().regex(/^mrr_[a-f0-9]{56}$/u), failedAssessmentKey: digest,
  originalRawHashes: z.array(digest).length(2), originalFindings: z.array(z.unknown()).max(30) }).strict()
export const manualFindingDispositionSchema = z.object({ index: z.number().int().nonnegative(), action: z.enum(['confirm', 'retract', 'replace']),
  reason: z.string().trim().min(1).max(1000), sourceEvidence: z.array(z.object({ segmentId: z.string().regex(/^c[0-9]+$/u) }).strict()).min(1).max(8),
  findingId: z.string().regex(/^f[0-9]+$/u).optional() }).strict()
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Every old opinion remains a named decision. Explanatory prose is never
 * parsed as a quote; only explicit source addresses become manuscript proof. */
export function validManualFindingDispositions(manual: z.infer<typeof manualReviewRepairManifestSchema>, value: unknown,
  findings: unknown[], bodies: ContinuityBodies) {
  const parsed = z.array(manualFindingDispositionSchema).safeParse(value)
  if (!parsed.success || parsed.data.length !== manual.originalFindings.length
    || new Set(parsed.data.map(row => row.index)).size !== parsed.data.length) return false
  const sources = continuitySourceCatalog(bodies).continuitySources
  return parsed.data.every(row => {
    if (row.index >= manual.originalFindings.length || row.sourceEvidence.some(ref => !sources.some(source => source.segmentId === ref.segmentId))) return false
    if (row.action === 'retract') return row.findingId === undefined
    const final = findings.find(finding => object(finding).findingId === row.findingId)
    if (!final) return false
    if (row.action === 'replace') return true
    const original = object(manual.originalFindings[row.index]), current = object(final)
    if (['signal', 'severity', 'suggestion'].some(key => original[key] !== current[key])) return false
    const description = typeof original.evidence === 'string' ? original.evidence : original.reason
    if (typeof description !== 'string' || current.reason !== description) return false
    const refs = Array.isArray(current.sourceEvidence) ? current.sourceEvidence.map(value => {
      const ref = object(value), source = sources.find(source => source.segmentId === ref.segmentId)
      return source ? { source: source.source, quote: ref.quote ?? source.quote } : null
    }) : []
    const addressed = { ...original, sourceEvidence: Array.isArray(original.sourceEvidence) ? original.sourceEvidence.map(value => {
      const ref = object(value), source = sources.find(source => source.segmentId === ref.segmentId)
      return ref.source === undefined && source ? { ...ref, source: source.source } : ref
    }) : [] }
    const bound = object(resolveContinuitySources(addressed, bodies, 3))
    if (!refs.length || refs.some(ref => !ref) || runtimeJson({ refs: bound.sourceEvidence }).hash !== runtimeJson({ refs }).hash) return false
    if (typeof original.evidence !== 'string') return true
    return !invalidContinuitySourceClaim(bound as Parameters<typeof invalidContinuitySourceClaim>[0], bodies,
      bound.sourceEvidence as Parameters<typeof invalidContinuitySourceClaim>[2])
  })
}

export function manualReviewRepairOperationId(taskId: string, failedAssessmentKey: string, frozenIdentity: unknown) {
  return `mrr_${runtimeJson({ kind: 'manual_review_repair', taskId, failedAssessmentKey, frozenIdentity }).hash.slice(0, 56)}`
}
