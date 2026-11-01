import { Prisma } from '@prisma/client'
import type { AdminCreditsManagementPayload } from '../../shared/contracts/index.js'
import { creditTransaction, lockCreditPolicy } from './credit-policy.js'
import { getCreditWindow } from './credits.js'

type AccountRow = { id: string; nickname: string; avatarUrl: string | null; dailyAllowanceMilli: number; dailyUsedMilli: number; bonusBalanceMilli: number; resetsAt: Date; suspended: boolean }
type Totals = { users: bigint; dailyAllowance: bigint; dailyUsed: bigint; bonusBalance: bigint; exhaustedUsers: bigint }

/** Bounded, read-only projection of the same daily-window policy used on admission.
 * Viewing an account never resets it or creates every user's account. */
export async function getPagedAdminCreditAccounts(search: string | undefined, page: number, pageSize: number): Promise<AdminCreditsManagementPayload> {
  return creditTransaction(async tx => {
    const setting = await lockCreditPolicy(tx)
    const now = new Date()
    const window = getCreditWindow(now, setting.resetHourUtc8)
    const expired = Prisma.sql`(a.user_id IS NULL OR (${setting.publicBetaEnabled} AND a.period_ends_at <= ${now.toISOString()}::timestamp))`
    const projection = Prisma.sql`WITH effective AS (
      SELECT u.id, u.nickname, u.avatar_url, u.email, u.phone,
        CASE WHEN ${expired} THEN ${setting.dailyAllowanceMilli} ELSE a.daily_allowance_milli END::integer AS allowance,
        CASE WHEN ${expired} THEN 0 ELSE a.daily_used_milli END::integer AS used,
        COALESCE(a.bonus_balance_milli, 0) AS bonus,
        CASE WHEN ${expired} THEN ${window.endsAt.toISOString()}::timestamp ELSE a.period_ends_at END AS resets_at,
        CASE WHEN a.user_id IS NULL THEN ${setting.globallyPaused} ELSE a.suspended_at IS NOT NULL END AS suspended
      FROM users u LEFT JOIN credit_accounts a ON a.user_id = u.id
    )`
    const keyword = search?.trim()
    const pattern = `%${keyword ?? ''}%`
    const where = keyword ? Prisma.sql`WHERE id ILIKE ${pattern} OR nickname ILIKE ${pattern} OR email ILIKE ${pattern} OR phone ILIKE ${pattern}` : Prisma.empty
    const [totals] = await tx.$queryRaw<Totals[]>(Prisma.sql`${projection}
      SELECT count(*)::bigint AS users, COALESCE(sum(allowance),0)::bigint AS "dailyAllowance",
        COALESCE(sum(used),0)::bigint AS "dailyUsed", COALESCE(sum(bonus),0)::bigint AS "bonusBalance",
        count(*) FILTER (WHERE GREATEST(0,allowance-used)+GREATEST(0,bonus)<=0)::bigint AS "exhaustedUsers" FROM effective`)
    const [matching] = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`${projection} SELECT count(*)::bigint AS count FROM effective ${where}`)
    const currentPage = Math.min(page, Math.max(1,Math.ceil(Number(matching.count)/pageSize)))
    const rows = await tx.$queryRaw<AccountRow[]>(Prisma.sql`${projection}
      SELECT id,nickname,avatar_url AS "avatarUrl",allowance AS "dailyAllowanceMilli",used AS "dailyUsedMilli",bonus AS "bonusBalanceMilli",resets_at AS "resetsAt",suspended
      FROM effective ${where} ORDER BY used DESC,id ASC OFFSET ${(currentPage-1)*pageSize} LIMIT ${pageSize}`)
    return {
      snapshotAt: now.toISOString(), summaryScope: 'global', pagination: { page: currentPage, pageSize, total: Number(matching.count), hasMore: currentPage*pageSize<Number(matching.count), totalPages: Math.max(1,Math.ceil(Number(matching.count)/pageSize)) },
      summary: { globallyPaused: setting.globallyPaused, publicBetaEnabled: setting.publicBetaEnabled, publicBetaRevision: setting.publicBetaRevision,
        users: Number(totals.users), dailyAllowance: Number(totals.dailyAllowance)/1000, dailyUsed: Number(totals.dailyUsed)/1000,
        bonusBalance: Number(totals.bonusBalance)/1000, exhaustedUsers: Number(totals.exhaustedUsers) },
      users: rows.map(row => {
        const remaining = Math.max(0,row.dailyAllowanceMilli-row.dailyUsedMilli)
        return { user: { id: row.id,nickname: row.nickname,avatarUrl: row.avatarUrl },planLabel: setting.publicBetaEnabled ? '公测版' as const : '免费版' as const,
          dailyAllowance: row.dailyAllowanceMilli/1000,dailyUsed: row.dailyUsedMilli/1000,dailyRemaining: remaining/1000,bonusBalance: row.bonusBalanceMilli/1000,
          totalRemaining: (remaining+Math.max(0,row.bonusBalanceMilli))/1000,usedPercent: row.dailyAllowanceMilli>0?Math.min(100,Math.round(row.dailyUsedMilli/row.dailyAllowanceMilli*1000)/10):100,
          resetsAt: row.resetsAt.toISOString(),suspended: row.suspended }
      })
    }
  })
}
