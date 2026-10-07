import { z } from 'zod'

export const storyCompilerModeSchema = z.enum(['balanced', 'premium']).default('premium')
export const storyCompilationStageSchema = z.enum(['prepare', 'beat', 'write', 'check', 'repair', 'commit'])
export const storyCompilationStatusSchema = z.enum(['active', 'completed', 'abandoned', 'failed'])
export const sceneTaskStatusSchema = z.enum(['ready', 'writing', 'completed', 'abandoned'])
export const readerPromiseStatusSchema = z.enum(['open', 'paid', 'deferred', 'abandoned'])

export const storyStateSchema = z.object({
  action: z.string().max(500).optional(),
  location: z.string().max(160).optional(),
  storyTime: z.string().max(160).optional(),
  knowledge: z.array(z.string().min(1).max(300)).max(30).default([]),
  emotion: z.array(z.string().min(1).max(300)).max(20).default([]),
  body: z.array(z.string().min(1).max(300)).max(20).default([]),
  objects: z.array(z.string().min(1).max(300)).max(30).default([]),
  relationships: z.array(z.string().min(1).max(300)).max(30).default([]),
  openLoops: z.array(z.string().min(1).max(300)).max(30).default([]),
})

export const storyCharterInputSchema = z.object({
  oneLinePromise: z.string().min(1).max(500),
  targetAudience: z.string().min(1).max(500),
  targetPlatform: z.string().max(160).default(''),
  protagonistDesire: z.string().min(1).max(1000),
  protagonistFear: z.string().min(1).max(1000),
  protagonistMisbelief: z.string().min(1).max(1000),
  protagonistNonNegotiable: z.string().min(1).max(1000),
  conflictEngine: z.string().min(1).max(2000),
  relationshipEngine: z.string().min(1).max(2000),
  genreRules: z.array(z.string().min(1).max(500)).max(30).default([]),
  abilityCosts: z.array(z.string().min(1).max(500)).max(30).default([]),
  realityBoundaries: z.array(z.string().min(1).max(500)).max(30).default([]),
  emotionalBaseline: z.string().min(1).max(1000),
  emotionalRange: z.string().min(1).max(1000),
  styleDna: z.array(z.string().min(1).max(500)).max(30).default([]),
  forbiddenZones: z.array(z.string().min(1).max(500)).max(30).default([]),
  antiExamples: z.array(z.string().min(1).max(1000)).max(20).default([]),
})

export const readerPromiseInputSchema = z.object({
  title: z.string().min(1).max(160),
  promise: z.string().min(1).max(2000),
  payoffHorizon: z.string().min(1).max(160),
  priority: z.number().int().min(1).max(100).default(50),
})

export const sceneTaskInputSchema = z.object({
  purpose: z.string().min(1).max(1000),
  entryState: storyStateSchema,
  goal: z.string().min(1).max(1000),
  obstacle: z.string().min(1).max(1000),
  choice: z.string().min(1).max(1000),
  cost: z.string().min(1).max(1000),
  turn: z.string().min(1).max(1000),
  exitState: storyStateSchema,
  styleBudget: z.object({
    description: z.enum(['low', 'medium', 'high']).default('low'),
    dialogue: z.enum(['low', 'medium', 'high']).default('medium'),
    rhetoric: z.enum(['low', 'medium', 'high']).default('low'),
  }),
})

export const continuityFindingInputSchema = z.object({
  signal: z.enum(['knowledge', 'location_time', 'body', 'object', 'relationship', 'emotion', 'hook', 'structure']),
  severity: z.enum(['warning', 'error']),
  evidence: z.string().min(1).max(1000),
  suggestion: z.string().min(1).max(1000),
  sourceEvidence: z.array(z.object({ source: z.enum(['previous', 'current']), quote: z.string().min(2).max(360) })).min(1).max(8).optional(),
})

export type StoryCompilerMode = z.infer<typeof storyCompilerModeSchema>
export type StoryCompilationStage = z.infer<typeof storyCompilationStageSchema>
export type StoryCompilationStatus = z.infer<typeof storyCompilationStatusSchema>
export type StoryState = z.infer<typeof storyStateSchema>
export type StoryCharterInput = z.infer<typeof storyCharterInputSchema>
export type ReaderPromiseInput = z.infer<typeof readerPromiseInputSchema>
export type SceneTaskInput = z.infer<typeof sceneTaskInputSchema>
export type ContinuityFindingInput = z.infer<typeof continuityFindingInputSchema>
