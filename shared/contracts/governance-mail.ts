export const governanceMailTemplates = {
  warning: {
    id: 238307, name: '账号使用提醒', subject: '【启创墨域】账号使用提醒', file: 'chevoink-account-warning.html',
  },
  enforcement: {
    id: 238308, name: '账号使用限制通知', subject: '【启创墨域】账号使用限制通知', file: 'chevoink-account-enforcement.html',
  },
  appeal_result: {
    id: 238309, name: '申诉处理结果通知', subject: '【启创墨域】申诉处理结果通知', file: 'chevoink-appeal-result.html',
  },
} as const

export type GovernanceMailKind = keyof typeof governanceMailTemplates


export function isGovernanceMailTemplateId(id: number | null | undefined) {
  return Object.values(governanceMailTemplates).some(template => template.id === id)
}
