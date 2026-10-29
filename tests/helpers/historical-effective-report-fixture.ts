import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { effectiveContinuityReportSchema } from '../../api/lib/agent/continuity-coordinator.js'

/** An immutable stored row for read-only pre-refactor replay tests. No request,
 * claim, provider, current report binding or application function is called. */
export function historicalEffectiveReportFixture(input: { runId: string; compilationId: string; audit: unknown; previousValidation?: unknown }) {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const audit = object(input.audit), marker = object(audit.continuityV4), manifest = object(marker.manifest), previous = object(input.previousValidation)
  if (audit.parserVersion !== 10 || audit.classification !== 'complete' || typeof manifest.hash !== 'string') throw Error('Historical row requires its complete original parser10 audit')
  const reportHash = runtimeJson(audit).hash, lineageHash = runtimeJson({ assessmentRequest: audit.assessmentRequest ?? null,
    ...(audit.phaseRequest ? { phaseRequest: audit.phaseRequest } : {}), ...(marker.projectionNormalization ? { projectionNormalization: marker.projectionNormalization } : {}),
    manifest: marker.manifest, first: marker.first, repair: marker.repair ?? null }).hash
  const id = runtimeJson({ kind: 'continuity_report', compilationId: input.compilationId, reportHash }).hash
  const pointer = effectiveContinuityReportSchema.parse({ version: 1, reportArtifactId: id, reportHash, manifestHash: manifest.hash, lineageHash })
  const artifact = { id, runId: input.runId, artifactType: 'continuityReview', metadata: runtimeJson({ version: 1, effectiveContinuityReport: {
    compilationId: input.compilationId, reportHash, manifestHash: manifest.hash, lineageHash, audit,
    supersedes: previous.effectiveReport ?? null, previousAuditHash: previous.continuityCriticResponse === undefined ? null : runtimeJson(previous.continuityCriticResponse).hash } }).value }
  return { pointer, artifact }
}
