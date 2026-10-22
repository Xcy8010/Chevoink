import { expect, it } from 'vitest'
import { isInternalAgentArtifact } from '../../api/lib/agent/artifact-visibility.js'

it('keeps private request/recovery journals out of deliverables without changing their records', () => {
  for (const metadata of [{ version: 1, kind: 'terminalCandidatePatch' }, ...[
    'continuityAssessmentRequestKey', 'assessmentRequestOwnerKey', 'assessmentResponseKey', 'assessmentApplicationKey',
    'firstAssessmentNotDispatchedKey', 'fullReassessmentKey', 'fullReassessmentNotDispatchedKey',
    'evidenceCorrectionKey', 'correctionClaimKey',
    'assessmentReservationId', 'assessmentAppliedReservationId', 'correctionAppliedObservationId', 'continuityAssessmentAdmissionId',
  ].map(key => ({ version: 1, [key]: 'owned-request' }))]) {
    const artifact = { artifactType: 'continuityReview', metadata }, before = JSON.stringify(artifact)
    expect(isInternalAgentArtifact(artifact)).toBe(true)
    expect(JSON.stringify(artifact)).toBe(before)
    expect(isInternalAgentArtifact({ ...artifact, artifactType: 'draft' })).toBe(false)
  }
})

it('does not expose observed correction responses as a saveable author summary', () => {
  expect(isInternalAgentArtifact({ artifactType: 'continuityReview', metadata: {
    version: 1, assessmentReservationId: 'owned-reservation', rawResponse: { version: 1, encoding: 'json-string', content: 'private response' },
  } })).toBe(true)
})

it('retains author continuity reports, empty deliverables and unrecognized metadata', () => {
  for (const metadata of [undefined, null, [], {}, { version: 1, findings: [] }, { version: 1, kind: 'report' },
    { version: 2, fullReassessmentKey: 'not-the-known-producer' }, { version: 1, assessmentResponseKey: null }]) {
    expect(isInternalAgentArtifact({ artifactType: 'continuityReview', metadata })).toBe(false)
  }
})
