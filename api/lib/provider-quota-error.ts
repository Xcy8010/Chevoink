import { DataAccessError } from './prisma.js'

const quotaCodes = new Set(['insufficient_quota', 'quota_exceeded', 'insufficient_balance'])
const observedQuotaMessage = /^(?:you|your) account balance exceeded your current quota[.!]?$/i

/** Only inspect a provider error envelope (or a non-OK HTTP error body).
 * Never inspect assistant text, tool arguments or other narrative content. */
export function isProviderQuotaError(error: unknown): boolean {
  if (typeof error === 'string') return observedQuotaMessage.test(error.trim())
  if (!error || typeof error !== 'object') return false
  const fields = error as { code?: unknown; type?: unknown; message?: unknown }
  return [fields.code, fields.type].some(value => typeof value === 'string' && quotaCodes.has(value.toLowerCase()))
    || typeof fields.message === 'string' && observedQuotaMessage.test(fields.message.trim())
}

export function providerQuotaError(custom: boolean): DataAccessError {
  return new DataAccessError(502, 'AI_PROVIDER_QUOTA_EXCEEDED', custom
    ? '自定义模型的供应商账号余额或额度不足。请检查该供应商账号的余额、额度和 API Key，处理后再继续当前任务。已保存内容和已知用量保留；未确认用量仍待核实，系统不会自动重试。'
    : '内置模型的上游供应商账号余额或额度不足，请联系平台管理员处理，或切换可用模型后继续当前任务。这不是 Chevoink Credits 不足。已保存内容和已知用量保留；未确认用量仍待核实，系统不会自动重试。')
}
