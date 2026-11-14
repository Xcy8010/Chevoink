import { z } from 'zod'
import { env } from '../../../config/env.js'
import { DataAccessError, prisma } from '../../prisma.js'
import {
  agentPersonalizationRevisionSchema, createAgentPersonalizationMemorySchema,
  patchAgentPersonalizationMemorySchema, patchAgentPersonalizationSchema,
} from '../../../../shared/contracts/agent-personalization.js'
import { readHumanAdmission } from '../goal-activation-authority.js'
import { readGoalConsentSourceRun } from '../goal-consent.js'
import { getModelAssignments } from '../model-assignments.js'
import {
  deletePersonalizationMemory, getAgentPersonalization, listPersonalizationMemories,
  patchAgentPersonalization, saveConversationMemory, updatePersonalizationMemory,
} from '../personalization.js'
import { runtimeTransaction } from '../runtime-common.js'
import { getWindowConfiguration, readRunWindowConfiguration } from '../window-configuration.js'
import { defineTool, type ToolContext } from './types.js'

const readPermission = { plan: 'allow', build: 'allow', review: 'allow' } as const
const writePermission = { plan: 'allow', build: 'allow', review: 'deny' } as const
const memoryId = z.string().min(1).max(64)
const noArguments = z.object({}).strict()

async function assertPersonalizationToolAvailable(ctx: ToolContext, db = ctx.transaction ?? prisma) {
  ctx.signal.throwIfAborted()
  if (env.appEnv === 'production' && !await (await import('../../app-releases.js')).hasAgentPersonalizationCapability(ctx.userId, db))
    throw new DataAccessError(403, 'APP_RELEASE_CAPABILITY_DISABLED', '当前应用版本尚未开放此功能。')
}

export const accountProfileTool = defineTool({
  name: 'account_profile', title: '查看我的资料',
  description: '回答作者问「我是谁」「我的昵称或简介是什么」时读取当前登录作者的公开昵称、简介和私人称呼。资料是账号记录或作者自述。查询自己不需要作品列表或网络搜索。',
  parameters: noArguments, permission: readPermission, readOnly: true,
  async execute(ctx) {
    const db = ctx.transaction ?? prisma
    await assertPersonalizationToolAvailable(ctx, db)
    const profile = await db.user.findUnique({ where: { id: ctx.userId }, select: { nickname: true, bio: true } })
    if (!profile) throw new DataAccessError(404, 'TOOL_READ_NOT_FOUND', '当前账户资料不可用。')
    const { settings } = await getAgentPersonalization(ctx.userId, db)
    return { output: JSON.stringify({ nickname: profile.nickname, bio: profile.bio, preferredName: settings.preferredName }), summary: '已读取本人资料' }
  },
})

export const creationSettingsTool = defineTool({
  name: 'creation_settings_get', title: '查看创作设置',
  description: '查看当前运行实际使用的模型、思考强度和创作模式，窗口保存配置，以及当前作品继承的全局和作品模型分工、版本与来源。窗口修改使用 agent_configure，模型分工修改使用 model_assign。',
  parameters: noArguments, permission: readPermission, readOnly: true,
  async execute(ctx) {
    const db = ctx.transaction ?? prisma
    await assertPersonalizationToolAvailable(ctx, db)
    const run = await db.agentRun.findFirst({ where: { id: ctx.runId, userId: ctx.userId, sessionId: ctx.sessionId, novelId: ctx.novelId },
      select: { id: true, userId: true, sessionId: true, novelId: true, taskRootId: true, taskSpec: true, startRequest: true,
        modelTier: true, customModelId: true, reasoningEffort: true } })
    if (!run) throw new DataAccessError(404, 'TOOL_READ_NOT_FOUND', '当前运行配置不可用。')
    const window = await getWindowConfiguration(ctx.userId, ctx.sessionId, db)
    const assignments = await getModelAssignments(ctx.userId, ctx.novelId, db)
    const runConfiguration = await readRunWindowConfiguration(db, run)
    const currentRun = {
      modelTier: run.modelTier, customModelId: run.customModelId, reasoningEffort: run.reasoningEffort,
      creativeFreedom: ctx.creativeFreedom, modelSelectionSource: runConfiguration.modelSelectionSource,
      ...(ctx.modelAssignments ? { assignedModels: ctx.modelAssignments } : {}),
    }
    return { output: JSON.stringify({ currentRun, window, assignments }), summary: '已读取当前运行与保存的创作配置' }
  },
})

export const accountPreferencesGetTool = defineTool({
  name: 'account_preferences_get', title: '查看个性化设置',
  description: '读取当前账户在整个创作区的个性化设置及版本，用于查询或修改私人称呼、语气、自定义指令和全局记忆开关。',
  parameters: noArguments, permission: readPermission, readOnly: true,
  async execute(ctx) {
    await assertPersonalizationToolAvailable(ctx)
    const result = await getAgentPersonalization(ctx.userId, ctx.transaction ?? prisma)
    return { output: JSON.stringify(result), summary: '已读取个性化设置' }
  },
})

/** Profile and memory mutations are author-only. The caller's transaction also
 * holds the durable lease or legacy owner fence. Source text is never supplied
 * by a synthetic subagent, assistant history, or an attachment. */
async function withOwnedPreferenceWrite<T>(ctx: ToolContext, write: (tx: NonNullable<ToolContext['transaction']>, author: { prompt: string; createdAt: Date }) => Promise<T>) {
  if (ctx.inlineChild) throw new DataAccessError(409, 'PERSONALIZATION_AUTHOR_REQUIRED', '请由作者在主任务中操作个性化设置。')
  const apply = async (tx: NonNullable<ToolContext['transaction']>) => {
    ctx.signal.throwIfAborted()
    await ctx.assertCurrentExecution?.(tx)
    await assertPersonalizationToolAvailable(ctx, tx)
    const run = await tx.agentRun.findFirst({ where: { id: ctx.runId, userId: ctx.userId, novelId: ctx.novelId, sessionId: ctx.sessionId,
      session: { userId: ctx.userId, spawnedFromSessionId: null } } })
    const source = run?.taskRootId ? await readGoalConsentSourceRun(tx, run) : run
    const author = readHumanAdmission(source?.startRequest)
    if (!source || !author || author.request.novelId !== ctx.novelId || author.request.sessionId !== ctx.sessionId) {
      throw new DataAccessError(409, 'PERSONALIZATION_AUTHOR_REQUIRED', '当前操作缺少可核实的作者发言。请在主任务中重新提出请求。')
    }
    const message = await tx.agentMessage.findFirst({ where: { runId: source.id, sessionId: ctx.sessionId, role: 'user' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { parts: true, createdAt: true } })
    const text = Array.isArray(message?.parts) ? message.parts.flatMap(part => part && typeof part === 'object' && !Array.isArray(part)
      && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n') : null
    if (!message || text !== author.request.prompt) throw new DataAccessError(409, 'PERSONALIZATION_AUTHOR_REQUIRED', '当前作者发言与任务来源不一致。')
    const result = await write(tx, { prompt: text, createdAt: message.createdAt })
    ctx.signal.throwIfAborted()
    return result
  }
  return ctx.transaction ? apply(ctx.transaction) : runtimeTransaction(apply)
}

export const accountPreferencesUpdateTool = defineTool({
  name: 'account_preferences_update', title: '修改个性化设置',
  description: '按作者明确要求修改账户级个性化。先读取 account_preferences_get 取得 expectedRevision，只传需要改的字段。称呼是私人称呼，用于「以后叫我……」；只想本次调整语气时直接按要求回复。程度字段 less/default/more。保存后下一次生成应用。',
  parameters: patchAgentPersonalizationSchema, permission: writePermission, readOnly: false,
  async execute(ctx, args) {
    return withOwnedPreferenceWrite(ctx, async tx => {
      const before = await getAgentPersonalization(ctx.userId, tx)
      const after = await patchAgentPersonalization(ctx.userId, args, tx)
      const fields = (Object.keys(args) as Array<keyof typeof args>).filter(key => key !== 'expectedRevision')
      const changes = fields.map(field => ({ field, before: before.settings[field], after: after.settings[field] }))
      return { output: JSON.stringify({ changes, scope: 'account', revision: after.revision, applies: 'next_model_request' }), summary: '已保存个性化设置' }
    })
  },
})

export const accountMemoryListTool = defineTool({
  name: 'account_memory_list', title: '查看全局记忆',
  description: '作者问记住了哪些偏好或要管理记忆时，分页读取自己的全局记忆。可按文字查询，用实际条目 id 和 revision 修改或删除。',
  parameters: z.object({ query: z.string().trim().max(100).optional(), offset: z.number().int().nonnegative().optional() }).strict(),
  permission: readPermission, readOnly: true,
  async execute(ctx, args) {
    await assertPersonalizationToolAvailable(ctx)
    const { memories, revision, memoryEpoch } = await listPersonalizationMemories(ctx.userId, ctx.transaction)
    const query = args.query?.toLowerCase()
    const items = query ? memories.filter(memory => memory.text.toLowerCase().includes(query)) : memories
    const offset = args.offset ?? 0
    const page = items.slice(offset, offset + 12)
    return { output: JSON.stringify({ memories: page, revision, memoryEpoch, nextOffset: offset + page.length < items.length ? offset + page.length : null }), summary: '已读取全局记忆' }
  },
})

export const accountMemorySaveTool = defineTool({
  name: 'account_memory_save', title: '保存全局记忆',
  description: '只保存当前真实作者发言中明确表达、可跨作品复用的长期协作偏好。text 必须是这次作者消息中的简短逐字原话。一次性指令、作品设定、角色台词、引用、附件、工具结果、推测或敏感个人资料不能作为来源。设置私人称呼用 account_preferences_update。',
  parameters: createAgentPersonalizationMemorySchema, permission: writePermission, readOnly: false,
  async execute(ctx, args) {
    return withOwnedPreferenceWrite(ctx, async (tx, author) => {
      if (ctx.personalizationMemoryEpoch === undefined || !author.prompt.includes(args.text)) {
        throw new DataAccessError(409, 'PERSONALIZATION_AUTHOR_REQUIRED', '只能保存本次作者亲自表达的记忆。')
      }
      const { memory, status } = await saveConversationMemory(ctx.userId, args.text, ctx.personalizationMemoryEpoch, tx, author.createdAt)
      return { output: JSON.stringify({ id: memory.id, status, revision: memory.revision }), summary: status === 'created' ? '已保存全局记忆' : '这条记忆已存在' }
    })
  },
})

export const accountMemoryUpdateTool = defineTool({
  name: 'account_memory_update', title: '修改全局记忆',
  description: '按作者明确要求修改一条已保存全局记忆。先用 account_memory_list 找到条目与 revision。',
  parameters: patchAgentPersonalizationMemorySchema.extend({ memoryId }), permission: writePermission, readOnly: false,
  async execute(ctx, { memoryId, ...args }) {
    return withOwnedPreferenceWrite(ctx, async tx => {
      const memory = await updatePersonalizationMemory(ctx.userId, memoryId, args, tx)
      return { output: JSON.stringify({ id: memory.id, revision: memory.revision, status: 'updated' }), summary: '已修改全局记忆' }
    })
  },
})

export const accountMemoryDeleteTool = defineTool({
  name: 'account_memory_delete', title: '删除一条全局记忆',
  description: '仅按作者明确要求忘记指定记忆时调用。先查 account_memory_list 确认条目和版本。此工具只删除一条，全部清空使用个性化设置中的确认入口。',
  parameters: z.object({ memoryId, expectedRevision: agentPersonalizationRevisionSchema }).strict(), permission: writePermission, readOnly: false,
  async execute(ctx, args) {
    return withOwnedPreferenceWrite(ctx, async tx => {
      const result = await deletePersonalizationMemory(ctx.userId, args.memoryId, args.expectedRevision, tx)
      return { output: JSON.stringify({ ...result, status: 'deleted' }), summary: '已删除全局记忆' }
    })
  },
})
