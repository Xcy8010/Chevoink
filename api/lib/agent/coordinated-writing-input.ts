import { z } from 'zod'
import { sceneTaskInputSchema } from '../../../shared/contracts/story-compiler-contracts.js'
import { writingVolumeDecisionSchema } from '../../../shared/contracts/writing-volume-contracts.js'
import { terminalCandidateSchema } from './terminal-state-review.js'
import { runtimeError, runtimeJson } from './runtime-common.js'
import { originalChapterReviewRequirements } from './chapter-review-guard.js'
import type { TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'

export const coordinatedWriterActions = ['chapter_write', 'chapter_append', 'chapter_edit_range'] as const
export const writingServiceStepSchema = z.enum(['body', 'continuity', 'quality', 'commit'])
export type WritingServiceStep = z.infer<typeof writingServiceStepSchema>

/** Literary decisions supplied by the genuine writer. Completion is a request
 * to review this saved version; it never attests a successful check or commit. */
export const coordinatedWritingInputSchema = z.object({
  draftComplete: z.boolean(),
  scenes: z.array(sceneTaskInputSchema.extend({
    entryState: sceneTaskInputSchema.shape.entryState.prefault({}),
    exitState: sceneTaskInputSchema.shape.exitState.prefault({}),
    styleBudget: sceneTaskInputSchema.shape.styleBudget.default({ description: 'low', dialogue: 'medium', rhetoric: 'low' }),
  }).strict()).min(1).max(4).optional(),
  actualOutcomes: terminalCandidateSchema.optional(),
  chapterSummary: z.string().min(1).max(2000).optional(),
  hookDecision: z.string().max(1000).optional(),
  delayedHookReason: z.string().max(1000).optional(),
  openingStructure: z.string().min(1).max(300).optional(),
  endingStructure: z.string().min(1).max(300).optional(),
  volumeDecision: writingVolumeDecisionSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.draftComplete) return
  for (const key of ['actualOutcomes', 'chapterSummary', 'hookDecision', 'delayedHookReason', 'openingStructure', 'endingStructure'] as const) {
    if (value[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'Complete writing requires the writer’s explicit literary decision' })
  }
})
export type CoordinatedWritingInput = z.infer<typeof coordinatedWritingInputSchema>

/** Frozen business manifest, not a second grant. Permission, current policy,
 * approval, version and source-receipt checks still happen at every effect. */
export function coordinatedWritingManifest(original: { spec: TaskSpec; prompt: string | null }, action: string, chapterId: string, value: unknown) {
  const spec = original.spec
  if (spec.scope.writingCoordinationProtocol !== 1 || !coordinatedWriterActions.some(name => name === action)
    || !['write', 'revise'].includes(spec.intent) || spec.writingPacing !== 'explicit_writing'
    || spec.scope.writing?.kind !== 'bounded' || spec.scope.selection || spec.scope.selectionBoundary || spec.scope.localEditBoundary
    || spec.scope.authorEffects?.manuscript === false) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '原任务没有完整章节写作协调能力，不能升级旧合同或扩大选区。')
  const writing = coordinatedWritingInputSchema.parse(value)
  // Uncreated targets are authenticated later through original server bindings;
  // a fully identified scope can already reject a different chapter here.
  if (!chapterId.trim() || spec.scope.writing.targets.every(target => target.chapterId !== null)
    && !spec.scope.writing.targets.some(target => target.chapterId === chapterId)) {
    return runtimeError('AUTHOR_CHAPTER_SCOPE', '写作目标不在原任务的完整章节范围内。')
  }
  const required = originalChapterReviewRequirements(original)
  const steps: Array<{ step: WritingServiceStep; actions: string[] }> = [
    { step: 'body', actions: ['story_compiler_prepare', 'scene_task_build', action] },
    ...(writing.draftComplete && required.continuity ? [{ step: 'continuity' as const, actions: ['continuity_validate'] }] : []),
    ...(writing.draftComplete && required.quality ? [{ step: 'quality' as const, actions: ['quality_analyze'] }] : []),
    ...(writing.draftComplete ? [{ step: 'commit' as const, actions: ['chapter_bridge_commit'] }] : []),
  ]
  return runtimeJson({ version: 1, chapterId, writingHash: runtimeJson(writing).hash, steps }).value
}
