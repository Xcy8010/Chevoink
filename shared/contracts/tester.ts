import { z } from 'zod'
export const testerUpdateSchema = z.object({ enabled: z.boolean(), reason: z.string().trim().min(1).max(500), expiresAt: z.string().datetime({ offset: true }).nullable(), expectedRevision: z.number().int().nonnegative(), operationId: z.string().uuid() }).strict()
export type TesterRow = { id: string; nickname: string; revision: number; effectiveTester: boolean; qualification: string; enabled: boolean; expiresAt: string | null; reason: string | null }
export type TesterList = { total: number; page: number; pageSize: number; users: TesterRow[]; rule: { thresholdMilli: number; targetMilli: number; balanceBasis: 'ledger'; version: string } }
