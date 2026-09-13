import { createHash } from 'node:crypto'
import { z } from 'zod'
import { prisma } from './prisma.js'
import { decryptSecret } from './secret-box.js'
import type { SupplierBalance } from '../../shared/contracts/supplier-balances.js'

const amount = z.string().regex(/^-?\d+(\.\d+)?$/).max(64)
const responseSchema = z.object({ balance_infos: z.array(z.object({ currency: z.enum(['CNY', 'USD']), total_balance: amount, granted_balance: amount, topped_up_balance: amount })).min(1).max(2) })
export function supplierEndpoint(base: string | null) {
  try {
    const url = new URL(base ?? '')
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    return url.hostname === 'api.deepseek.com' ? 'https://api.deepseek.com/user/balance' : null
  } catch { return null }
}

export async function queryDeepSeekBalance(key: string, deadline?: AbortSignal): Promise<SupplierBalance['balances']> {
  const timeout = AbortSignal.timeout(8000)
  const response = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: deadline ? AbortSignal.any([timeout, deadline]) : timeout })
  if (!response.ok) { await response.body?.cancel(); throw new Error('BALANCE_UNAVAILABLE') }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('BALANCE_UNAVAILABLE')
  let text = ''
  let size = 0
  const decoder = new TextDecoder()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 16384) throw new Error('BALANCE_UNAVAILABLE')
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return responseSchema.parse(JSON.parse(text)).balance_infos.map(row => ({ currency: row.currency, total: row.total_balance, granted: row.granted_balance, toppedUp: row.topped_up_balance }))
}

let snapshot: { expires: number; promise: Promise<SupplierBalance[]> } | undefined
export function getSupplierBalances() {
  if (snapshot && snapshot.expires > Date.now()) return snapshot.promise
  const promise = loadBalances().catch(error => { snapshot = undefined; throw error })
  snapshot = { expires: Date.now() + 60000, promise }
  return promise
}

async function loadBalances(): Promise<SupplierBalance[]> {
  const configs = await prisma.aiModelConfig.findMany({ where: { ownerUserId: null }, orderBy: { id: 'asc' }, take: 64 })
  const groups = new Map<string, { row: SupplierBalance; key: string | null; endpoint: string | null }>()
  for (const config of configs) {
    let key: string | null = null
    try { key = config.apiKeyCiphertext ? decryptSecret(config.apiKeyCiphertext) : null } catch { /* Report missing credentials, never plaintext errors. */ }
    let host = '未配置'
    try { host = new URL(config.baseUrl ?? '').hostname } catch { /* Invalid config does not authorize a network request. */ }
    const identity = `${host}:${createHash('sha256').update(key ?? config.id).digest('hex')}`
    const existing = groups.get(identity)
    if (existing) { existing.row.models.push(config.displayName); continue }
    const consoleUrl = ({ 'api.deepseek.com': 'https://platform.deepseek.com', 'open.bigmodel.cn': 'https://open.bigmodel.cn', 'www.hohoapi.com': 'https://www.hohoapi.com', 'api.bochaai.com': 'https://open.bochaai.com' } as Record<string, string>)[host] ?? null
    groups.set(identity, { key, endpoint: supplierEndpoint(config.baseUrl), row: { provider: host, models: [config.displayName], balances: [], checkedAt: new Date().toISOString(), status: key ? 'unsupported' : 'unconfigured', message: key ? '尚未核实公开余额接口，请在供应商控制台查看。' : '数据库凭据未配置或不可解密；未查询环境变量回退凭据。', consoleUrl } })
  }
  // Sequential, bounded requests avoid bursts; only the documented DeepSeek host receives its own key.
  const deadline = AbortSignal.timeout(10000)
  for (const group of groups.values()) {
    if (!group.key || !group.endpoint) continue
    try { group.row.balances = await queryDeepSeekBalance(group.key, deadline); group.row.status = 'ready'; group.row.message = '供应商账户余额，不是单模型余额；不同凭据可能属于同一账户，请勿相加。' }
    catch { group.row.status = 'error'; group.row.message = '余额查询暂不可用，请核对凭据、网络或供应商状态。' }
    group.row.checkedAt = new Date().toISOString()
  }
  return [...groups.values()].map(group => group.row)
}
