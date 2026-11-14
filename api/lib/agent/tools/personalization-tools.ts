import { z } from 'zod'
import { env } from '../../../config/env.js'
import { DataAccessError, prisma } from '../../prisma.js'
import {
  agentPersonalizationExpectedRevisionSchema, agentPersonalizationMemoryIdSchema, createAgentPersonalizationMemorySchema,
  patchAgentPersonalizationMemoryFields, patchAgentPersonalizationSchema, removeAgentPersonalizationRuleSchema,
  writeAgentPersonalizationToolRuleSchema,
} from '../../../../shared/contracts/agent-personalization.js'
import { getModelAssignments } from '../model-assignments.js'
import {
  changePersonalizationRule, clearPersonalizationMemories, deletePersonalizationMemory, getAgentPersonalization, listPersonalizationMemories,
  patchAgentPersonalization, restorePersonalizationMemory, saveConversationMemory, updatePersonalizationMemory,
} from '../personalization.js'
import { assertPersonalizationWriteAdmission, personalizationWriteAdmission, readPersonalizationAuthor } from '../personalization-authority.js'
import { assertPersonalizationRuleOperation, listPersonalizationRuleOperations } from '../personalization-tool-policy.js'
import { interpretPersonalizationRule } from '../personalization-rule-language.js'
import { runtimeTransaction } from '../runtime-common.js'
import { getWindowConfiguration, readRunWindowConfiguration } from '../window-configuration.js'
import { defineTool, type ToolContext } from './types.js'

const readPermission = { plan: 'allow', build: 'allow', review: 'allow' } as const
const writePermission = { plan: 'allow', build: 'allow', review: 'deny' } as const
const memoryTarget = agentPersonalizationExpectedRevisionSchema.extend({ memoryId: agentPersonalizationMemoryIdSchema })
const noArguments = z.object({}).strict()

async function assertPersonalizationToolAvailable(ctx: ToolContext, db = ctx.transaction ?? prisma) {
  ctx.signal.throwIfAborted()
  if (env.appEnv === 'production' && !await (await import('../../app-releases.js')).hasAgentPersonalizationCapability(ctx.userId, db))
    throw new DataAccessError(403, 'APP_RELEASE_CAPABILITY_DISABLED', '当前应用版本尚未开放此功能。')
}

export const accountProfileTool = defineTool({
  name: 'account_profile', title: '查看我的资料',
  description: '回答作者问「我是谁」「我的昵称或简介是什么」时，读取当前登录作者的公开昵称和简介。称呼和长期协作偏好来自全局记忆；如无资料，自然说明即可。不要查作品或联网。',
  parameters: noArguments, permission: readPermission, readOnly: true,
  async execute(ctx) {
    const db = ctx.transaction ?? prisma
    await assertPersonalizationToolAvailable(ctx, db)
    const profile = await db.user.findUnique({ where: { id: ctx.userId }, select: { nickname: true, bio: true } })
    if (!profile) throw new DataAccessError(404, 'TOOL_READ_NOT_FOUND', '当前账户资料不可用。')
    return { output: JSON.stringify(profile), summary: '已读取本人资料' }
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
  description: '读取当前账户在整个创作区的语气、基础风格、回答偏好、全局记忆开关、自定义权限规则及版本。',
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
async function withOwnedPreferenceWrite<T>(ctx: ToolContext, action: string, args: unknown,
  write: (tx: NonNullable<ToolContext['transaction']>, author: NonNullable<Awaited<ReturnType<typeof readPersonalizationAuthor>>>) => Promise<T>) {
  if (ctx.inlineChild) throw new DataAccessError(409, 'PERSONALIZATION_AUTHOR_REQUIRED', '请由作者在主任务中操作个性化设置。')
  const apply = async (tx: NonNullable<ToolContext['transaction']>) => {
    ctx.signal.throwIfAborted()
    await ctx.assertCurrentExecution?.(tx)
    await assertPersonalizationToolAvailable(ctx, tx)
    const author = await readPersonalizationAuthor(tx, ctx)
    assertPersonalizationWriteAdmission(personalizationWriteAdmission(action, args, author), ctx.personalizationApproved === true)
    const result = await write(tx, author!)
    ctx.signal.throwIfAborted()
    return result
  }
  return ctx.transaction ? apply(ctx.transaction) : runtimeTransaction(apply)
}

export const accountPreferencesUpdateTool = defineTool({
  name: 'account_preferences_update', title: '修改个性化设置',
  description: '按作者明确要求修改账户级个性化。先用 account_preferences_get 取得 expectedRevision，只传要改的字段。只调整本次回复时不改设置，称呼使用全局记忆。程度字段 less/default/more。主动建议的改动会交给作者确认。',
  parameters: patchAgentPersonalizationSchema, permission: writePermission, readOnly: false,
  async execute(ctx, args) {
    return withOwnedPreferenceWrite(ctx, 'account_preferences_update', args, async tx => {
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
  description: '分页读取自己的全局记忆。includeArchived=true 时只查最近整理中可恢复的记忆。用实际条目 id 和 revision 修改、恢复或彻底删除。',
  parameters: z.object({ query: z.string().trim().max(100).optional(), offset: z.number().int().nonnegative().optional(), includeArchived: z.boolean().optional() }).strict(),
  permission: readPermission, readOnly: true,
  async execute(ctx, args) {
    await assertPersonalizationToolAvailable(ctx)
    const { memories, archived, revision, memoryEpoch } = await listPersonalizationMemories(ctx.userId, ctx.transaction)
    const query = args.query?.toLowerCase()
    const rows = args.includeArchived ? archived : memories
    const items = query ? rows.filter(memory => memory.text.toLowerCase().includes(query)) : rows
    const offset = args.offset ?? 0
    const page = items.slice(offset, offset + 12)
    return { output: JSON.stringify({ memories: page, revision, memoryEpoch, nextOffset: offset + page.length < items.length ? offset + page.length : null }), summary: '已读取全局记忆' }
  },
})

export const accountMemorySaveTool = defineTool({
  name: 'account_memory_save', title: '保存全局记忆',
  description: '只保存当前作者发言的简短逐字原话，用于长期协作、语言和称呼。自动保存不适用于一次性指令、作品设定、角色台词、引用、附件、工具结果、推测或敏感资料。作者要求一直记住时才传 pinned=true。明确更正保留原话中的更正措辞；结果 not_saved 时如实说明原因。',
  parameters: createAgentPersonalizationMemorySchema, permission: writePermission, readOnly: false,
  async execute(ctx, args) {
    return withOwnedPreferenceWrite(ctx, 'account_memory_save', args, async (tx, author) => {
      if (ctx.personalizationMemoryEpoch === undefined) {
        throw new DataAccessError(409, 'PERSONALIZATION_AUTHOR_REQUIRED', '只能保存本次作者亲自表达的记忆。')
      }
      const pinned = args.pinned === true || /^(?:请)?(?:一直|永远|固定)记住/u.test(author.prompt.trim())
      const result = await saveConversationMemory(ctx.userId, args.text, ctx.personalizationMemoryEpoch, tx, author.createdAt, pinned)
      if (result.status === 'not_saved') {
        const detail = { capacity: '没有合适的可整理条目，请先腾出位置。', ambiguous: '与现有记忆冲突，请确认要修改哪一条。', recoverable: '该记忆在最近整理中，可以恢复。' }[result.reason]
        return { output: JSON.stringify({ ...result, detail }), summary: '未保存全局记忆' }
      }
      return { output: JSON.stringify({ id: result.memory.id, status: result.status, revision: result.memory.revision }),
        summary: { created: '已保存全局记忆', existing: '这条记忆已存在', merged: '已合并重复记忆', corrected: '已更正全局记忆' }[result.status] }
    })
  },
})

export const accountMemoryUpdateTool = defineTool({
  name: 'account_memory_update', title: '修改全局记忆',
  description: '修改、固定或取消固定一条已保存记忆。用 account_memory_list 找到条目与 revision。请准确提交作者要改的内容，作者会看到并确认实际变更。',
  parameters: patchAgentPersonalizationMemoryFields.extend({ memoryId: agentPersonalizationMemoryIdSchema }).refine(value => value.text !== undefined || value.pinned !== undefined),
  permission: writePermission, readOnly: false,
  async execute(ctx, { memoryId, ...args }) {
    return withOwnedPreferenceWrite(ctx, 'account_memory_update', { memoryId, ...args }, async tx => {
      const memory = await updatePersonalizationMemory(ctx.userId, memoryId, args, tx)
      return { output: JSON.stringify({ id: memory.id, revision: memory.revision, status: 'updated' }), summary: '已修改全局记忆' }
    })
  },
})

export const accountMemoryDeleteTool = defineTool({
  name: 'account_memory_delete', title: '删除一条全局记忆',
  description: '彻底删除一条指定的全局记忆。先查询实际条目和版本，提交给作者确认。普通整理或替换不能使用彻底删除。',
  parameters: memoryTarget, permission: writePermission, readOnly: false,
  async execute(ctx, args) {
    return withOwnedPreferenceWrite(ctx, 'account_memory_delete', args, async tx => {
      const result = await deletePersonalizationMemory(ctx.userId, args.memoryId, args.expectedRevision, tx)
      return { output: JSON.stringify({ ...result, status: 'deleted' }), summary: '已删除全局记忆' }
    })
  },
})

export const accountMemoryRestoreTool = defineTool({
  name: 'account_memory_restore', title: '恢复一条全局记忆',
  description: '恢复一条仍在「最近整理」中的全局记忆。先用 account_memory_list 的 includeArchived=true 查询 id 和 revision，再交给作者确认。有效记忆已满时不会挤掉其他记忆。',
  parameters: memoryTarget, permission: writePermission, readOnly: false,
  async execute(ctx, args) {
    return withOwnedPreferenceWrite(ctx, 'account_memory_restore', args, async tx => {
      const { id, revision } = await restorePersonalizationMemory(ctx.userId, args.memoryId, args.expectedRevision, tx)
      return { output: JSON.stringify({ id, revision, status: 'restored' }), summary: '已恢复全局记忆' }
    })
  },
})

export const accountMemoryClearTool = defineTool({
  name: 'account_memory_clear', title: '彻底清空全局记忆',
  description: '仅在作者明确要彻底清空全部有效和可恢复记忆时，使用 account_memory_list 的列表 revision 并提交本次清空确认。不能将整理、忘记一条或关闭记忆视为清空。',
  parameters: agentPersonalizationExpectedRevisionSchema, permission: writePermission, readOnly: false,
  async execute(ctx, args) {
    return withOwnedPreferenceWrite(ctx, 'account_memory_clear', args, async tx => {
      const result = await clearPersonalizationMemories(ctx.userId, args.expectedRevision, tx)
      return { output: JSON.stringify({ ...result, status: 'cleared' }), summary: '已清空全局记忆' }
    })
  },
})

export const accountRuleOperationsTool = defineTool({
  name: 'account_rule_operations', title: '查看可设置权限的操作',
  description: '按需查询机器可执行的规则操作及对应 toolName。规则可允许（不提升基础能力）、先询问或禁止；当前已保存规则由 account_preferences_get 返回。',
  parameters: z.object({ query: z.string().trim().max(100).optional(), offset: z.number().int().nonnegative().optional() }).strict(),
  permission: readPermission, readOnly: true,
  async execute(ctx, { query, offset = 0 }) {
    await assertPersonalizationToolAvailable(ctx)
    const operations = (await listPersonalizationRuleOperations()).filter(item => !query || item.title.includes(query) || item.toolName.includes(query))
    const page = operations.slice(offset, offset + 25)
    return { output: JSON.stringify({ operations: page, nextOffset: offset + page.length < operations.length ? offset + page.length : null }), summary: '已读取可设置权限的操作' }
  },
})

export const accountRuleSetTool = defineTool({
  name: 'account_rule_set', title: '新增或修改自定义权限规则',
  description: '按作者要求新增或修改一条规则。查询设置版本和实际操作编号。text 可保留和执行方式相符的作者原话。更改须经作者确认，既有禁止、作品归属、费用和平台强制确认仍适用。',
  parameters: writeAgentPersonalizationToolRuleSchema, permission: writePermission, readOnly: false,
  async execute(ctx, args) {
    return withOwnedPreferenceWrite(ctx, 'account_rule_set', args, async tx => {
      await assertPersonalizationRuleOperation(args.toolName)
      if (args.text) {
        const interpreted = await interpretPersonalizationRule(args.text)
        if (args.toolName !== interpreted.toolName || args.permission !== interpreted.permission)
          throw new DataAccessError(422, 'PERSONALIZATION_RULE_TEXT_MISMATCH', '规则原文和对应的操作或权限不一致。')
      }
      const { revision } = await changePersonalizationRule(ctx.userId, args.toolName, args.permission, args.expectedRevision, tx, args.text)
      return { output: JSON.stringify({ toolName: args.toolName, permission: args.permission, text: args.text, revision }), summary: '已保存自定义权限规则' }
    })
  },
})

export const accountRuleRemoveTool = defineTool({
  name: 'account_rule_remove', title: '移除自定义权限规则',
  description: '提交作者明确要求移除的单条规则并等待确认。只恢复该操作的基础权限，不授予新的权限。',
  parameters: removeAgentPersonalizationRuleSchema, permission: writePermission, readOnly: false,
  async execute(ctx, args) {
    return withOwnedPreferenceWrite(ctx, 'account_rule_remove', args, async tx => {
      const { revision } = await changePersonalizationRule(ctx.userId, args.toolName, null, args.expectedRevision, tx)
      return { output: JSON.stringify({ toolName: args.toolName, revision }), summary: '已移除自定义权限规则' }
    })
  },
})
