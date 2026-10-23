import { auxiliaryTextModel } from '../auxiliary-text-model.js'
import { z } from 'zod'

import { generateTextCompletion } from '../../ai-service.js'
import { loadSkill } from '../skills/index.js'
import { recordSkillLoads } from '../skills/receipts.js'
import {
  createNovelSkillDraftWithId,
  listNovelSkills,
  publishNovelSkillVersion,
  resolveEnabledRuntimeSkills,
  resolveRuntimeSkillContext,
  testNovelSkill,
  updateNovelSkill,
} from '../skills/service.js'
import { acceptSkillShareInvite, listSkillShareInvites } from '../skills/sharing.js'
import { defineTool } from './types.js'
import { prepareCreativeReview, saveCreativeReview } from './creative-review.js'

const FREEDOM = z.enum(['stable', 'balanced', 'bold']).default('balanced')
const PHASE = z.enum(['research', 'plan', 'scene', 'draft', 'critique', 'revision', 'commit'])

export const skillCatalogTool = defineTool({
  name: 'skill_catalog', title: '查看创作能力',
  description: '查看本任务可用技能元数据。只返回名称、实际版本、阶段和说明，不加载完整工作流。',
  parameters: z.object({ phase: PHASE.optional() }),
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: true,
  async execute(ctx, args) {
    const runtime = await resolveEnabledRuntimeSkills(ctx.userId, ctx.novelId, ctx.runId, ctx.transaction)
    const items = args.phase ? runtime.filter((item) => item.phases.includes(args.phase!)) : runtime
    return {
      output: items.map((item) => `${item.id}@${item.version} [${item.phases.join('/')}] ${item.synopsis}${item.attribution ? ` 来源说明：${item.attribution}` : ''}`).join('\n'),
      summary: `创作能力 · ${items.length} 项`,
    }
  },
})

export const skillLoadTool = defineTool({
  name: 'skill_load', title: '加载创作能力',
  description: '按阶段加载一个 Skill 的完整工作流。作者指定、任务进入新阶段、或技能描述与当前子任务明确吻合且尚未加载时使用；已经加载的同版本同阶段无需重复，也不要批量加载无关技能。',
  parameters: z.object({ skillId: z.string().min(1), phase: PHASE, creativeFreedom: FREEDOM }),
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: true,
  async execute(ctx, args) {
    const { catalog: runtime, routerVersion } = await resolveRuntimeSkillContext(ctx.userId, ctx.novelId, ctx.runId, ctx.transaction)
    const content = loadSkill(args.skillId, args.phase, args.creativeFreedom, runtime)
    const loaded = content ? runtime.filter(skill => content.startsWith(`[Skill ${skill.id}@${skill.version} /`)) : []
    if (ctx.runId && loaded.length) await recordSkillLoads({ ...ctx, runId: ctx.runId, routerVersion }, loaded, args.phase, 'tool', ctx.transaction)
    return content
      ? { output: content, summary: `加载 ${args.skillId} · ${args.phase}` }
      : { output: `Skill ${args.skillId} 不存在或不支持 ${args.phase} 阶段。` }
  },
})

const CUSTOM_INTENT = z.enum(['plan', 'write', 'revise', 'review', 'structure', 'global_transform'])
const CUSTOM_MODE = z.enum(['plan', 'build', 'review'])
const customSkillDraftSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  intents: z.array(CUSTOM_INTENT).min(1).max(6),
  modes: z.array(CUSTOM_MODE).min(1).max(3),
  phases: z.array(PHASE).min(1).max(7),
  triggerPhrases: z.array(z.string().min(1).max(80)).min(1).max(24),
  negativeTriggerPhrases: z.array(z.string().min(1).max(80)).min(1).max(24),
  instructions: z.object({
    research: z.string().optional(), plan: z.string().optional(), scene: z.string().optional(), draft: z.string().optional(),
    critique: z.string().optional(), revision: z.string().optional(), commit: z.string().optional(),
  }),
  tokenBudget: z.number().int().min(100).max(1_500).optional(),
  priority: z.number().int().min(0).max(150).optional(),
})

export const skillCreateDraftTool = defineTool({
  name: 'skill_create_draft', title: '草拟作品技能',
  description: '仅当作者明确要求把长期写作偏好保存为技能时使用。创建的是私有、关闭、未发布草稿，必须先测试并由作者确认发布；普通单轮要求禁止保存成技能。',
  parameters: customSkillDraftSchema,
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: false,
  async execute(ctx, args) {
    const { skillId, payload } = await createNovelSkillDraftWithId(ctx.userId, ctx.novelId, { ...args, source: 'agent' }, ctx.transaction)
    const draft = payload.items.find((item) => item.id === skillId)
    return {
      output: draft
        ? `已创建私有技能草稿 ${draft.id}@${draft.activeVersion}。当前未启用；请先调用 skill_test，再请作者确认是否发布。`
        : '技能草稿已创建，当前未启用。',
      summary: `草拟技能「${args.name}」`,
    }
  },
})

export const skillTestTool = defineTool({
  name: 'skill_test', title: '测试作品技能',
  description: '针对作者自有技能运行一条确定性触发/负触发测试并保存结果。只有在创建或修改技能后使用，禁止为普通创作任务例行测试。',
  parameters: z.object({
    skillId: z.string().min(1), version: z.string().optional(), prompt: z.string().min(1).max(4_000),
    intent: CUSTOM_INTENT, mode: CUSTOM_MODE, phase: PHASE, expectMatch: z.boolean(),
  }),
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: false,
  async execute(ctx, args) {
    const result = await testNovelSkill(ctx.userId, ctx.novelId, args.skillId, args, ctx.transaction)
    return {
      output: `测试${result.passed ? '通过' : '失败'}：实际${result.matched ? '命中' : '未命中'}，预期${result.expected ? '命中' : '未命中'}，score=${result.score}，负触发=${result.blockedByNegativeTrigger ? '是' : '否'}。`,
      summary: `测试技能 · ${result.passed ? '通过' : '失败'}`,
    }
  },
})

export const skillEnableTool = defineTool({
  name: 'skill_enable', title: '启停作品技能',
  description: '仅在作者明确要求启用或关闭某个已发布技能时使用；关闭从下一轮立即生效。未发布草稿不能启用。',
  parameters: z.object({ skillId: z.string().min(1), enabled: z.boolean() }),
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: false,
  async execute(ctx, args) {
    await updateNovelSkill(ctx.userId, ctx.novelId, args.skillId, { enabled: args.enabled }, ctx.transaction)
    return { output: `技能 ${args.skillId} 已${args.enabled ? '启用' : '关闭'}，从下一轮开始生效。`, summary: `${args.enabled ? '启用' : '关闭'}技能` }
  },
})

export const skillRollbackTool = defineTool({
  name: 'skill_rollback', title: '回滚作品技能',
  description: '仅在作者明确指定技能与目标已发布版本时回滚作品安装；不会覆盖或删除历史版本。',
  parameters: z.object({ skillId: z.string().min(1), version: z.string().min(1) }),
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: false,
  async execute(ctx, args) {
    await updateNovelSkill(ctx.userId, ctx.novelId, args.skillId, { lockedVersion: args.version }, ctx.transaction)
    return { output: `技能 ${args.skillId} 已回滚并锁定到 ${args.version}。`, summary: `回滚技能到 ${args.version}` }
  },
})

export const skillPublishTool = defineTool({
  name: 'skill_publish', title: '发布作品技能',
  description: '发布已通过静态审计和确定性测试的作者私有技能版本。会改变后续 Agent 行为，必须得到作者本轮明确确认。',
  parameters: z.object({ skillId: z.string().min(1), version: z.string().min(1) }),
  permission: { plan: 'ask', build: 'ask', review: 'ask' }, readOnly: false, alwaysConfirm: true,
  async execute(ctx, args) {
    await publishNovelSkillVersion(ctx.userId, ctx.novelId, args.skillId, args.version, ctx.transaction)
    return { output: `技能 ${args.skillId}@${args.version} 已发布并启用。`, summary: `发布技能 ${args.version}` }
  },
})

export const skillRunExplainTool = defineTool({
  name: 'skill_run_explain', title: '解释技能路由',
  description: '仅在作者询问本轮为什么使用或没有使用某技能时读取最近路由回执；禁止每轮例行调用。',
  parameters: z.object({ runId: z.string().optional() }),
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: true,
  async execute(ctx, args) {
    const payload = await listNovelSkills(ctx.userId, ctx.novelId, ctx.transaction)
    const run = args.runId ? payload.recentRuns.find((item) => item.runId === args.runId) : payload.recentRuns[0]
    return run
      ? { output: `阶段=${run.phase}；已选=${run.selected.map((item) => `${item.id}@${item.version}`).join('、') || '无'}；原因=${run.reasonCodes.join('、') || '无明确触发'}；置信度=${run.confidence}；估算 token=${run.estimatedTokens}。`, summary: '解释技能路由' }
      : { output: '当前作品暂无可解释的技能路由记录。', summary: '暂无技能路由记录' }
  },
})

export const skillSharedInvitesTool = defineTool({
  name: 'skill_shared_invites', title: '查看共享技能邀请',
  description: '仅在作者询问可安装的共享技能、或明确要求安装共享技能时使用。只列出当前账号仍待处理的邀请，不读取或导入任意外部源码。',
  parameters: z.object({}),
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: true,
  async execute(ctx) {
    const invites = await listSkillShareInvites(ctx.userId, ctx.transaction)
    const pending = invites.received.filter((invite) => invite.status === 'pending')
    return {
      output: pending.length
        ? pending.map((invite) => `inviteId=${invite.id}｜${invite.skillName}@${invite.version}｜来自 ${invite.counterpart.nickname} 的《${invite.sourceNovel.title}》｜${invite.message || '无附言'}｜到期 ${invite.expiresAt}`).join('\n')
        : '当前没有待处理的共享技能邀请。',
      summary: `共享技能邀请 · ${pending.length} 项待处理`,
    }
  },
})

export const skillInstallSharedTool = defineTool({
  name: 'skill_install_shared', title: '安装共享作品技能',
  description: '仅当作者明确指定接受某一已列出的共享技能邀请时使用。安装会使该技能从下一轮开始参与当前作品的自动路由，必须逐次确认；禁止用它安装任意 GitHub 或外部源码。',
  parameters: z.object({ inviteId: z.string().min(1) }),
  permission: { plan: 'ask', build: 'ask', review: 'ask' }, readOnly: false, alwaysConfirm: true,
  async execute(ctx, args) {
    await acceptSkillShareInvite(ctx.userId, args.inviteId, ctx.novelId, ctx.transaction)
    return { output: '共享作品技能已安装并启用，将从下一轮任务开始由服务端按需路由。', summary: '安装共享作品技能' }
  },
})

export const creativeCritiqueTool = defineTool({
  name: 'creative_critique', title: '独立创作批评',
  description: '在与 Draft 分离的模型上下文中审阅指定正文，只给有原文证据的问题，不改正文。结果保存为审阅产物，供作者选择。',
  parameters: z.object({
    chapterId: z.string().min(1), start: z.number().int().min(0).optional(), end: z.number().int().positive().optional(),
    skillIds: z.array(z.string()).min(1).max(3), creativeFreedom: FREEDOM,
  }),
  permission: { plan: 'deny', build: 'allow', review: 'allow' }, readOnly: false,
  async execute(ctx, args) {
    const work = await prepareCreativeReview(ctx, args, 'critique')
    const critique = await generateTextCompletion(
      work.system, work.content,
      { modelRuntime: auxiliaryTextModel(ctx.modelRuntime), signal: ctx.signal, userId: ctx.userId, action: 'agentCreativeCritique', novelId: ctx.novelId, chapterId: work.chapter.id, targetType: 'chapter', targetId: work.chapter.id, temperature: work.temperature },
    )
    return saveCreativeReview(ctx, work, critique)
  },
})

export const creativeRevisionDraftTool = defineTool({
  name: 'creative_revision_draft', title: '生成选择性修订稿',
  description: '在独立 Revision 上下文中，只根据作者选中的批评项生成修订稿；不直接写入章节，返回 artifactId 和草稿供主 Agent 用精准编辑工具应用。',
  parameters: z.object({
    critiqueArtifactId: z.string().min(1), chapterId: z.string().min(1), selectedFindings: z.array(z.string().min(1)).min(1).max(12),
    start: z.number().int().min(0).optional(), end: z.number().int().positive().optional(), skillIds: z.array(z.string()).min(1).max(3), creativeFreedom: FREEDOM,
  }),
  permission: { plan: 'deny', build: 'allow', review: 'deny' }, readOnly: false,
  async execute(ctx, args) {
    const work = await prepareCreativeReview(ctx, args, 'revision')
    const revised = await generateTextCompletion(
      work.system, work.content,
      { modelRuntime: auxiliaryTextModel(ctx.modelRuntime), signal: ctx.signal, userId: ctx.userId, action: 'agentCreativeRevision', novelId: ctx.novelId, chapterId: work.chapter.id, targetType: 'chapter', targetId: work.chapter.id, temperature: work.temperature },
    )
    return saveCreativeReview(ctx, work, revised)
  },
})
