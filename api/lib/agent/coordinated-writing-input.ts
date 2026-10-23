import { z } from 'zod'
import { sceneTaskInputSchema } from '../../../shared/contracts/story-compiler-contracts.js'
import { writingVolumeDecisionSchema } from '../../../shared/contracts/writing-volume-contracts.js'
import { terminalCandidateSchema } from './terminal-candidate-contract.js'
import { runtimeError, runtimeJson } from './runtime-common.js'
import { originalChapterReviewRequirements } from './chapter-review-requirements.js'
import { createHash } from 'node:crypto'
import { assertFrozenWritingContract } from './writing-contract.js'
import { lexAuthorWritingRequest } from './author-writing-request.js'
import { requiresWritingConfirmation } from './writing-pacing-policy.js'
import type { TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import type { AgentTool } from './tools/types.js'

export const coordinatedWriterActions = ['chapter_write', 'chapter_append', 'chapter_edit_range'] as const
/** A conditional future instruction is not immediate complete-chapter work.
 * Inspect author clauses only; quotation/code content remains inert data. */
export function isDeferredWritingRequest(prompt: string): boolean {
  const author = lexAuthorWritingRequest(prompt).clauses.map(clause => clause.masked).join('\n')
  return requiresWritingConfirmation(author) || /(?:等|待|需|须|经|得到|获得).{0,24}(?:确认|同意|批准|许可).{0,16}(?:再|才|后).{0,24}(?:写|修改|修订|改写|动笔|创作)|(?:先|仅|只).{0,8}(?:给|提供|讨论|做|出).{0,12}(?:方案|计划|大纲|建议).{0,32}(?:再|才|确认).{0,16}(?:写|修改|动笔)|\b(?:after|until|once|when)\b.{0,32}\b(?:approv\w*|confirm\w*|consent)\b.{0,32}\b(?:write|revise|edit|draft)\b/isu.test(author)
}
/** Fresh issuer only. The legacy broad-book pacing classifier omits ordinary
 * chapter requests; only the authenticated v2 bounded interpretation can fill
 * that omission, before this new root/configuration is frozen. */
export function issueWritingCoordination(spec: TaskSpec, mode: string, names: ReadonlySet<string>, prompt: string): TaskSpec {
  if (spec.scope.writingCoordinationProtocol || mode !== 'build' || spec.scope.authorEffects?.manuscript !== true
    || !['write', 'revise'].includes(spec.intent) || ['proposal_only', 'conversation_only'].includes(spec.writingPacing ?? '')
    || spec.scope.writing?.kind !== 'bounded' || !spec.scope.writing.targets.length
    || spec.scope.selection || spec.scope.selectionBoundary || spec.scope.localEditBoundary || isDeferredWritingRequest(prompt)) return spec
  let admitted = spec
  if (spec.writingPacing === undefined) {
    const original = spec.scope.writingInterpretation
    if (spec.scope.writingTargetProtocol !== 2 || !original || !['write', 'revise'].includes(original.intent ?? '')
      || original.requestHash !== createHash('sha256').update(prompt).digest('hex')
      || spec.scope.authorEffects.requestHash !== original.requestHash
      || original.reasons.length || original.operations.some(operation => operation.start < 0 || operation.end > prompt.length || operation.start >= operation.end)
      || !original.operations.some(operation => operation.polarity === 'affirmative' && ['write', 'revise'].includes(operation.kind))) return spec
    assertFrozenWritingContract(spec)
    admitted = { ...spec, writingPacing: 'explicit_writing' }
  }
  const required = originalChapterReviewRequirements({ spec: admitted, prompt })
  const actions = ['chapter_read', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'story_compiler_prepare', 'scene_task_build', 'chapter_bridge_commit',
    ...(required.continuity ? ['continuity_validate'] : []), ...(required.quality ? ['quality_analyze'] : []),
    ...(spec.scope.writing.targets.some(target => !target.chapterId) ? ['chapter_create'] : [])]
  if (actions.some(action => !names.has(action))) return spec
  return { ...admitted, scope: { ...admitted.scope, writingCoordinationProtocol: 1 } }
}
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

/** Only the original server marker can publish/parse the additional literary
 * carrier. Unmarked schemas retain their exact objects and hashes. */
export function coordinatedWriterParameters(tool: Pick<AgentTool, 'name' | 'parameters'>, scope?: TaskSpec['scope']) {
  if (scope?.writingCoordinationProtocol !== 1 || !coordinatedWriterActions.some(action => action === tool.name)) return tool.parameters
  if (!(tool.parameters instanceof z.ZodObject)) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '写作协调字段不能替换另一类工具的原参数。')
  return tool.parameters.safeExtend({ writing: coordinatedWritingInputSchema }).strict()
}

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
