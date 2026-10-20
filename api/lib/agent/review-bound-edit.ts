import type { Prisma } from '@prisma/client'
import { taskSpecSchema, type TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'
import { runtimeJson } from './runtime-common.js'
import type { ReviewCycle } from './review-cycle.js'

type Boundary = Extract<NonNullable<TaskSpec['scope']['localEditBoundary']>, { version: 3 }>
type Range = { start: number; end: number; newText: string }
export type ReviewBoundEvidence = { contentHash: string; cycle: ReviewCycle | null;
  anchors: Array<{ start: number; end: number; text: string; source: 'continuity' | 'quality'; reportId: string; findingId: string }> }
const deny = () => new DataAccessError(409, 'AUTHOR_LOCAL_SCOPE', '条件修订只允许当前任务完整检查中逐字证实的问题片段；先完成检查，保留其他正文和原范围上限。')

/** Pure final-effect check. An admission baseline is never an editable span. */
export function reviewBoundEditAllowed(boundary: Boundary, chapter: { id: string; revision: number; content: string },
  evidence: ReviewBoundEvidence, after: string, ranges: Range[]) {
  const frozen = boundary.regions.find(region => region.chapterId === chapter.id)
  const currentHash = runtimeJson({ content: chapter.content }).hash
  if (!frozen || evidence.contentHash !== currentHash || after.length > frozen.maxBodyLength || !ranges.length || ranges.length > 8) return false
  let baseline = { revision: frozen.revision, contentHash: frozen.contentHash }
  if (baseline.revision !== chapter.revision || baseline.contentHash !== currentHash) {
    // Only this task's recorded contiguous body CAS transitions may advance the
    // original baseline. A new compilation/report cannot reset that baseline.
    const cycle = evidence.cycle
    if (!cycle || cycle.scope.chapterId !== chapter.id || !cycle.transitions.length) return false
    for (const step of cycle.transitions) {
      if (!step.contiguous || step.before.revision !== baseline.revision || step.before.contentHash !== baseline.contentHash) return false
      baseline = step.after
    }
    if (baseline.revision !== chapter.revision || baseline.contentHash !== currentHash) return false
  }
  const ordered = [...ranges].sort((a, b) => a.start - b.start)
  if (ordered.some((range, index) => !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 0 || range.end < range.start || range.end > chapter.content.length
    || index > 0 && (range.start < ordered[index - 1].end || range.start === ordered[index - 1].start)
    || range.start === 0 && range.end === chapter.content.length
    || !evidence.anchors.some(anchor => anchor.text.length <= 512 && anchor.text.length > 0
      && !(anchor.start === 0 && anchor.end === chapter.content.length)
      && anchor.end - anchor.start === anchor.text.length && chapter.content.slice(anchor.start, anchor.end) === anchor.text
      && (range.start === range.end ? range.start > anchor.start && range.end < anchor.end : range.start >= anchor.start && range.end <= anchor.end)
      && range.newText.length <= Math.max(32, anchor.text.length * 2)))) return false
  if (ordered.reduce((sum, range) => sum + range.end - range.start, 0) >= chapter.content.length) return false
  for (const text of frozen.protectedText) {
    const start = chapter.content.indexOf(text)
    if (start < 0 || chapter.content.indexOf(text, start + 1) >= 0 || ordered.some(range =>
      range.start < start + text.length && range.end > start || range.start === range.end && range.start > start && range.start < start + text.length)) return false
  }
  let composed = chapter.content
  for (const range of [...ordered].reverse()) composed = composed.slice(0, range.start) + range.newText + composed.slice(range.end)
  return composed === after && composed !== chapter.content
}

/** Called only inside the manuscript guard's transaction/novel lock. Never
 * accepts report IDs, finding offsets or an authorization token from tools. */
export async function assertReviewBoundEdit(tx: Prisma.TransactionClient, subject: { userId: string; novelId: string; runId: string },
  chapter: { id: string; revision: number }, boundary: Boundary,
  options: { mutation?: string; after?: string; editRanges?: Range[] }) {
  if (options.mutation !== 'range' || options.after === undefined || !options.editRanges?.length) throw deny()
  const { readWritingScope } = await import('./writing-scope.js')
  const scope = await readWritingScope(tx, subject)
  const interpretation = taskSpecSchema.parse(scope.spec).scope.writingInterpretation
  if (!interpretation || interpretation.revisionDenied || interpretation.excludedChapterIds.includes(chapter.id)
    || scope.writing?.kind !== 'bounded' || !scope.writing.targets.some(target => target.chapterId === chapter.id)) throw deny()
  const { readChapterReviewReadiness, lockChapterReviewDecisions } = await import('./chapter-review-guard.js')
  const current = await tx.chapter.findFirst({ where: { id: chapter.id, revision: chapter.revision, authorId: subject.userId,
    ...activeChapterScope(subject.novelId) }, select: { id: true, revision: true, content: true } })
  if (!current) throw deny()
  let review = await readChapterReviewReadiness(tx, subject, undefined, { reviewBoundEvidence: true })
  if (review?.qualityReportId) {
    await lockChapterReviewDecisions(tx, review.qualityReportId)
    review = await readChapterReviewReadiness(tx, subject, review.compilationId, { reviewBoundEvidence: true })
  }
  if (!review?.ready || !review.checksRequired || review.chapterId !== chapter.id || review.revision !== chapter.revision
    || !review.reviewBoundEvidence || !reviewBoundEditAllowed(boundary, current, review.reviewBoundEvidence, options.after, options.editRanges)) throw deny()
}
