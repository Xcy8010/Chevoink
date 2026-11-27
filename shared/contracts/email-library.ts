import { z } from 'zod'
import { governanceMailTemplates } from './governance-mail.js'

export const emailVariablePattern = /{{\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*}}/g

export const emailLibraryEntryFields = z.object({
  id: z.number().int().positive().max(2147483647).refine(id => id !== 237702, '回归激励模板已在模板库中。')
    .refine(id => !Object.values(governanceMailTemplates).some(template => template.id === id), '该模板专用于对应的治理通知。'),
  name: z.string().trim().min(1).max(80),
  subject: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(65536),
}).strict()

export function hasValidEmailVariables(template: {subject: string; body: string}) {
  const content = template.subject + '\n' + template.body
  return !/\{\{|\}\}/.test(content.replace(emailVariablePattern, '')) && emailVariables(content).length <= 32
}
export const emailLibraryEntrySchema = emailLibraryEntryFields.refine(hasValidEmailVariables, '模板变量格式不正确或超过 32 个。')
export type EmailLibraryEntry = z.infer<typeof emailLibraryEntrySchema>

export function emailVariables(body: string) {
  return [...new Set(Array.from(body.matchAll(emailVariablePattern), match => match[1]))]
}
