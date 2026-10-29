import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { bindContinuityOpinions, buildContinuitySnapshot, type ContinuityOpinion, type ContinuityReport } from '../../api/lib/agent/continuity-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

/** Current unit storage evidence uses the production owned-source snapshot and
 * source-address binder. Historical validation remains unchanged and readable. */
export async function currentReviewReadinessFixture(db: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string },
  compilation: { id: string; chapterId?: string | null; validation: unknown }, opinions: ContinuityOpinion[] | ((snapshot: Awaited<ReturnType<typeof buildContinuitySnapshot>>) => ContinuityOpinion[]) = []) {
  const raw = compilation.validation && typeof compilation.validation === 'object' && !Array.isArray(compilation.validation)
    ? compilation.validation as Record<string, unknown> : {}
  const snapshot = await buildContinuitySnapshot(subject, { compilationId: compilation.id, ...(compilation.chapterId ? { chapterId: compilation.chapterId } : {}),
    ...(typeof raw.reviewFocus === 'string' ? { focus: raw.reviewFocus } : {}) }, db)
  const actual = typeof opinions === 'function' ? opinions(snapshot) : opinions
  const located = bindContinuityOpinions(actual, snapshot.sources)
  const report: ContinuityReport = { version: 1, id: runtimeJson({ context: snapshot.contextHash, opinions: actual }).hash,
    taskId: snapshot.original.taskId, chapterId: snapshot.chapter.id, revision: snapshot.chapter.revision,
    contextHash: snapshot.contextHash, contentHash: createHash('sha256').update(snapshot.chapter.content).digest('hex'),
    sourceVersions: snapshot.sources.map(source => ({ chapterId: source.chapterId, revision: source.revision, contentHash: source.table.contentHash })),
    complete: located.unlocatedIndexes.length === 0, ...located, opinions: actual, rawResponses: [JSON.stringify({ findings: actual })],
    usageIds: [], billingKnown: true }
  compilation.validation = { ...raw, continuityReport: report }
  return report
}
