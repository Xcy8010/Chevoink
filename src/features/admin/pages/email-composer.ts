import type { EmailLibraryEntry } from '../../../../shared/contracts/email-library'
import approvedHtml from './creator-return.html?raw'

import { governanceMailTemplates } from '../../../../shared/contracts/governance-mail'
import warningHtml from '../../../../api/templates/governance/chevoink-account-warning.html?raw'
import enforcementHtml from '../../../../api/templates/governance/chevoink-account-enforcement.html?raw'
import appealHtml from '../../../../api/templates/governance/chevoink-appeal-result.html?raw'

const systemTemplate = (kind: keyof typeof governanceMailTemplates, body: string, to: string, action: string) => {
  const { id, name, subject } = governanceMailTemplates[kind]
  return { id, name, subject, body, to, action }
}
export const governanceLibrary = [
  systemTemplate('warning', warningHtml, '/admin/governance/safety', '前往安全复核'),
  systemTemplate('enforcement', enforcementHtml, '/admin/governance/restrictions', '前往账号处置'),
  systemTemplate('appeal_result', appealHtml, '/admin/governance/appeals', '前往申诉处理'),
]

export const returnMail: EmailLibraryEntry = {
  id: 237702, name: '创作者回归激励', subject: '【启创墨域】你有一份创作额度福利！', body: approvedHtml,
}
export const invitation: EmailLibraryEntry = { id: 0, name: '内测邀请', subject: '【启创墨域】内测邀请', body: '实际正文将在生成发送预览后显示。' }
export type ReturnFields = {credits:string;kind:'relative'|'fixed';days:string;fixed:string;path:string}
export const defaultReturn: ReturnFields = {credits:'80',kind:'relative',days:'7',fixed:'',path:'studio'}
export function resolvedDate(fields:ReturnFields,now:Date) {
  return fields.kind === 'fixed' ? new Date(fields.fixed+':00+08:00') : new Date(now.getTime()+Number(fields.days)*86400000)
}
