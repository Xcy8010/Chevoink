import { z } from 'zod'
import { storyCompilerModeSchema } from './story-compiler-contracts.js'
import { taskAuthorizationSchema } from './task-authorization.js'
import { writingTailVolumeCapabilitySchema } from './writing-volume-contracts.js'

const localEditRegionSchema = z.object({ chapterId: z.string().min(1), revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), start: z.number().int().nonnegative(), end: z.number().int().positive(),
  prefix: z.string(), suffix: z.string() }).strict()
const localEditBoundarySchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), kind: z.enum(['bounded', 'needs_input']), regions: z.array(localEditRegionSchema) }).strict(),
  z.object({ version: z.literal(2), kind: z.enum(['bounded', 'needs_input']), regions: z.array(localEditRegionSchema.extend({
    text: z.string().min(1).max(512), maxNewChars: z.number().int().positive().max(1024),
    source: z.object({ kind: z.literal('author_issue_quote'), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
      quoteStart: z.number().int().nonnegative(), quoteEnd: z.number().int().positive(),
      issueStart: z.number().int().nonnegative(), issueEnd: z.number().int().positive() }).strict(),
  }).strict()).max(8) }).strict(),
  // A review is executable before its findings exist. This is a baseline and
  // policy, never a pre-authorized whole-body editing interval.
  z.object({ version: z.literal(3), kind: z.literal('review_bound'),
    regions: z.array(localEditRegionSchema.extend({ protectedText: z.array(z.string().min(1)),
      maxBodyLength: z.number().int().positive() }).strict()).min(1).max(1000),
    source: z.object({ requestHash: z.string().regex(/^[a-f0-9]{64}$/),
      reviews: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()).min(1),
      repairs: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(),
        condition: z.object({ kind: z.enum(['review_findings', 'necessity']), start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict() }).strict()).min(1),
    }).strict(),
  }).strict(),
])

/** Agent 2.0 任务契约：把自然语言请求冻结为可验证、可恢复的运行时输入。 */
export const taskIntentSchema = z.enum([
  'write',
  'revise',
  'global_transform',
  'plan',
  'review',
  'research_analysis',
  'structure',
])

export const taskScopeSchema = z.object({
  novelId: z.string().min(1),
  volumeIds: z.array(z.string().min(1)).optional(),
  chapterIds: z.array(z.string().min(1)).optional(),
  /** Only fresh server admission opts in; absence preserves frozen legacy runs. */
  manuscriptProtocol: z.literal(1).optional(),
  /** Fresh author admission: complete strict review obligations, separate from automatic repair windows. */
  reviewProtocol: z.literal(1).optional(),
  /** Genuine fresh admission only: natural-language locality is server frozen. */
  localEditProtocol: z.literal(1).optional(),
  /** Fresh admission binds chapter targets to their requested action, never reference prose. */
  writingTargetProtocol: z.union([z.literal(1), z.literal(2)]).optional(),
  /** Fresh parser result, bound once to original human input; never re-derived on recovery. */
  writingInterpretation: z.object({ version: z.literal(2), requestHash: z.string().regex(/^[a-f0-9]{64}$/), scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    intent: z.enum(['write', 'revise', 'review']).nullable(), reasons: z.array(z.string().min(1)).max(32),
    revisionDenied: z.boolean(), creationDenied: z.boolean(),
    operations: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(),
      kind: z.enum(['write', 'revise', 'review']), polarity: z.enum(['affirmative', 'negative']) }).strict()).max(1000),
    excludedChapterIds: z.array(z.string().min(1)).max(1000),
  }).strict().optional(),
  /** New human admission requires factual claims anchored in the current manuscript. */
  continuityEvidenceProtocol: z.literal(1).optional(),
  terminalEvidenceProtocol: z.union([z.literal(1), z.literal(2)]).optional(),
  /** Fresh admission permits exact, unique same-source terminal quote addressing. */
  terminalQuoteAddressProtocol: z.literal(1).optional(),
  terminalCoverageProtocol: z.literal(1).optional(),
  /** Fresh empty-book admission may bind one explicit first-chapter answer. */
  writingClarificationProtocol: z.literal(1).optional(),
  localEditBoundary: localEditBoundarySchema.optional(),
  selectionBoundary: z.object({ version: z.literal(1), chapterId: z.string().min(1),
    revision: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
    prefix: z.string(), suffix: z.string() }).strict().optional(),
  /** Admission-time ceiling from the complete original request. Never widened by tools. */
  writing: z.object({ version: z.literal(1), kind: z.enum(['bounded', 'unbounded', 'needs_input']),
    targets: z.array(z.object({ orderIndex: z.number().int().positive(), chapterId: z.string().min(1).nullable(),
      volumeId: z.string().min(1).optional(), positionInVolume: z.number().int().positive().optional() })),
    titleAndBodyOnly: z.boolean(), repairAuthorized: z.boolean(), tailVolume: writingTailVolumeCapabilitySchema.optional() }).optional(),
  selection: z
    .object({
      chapterId: z.string().min(1),
      start: z.number().int().min(0),
      end: z.number().int().min(0),
    })
    .refine((selection) => selection.end >= selection.start, {
      message: 'selection.end 必须大于等于 selection.start',
    })
    .optional(),
})

export const constraintRefSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['safety', 'author_directive', 'story_fact', 'task']),
  text: z.string().min(1),
  sourceId: z.string().min(1).optional(),
  revision: z.number().int().positive().optional(),
})

export const preferenceRefSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  weight: z.number().min(0).max(1).default(0.5),
  sourceId: z.string().min(1).optional(),
})

export const outputContractSchema = z.object({
  kind: z.enum(['text', 'artifact', 'changeset', 'validation_report']),
  description: z.string().min(1),
  required: z.boolean().default(true),
  /** Server-frozen report requirement; legacy outputs retain their behavior. */
  minimumChineseCharacters: z.number().int().positive().max(2_000_000).optional(),
})

export const postconditionSchema = z.object({
  code: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(['error', 'warning']).default('error'),
})

export const taskSpecSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1).optional(),
  intent: taskIntentSchema,
  /** New server policy; absence preserves legacy metadata without a default cap. */
  controlPolicy: z.literal('until_completion').optional(),
  /** Frozen from the original request, never selected by a search tool. */
  researchBudget: z.enum(['standard', 'extended']).optional(),
  /** Fresh server-derived denial; absent legacy contracts keep their ceiling. */
  networkAccess: z.literal('denied').optional(),
  /** Search-only scope is distinct from a complete network prohibition. */
  researchReadAccess: z.literal('denied').optional(),
  /** Fresh server policy for bounded source discovery/reading and limitation receipts. */
  researchDiscoveryProtocol: z.literal(1).optional(),
  /** Fresh HTTP admission only. Navigation is not original prose or a new budget. */
  researchNavigation: z.object({ version: z.literal(1), requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    alternativeSelection: z.enum(['denied', 'after_preferred_unavailable']), sourceSites: z.array(z.string().min(1).max(8192)).max(8).optional(),
    sourceHosts: z.array(z.string().min(1).max(253)).min(1).max(8).optional() }).strict().optional(),
  /** Exact external work named by the fresh author, never a model-selected prefix. */
  researchTarget: z.object({ title: z.string().trim().min(1).max(120), author: z.string().trim().min(1).max(120).optional(),
    textAnalysisRequired: z.boolean().optional(),
    sourceHosts: z.array(z.string().min(1).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu)).min(1).max(8).optional() }).strict().optional(),
  /** Server-frozen creative scope; a broad book request is a proposal, not permission to serialize indefinitely. */
  writingPacing: z.enum(['proposal_only', 'explicit_writing', 'conversation_only']).optional(),
  scope: taskScopeSchema,
  /** Additive migration: missing means legacy/unmigrated, never implicit consent. */
  authorization: taskAuthorizationSchema.optional(),
  goals: z.array(z.string().min(1)).min(1),
  hardConstraints: z.array(constraintRefSchema).default([]),
  softPreferences: z.array(preferenceRefSchema).default([]),
  expectedOutputs: z.array(outputContractSchema).min(1),
  postconditions: z.array(postconditionSchema).default([]),
  ambiguity: z.enum(['none', 'safe_to_assume', 'must_ask']),
  creativeFreedom: z.enum(['stable', 'balanced', 'bold']).default('balanced'),
  qualityMode: storyCompilerModeSchema.default('premium'),
  createdAt: z.string().datetime(),
}).superRefine((spec, ctx) => {
  if (spec.authorization && (spec.authorization.binding.taskRootId !== spec.id
    || spec.authorization.binding.novelId !== spec.scope.novelId)) {
    ctx.addIssue({ code: 'custom', path: ['authorization', 'binding'], message: 'Authorization must bind this task and novel' })
  }
  if (spec.scope.writingTargetProtocol === 2 && (!spec.scope.writingInterpretation || !spec.scope.writing)) {
    ctx.addIssue({ code: 'custom', path: ['scope', 'writingInterpretation'], message: 'Fresh author scope requires its complete frozen projection' })
  }
  if (spec.scope.localEditBoundary?.version === 2 && (spec.scope.writingTargetProtocol !== 2
    || spec.scope.localEditProtocol !== 1 || !spec.scope.writingInterpretation
    || spec.scope.localEditBoundary.regions.some(region => region.source.requestHash !== spec.scope.writingInterpretation!.requestHash))) {
    ctx.addIssue({ code: 'custom', path: ['scope', 'localEditBoundary'], message: 'Issue quotations require the same frozen author interpretation' })
  }
  const conditional = spec.scope.localEditBoundary
  if (conditional?.version === 3 && (spec.scope.writingTargetProtocol !== 2 || spec.scope.localEditProtocol !== 1
    || !spec.scope.writingInterpretation || conditional.source.requestHash !== spec.scope.writingInterpretation.requestHash
    || spec.scope.writing?.kind !== 'bounded' || spec.scope.writing.repairAuthorized
    || conditional.regions.length !== spec.scope.writing.targets.length
    || conditional.regions.some(region => !spec.scope.writing!.targets.some(target => target.chapterId === region.chapterId)
      || region.start !== 0 || region.end <= 0 || region.prefix !== '' || region.suffix !== '' || region.maxBodyLength < region.end)
    || new Set(conditional.regions.map(region => region.chapterId)).size !== conditional.regions.length
    || conditional.source.reviews.some(span => span.end <= span.start || !spec.scope.writingInterpretation!.operations.some(op =>
      op.kind === 'review' && op.polarity === 'affirmative' && op.start === span.start && op.end === span.end))
    || conditional.source.repairs.some(span => span.end <= span.start || span.condition.end <= span.condition.start
      || span.condition.end > span.start || !conditional.source.reviews.some(review => review.end <= span.condition.start)
      || !spec.scope.writingInterpretation!.operations.some(op => op.kind === 'revise' && op.polarity === 'affirmative'
        && op.start === span.start && op.end === span.end)))) {
    ctx.addIssue({ code: 'custom', path: ['scope', 'localEditBoundary'], message: 'Conditional repair requires its bounded original review policy' })
  }
})

export type TaskIntent = z.infer<typeof taskIntentSchema>
export type TaskScope = z.infer<typeof taskScopeSchema>
export type ConstraintRef = z.infer<typeof constraintRefSchema>
export type PreferenceRef = z.infer<typeof preferenceRefSchema>
export type OutputContract = z.infer<typeof outputContractSchema>
export type Postcondition = z.infer<typeof postconditionSchema>
export type TaskSpec = z.infer<typeof taskSpecSchema>
