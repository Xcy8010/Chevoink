import type { AdminYunshuCall } from '../../shared/contracts/admin-yunshu-usage.js'
import type { GovernanceReconciliation, ReconciliationRow } from '../../shared/contracts/governance-reconciliation.js'
import { prisma } from './prisma.js'
import { getAdminYunshuOperations } from './admin-yunshu-usage.js'
import { tokenPriceSchema } from './billing/token-price.js'
import { calculateV1ChargeMilli, calculateV2UserChargeMilli } from './billing/pricing.js'

import { readFixedFeeReceipts, readGoalReceipt } from './governance-fixed-receipts.js'

const object = (v: unknown): Record<string,unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {}
type Local = { owner:string; actionId:string; key:string; price:unknown; multiplier:number; settled:boolean; input:number|null; output:number|null; cache:number|null; reported:boolean; recordedCharge:number|null; exempt:boolean; reserved:boolean }
type Ledger = { userId:string; deltaMilli:number; metadata:unknown; refundIntent:{settledAt:Date|null}|null }
export function compareGovernanceReceipt(row: AdminYunshuCall, local: Local|null, ledger: Ledger|null, refund: {userId:string; deltaMilli:number}|null): ReconciliationRow {
  const base = { upstreamId:row.requestId, observedAt:row.createdAt, userId:local?.owner ?? null, actionId:local?.actionId ?? null, expectedMilli:null, chargedMilli:null, refundMilli:null }
  const result = (state:ReconciliationRow['state'],reason:string): ReconciliationRow => ({...base,state,reason})
  if (row.ambiguousConsumption) return { ...result('unknown','同一网关编号出现多条消耗记录'), userId: null, actionId: null }
  if (!local) return result('unknown','缺少可唯一关联的本次调用记录')
  if (ledger && ledger.userId !== local.owner || refund && refund.userId !== local.owner) return result('unknown','账本归属待核实')
  if (row.kind === 'error') return result('provider_error','供应商错误回执，计费结果单独核查')
  if (ledger?.refundIntent && !ledger.refundIntent.settledAt) return result('pending','退款待结算')
  if (refund && ledger && refund.deltaMilli === -ledger.deltaMilli && refund.deltaMilli >= 0) return {...result('refunded','已按原扣款核实到账退款'),chargedMilli:-ledger.deltaMilli,refundMilli:refund.deltaMilli}
  if (row.kind === 'refund' || refund) return result('unknown','上游退款与墨域账本退款分别核对')
  if (local.exempt) return result('unknown','豁免或独立计费合同需按原业务核查')
  if (local.reserved || !local.settled) return result('pending','预约、目标预算或供应商结果仍待结算')
  if (!local.reported || local.input === null || local.output === null || local.input !== row.requestTokens || local.output !== row.responseTokens) return result('unknown','上游与本地 token 的计量口径或数据待核实')
  if (row.cacheHitTokens != null && local.cache != null && row.cacheHitTokens !== local.cache) return result('unknown','上游与本地缓存命中计量不符')
  const frozen = tokenPriceSchema.safeParse(local.price)
  // consumeTokenCredits explicitly replays a null legacy AiUsageLog snapshot at V1.
  // Persistent operations have a mandatory price envelope.
  if ((local.price != null || !local.key.startsWith('usage:')) && !frozen.success) return result('unknown','历史价格快照不完整')
  const price = frozen.success ? frozen.data : null
  if (price?.version==='credits-v1-exact' && local.key.startsWith('usage:') && price.multiplierBps!==local.multiplier) return result('unknown','原调用倍率与同期价格不符')
  const metadata = object(ledger?.metadata)
  const cache = metadata.cachePricingPolicy === 'unknown-cache-discount-2026-09-09' ? null : local.cache
  let expectedMilli: number
  try {
    expectedMilli = price?.version === 'credits-v2-itemized'
      ? calculateV2UserChargeMilli(local.input,local.output,cache,price.rates,price.v1CeilingBps,price.activity)
      : calculateV1ChargeMilli(local.input,local.output,price?.multiplierBps ?? local.multiplier)
  } catch { return result('unknown','计量或价格无法复算') }
  const chargedMilli = ledger ? -ledger.deltaMilli : 0
  const amounts = {expectedMilli,chargedMilli}
  if (local.recordedCharge !== null && local.recordedCharge !== chargedMilli || chargedMilli > expectedMilli) return {...result('difference','已结算用量与原扣款不符，交由账务核查'),...amounts}
  if (chargedMilli < expectedMilli) return {...result('unknown','实际扣费低于标准应扣，需核对余额耗尽或原预算合同'),...amounts}
  return {...result('matched','同一请求的计量、历史价格和账本一致'),...amounts}
}

async function findLocal(kind:string, id:string): Promise<Local|null> {
  if (kind === 'usage') {
    const v = await prisma.aiUsageLog.findUnique({where:{id},select:{ userId:true,modelTier:true,requestTokens:true,responseTokens:true,promptCacheHitTokens:true,reservedCreditMilli:true,billingStatus:true,billingSnapshot:true,usageSource:true,creditChargeMilli:true,multiplierBps:true }})
    if (!v || v.modelTier === 'custom') return null
    return {owner:v.userId,actionId:id,key:'usage:'+id,price:v.billingSnapshot,multiplier:v.multiplierBps,settled:v.billingStatus==='settled',input:v.requestTokens,output:v.responseTokens,cache:v.promptCacheHitTokens,reported:v.usageSource==='reported',recordedCharge:v.creditChargeMilli,exempt:v.billingStatus==='exempt',reserved:v.reservedCreditMilli>0}
  }
  if (kind !== 'attempt') return null
  const v = await prisma.agentProviderAttempt.findUnique({where:{id},select:{operationId:true,usageReceipt:true,operation:{select:{inputSnapshot:true,taskRoot:{select:{userId:true}}}}}})
  if (!v) return null
  const price = object(object(v.operation.inputSnapshot).input).billing
  if (!price || object(price).modelTier === 'custom') return null
  const u = v.usageReceipt
  return {owner:v.operation.taskRoot.userId,actionId:v.operationId,key:'operation:'+v.operationId,price,multiplier:10000,settled:u?.settlementStatus==='settled',input:u?.promptTokens??null,output:u?.completionTokens??null,cache:u?.cacheHitTokens??null,reported:u?.source==='reported',recordedCharge:null,exempt:false,reserved:false}
}

export function uniqueGatewayLink<T extends {kind:string; localId:string; requestId:string}>(forward:T[], reverse:{requestId:string}[], requestId:string|null) {
  return forward.length===1 && reverse.length===1 && forward[0].requestId===requestId && reverse[0].requestId===requestId ? forward[0] : null
}

export async function readGovernanceReconciliation(page:number, signal:AbortSignal, userId?:string, actionId?:string): Promise<GovernanceReconciliation> {
  const focused = Boolean(userId || actionId)
  const skip = (page-1)*20
  const [usage, attempts] = focused ? await Promise.all([
    prisma.aiUsageLog.findMany({where:{userId,id:actionId,OR:[{modelTier:null},{modelTier:{not:'custom'}}]},orderBy:[{createdAt:'desc'},{id:'asc'}],skip,take:21,select:{id:true,createdAt:true,userId:true}}),
    prisma.agentProviderAttempt.findMany({where:{operation:{taskRoot:{userId}},...(actionId?{OR:[{id:actionId},{operationId:actionId}]}:{})},orderBy:[{createdAt:'desc'},{id:'asc'}],skip,take:21,select:{id:true,createdAt:true,operation:{select:{taskRoot:{select:{userId:true}}}}}}),
  ]) : [[],[]]
  const selected = [...usage.slice(0,20).map(v=>({...v,kind:'usage'})),...attempts.slice(0,20).map(v=>({kind:'attempt',id:v.id,createdAt:v.createdAt,userId:v.operation.taskRoot.userId}))]
  const links = focused ? await prisma.yunshuRequestLink.findMany({where:{OR:selected.map(v=>({kind:v.kind,localId:v.id}))}}) : []
  const requested = focused ? new Set(links.map(v=>v.requestId)) : undefined
  const upstream = await getAdminYunshuOperations({period:'month',page:focused?1:page,pageSize:focused?100:20,kind:'all',view:'records'},signal,requested)
  const rows: ReconciliationRow[] = []
  for (const row of upstream.records.items) {
    const links = row.requestId ? await prisma.yunshuRequestLink.findMany({where:{requestId:row.requestId},take:2}) : []
    const link = links.length === 1 ? links[0] : null
    const inverse = link ? await prisma.yunshuRequestLink.findMany({where:{kind:link.kind,localId:link.localId},take:2,select:{requestId:true}}) : []
    const local = uniqueGatewayLink(links,inverse,row.requestId) && (!focused || selected.some(v=>v.id===links[0].localId && v.kind===links[0].kind)) ? await findLocal(links[0].kind,links[0].localId) : null
    const keys = local ? [local.key,'refund:'+local.key] : []
    const entries = keys.length ? await prisma.creditLedgerEntry.findMany({where:{idempotencyKey:{in:keys}},select:{idempotencyKey:true,userId:true,deltaMilli:true,metadata:true,refundIntent:{select:{settledAt:true}}}}) : []
    const observation = compareGovernanceReceipt(row,local,entries.find(e=>e.idempotencyKey===keys[0])??null,entries.find(e=>e.idempotencyKey===keys[1])??null)
    if (observation.userId && local && link) observation.goal = await readGoalReceipt(local.owner, (link.kind === 'usage' ? 'legacy:' : 'durable:') + link.localId)
    rows.push(observation)
  }
  for (const item of selected) {
    const witnessed = links.filter(v=>v.localId===item.id && v.kind===item.kind)
    if (witnessed.some(v=>rows.some(r=>r.upstreamId===v.requestId))) continue
    const goal = await readGoalReceipt(item.userId, (item.kind === 'usage' ? 'legacy:' : 'durable:') + item.id)
    rows.push({goal,userId:item.userId,actionId:item.id,upstreamId:witnessed[0]?.requestId??null,observedAt:item.createdAt.toISOString(),
      state:'unknown',reason:'所选业务在本期可见上游日志中缺少唯一对应记录',expectedMilli:null,chargedMilli:null,refundMilli:null})
  }
  const fixedFees = await readFixedFeeReceipts(page, userId, actionId)
  return { fixedFees:fixedFees.items, observedAt:upstream.observedAt,message:upstream.message,page:focused?page:upstream.records.page,hasMore:focused?usage.length>20 || attempts.length>20 || fixedFees.hasMore:upstream.records.hasMore,rows }
}
