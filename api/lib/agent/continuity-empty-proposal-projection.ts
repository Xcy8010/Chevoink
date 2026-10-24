import { inspectContinuityResponse } from './continuity-format-recovery.js'
import { fixedContinuityResponseFields, assertFixedContinuityResponseFields } from './continuity-response-contract.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import { terminalReviewAddressCatalog } from './terminal-review-addresses.js'
import { continuitySourceScopeSchema } from './continuity-source-authority.js'
import type { ContinuityBodies } from './continuity-review-context.js'
import type { TerminalEvidenceContext } from './terminal-evidence-context.js'
import { runtimeJson } from './runtime-common.js'
import type { LegacyAssessmentInput } from './assessment-response-lifecycle.js'

type Inspection = ReturnType<typeof inspectContinuityResponse>
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const kind = 'empty_optional_proposal_table'
const hasOwn = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key)

/** Only rendered user-content may drift. Reviewer system, owned target, every
 * frozen source/candidate/contract field and unknown extra fields stay exact. */
export function sameEmptyOptionalProposalInput(stored: unknown, proposed: LegacyAssessmentInput): stored is LegacyAssessmentInput {
  const frozen = object(stored)
  if (!frozen || proposed.targetType !== 'story_compilation' || proposed.parserVersion !== 8
    || ![3, 4, 5].includes(proposed.reassessmentProtocol as number)
    || typeof proposed.bindingHash !== 'string' || !/^[a-f0-9]{64}$/u.test(proposed.bindingHash)
    || typeof frozen.content !== 'string' || typeof proposed.content !== 'string' || frozen.system !== proposed.system) return false
  const withoutContent = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'content'))
  try { return runtimeJson(withoutContent(frozen)).hash === runtimeJson(withoutContent(proposed)).hash }
  catch { return false }
}

function replayAudit(value: unknown, bodies: ContinuityBodies): Inspection | null {
  const audit = object(value), raw = object(audit?.rawResponse)
  if (!audit || audit.parserVersion !== 8 || audit.responseContract !== 3 || raw?.complete !== true
    || raw.encoding !== 'json-string' || typeof raw.content !== 'string') return null
  const response: unknown = JSON.parse(raw.content)
  if (typeof response !== 'string') return null
  const scope = audit.sourceScope === undefined ? undefined : continuitySourceScopeSchema.parse(audit.sourceScope)
  const inspected = inspectContinuityResponse(response, bodies, true, 8, audit.terminalCandidate as Inspection['audit']['terminalCandidate'], scope, { responseContract: 3 })
  return runtimeJson(inspected.audit).hash === runtimeJson(audit).hash ? inspected : null
}

function omitEmpty(raw: string, allowAbsent = false) {
  const parsed = object(parseQualityJsonObject(raw, 'continuity', 3)), wire = object(JSON.parse(raw))
  if (!wire || !parsed || runtimeJson(wire).hash !== runtimeJson(parsed).hash) return null
  if (!hasOwn(wire, 'proposalDispositions')) return allowAbsent ? raw : null
  if (!Array.isArray(wire.proposalDispositions) || wire.proposalDispositions.length !== 0) return null
  const projected = { ...wire }
  delete projected.proposalDispositions
  return JSON.stringify(projected)
}

/** Opt-in format recovery, separate from the frozen parser. An empty table
 * carries no judgment when no proposal catalogue exists. Every other value,
 * opinion and source is rechecked by the unchanged strict parser. */
export function recoverEmptyOptionalProposalTable(original: Inspection, bodies: ContinuityBodies,
  second?: { audit: unknown; protocol: 3 | 4 | 5 }): Inspection | null {
  try {
    const context = bodies.terminalEvidence, candidate = original.audit.terminalCandidate
    if (!context || context.verdictProtocol !== 6 || hasOwn(context, 'proposalChanges') || !candidate
      || terminalReviewAddressCatalog(candidate, context).proposals.length !== 0 || original.complete
      || original.audit.classification !== 'terminal_invalid' || !replayAudit(original.audit, bodies)) return null
    const firstRaw = omitEmpty(JSON.parse(original.audit.rawResponse.content) as string)
    if (firstRaw === null) return null
    const first = inspectContinuityResponse(firstRaw, bodies, true, 8, candidate, original.audit.sourceScope, { responseContract: 3 })
    if (!first.complete) return null
    let final = first
    if (second) {
      if (![3, 4, 5].includes(second.protocol)) return null
      const observed = replayAudit(second.audit, bodies)
      if (!observed) return null
      const secondRaw = omitEmpty(JSON.parse(observed.audit.rawResponse.content) as string, true)
      if (secondRaw === null) return null
      // This first report already has valid findings/semantic checks. Reuse
      // the same fixed-field guard as full field repair, without importing
      // the database lifecycle into the pure current/proof verifier.
      const fixed = fixedContinuityResponseFields(original)
      if (!fixed) return null
      assertFixedContinuityResponseFields(fixed, parseQualityJsonObject(secondRaw, 'continuity', 3) as Record<string, unknown>)
      final = inspectContinuityResponse(secondRaw, bodies, true, 8, candidate, original.audit.sourceScope, { responseContract: 3 })
      if (!final.complete) return null
    }
    return { ...final, audit: { ...final.audit,
      reassessment: { ...object((final.audit as Record<string, unknown>).reassessment), version: 1, kind, original: original.audit },
      formatProjection: { version: 1, kind, original: original.audit,
      frozenBodies: bodies, frozenBodiesHash: runtimeJson(bodies).hash, ...(second ? { second: { audit: second.audit, protocol: second.protocol } } : {}),
      projectedAuditHash: runtimeJson(final.audit).hash } } as Inspection['audit'] }
  } catch { return null }
}

/** All current/commit/proof/cache readers must reconstruct this marker. Saved
 * original audits remain strict failures; no parser version is reinterpreted. */
export function validEmptyOptionalProposalProjection(value: unknown, content: string, context?: TerminalEvidenceContext) {
  const saved = object(value)
  if (!saved || !hasOwn(saved, 'formatProjection')) {
    const legacyKind = object(saved?.reassessment)?.kind
    return legacyKind === undefined || ['field_repair', 'sparse_table_repair', 'sparse_table_repair_failed'].includes(legacyKind as string)
  }
  try {
    const marker = object(saved.formatProjection), bodies = object(marker?.frozenBodies), second = object(marker?.second)
    if (!marker || marker.kind !== kind || marker.version !== 1 || object(saved.reassessment)?.kind !== kind || !context || !bodies || bodies.current !== content
      || bodies.previous !== null && typeof bodies.previous !== 'string'
      || marker.frozenBodiesHash !== runtimeJson(bodies).hash
      || runtimeJson(bodies.terminalEvidence).hash !== runtimeJson(context).hash
      || hasOwn(marker, 'second') && (!second || ![3, 4, 5].includes(second.protocol as number))) return false
    const original = replayAudit(marker.original, bodies as ContinuityBodies)
    if (!original) return false
    const rebuilt = recoverEmptyOptionalProposalTable(original, bodies as ContinuityBodies,
      second ? { audit: second.audit, protocol: second.protocol as 3 | 4 | 5 } : undefined)
    if (!rebuilt) return false
    const comparable = { ...saved }
    if (hasOwn(comparable, 'assessmentRequest')) {
      const binding = object(comparable.assessmentRequest)
      if (!binding || binding.version !== 1 || Object.keys(binding).sort().join(',') !== 'inputHash,key,version'
        || ![binding.key, binding.inputHash].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash))) return false
      delete comparable.assessmentRequest
    }
    return runtimeJson(rebuilt.audit).hash === runtimeJson(comparable).hash
  } catch { return false }
}
