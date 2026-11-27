import type { FixedFeeReceipt, GoalReceipt } from '../../shared/contracts/governance-reconciliation.js'
import { prisma } from './prisma.js'

const goalSelect = { goalId: true, runId: true, creditsMicros: true, reservedTokens: true, status: true, goal: { select: { userId: true } } } as const
type GoalEvidence = { goalId: string; runId: string; creditsMicros: bigint; reservedTokens: bigint; status: string; goal: { userId: string } }
export function goalReceipt(owner: string, row: GoalEvidence | null): GoalReceipt | null {
  if (!row || row.goal.userId !== owner) return null
  return { goalId: row.goalId, runId: row.runId, creditsMicros: String(row.creditsMicros), reservedTokens: String(row.reservedTokens), status: row.status }
}

export async function readGoalReceipt(owner: string, sourceKey: string) {
  return goalReceipt(owner, await prisma.agentGoalUsage.findUnique({ where: { sourceKey }, select: goalSelect }))
}

const info = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
type Charge = { sourceType: string; metadata: unknown; userId: string; referenceId: string | null; idempotencyKey: string }
async function frozenFixedPrice(entry: Charge): Promise<number | null> {
  const metadata = info(entry.metadata)
  if (entry.sourceType === 'image_generation') {
    // Every retry on this image charge must agree on the frozen price.
    const usage = await prisma.aiUsageLog.findMany({ where: { userId: entry.userId, providerType: 'image', targetType: 'imageCharge', targetId: entry.idempotencyKey }, select: { billingSnapshot: true }, take: 9 })
    const amounts = usage.map(v => info(v.billingSnapshot).amountMilli)
    const amount = amounts[0]
    if (amounts.length > 0 && amounts.length <= 8 && typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 && amounts.every(v => v === amount)) return amount
    return null
  }
  if (typeof metadata.webToolCallId !== 'string') return null
  const receipt = await prisma.webToolCall.findUnique({ where: { id: metadata.webToolCallId }, select: { runId: true, requestHash: true, kind: true, amountMilli: true } })
  return receipt && receipt.runId === entry.referenceId && receipt.kind === entry.sourceType.slice(4) && receipt.requestHash === metadata.requestHash ? receipt.amountMilli : null
}

export async function readFixedFeeReceipts(page: number, userId?: string, actionId?: string) {
  if (!userId && !actionId) return { items: [], hasMore: false }
  const entries = await prisma.creditLedgerEntry.findMany({ where: {
    userId, kind: 'usage', sourceType: { in: ['image_generation', 'web_search', 'web_fetch'] },
    ...(actionId ? { OR: [{ id: actionId }, { referenceId: actionId }, { idempotencyKey: actionId }] } : {}),
  }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 21, skip: (page - 1) * 20,
  select: { id: true, userId: true, idempotencyKey: true, referenceId: true, sourceType: true, metadata: true, deltaMilli: true,
    refundIntent: { select: { settledAt: true } } } })
  const items = await Promise.all(entries.slice(0, 20).map(async (entry): Promise<FixedFeeReceipt> => {
    const [goal, refund, expectedMilli] = await Promise.all([
      readGoalReceipt(entry.userId, 'ledger:' + entry.id),
      prisma.creditLedgerEntry.findUnique({ where: { idempotencyKey: 'refund:' + entry.idempotencyKey }, select: { userId: true, kind: true, sourceType: true, deltaMilli: true } }),
      frozenFixedPrice(entry),
    ])
    const chargedMilli = -entry.deltaMilli
    const refundVerified = refund?.userId === entry.userId && refund.kind === 'refund' && refund.sourceType === entry.sourceType && refund.deltaMilli === chargedMilli
    return { id: entry.id, userId: entry.userId, actionId: entry.referenceId, sourceType: entry.sourceType, expectedMilli, chargedMilli,
      refundMilli: refundVerified ? refund.deltaMilli : null, refundPending: !!entry.refundIntent && !entry.refundIntent.settledAt, goal }
  }))
  return { items, hasMore: entries.length > 20 }
}
