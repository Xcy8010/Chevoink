import { z } from 'zod'

export const humanityQualitySignalSchema = z.enum([
  'style_drift',
  'orphaned_sophistication',
  'plot_progress',
  'description_load',
  'emotion_grounding',
  'explanation_echo',
  'sentence_homology',
  'image_repetition',
  'character_voice',
  'causal_gap',
  'chapter_bridge',
  'reader_pull',
  'punctuation_misuse',
])

export const qualityFindingSeveritySchema = z.enum(['advisory', 'warning', 'error'])
export const qualityFindingDispositionSchema = z.enum(['pending', 'selected', 'repaired'])
export const qualityFindingFeedbackSchema = z.enum(['accepted', 'rejected'])

export const criticQualityFindingSchema = z.object({
  signal: humanityQualitySignalSchema,
  severity: z.enum(['advisory', 'warning']),
  quote: z.string().min(1).max(360),
  // Only the review harness resolves these IDs against its frozen source table.
  // Models never supply trusted manuscript offsets.
  sourceId: z.string().min(1).max(96).optional(),
  explanation: z.string().min(1).max(1_000),
  suggestion: z.string().min(1).max(1_000),
  confidence: z.number().min(0).max(1).default(0.7),
})

export const characterVoiceProfileInputSchema = z.object({
  characterName: z.string().trim().min(1).max(128),
  vocabularyLevel: z.string().trim().min(1).max(240),
  sentenceLength: z.object({ short: z.number().int().min(1).max(200), long: z.number().int().min(1).max(400) }),
  addressSystem: z.array(z.string().trim().min(1).max(160)).max(30).default([]),
  pressureResponse: z.string().trim().min(1).max(1_000),
  avoidedTopics: z.array(z.string().trim().min(1).max(240)).max(30).default([]),
  attentionBias: z.array(z.string().trim().min(1).max(240)).max(30).default([]),
  voiceSamples: z.array(z.object({
    text: z.string().trim().min(1).max(240),
    sourceChapterId: z.string().min(1).optional(),
    sourceRevision: z.number().int().positive().optional(),
  })).min(1).max(10),
  forbiddenKnowledge: z.array(z.string().trim().min(1).max(240)).max(30).default([]),
  evolutionNotes: z.string().trim().max(1_500).default(''),
  confirmed: z.boolean().default(false),
}).superRefine((value, refinement) => {
  if (value.confirmed && value.voiceSamples.length < 3) {
    refinement.addIssue({ code: 'custom', path: ['voiceSamples'], message: '确认版 Voice DNA 至少需要 3 条逐字声口样本' })
  }
})

export const experienceAnchorInputSchema = z.object({
  characterName: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(160),
  triggerEvent: z.string().trim().min(1).max(800),
  concreteDetail: z.string().trim().min(1).max(1_200),
  sensoryCue: z.string().trim().max(600).default(''),
  habitualResponse: z.string().trim().min(1).max(800),
  emotionalMeaning: z.string().trim().min(1).max(800),
  sourceType: z.enum(['chapter', 'author_input']),
  sourceId: z.string().trim().min(1).max(64),
  sourceRevision: z.number().int().positive().optional(),
})

export type HumanityQualitySignal = z.infer<typeof humanityQualitySignalSchema>
export type QualityFindingSeverity = z.infer<typeof qualityFindingSeveritySchema>
export type QualityFindingDisposition = z.infer<typeof qualityFindingDispositionSchema>
export type QualityFindingFeedback = z.infer<typeof qualityFindingFeedbackSchema>
export type CriticQualityFinding = z.infer<typeof criticQualityFindingSchema>
export type CharacterVoiceProfileInput = z.infer<typeof characterVoiceProfileInputSchema>
export type ExperienceAnchorInput = z.infer<typeof experienceAnchorInputSchema>
