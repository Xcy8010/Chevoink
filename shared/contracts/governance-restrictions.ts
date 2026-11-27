import { z } from 'zod'

export const restrictionScopes = ['novel_comment', 'post_comment', 'post', 'direct_message', 'novel_publish', 'agent', 'platform'] as const
export type RestrictionScope = typeof restrictionScopes[number]
export const restrictionLabels: Record<RestrictionScope, string> = {
  novel_comment: '作品及章节评论', post_comment: '帖子评论', post: '发帖', direct_message: '发送私信',
  novel_publish: '发布作品', agent: '使用创作 Agent 和生成封面', platform: '全平台访问',
}
const reason = z.string().trim().min(1).max(1000)
const deadline = z.string().datetime({ offset: true }).nullable()
export const issueRestrictionsSchema = z.object({
  userId: z.string().min(1).max(64), scopes: z.array(z.enum(restrictionScopes)).min(1).max(7),
  reason, clause: z.string().trim().min(1).max(300), expiresAt: deadline, sourceId: z.string().max(64).optional(),
  operationId: z.string().uuid().optional(), confirmPlatform: z.boolean().optional(),
}).refine(v => !v.scopes.includes('platform') || v.confirmPlatform === true, '全平台封禁须再次确认。')
export const changeRestrictionSchema = z.object({
  action: z.enum(['revoke', 'extend', 'adjust']), reason, expiresAt: deadline.optional(),
}).refine(v => v.action === 'revoke' || v.expiresAt !== undefined, '请选择新的截止时间。')
export const safetyReviewSchema = z.object({
  decision: z.enum(['confirmed', 'dismissed']), reason, category: z.string().trim().min(1).max(80),
  evasion: z.enum(['none', 'credible', 'high']), evidenceRef: z.string().trim().min(1).max(300),
})
