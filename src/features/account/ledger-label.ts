import type { CreditLedgerItem } from '../../../shared/contracts'

/** Credits 记录来源文案：与后端 ledger sourceType 一一对应 */
export const SOURCE_LABELS: Record<string, string> = {
  model_tokens: '文本模型', image_generation: '生图模型', web_search: '联网搜索', view_image: '查看图片',
  referral_inviter: '邀请奖励', referral_invitee: '受邀奖励', admin_reset: '管理员重置', admin_reset_all: '管理员全体重置',
}

/** 文本模型行按实际调用档位展示模型名，而非笼统的「文本模型」 */
export const TIER_LABELS: Record<string, string> = {
  lite: '轻量', speed: '极速', standard: '标准', performance: '性能', ultimate: '极致', basic: '基础', custom: '自定义模型',
}

export function ledgerLabel(item: CreditLedgerItem): string {
  if (item.kind === 'refund') return '失败调用返还'
  if (item.sourceType === 'model_tokens') return item.modelLabel || TIER_LABELS[item.modelTier ?? ''] || SOURCE_LABELS.model_tokens
  return SOURCE_LABELS[item.sourceType] ?? item.sourceType
}
