import type { CreditModelTier } from '../../../shared/contracts/credits.js'
import type { RunLeaseToken } from '../agent/runtime-lease.js'
import { withRunLease } from '../agent/runtime-lease.js'
import { runtimeError, runtimeJson } from '../agent/runtime-common.js'
import { tokenPriceSchema, type TokenPrice } from './token-price.js'
import { getActiveTokenPrice } from './rate-cards.js'
import { prisma } from '../prisma.js'

/** Recover an operation's exact price before consulting today's active rate card.
 * No fee changes on replay, even after the old card is retired. */
export async function resolveDurableTokenPrice(lease: RunLeaseToken, key: string, modelTier: Exclude<CreditModelTier, 'custom'>, multiplierBps: number): Promise<TokenPrice> {
  const saved = await withRunLease(lease, async tx => {
    const operation = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: key } } })
    if (!operation) return null
    if (!operation.inputSnapshot || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原模型计费快照损坏。')
    const envelope = operation.inputSnapshot as { input?: { billing?: unknown } }
    const price = tokenPriceSchema.safeParse(envelope.input?.billing)
    if (!price.success || price.data.modelTier !== modelTier) return runtimeError('RUNTIME_PRICE_INVALID', '原计费快照缺失或档位不匹配。')
    return price.data
  })
  if (saved) return saved
  return resolveTokenPrice(modelTier, multiplierBps)
}

/** Used before default/non-streaming requests as well as durable operations. */
export async function resolveTokenPrice(modelTier: Exclude<CreditModelTier, 'custom'>, multiplierBps: number): Promise<TokenPrice> {
  // 0 倍率档由产品公示为真免费：恒定按 v1-exact 零费结算，历史遗留费率卡不得再对免费档收费。
  // 与准入 assertCreditAccess、预留豁免 reserveTokenCredits 保持同一判定源（倍率为 0）。
  if (multiplierBps === 0) return tokenPriceSchema.parse({ version: 'credits-v1-exact', modelTier, multiplierBps: 0 })
  const active = await getActiveTokenPrice(modelTier)
  if (active) return active
  // Compatibility during rollout only; an already migrated tier cannot silently revert.
  const migrated = await prisma.creditRateCardEvent.findFirst({ where: { status: 'active', card: { modelTier } }, select: { id: true } })
  if (migrated) return runtimeError('RUNTIME_PRICE_REQUIRED', '此档位的新费率暂未生效，不能退回旧公式收费。')
  return tokenPriceSchema.parse({ version: 'credits-v1-exact', modelTier, multiplierBps })
}
