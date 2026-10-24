import { createHash } from 'node:crypto'
import type { TaskSpec } from '../../../shared/contracts/index.js'
import type { ChapterReviewReadiness } from './chapter-review-guard.js'

/** A persisted terminal judgment needs a short processing sequence, not just
 * one read. These are consumed handoff receipts, never semantic progress,
 * review permissions or additional credit. Resume/report IDs cannot refill it. */
export function terminalFeedbackSlots(review: ChapterReviewReadiness | null,
  subject: { userId: string; novelId: string; taskSpec: TaskSpec }): string[] | null {
  const evidence = review?.progressEvidence, spec = subject.taskSpec
  const completeJudgment = review?.continuity === 'complete' && review.terminalReview?.state === 'unverified'
    && !!review.terminalReview.unresolved.length && evidence?.phases.includes('terminal')
  const candidateCorrection = review?.continuity === 'incomplete' && !review.ready && review.terminalReview?.state === 'unverified'
    && review.requiredTools.some(tool => tool.name === 'continuity_validate') && review.terminalCorrection?.version === 1
    && !!review.terminalCorrection.paths.length && /^[a-f0-9]{64}$/u.test(review.terminalCorrection.candidateHash)
  if (!review || review.terminalReview?.deliveryEligible || !evidence || !completeJudgment && !candidateCorrection
    || evidence.taskId !== spec.id || evidence.userId !== subject.userId || evidence.novelId !== subject.novelId
    || evidence.chapterId !== review.chapterId || spec.scope.novelId !== subject.novelId
    || !/^[a-f0-9]{64}$/u.test(evidence.contentHash) || !['write', 'revise'].includes(spec.intent)
    || ['conversation_only', 'proposal_only'].includes(spec.writingPacing ?? '')
    || !(spec.scope.writing?.kind === 'bounded'
      ? spec.scope.writing.targets.some(target => target.orderIndex === evidence.orderIndex
        && (!target.chapterId || target.chapterId === evidence.chapterId))
      : spec.scope.chapterIds?.includes(evidence.chapterId))) return null
  return Array.from({ length: 4 }, (_, slot) => createHash('sha256').update(JSON.stringify({
    kind: 'terminal-feedback-handoff', protocol: 3, userId: evidence.userId, novelId: evidence.novelId,
    taskId: evidence.taskId, chapterId: evidence.chapterId, contentHash: evidence.contentHash, slot,
  })).digest('hex'))
}

/** Reuse the existing persisted feedback ledger. A completed bootstrap can be
 * retired after a crash without repeating its paid request or refilling slots. */
export function terminalCorrectionReceiptKey(slots: string[]) {
  return createHash('sha256').update(JSON.stringify({ kind: 'terminal-candidate-correction-handoff', slots })).digest('hex')
}
