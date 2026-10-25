/** Recovery journals remain durable evidence, not author deliverables. Match
 * producer markers, never titles, empty content or the report type alone. */
export function isInternalAgentArtifact(record: { artifactType: string; metadata?: unknown }): boolean {
  if (record.artifactType !== 'continuityReview' || !record.metadata || typeof record.metadata !== 'object'
    || Array.isArray(record.metadata)) return false
  const meta = record.metadata as Record<string, unknown>
  if (meta.version !== 1) return false
  return meta.kind === 'terminalCandidatePatch' || [
    'effectiveContinuityReport', 'continuityPhaseClaim', 'continuitySourceRecovery', 'continuitySupplementQuestion',
    'continuitySupplementAnswer', 'continuitySupplementUsage', 'continuitySupplementDispatch', 'continuitySupplementResponse',
    'continuitySupplementApplication', 'continuitySupplementExecution', 'continuityUsageAccounted', 'continuityProseRevision',
    'continuityMergedRevision', 'continuityRevisionApplied', 'legacyContinuityVerification',
  ].some(key => meta[key] !== null && typeof meta[key] === 'object' && !Array.isArray(meta[key])) || [
    'continuityAssessmentRequestKey', 'assessmentRequestOwnerKey', 'assessmentResponseKey', 'assessmentApplicationKey',
    'firstAssessmentNotDispatchedKey', 'fullReassessmentKey', 'fullReassessmentNotDispatchedKey',
    'evidenceCorrectionKey', 'correctionClaimKey',
    'assessmentReservationId', 'assessmentAppliedReservationId', 'correctionAppliedObservationId', 'continuityAssessmentAdmissionId',
  ].some(key => typeof meta[key] === 'string')
}
