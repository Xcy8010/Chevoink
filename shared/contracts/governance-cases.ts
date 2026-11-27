export const governanceTargets = ['post', 'message', 'profile', 'novel', 'comment', 'platform'] as const
export type ReportTarget = (typeof governanceTargets)[number]
export const reportReasons = {
  harmful: '违法有害内容',
  sexual: '色情低俗',
  threat: '暴力威胁',
  harassment: '骚扰辱骂',
  fraud: '欺诈广告',
  copyright: '侵权抄袭',
  privacy: '隐私泄露',
  other: '其他',
} as const
export const usageCategories = {
  resale: '未经授权的代理或转售',
  reward: '奖励或资格异常',
  billing: '疑似故意利用计费缺陷',
  account: '账号共享牟利或被盗保护',
  community: '骚扰、广告或滥用举报',
  security: '服务或数据安全',
  evasion: '持续规避内容规则',
} as const
export type ReportReason = keyof typeof reportReasons
export function allowedReasons(kind: ReportTarget): ReportReason[] {
  const reasons = Object.keys(reportReasons) as ReportReason[]
  return kind === 'platform' ? ['privacy', 'fraud', 'other'] : reasons
}
export const caseStatuses = {
  pending: '待受理',
  investigating: '调查中',
  upheld: '成立',
  dismissed: '不成立',
  linked: '重复关联',
  maintained: '维持原决定',
  adjusted: '已调整',
  lifted: '已解除',
  corrected: '已纠错',
} as const
export type CaseStatus = keyof typeof caseStatuses
export const reportFeedback: Record<string, string> = {
  pending: '感谢你的反馈，我们已收到举报，将尽快核查。',
  investigating: '我们正在进一步核查相关情况。',
  upheld: '经核实，我们已对相关内容或行为采取相应措施。感谢你帮助维护创作环境。',
  dismissed: '感谢你的反馈。经核查，目前尚未发现足以认定违规的依据。如有其他信息，欢迎继续补充。',
  linked: '你的举报已关联至同一事项，我们会向你反馈处理结果。',
}
export type CaseRow = {
  id: string
  kind: string
  targetKind: string
  targetId: string
  category: string
  status: CaseStatus
  acknowledgeBy: string
  feedbackBy: string | null
  materialsAt: string | null
  acknowledgedAt: string | null
  publicProgress: string | null
  createdAt: string
  updatedAt: string
}
export type CaseDetails = CaseRow & {
  statement: string | null
  snapshot: string | null
  subjectId: string | null
  conclusion: string | null
  relatedId: string | null
  safetyEvents: { id: string; category: string }[]
  events: { id: string; action: string; result: string | null; reason: string | null; createdAt: string }[]
}
export type AppealSubject = {
  id: string
  kind: 'restriction' | 'warning' | 'legacy'
  reason: string
  clause: string
  measure: string
  expiresAt: string | null
}
