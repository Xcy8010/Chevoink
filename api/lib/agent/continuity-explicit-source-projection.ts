import { z } from 'zod'
import { inspectContinuityResponse } from './continuity-format-recovery.js'
import { continuityReassessmentEnvelope } from './continuity-response-contract.js'
import { continuitySourceScopeSchema } from './continuity-source-authority.js'
import type { ContinuityBodies } from './continuity-review-context.js'
import { terminalEvidenceContextSchema, type TerminalEvidenceContext } from './terminal-evidence-context.js'
import { runtimeJson } from './runtime-common.js'
import type { LegacyAssessmentInput } from './assessment-response-lifecycle.js'

type Inspection = ReturnType<typeof inspectContinuityResponse>
type Second = { audit: unknown; protocol: 2 }
const kind = 'explicit_source_evidence'
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const bindingSchema = z.object({ version: z.literal(1), key: hash, inputHash: hash }).strict()
const bodiesSchema = z.object({ current: z.string(), previous: z.string().nullable(), terminalEvidence: terminalEvidenceContextSchema.optional() }).strict()
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const hasOwn = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key)

/** Rendered guidance alone may drift. The original frozen system, source,
 * model-independent subject and every other input field remain identical. */
export function sameExplicitSourceInput(stored: unknown, proposed: LegacyAssessmentInput): boolean {
  const frozen = object(stored)
  if (!frozen || !bodiesSchema.safeParse(proposed.bodies).success
    || !['chapter', 'story_compilation'].includes(proposed.targetType) || hasOwn(proposed, 'terminalCandidate')
    || !(proposed.parserVersion === 7 && !hasOwn(proposed, 'reassessmentProtocol') && !hasOwn(proposed.bodies, 'terminalEvidence')
      || proposed.parserVersion === 8 && proposed.reassessmentProtocol === 2 && proposed.bodies.terminalEvidence?.verdictProtocol === 5)
    || !continuitySourceScopeSchema.safeParse(proposed.sourceScope).success
    || !hash.safeParse(proposed.bindingHash).success || typeof frozen.content !== 'string' || typeof proposed.content !== 'string'
    || typeof proposed.system !== 'string' || frozen.system !== proposed.system) return false
  const withoutContent = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'content'))
  try { return runtimeJson(withoutContent(frozen)).hash === runtimeJson(withoutContent(proposed)).hash }
  catch { return false }
}

function replayAudit(value: unknown, bodies: ContinuityBodies): Inspection | null {
  const audit = object(value), raw = object(audit?.rawResponse)
  if (!audit || audit.classification !== 'source_invalid' || raw?.complete !== true
    || raw.encoding !== 'json-string' || typeof raw.content !== 'string'
    || !(audit.parserVersion === 7 && !hasOwn(bodies, 'terminalEvidence') && !hasOwn(audit, 'terminalEvidence')
      || audit.parserVersion === 8 && bodies.terminalEvidence?.verdictProtocol === 5)
    || hasOwn(audit, 'terminalCandidate') || hasOwn(audit, 'terminalContentHash') || hasOwn(audit, 'responseContract')
    || hasOwn(audit, 'sourceCheckPolicy')) return null
  const response: unknown = JSON.parse(raw.content)
  if (typeof response !== 'string') return null
  const scope = audit.sourceScope === undefined ? undefined : continuitySourceScopeSchema.parse(audit.sourceScope)
  const strict = inspectContinuityResponse(response, bodies, true, audit.parserVersion as 7 | 8, undefined, scope)
  return runtimeJson(strict.audit).hash === runtimeJson(audit).hash ? strict : null
}

/** A free opt-in report projection. No raw response, finding, disposition or
 * semantic/terminal judgment is rewritten. The original audit stays a failure.
 * Database callers authenticate ownership, frozen input and unapplied lineage. */
export function recoverExplicitSourceEvidence(original: Inspection, bodies: ContinuityBodies, second?: Second): Inspection | null {
  try {
    const frozen = bodiesSchema.parse(bodies)
    if (frozen.terminalEvidence && (frozen.terminalEvidence.verdictProtocol !== 5
      || frozen.terminalEvidence.current.contentHash !== runtimeJson({ content: frozen.current }).hash)) return null
    const strict = replayAudit(original.audit, frozen)
    if (!strict || original.complete || !original.structured
      || runtimeJson({ structured: original.structured, findings: original.findings, complete: original.complete,
        candidateFindings: original.candidateFindings, invalidSourceReferences: original.invalidSourceReferences, audit: original.audit }).hash !== runtimeJson(strict).hash) return null
    let selected = strict
    let dispositionDiagnostics: NonNullable<ReturnType<typeof continuityReassessmentEnvelope>['dispositionDiagnostics']> | undefined
    if (second) {
      if (strict.audit.parserVersion !== 8 || second.protocol !== 2) return null
      const final = replayAudit(second.audit, frozen)
      if (!final) return null
      const envelope = continuityReassessmentEnvelope(strict, JSON.parse(final.audit.rawResponse.content) as string, frozen, 2,
        { dispositionProofs: 'diagnose_unapplied_body_only' })
      dispositionDiagnostics = envelope.dispositionDiagnostics
      if (dispositionDiagnostics?.some(item => item.code !== 'retract_source_proof_invalid'
        || envelope.envelope.decisions.find(decision => decision.index === item.index)?.action !== 'retract')) return null
      selected = final
    }
    const projected = inspectContinuityResponse(JSON.parse(selected.audit.rawResponse.content) as string, frozen, true, selected.audit.parserVersion, undefined,
      selected.audit.sourceScope, { sourceCheckPolicy: 'explicit_source_evidence_v1' })
    if (!projected.complete) return null
    return { ...projected, audit: { ...projected.audit, sourceProjection: { version: 1, kind,
      scope: second ? 'unapplied_body_only_final_report' : 'single_report', originalAudit: strict.audit,
      frozenBodies: frozen, frozenBodiesHash: runtimeJson(frozen).hash,
      ...(second ? { second: { audit: selected.audit, protocol: 2 }, dispositionDiagnostics: dispositionDiagnostics ?? [] } : {}),
      projectedAuditHash: runtimeJson(projected.audit).hash } } as Inspection['audit'] }
  } catch { return null }
}

/** Rebuild the full first/final lineage and the explicit policy before a saved
 * projection can be consumed. Only the separately authenticated binding may be
 * appended to this audit; unknown fields and changed frozen values are refused. */
export function validateStoredExplicitSourceProjection(value: unknown, content: string, context?: TerminalEvidenceContext): Inspection | null {
  try {
    const saved = object(value), marker = object(saved?.sourceProjection)
    if (!saved || !marker || marker.kind !== kind || marker.version !== 1) return null
    const bodies = bodiesSchema.parse(marker.frozenBodies)
    if (bodies.current !== content || marker.frozenBodiesHash !== runtimeJson(bodies).hash
      || hasOwn(bodies, 'terminalEvidence') !== (context !== undefined)
      || context !== undefined && runtimeJson(bodies.terminalEvidence).hash !== runtimeJson(context).hash) return null
    const original = replayAudit(marker.originalAudit, bodies)
    if (!original) return null
    const second = hasOwn(marker, 'second') ? object(marker.second) : null
    if (hasOwn(marker, 'second') && (!second || second.protocol !== 2 || Object.keys(second).sort().join(',') !== 'audit,protocol')) return null
    const rebuilt = recoverExplicitSourceEvidence(original, bodies, second ? { audit: second.audit, protocol: 2 } : undefined)
    if (!rebuilt) return null
    const comparable = { ...saved }
    const binding = hasOwn(comparable, 'assessmentRequest') ? bindingSchema.parse(comparable.assessmentRequest) : null
    delete comparable.assessmentRequest
    if (runtimeJson(rebuilt.audit).hash !== runtimeJson(comparable).hash) return null
    return binding ? { ...rebuilt, audit: { ...rebuilt.audit, assessmentRequest: binding } as Inspection['audit'] } : rebuilt
  } catch { return null }
}
