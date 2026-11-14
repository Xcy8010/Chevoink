import { z } from 'zod'
import { agentPersonalizationMemoryTextSchema, patchAgentPersonalizationSchema } from '../../../shared/contracts/agent-personalization.js'
import { DataAccessError } from '../prisma.js'
import { readHumanAdmission } from './goal-activation-authority.js'
import { readGoalConsentSourceRun } from './goal-consent.js'
import { PERSONALIZATION_WRITE_ACTIONS } from './personalization-operations.js'
import { identifyMemory } from './personalization.js'
import type { RuntimeTx } from './runtime-common.js'
import type { ToolContext } from './tools/types.js'

type Scope = Pick<ToolContext, 'runId' | 'userId' | 'sessionId' | 'novelId'>

export async function readPersonalizationAuthor(tx: RuntimeTx, ctx: Scope) {
  const run = await tx.agentRun.findFirst({ where: { id: ctx.runId, userId: ctx.userId, novelId: ctx.novelId, sessionId: ctx.sessionId,
    session: { userId: ctx.userId, spawnedFromSessionId: null } } })
  const source = run?.taskRootId ? await readGoalConsentSourceRun(tx, run) : run
  const author = readHumanAdmission(source?.startRequest)
  if (!source || !author || author.request.novelId !== ctx.novelId || author.request.sessionId !== ctx.sessionId) return null
  const message = await tx.agentMessage.findFirst({ where: { runId: source.id, sessionId: ctx.sessionId, role: 'user' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { parts: true, createdAt: true } })
  const text = Array.isArray(message?.parts) ? message.parts.flatMap(part => part && typeof part === 'object' && !Array.isArray(part)
    && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n') : null
  return message && text === author.request.prompt ? { prompt: text, createdAt: message.createdAt, hasAttachments: Boolean(author.request.attachments?.length) } : null
}

type Author = NonNullable<Awaited<ReturnType<typeof readPersonalizationAuthor>>>
type WriteAdmission = 'direct' | 'confirm' | 'reject'
const untrustedMemorySource = /[\n\r「」『』“”`]|(?:引用|台词|角色|示例|假设|转述|不要记|别记|不必记|暂时|这次|本次|这一章|本书设定)/u
const sensitiveMemory = /(?:身份证|密码|密钥|住址|地址|电话|手机号|银行卡|病历|诊断|政治倾向|性取向|宗教)|[a-z\d._%+-]+@[a-z\d.-]+\.\w{2,}|\d{6,}/iu
const standalone = (prompt: string) => prompt.trim().replace(/[。.!！]+$/u, '')
const memorization = z.object({ text: agentPersonalizationMemoryTextSchema, pinned: z.boolean().optional() })
const degrees = [
  ['warmth', '亲切程度', '克制', '更亲切'],
  ['enthusiasm', '热情程度', '平稳', '更积极'],
  ['detail', '回答详略', '简短', '详细'],
  ['emoji', '表情符号', '少用', '多用'],
  ['format', '标题与列表', '少用', '多用'],
] as const

function authorSettingChange(prompt: string) {
  const match = /^(?:请)?(?:把|将)?(?:个性化(?:设置)?(?:中的?)?)?(.+?)(?:改成|改为|设为|设置为|切换到|切换为)(.+)$/u.exec(prompt)
  if (/^(?:请)?(?:开启|打开|启用)全局记忆$/u.test(prompt)) return { memoryEnabled: true }
  if (/^(?:请)?(?:关闭|停用|禁用)全局记忆$/u.test(prompt)) return { memoryEnabled: false }
  if (!match) return null
  const [, field, value] = match
  if (['风格', '交流风格', '基础风格'].includes(field)) {
    const style = { 自然: 'natural', 专业: 'professional', 直率: 'direct', 创作搭档: 'partner' }[value]
    return style ? { style } : null
  }
  if (field === '自定义指令' || field === '回答偏好') return { customInstructions: value.trim() }
  const degree = degrees.find(([, label]) => field === label)
  if (degree) {
    const [key, , less, more] = degree
    const next = value === '默认' ? 'default' : value === less ? 'less' : value === more ? 'more' : null
    return next ? { [key]: next } : null
  }
  return null
}

export function personalizationWriteAdmission(action: string, args: unknown, author: Author | null): WriteAdmission {
  if (!PERSONALIZATION_WRITE_ACTIONS.includes(action)) return 'direct'
  if (!author) return 'reject'
  if (action === 'account_memory_save') {
    const value = memorization.safeParse(args)
    if (!value.success || !author.prompt.includes(value.data.text)) return 'reject'
    const { text, pinned } = value.data
    const main = standalone(author.prompt)
    const explicit = /^(?:请)?(?:(?:一直|永远|固定)记住|记住|记下)[:：,，]?\s*(.+)$/u.exec(main)
    const demonstrablyPinned = /^(?:请)?(?:一直|永远|固定)记住/u.test(main)
    if (author.hasAttachments || untrustedMemorySource.test(author.prompt)) return 'reject'
    if (sensitiveMemory.test(author.prompt)) return explicit && standalone(text) === standalone(explicit[1]) ? 'confirm' : 'reject'
    if (pinned && !demonstrablyPinned) return 'confirm'
    if (explicit && standalone(text) === standalone(explicit[1])) return 'direct'
    if (standalone(text) !== main || /[。!?！？;；]/u.test(main)) return 'reject'
    const identity = identifyMemory(text)
    return identity.protected || /^(?:我(?:平时|通常|一贯|长期|一直)(?:偏好|喜欢|习惯|倾向|会)|(?:今后|以后)(?:请|希望)(?:优先|尽量|总是))/u.test(main)
      ? 'direct' : 'reject'
  }
  if (action === 'account_preferences_update' && !author.hasAttachments && !untrustedMemorySource.test(author.prompt) && !sensitiveMemory.test(author.prompt)) {
    const value = patchAgentPersonalizationSchema.safeParse(args)
    if (value.success) {
      const { expectedRevision: _observed, ...changes } = value.data
      void _observed
      const intended = authorSettingChange(standalone(author.prompt))
      if (intended && Object.keys(changes).length === 1 && Object.entries(intended).every(([key, expected]) => Object.entries(changes).some(([field, actual]) => field === key && actual === expected)))
        return 'direct'
    }
  }
  // Rule administration and destructive operations are always tied to the
  // exact authenticated confirmation receipt, even with an account allow rule.
  return 'confirm'
}

export async function readPersonalizationWriteAdmission(tx: RuntimeTx, ctx: Scope, action: string, args: unknown) {
  return PERSONALIZATION_WRITE_ACTIONS.includes(action)
    ? personalizationWriteAdmission(action, args, await readPersonalizationAuthor(tx, ctx)) : 'direct'
}

export function assertPersonalizationWriteAdmission(admission: WriteAdmission, approved: boolean) {
  if (admission === 'reject') throw new DataAccessError(409, 'PERSONALIZATION_AUTHOR_REQUIRED', '请由作者在主任务中明确提出请求。记忆来源必须是本次作者亲自表达的内容。')
  if (admission === 'confirm' && !approved) throw new DataAccessError(409, 'PERSONALIZATION_CONFIRMATION_REQUIRED', '请由作者确认本次个性化变更。')
}
