import type { TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import type { RuntimeTx } from './runtime-common.js'
import { requiresNextChapterDelivery } from './completion-guard.js'
import { requiresManuscriptDelivery } from './task-spec.js'
import { hasCommittedTaskChapter } from './humanity-quality.js'
import { readCompletedWritingDelivery, readCompletedWritingPresentation } from './writing-scope.js'

/** Current manuscript proof for reconciling an existing plan only. The ordinary
 * presentation remains subject to the task's separate completion obligations. */
export async function readWritingTodoSyncDelivery(tx: RuntimeTx,
  subject: { userId: string; novelId: string; runId: string }, spec: TaskSpec) {
  const delivery = await readCompletedWritingDelivery(tx, subject)
  if (delivery) return delivery
  if (!requiresManuscriptDelivery(spec) || spec.goals.length !== 1 || !requiresNextChapterDelivery(spec.goals)
    || !await hasCommittedTaskChapter(tx, subject.userId, subject.novelId, subject.runId)) return null
  return readCompletedWritingPresentation(tx, subject)
}

/** Only proposals that redo a completed chapter workflow; factual reads and
 * the author's question channel remain available during plan reconciliation. */
export function isCompletedWritingRepeatProposal(toolName: string): boolean {
  return ['chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'story_compiler_prepare',
    'scene_task_build', 'continuity_validate', 'quality_analyze', 'chapter_bridge_commit'].includes(toolName)
}
