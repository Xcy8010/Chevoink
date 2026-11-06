import { z } from 'zod'
export const testerUpdateSchema = z.object({ enabled: z.boolean(), reason: z.string().trim().min(1).max(500), expiresAt: z.string().datetime({ offset: true }).nullable(), expectedRevision: z.number().int().nonnegative(), operationId: z.string().uuid() }).strict()
export type TesterRow = { id: string; nickname: string; revision: number; effectiveTester: boolean; qualification: string; enabled: boolean; expiresAt: string | null; reason: string | null }
export type TesterList = { total: number; page: number; pageSize: number; users: TesterRow[]; rule: { thresholdMilli: number; targetMilli: number; balanceBasis: 'ledger'; version: string } }

export type TesterIdentity = { enabled: boolean; effective: boolean; revision: number; expiresAt: string | null; reason: string | null }
export const userIdentityUpdateSchema = z.object({
  operationId: z.string().uuid(),
  role: z.enum(['user', 'admin']).optional(),
  expectedRole: z.enum(['user', 'author', 'admin']).optional(),
  tester: testerUpdateSchema.omit({ operationId: true }).optional(),
}).strict().refine(value => value.role !== undefined || value.tester !== undefined, '请选择需要修改的身份。')
  .refine(value => value.role === undefined ? value.expectedRole === undefined : value.expectedRole !== undefined, '角色修改需要原身份版本。')
export type UserIdentityUpdate = z.infer<typeof userIdentityUpdateSchema>
export type UserIdentityUpdateResult = { role: 'user' | 'author' | 'admin'; tester: TesterIdentity; replayed: boolean }

export type AdminUserIdentityInput = UserIdentityUpdate
export type AdminUserIdentityResult = UserIdentityUpdateResult
