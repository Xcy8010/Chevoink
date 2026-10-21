import type { Prisma } from '@prisma/client'
import { taskSpecSchema, type TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'
import { runtimeJson } from './runtime-common.js'
import type { ReviewCycle } from './review-cycle.js'
import type { ChapterReviewReadiness } from './chapter-review-guard.js'

type Boundary = Extract<NonNullable<TaskSpec['scope']['localEditBoundary']>, { version: 3 }>
type Range = { start: number; end: number; newText: string }
export type ReviewBoundEvidence = { contentHash: string; cycle: ReviewCycle | null;
  anchors: Array<{ start: number; end: number; text: string; source: 'continuity' | 'quality'; reportId: string; findingId: string }> }
const deny = () => new DataAccessError(409, 'AUTHOR_LOCAL_SCOPE', '条件修订只允许当前任务完整检查中逐字证实的问题片段；先完成检查，保留其他正文和原范围上限。')
const provenRange = (content: string, anchors: ReviewBoundEvidence['anchors'], range: Range) => anchors.some(anchor =>
  anchor.text.length <= 512 && anchor.text.length > 0 && !(anchor.start === 0 && anchor.end === content.length)
  && anchor.end - anchor.start === anchor.text.length && content.slice(anchor.start, anchor.end) === anchor.text
  && (range.start === range.end ? range.start > anchor.start && range.end < anchor.end : range.start >= anchor.start && range.end <= anchor.end)
  && range.newText.length <= Math.max(32, anchor.text.length * 2))
export function unprovenReviewBoundPatchIndexes(content: string, evidence: ReviewBoundEvidence, ranges: Range[]) {
  return ranges.flatMap((range, index) => provenRange(content, evidence.anchors, range) ? [] : [index])
}

export type ReviewBoundEditPlan = {
  version: 1; chapterId: string; revision: number; contentHash: string
  state: 'checks_required' | 'findings_available' | 'no_proven_findings' | 'proposal_outside_evidence' | 'unavailable'
  requiredTools: ChapterReviewReadiness['requiredTools']; unprovenPatchIndexes: number[]
  anchors: ReviewBoundEvidence['anchors']; maxBodyLength: number; protectedText: string[]; guidance: string
}

/** One read-only phase/evidence projection for presentation, preflight and the
 * transactional writer. Neither a baseline nor this projection grants writes. */
export function projectReviewBoundEditPlan(boundary: Boundary, chapter: { id: string; revision: number; content: string },
  review: ChapterReviewReadiness | null, proposal?: { after: string; ranges: Range[] }): ReviewBoundEditPlan {
  const frozen = boundary.regions.find(region => region.chapterId === chapter.id)
  const current = review?.chapterId === chapter.id && review.revision === chapter.revision
  const evidence = current ? review.reviewBoundEvidence : undefined
  const anchors = evidence?.anchors.filter(anchor => anchor.text.length > 0 && anchor.text.length <= 512
    && !(anchor.start === 0 && anchor.end === chapter.content.length)
    && anchor.end - anchor.start === anchor.text.length && chapter.content.slice(anchor.start, anchor.end) === anchor.text) ?? []
  const requiredTools = current ? review.requiredTools : []
  const unprovenPatchIndexes = proposal && evidence ? unprovenReviewBoundPatchIndexes(chapter.content, evidence, proposal.ranges) : []
  const state: ReviewBoundEditPlan['state'] = !frozen || !current ? 'unavailable'
    : requiredTools.length ? 'checks_required'
      : !review.ready || !review.checksRequired || !evidence || evidence.contentHash !== runtimeJson({ content: chapter.content }).hash ? 'unavailable'
        : !anchors.length ? 'no_proven_findings'
          : proposal && (!proposal.ranges.length || unprovenPatchIndexes.length
            || !reviewBoundEditAllowed(boundary, chapter, evidence, proposal.after, proposal.ranges)) ? 'proposal_outside_evidence' : 'findings_available'
  const limit = `条件局部修订仅限 chapterId=${chapter.id} 当前 r${chapter.revision}；最多8处，正文上限${frozen?.maxBodyLength ?? 0}字，保留原保护文字和范围外全文。`
  const phase = state === 'checks_required' ? `尚缺当前版本检查：${requiredTools.map(tool => tool.name).join('、')}。先通过原工具、预算和恢复准入完成缺项；本次正文提议未执行，不因提议自动重试未知请求。`
    : state === 'unavailable' ? '当前完整检查或原任务证据尚不可确认；不得改稿，也不能要求作者重复授权已明确的章节。先读取当前报告和状态。'
      : state === 'no_proven_findings' ? '当前完整检查没有可授权局部改稿的逐字问题片段；保持正文，核对终态候选或按真实报告提交。'
        : state === 'proposal_outside_evidence' ? `本批补丁未执行，${unprovenPatchIndexes.length ? `第${unprovenPatchIndexes.map(index => index + 1).join('、')}项超出证实问题范围` : '组合效果超出原冻结范围、长度或保护限制'}。不得以主模型猜测或未知终态新增结构；保持其余正文。`
          : '只可在下列当前报告问题原文范围内精确修订；报告是定位证据，不代表建议必然正确。纯审美建议可按原流程说明保留。'
  const shown = anchors.slice(0, 8).map(({ text, source, reportId, findingId }) => ({ text, source, reportId, findingId }))
  return { version: 1, chapterId: chapter.id, revision: chapter.revision, contentHash: runtimeJson({ content: chapter.content }).hash,
    state, requiredTools, unprovenPatchIndexes, anchors, maxBodyLength: frozen?.maxBodyLength ?? 0,
    protectedText: frozen?.protectedText ?? [], guidance: `${limit}${phase}${shown.length ? ` 当前问题原文（最多显示8项，其余读取报告）：${JSON.stringify(shown)}` : ''}` }
}

export async function readReviewBoundEditPlan(tx: Prisma.TransactionClient, subject: { userId: string; novelId: string; runId: string },
  chapter: { id: string; revision: number; content: string }, proposal?: { after: string; ranges: Range[] }) {
  const { readWritingScope } = await import('./writing-scope.js')
  const { originalLocalEditBoundary } = await import('./local-edit-scope.js')
  const scope = await readWritingScope(tx, subject), boundary = originalLocalEditBoundary(scope.spec)
  if (boundary?.version !== 3) return null
  const { readChapterReviewReadiness } = await import('./chapter-review-guard.js')
  const review = await readChapterReviewReadiness(tx, subject, undefined, { reviewBoundEvidence: true })
  return projectReviewBoundEditPlan(boundary, chapter, review, proposal)
}

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
    || !provenRange(chapter.content, evidence.anchors, range))) return false
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
  const plan = projectReviewBoundEditPlan(boundary, current, review, { after: options.after, ranges: options.editRanges })
  if (plan.state !== 'findings_available') throw new DataAccessError(409, 'AUTHOR_LOCAL_SCOPE', plan.guidance)
}
