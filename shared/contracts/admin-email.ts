import { z } from 'zod'
import { MAX_CREDIT_MILLI } from './admin-credit-adjustment.js'
import { emailLibraryEntryFields, emailVariables, hasValidEmailVariables } from './email-library.js'

export const ADMIN_EMAIL_BATCH_LIMIT = 100
export const ADMIN_EMAIL_PURPOSE = 'tester_invitation'
export const ADMIN_EMAIL_TEMPLATE = 'tester-invitation-v1'
export const ADMIN_RETURN_EMAIL_PURPOSE = 'creator_return'
export const ADMIN_CUSTOM_EMAIL_PURPOSE = 'custom_notification'
export const adminEmailPurposeSchema = z.enum([ADMIN_EMAIL_PURPOSE, ADMIN_RETURN_EMAIL_PURPOSE, ADMIN_CUSTOM_EMAIL_PURPOSE])
export const ADMIN_RETURN_TEMPLATE_ID = '237702'
const templateKey = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const adminCustomEmailTemplateSchema = emailLibraryEntryFields.extend({
  values: z.record(z.string().regex(templateKey), z.string().min(1).max(2000)),
}).refine(hasValidEmailVariables).refine(template => {
  const keys = emailVariables(template.subject + '\n' + template.body)
  return Object.keys(template.values).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(template.values, key))
})
export type AdminCustomEmailTemplate = z.infer<typeof adminCustomEmailTemplateSchema>
export const adminEmailCampaignSchema = z.object({
  maxCredits: z.number().int().positive().max(Math.floor(MAX_CREDIT_MILLI / 1000)),
  deadline: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('relative'), days: z.number().int().min(1).max(3650) }).strict(),
    z.object({ mode: z.literal('fixed'), at: z.iso.datetime({ offset: true }) }).strict(),
  ]),
  workspacePath: z.string().max(180).regex(/^studio(?:\/novel\/[A-Za-z0-9_-]+)?$/),
}).strict()
export type AdminEmailCampaign = z.infer<typeof adminEmailCampaignSchema>
const adminEmailModeSchema = z.enum(['mock', 'tencent'])
export type AdminEmailMode = z.infer<typeof adminEmailModeSchema>
export const adminEmailId = z.uuid()

const filters = z.object({
  role: z.enum(['user', 'author', 'admin']).optional(),
  registeredSince: z.iso.date().optional(),
  registeredBefore: z.iso.date().optional(),
  inactiveForDays: z.number().int().min(1).max(36500).optional(),
  minCreations: z.number().int().nonnegative().max(1000000).optional(),
  maxCreations: z.number().int().nonnegative().max(1000000).optional(),
  activeWithinDays: z.number().int().min(1).max(365).optional(),
  tester: z.enum(['effective', 'other']).optional(),
}).strict().refine(value => !value.registeredSince || !value.registeredBefore || value.registeredSince <= value.registeredBefore, '注册日期范围无效')
  .refine(value => (value.minCreations ?? 0) <= (value.maxCreations ?? Infinity), '创作次数范围无效')

export const adminEmailSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('manual'), userIds: z.array(z.string().min(1).max(64)).min(1).max(ADMIN_EMAIL_BATCH_LIMIT) }).strict(),
  z.object({
    mode: z.literal('emails'),
    emails: z.array(z.string().trim().toLowerCase().max(255).pipe(z.email())).min(1).max(ADMIN_EMAIL_BATCH_LIMIT),
  }).strict(),
  z.object({ mode: z.literal('filter'), filters }).strict(),
  z.object({
    mode: z.literal('sample'), filters,
    size: z.number().int().min(1).max(ADMIN_EMAIL_BATCH_LIMIT),
    weighting: z.enum(['equal', 'recent_activity']),
  }).strict(),
])
export type AdminEmailSelection = z.infer<typeof adminEmailSelectionSchema>
export const adminEmailPreviewSchema = z.object({
  mode: adminEmailModeSchema,
  selection: adminEmailSelectionSchema,
  replaces: adminEmailId.optional(),
  campaign: adminEmailCampaignSchema.optional(),
  customTemplate: adminCustomEmailTemplateSchema.optional(),
}).strict().refine(input => !(input.campaign && input.customTemplate))

export const adminEmailConfirmSchema = z.object({
  mode: adminEmailModeSchema,
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const adminEmailExclusions = [
  'missing_user', 'banned', 'unverified_email', 'unsubscribed', 'hard_bounce', 'complained', 'no_permission', 'duplicate_email',
  'outside_send_scope',
] as const
export type AdminEmailExclusion = typeof adminEmailExclusions[number]
export type AdminEmailRecipientState =
  | 'preview' | 'queued' | 'sending' | 'accepted' | 'deferred' | 'delivered'
  | 'rejected' | 'bounced' | 'unknown' | 'skipped' | 'cancelled'
export type AdminEmailBatchState = 'preview' | 'confirmed' | 'cancelled'

export type AdminEmailCandidate = {
  id: string
  nickname: string
  maskedEmail: string | null
  exclusion: AdminEmailExclusion | null
}

export type AdminEmailPreviewCandidates = {
  items: Array<AdminEmailCandidate & { selected: boolean }>
  page: number
  hasNextPage: boolean
  reconstructed: boolean
}

export type AdminEmailBatch = {
  id: string
  mode: AdminEmailMode
  state: AdminEmailBatchState
  createdAt: string
  expiresAt: string
  recipientCount: number
  progress: Partial<Record<AdminEmailRecipientState, number>>
}

export type AdminEmailBatchDetail = AdminEmailBatch & {
  campaign?: AdminEmailCampaign
  customTemplate?: AdminCustomEmailTemplate
  previewHash: string
  replacedById: string | null
  selection: AdminEmailSelection
  template: { id: string; from: string; replyTo: string; subject: string; sampleBody: string }
  candidateCount: number
  eligibleCount: number
  exclusions: Partial<Record<AdminEmailExclusion, number>>
  blocker: 'empty' | 'batch_limit' | 'sample_size' | null
  recipients: Array<{
    userId: string
    nickname: string
    maskedEmail: string
    state: AdminEmailRecipientState
    reason: string | null
    providerMessageId: string | null
    providerRequestId: string | null
    attemptedAt: string | null
    updatedAt: string
  }>
}

export type AdminEmailInfo = {
  mode: AdminEmailMode
  template: typeof ADMIN_EMAIL_TEMPLATE
  purpose: typeof ADMIN_EMAIL_PURPOSE
  batchLimit: typeof ADMIN_EMAIL_BATCH_LIMIT
}
