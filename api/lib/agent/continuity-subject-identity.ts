import { z } from 'zod'
import { terminalCandidateSchema } from './terminal-candidate-contract.js'
import { terminalEvidenceContextSchema } from './terminal-evidence-context.js'
import { terminalCandidateFacts } from './terminal-fact-identity.js'
import { terminalProofCatalog } from './terminal-proof-verdict.js'
import { continuitySourceScopeSchema } from './continuity-source-authority.js'
import { runtimeJson } from './runtime-common.js'

/** Protocol/rendering selectors never create a new paid judgment. Frozen
 * requests still bind their exact parser, prompt, manifest and call identity. */
export function continuitySubjectIdentity(value: unknown) {
  const parsed = z.object({ chapterId: z.string(), revision: z.number().int(), targetType: z.literal('story_compilation'), targetId: z.string(),
    bodies: z.object({ previous: z.string().nullable(), current: z.string(), terminalEvidence: terminalEvidenceContextSchema }),
    terminalCandidate: terminalCandidateSchema, sourceScope: continuitySourceScopeSchema }).safeParse(value)
  if (!parsed.success) return null
  const input = parsed.data, context = input.bodies.terminalEvidence, facts = terminalCandidateFacts(input.terminalCandidate)
  const factIds = new Set(facts.map(fact => fact.id)), catalog = context.proposalChanges
  const uniqueFacts = [...new Map(facts.map(({ id, field, claim }) => [id, { id, field, claim }])).values()].sort((a, b) => a.id.localeCompare(b.id))
  return runtimeJson({ chapterId: input.chapterId, revision: input.revision, targetType: input.targetType, targetId: input.targetId,
    current: context.current, previousContent: input.bodies.previous, sourceScope: input.sourceScope,
    previous: context.previous ? { id: context.previous.id, revision: context.previous.revision, orderIndex: context.previous.orderIndex, contentHash: context.previous.contentHash,
      ...(context.previous.carried ? { carried: context.previous.carried.map(({ segmentId: _address, ...fact }) => fact).sort((a, b) => a.proofHash.localeCompare(b.proofHash)) } : {}) } : null,
    facts: uniqueFacts, selectedProofs: terminalProofCatalog(input.terminalCandidate, context).map(item => item.fact.proofHash).sort(),
    coverage: context.factCoverage ? { taskId: context.factCoverage.taskId, chapterId: context.factCoverage.chapterId, obligations: [...context.factCoverage.obligations].sort((a, b) => a.id.localeCompare(b.id)) } : null,
    proposals: catalog ? { taskId: catalog.taskId, chapterId: catalog.chapterId, bodyHash: catalog.bodyHash, sourceHash: catalog.sourceHash,
      verifiedFactIds: [...catalog.verifiedFactIds].filter(id => !factIds.has(id)).sort(), proposals: [...catalog.proposals].sort((a, b) => a.id.localeCompare(b.id)) } : null }).hash
}
export function sameContinuitySubject(left: unknown, right: unknown) {
  const key = continuitySubjectIdentity(left)
  return key !== null && key === continuitySubjectIdentity(right)
}

/** Same subject projection for immutable native work. This digest is not an
 * admission: adapters authenticate the parent/children before using it. */
export function continuityWorkSubjectIdentity(value: unknown) {
  const parsed = z.object({ kind: z.literal('check'), chapter: z.object({ id: z.string(), revision: z.number().int() }),
    compiler: z.object({ id: z.string() }), sourceBodies: z.unknown(), terminalCandidate: z.unknown(), sourceScope: z.unknown() }).safeParse(value)
  return parsed.success ? continuitySubjectIdentity({ chapterId: parsed.data.chapter.id, revision: parsed.data.chapter.revision,
    targetType: 'story_compilation', targetId: parsed.data.compiler.id, bodies: parsed.data.sourceBodies,
    terminalCandidate: parsed.data.terminalCandidate, sourceScope: parsed.data.sourceScope }) : null
}
