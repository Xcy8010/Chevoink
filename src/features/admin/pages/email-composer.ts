import type { EmailLibraryEntry } from '../../../../shared/contracts/email-library'
import approvedHtml from './creator-return.html?raw'

export const returnMail: EmailLibraryEntry = {
  id: 237702, name: '创作者回归激励', subject: '【启创墨域】你有一份创作额度福利！', body: approvedHtml,
}
export const invitation: EmailLibraryEntry = { id: 0, name: '内测邀请', subject: '【启创墨域】内测邀请', body: '实际正文将在生成发送预览后显示。' }
export type ReturnFields = {credits:string;kind:'relative'|'fixed';days:string;fixed:string;path:string}
export const defaultReturn: ReturnFields = {credits:'80',kind:'relative',days:'7',fixed:'',path:'studio'}
export function resolvedDate(fields:ReturnFields,now:Date) {
  return fields.kind === 'fixed' ? new Date(fields.fixed+':00+08:00') : new Date(now.getTime()+Number(fields.days)*86400000)
}
