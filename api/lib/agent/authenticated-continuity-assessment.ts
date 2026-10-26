import { inspectContinuityResponse } from './continuity-format-recovery.js'
import { inspectContinuityV4, validateStoredContinuityV4Projection, type ContinuityReviewManifest, type ContinuityV4Inspection } from './continuity-review-v4.js'
import { terminalCandidateSchema, type TerminalCandidate } from './terminal-candidate-contract.js'
import { inspectTerminalReview } from './terminal-review-engine.js'
import type { ContinuityBodies } from './continuity-review-context.js'
import type { ContinuitySourceScope } from './continuity-source-authority.js'
import { validContinuitySparseProjection } from './continuity-response-repair.js'
import { validEmptyOptionalProposalProjection } from './continuity-empty-proposal-projection.js'
import { validateStoredExplicitSourceProjection } from './continuity-explicit-source-projection.js'
import { runtimeJson } from './runtime-common.js'

export type LegacyContinuityInspection = ReturnType<typeof inspectContinuityResponse>
export type AuthenticatedContinuityInspection = LegacyContinuityInspection | ContinuityV4Inspection
export const isContinuityV4Inspection = (value: AuthenticatedContinuityInspection): value is ContinuityV4Inspection => value.audit.parserVersion === 9 || value.audit.parserVersion === 10
export function assertLegacyContinuityInspection(value: AuthenticatedContinuityInspection): asserts value is LegacyContinuityInspection {
  if (isContinuityV4Inspection(value)) throw Error('A v4 response cannot enter a frozen legacy parser')
}

/** Exact request version dispatch. Database adapters still authenticate the
 * original owner, reservation, raw transport and known priced usage first. */
export function inspectAuthenticatedContinuityAssessment(raw: string, input: {
  bodies: ContinuityBodies; parserVersion?: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10; terminalCandidate?: TerminalCandidate;
  sourceScope?: ContinuitySourceScope; continuityManifest?: ContinuityReviewManifest; reassessmentProtocol?: 2 | 3 | 4 | 5 | 6 | 7;
}, complete: boolean): AuthenticatedContinuityInspection {
  if (input.parserVersion === 9 || input.parserVersion === 10) {
    if (!input.continuityManifest || !input.terminalCandidate || !input.sourceScope
      || input.reassessmentProtocol !== (input.parserVersion === 10 ? 7 : 6)
      || (input.parserVersion === 10) !== !!input.continuityManifest.typedLineage) throw Error('Frozen v4 request missing manifest or contract')
    return inspectContinuityV4(raw, { manifest: input.continuityManifest, bodies: input.bodies, candidate: input.terminalCandidate, sourceScope: input.sourceScope }, complete)
  }
  return inspectContinuityResponse(raw, input.bodies, complete, input.parserVersion ?? 6, input.terminalCandidate, input.sourceScope,
    input.reassessmentProtocol === 3 || input.reassessmentProtocol === 4 || input.reassessmentProtocol === 5 ? { responseContract: 3 } : {})
}

/** Shared synchronous proof consumer. Legacy replay is byte-for-byte the old
 * terminal gate; v4 replays the entire common manifest/first/repair lineage. */
export function readAuthenticatedContinuityAssessment(value: unknown, content: string, context: ContinuityBodies['terminalEvidence'], complete: boolean) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const audit = value as Record<string, unknown>
  if (audit.parserVersion === 9 || audit.parserVersion === 10 || audit.continuityV4 !== undefined) {
    const rebuilt = validateStoredContinuityV4Projection(value, content, context)
    return complete && rebuilt?.complete && rebuilt.terminalReview ? { ...rebuilt.terminalReview,
      ...(audit.parserVersion === 10 ? { establishedIssuesComplete: Array.isArray(rebuilt.parsed?.record.issueDispositions)
        && rebuilt.parsed.record.issueDispositions.every(row => !!row && typeof row === 'object' && (row as Record<string, unknown>).outcome !== 'unknown'),
        establishedIssueDispositions: (rebuilt.parsed?.record.issueDispositions as Array<{ issueIndex: number; outcome: string; explanation: string }> ?? []).map(row => ({ ...row,
          issue: rebuilt.audit.continuityV4.manifest.typedLineage?.establishedIssues[row.issueIndex] })) } : {}) } : null
  }
  if (audit.sourceProjection !== undefined && !validateStoredExplicitSourceProjection(audit, content, context)) return null
  if (!validEmptyOptionalProposalProjection(audit, content, context) || !validContinuitySparseProjection(audit, content, context)) return null
  const candidate = terminalCandidateSchema.safeParse(audit.terminalCandidate), rawReceipt = audit.rawResponse as { complete?: unknown; content?: unknown } | undefined
  if (!candidate.success || audit.terminalContentHash !== runtimeJson({ content }).hash || rawReceipt?.complete !== true || typeof rawReceipt.content !== 'string'
    || (audit.parserVersion === 8 ? !context || runtimeJson(audit.terminalEvidence).hash !== runtimeJson(context).hash : context !== undefined)) return null
  try {
    const raw: unknown = JSON.parse(rawReceipt.content)
    return typeof raw === 'string' && (audit.responseContract === undefined || audit.responseContract === 3)
      ? inspectTerminalReview(candidate.data, content, raw, complete, context, undefined, audit.responseContract === 3 ? { responseContract: 3 } : {}) : null
  } catch { return null }
}

/** A complete returned protocol failure is distinct from a missing response. */
export function knownFinalContinuityFailure(audit: { parserVersion?: number; classification?: string }) {
  return audit.parserVersion === 9 || audit.parserVersion === 10 ? ['projection_invalid', 'json_invalid', 'duplicate_keys', 'ambiguous_envelope', 'envelope_invalid', 'response_too_large'].includes(audit.classification ?? '')
    : audit.parserVersion === 8 && audit.classification === 'source_invalid'
}
