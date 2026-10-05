import { isBuiltInModelTier } from '../../../shared/contracts/model-tier.js'
import type { Prisma } from '@prisma/client'
import { MODEL_ASSIGNMENT_TASKS, type AgentModelSelection, type ModelAssignmentTask } from '../../../shared/contracts/agent-model-assignments.js'
import type { CreativeFreedom } from '../../../shared/contracts/agent-events.js'
import { DataAccessError } from '../prisma.js'
import { readHumanAdmission } from './goal-activation-authority.js'
import { readGoalConsentSourceRun } from './goal-consent.js'
import { runtimeJson } from './runtime-common.js'
import type { ToolContext } from './tools/types.js'
import { configurationDirectives } from './configuration-command.js'
import { readConfigurationConsents } from './configuration-journal.js'
export { isConfigurationCommand } from './configuration-command.js'

const tierNames: Record<string, string[]> = { lite: ['lite', '轻量'], speed: ['speed', '极速'], standard: ['standard', '标准'],
  performance: ['performance', '性能'], ultimate: ['ultimate', '极致'] }
const modeNames: Record<CreativeFreedom, string[]> = { stable: ['stable', '平衡'], balanced: ['balanced', '严谨'], bold: ['bold', '大胆'] }
const taskNames: Partial<Record<ModelAssignmentTask, string[]>> = { chapter_writing: ['写作', '正文'], continuity: ['连续性'], quality: ['质量'],
  main: ['主 Agent', '主Agent'], subagent: ['子 Agent', '子Agent'], import_analysis: ['导入'], vision: ['图片'], session_title: ['命名'] }
const effortNames: Record<string, string[]> = { none: ['关闭思考'], minimal: ['最小'], low: ['低'], medium: ['中等', '中'], high: ['高'], xhigh: ['极高'], max: ['最高'] }
function mentionsEffort(command: string, effort: string): boolean {
  if (mentionsConfigurationChoice(command, [effort])) return true
  return (effortNames[effort] ?? []).some(name => new RegExp(`(?:^|\\s|(?:思考|推理)(?:强度)?(?:为|设为|改为|[:：\\s])*)${name}(?:$|\\s|强度)`, 'u').test(command))
}
export function mentionsConfigurationChoice(prompt: string, names: string[]): boolean {
  return names.some(name => name && (/[\p{Script=Han}]/u.test(name) ? prompt.includes(name)
    : new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'iu').test(prompt)))
}
function directiveTask(command: string): ModelAssignmentTask {
  const body = command.replace(/^(?:(?:请|麻烦|现在|接下来|以后|后续|全局|所有作品|所有小说|全部作品|please|global|all novels|now)\s*)*/iu, '')
  if (/^(?:写作模式|创作模式)/u.test(body)) return 'main'
  const tasks = MODEL_ASSIGNMENT_TASKS.flatMap(task => [task.label, task.key, ...(taskNames[task.key] ?? [])].map(name => ({ key: task.key, name })))
    .sort((a, b) => b.name.length - a.name.length)
  return tasks.find(task => body.startsWith(task.name) && /(?:用|切换|改为|设为|\buse\b|\bset\b)/iu.test(body.slice(task.name.length)))?.key ?? 'main'
}
const globalDirective = (command: string) => /(?:全局|所有作品|所有小说|全部作品|all novels|global)/iu.test(command)
const modeDirective = (command: string) => /(?:写作模式|创作模式|模式|\bmode\b|严谨|大胆|平衡)/iu.test(command)
const effortDirective = (command: string) => /(?:思考|推理|\breasoning\b|\beffort\b|\bnone\b|\bminimal\b|\blow\b|\bmedium\b|\bhigh\b|\bxhigh\b|\bmax\b)/iu.test(command)
function effortOnlyDirective(command: string) {
  let body = command.replace(/^(?:(?:请|麻烦|现在|接下来|以后|后续|全局|所有作品|所有小说|全部作品|please|global|all novels|now)\s*)*/iu, '')
  const task = directiveTask(command)
  const names = [MODEL_ASSIGNMENT_TASKS.find(item => item.key === task)!.label, task, ...(taskNames[task] ?? [])].sort((a, b) => b.length - a.length)
  const prefix = names.find(name => body.startsWith(name))
  if (prefix) body = body.slice(prefix.length).trim()
  return /^(?:思考强度|推理强度|reasoning|effort)/iu.test(body)
}
function selectsModel(command: string, names: string[]): boolean {
  const selection = command.match(/(?:切换(?:到|为)?|换成|改用|使用|改为|设为|用|\bswitch(?:\s+to)?|\buse|\bset(?:\s+to)?|\bchange(?:\s+to)?)\s*[:：]?\s*(.+)$/iu)?.[1]
  if (!selection) return false
  return names.some(name => name && new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s|[，,。；;])`, 'iu').test(selection))
}
/** Only the saved authentic HTTP author request grants a change. Synthetic child prompts never do. */
export async function assertConfigurationAuthority(tx: Prisma.TransactionClient, ctx: ToolContext, input: {
  model?: AgentModelSelection; creativeFreedom?: CreativeFreedom; task?: ModelAssignmentTask; global?: boolean; effortOnly?: string; effectiveReasoningEffort?: string
}) {
  const deny = () => { throw new DataAccessError(409, 'CONFIGURATION_AUTHOR_REQUIRED', '请先向作者确认要切换的模型、思考强度或写作模式。') }
  if (ctx.inlineChild) return deny()
  const run = await tx.agentRun.findFirst({ where: { id: ctx.runId, userId: ctx.userId, sessionId: ctx.sessionId, novelId: ctx.novelId } })
  const session = await tx.agentSession.findFirst({ where: { id: ctx.sessionId, userId: ctx.userId, novelId: ctx.novelId } })
  if (!run || !session || session.spawnedFromSessionId) return deny()
  const source = await readGoalConsentSourceRun(tx, run)
  const admitted = readHumanAdmission(source.startRequest)
  const message = admitted ? await tx.agentMessage.findFirst({ where: { runId: source.id, sessionId: ctx.sessionId, role: 'user' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) : null
  if (!admitted || !message || admitted.request.novelId !== ctx.novelId || admitted.request.sessionId !== ctx.sessionId) return deny()
  const expected = [{ type: 'text', text: admitted.request.prompt }, ...(admitted.request.attachments ?? []).map(item => ({ type: 'attachment', kind: item.kind, name: item.name, url: item.url, size: item.size }))]
  if (runtimeJson(JSON.parse(JSON.stringify(expected))).hash !== runtimeJson(message.parts).hash) return deny()
  const journals = [...await readConfigurationConsents(tx, run, true, ctx.durableConfiguration?.lease.epoch, true),
    ...await readConfigurationConsents(tx, run, false, ctx.durableConfiguration?.lease.epoch, true)]
    .sort((a, b) => a.row.sequence < b.row.sequence ? -1 : a.row.sequence > b.row.sequence ? 1 : 0)
  const candidates = [{ prompt: admitted.request.prompt, messageId: message.id, messageHash: runtimeJson(message.parts).hash },
    ...journals.map(item => ({ prompt: item.prompt, messageId: item.consent.messageId, messageHash: item.consent.messageHash,
      pending: !item.consent.consumed || !item.currentEpoch }))]
  let modelNames: string[] | undefined
  let ambiguousNames: string[][] = []
  if (input.model) {
    const record = await tx.aiModelConfig.findFirst({ where: input.model.modelTier === 'custom'
      ? { id: input.model.customModelId, ownerUserId: ctx.userId, enabled: true }
      : { tier: input.model.modelTier, ownerUserId: null, enabled: true } })
    modelNames = [input.model.modelTier, ...(tierNames[input.model.modelTier] ?? []), record?.displayName ?? '', record?.modelName ?? '']
    const choices = await tx.aiModelConfig.findMany({ where: { enabled: true, OR: [{ ownerUserId: ctx.userId }, { ownerUserId: null, selectable: true, tier: { not: null } }] },
      select: { id: true, ownerUserId: true, tier: true, displayName: true, modelName: true } })
    ambiguousNames = choices.filter(choice => choice.ownerUserId === ctx.userId || isBuiltInModelTier(choice.tier))
      .filter(choice => input.model?.modelTier === 'custom' ? choice.id !== input.model.customModelId : choice.ownerUserId !== null || choice.tier !== input.model?.modelTier)
      .map(choice => [...(choice.ownerUserId ? ['custom'] : [choice.tier ?? '', ...(tierNames[choice.tier ?? ''] ?? [])]), choice.displayName, choice.modelName])
  }
  const directives = candidates.flatMap(candidate => configurationDirectives(candidate.prompt).map(directive => ({ ...candidate, ...directive,
    revoked: directive.revoked || 'pending' in candidate && candidate.pending })))
  const target = input.task ?? 'main'
  const latest = (setting: 'model' | 'mode' | 'effort') => [...directives].reverse().find(directive => directiveTask(directive.command) === target
    && globalDirective(directive.command) === Boolean(input.global)
    && (setting === 'mode' ? modeDirective(directive.command) : setting === 'effort' ? effortDirective(directive.command) : !modeDirective(directive.command)
      && !effortOnlyDirective(directive.command)))
  const latestModel = latest('model')
  const model = input.model ? latestModel : undefined
  const mode = input.creativeFreedom ? latest('mode') : undefined
  const latestEffort = latest('effort')
  const modelEffort = latestModel && (!latestEffort || directives.indexOf(latestModel) > directives.indexOf(latestEffort)) ? latestModel : latestEffort
  const effort = input.effortOnly ? modelEffort : undefined
  if (input.model && (!model || model.revoked || !selectsModel(model.command, modelNames!) || ambiguousNames.some(names => selectsModel(model.command, names))
    || input.model.reasoningEffort && (!modelEffort || modelEffort.revoked || !mentionsEffort(modelEffort.command, input.model.reasoningEffort)))) return deny()
  if (input.model && input.model.reasoningEffort === undefined && input.effectiveReasoningEffort
    && (!modelEffort || modelEffort.revoked || (modelEffort !== model || effortDirective(modelEffort.command))
      && !mentionsEffort(modelEffort.command, input.effectiveReasoningEffort))) return deny()
  if (input.creativeFreedom && (!mode || mode.revoked || !mentionsConfigurationChoice(mode.command, modeNames[input.creativeFreedom]))) return deny()
  if (input.effortOnly && (!effort || effort.revoked || !mentionsEffort(effort.command, input.effortOnly))) return deny()
  const authorized = model ?? mode ?? effort
  if (!authorized) return deny()
  return { sourceMessageId: authorized.messageId, sourceHash: authorized.messageHash }
}
