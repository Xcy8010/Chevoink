import { auxiliaryTextModel } from '../auxiliary-text-model.js'
import { z } from 'zod'

import { generateTextCompletion } from '../../ai-service.js'
import { prisma } from '../../prisma.js'
import { loadSkill, type CreativeFreedom, type SkillPhase } from '../skills/index.js'
import { recordSkillLoads } from '../skills/receipts.js'
import {
  createNovelSkillDraft,
  listNovelSkills,
  publishNovelSkillVersion,
  resolveEnabledRuntimeSkills,
  testNovelSkill,
  updateNovelSkill,
} from '../skills/service.js'
import { acceptSkillShareInvite, listSkillShareInvites } from '../skills/sharing.js'
import { defineTool } from './types.js'

const FREEDOM = z.enum(['stable', 'balanced', 'bold']).default('balanced')
const PHASE = z.enum(['research', 'plan', 'scene', 'draft', 'critique', 'revision', 'commit'])

export const skillCatalogTool = defineTool({
  name: 'skill_catalog', title: '查看创作能力',
  description: '查看可用 Skill 3.0 元数据。只返回名称、版本、阶段和说明，不加载完整工作流。',
  parameters: z.object({ phase: PHASE.optional() }),
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: true,
  async execute(ctx, args) {
    const runtime = await resolveEnabledRuntimeSkills(ctx.userId, ctx.novelId)
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
    const runtime = await resolveEnabledRuntimeSkills(ctx.userId, ctx.novelId)
    const content = loadSkill(args.skillId, args.phase, args.creativeFreedom, runtime)
    const loaded = content ? runtime.filter(skill => content.startsWith(`[Skill ${skill.id}@${skill.version} /`)) : []
    if (ctx.runId && loaded.length) await recordSkillLoads(ctx as typeof ctx & { runId: string }, loaded, args.phase, 'tool')
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
    const payload = await createNovelSkillDraft(ctx.userId, ctx.novelId, { ...args, source: 'agent' })
    const draft = payload.items.find((item) => item.source === 'agent' && item.name === args.name)
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
    const result = await testNovelSkill(ctx.userId, ctx.novelId, args.skillId, args)
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
    await updateNovelSkill(ctx.userId, ctx.novelId, args.skillId, { enabled: args.enabled })
    return { output: `技能 ${args.skillId} 已${args.enabled ? '启用' : '关闭'}，从下一轮开始生效。`, summary: `${args.enabled ? '启用' : '关闭'}技能` }
  },
})

export const skillRollbackTool = defineTool({
  name: 'skill_rollback', title: '回滚作品技能',
  description: '仅在作者明确指定技能与目标已发布版本时回滚作品安装；不会覆盖或删除历史版本。',
  parameters: z.object({ skillId: z.string().min(1), version: z.string().min(1) }),
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: false,
  async execute(ctx, args) {
    await updateNovelSkill(ctx.userId, ctx.novelId, args.skillId, { lockedVersion: args.version })
    return { output: `技能 ${args.skillId} 已回滚并锁定到 ${args.version}。`, summary: `回滚技能到 ${args.version}` }
  },
})

export const skillPublishTool = defineTool({
  name: 'skill_publish', title: '发布作品技能',
  description: '发布已通过静态审计和确定性测试的作者私有技能版本。会改变后续 Agent 行为，必须得到作者本轮明确确认。',
  parameters: z.object({ skillId: z.string().min(1), version: z.string().min(1) }),
  permission: { plan: 'ask', build: 'ask', review: 'ask' }, readOnly: false, alwaysConfirm: true,
  async execute(ctx, args) {
    await publishNovelSkillVersion(ctx.userId, ctx.novelId, args.skillId, args.version)
    return { output: `技能 ${args.skillId}@${args.version} 已发布并启用。`, summary: `发布技能 ${args.version}` }
  },
})

export const skillRunExplainTool = defineTool({
  name: 'skill_run_explain', title: '解释技能路由',
  description: '仅在作者询问本轮为什么使用或没有使用某技能时读取最近路由回执；禁止每轮例行调用。',
  parameters: z.object({ runId: z.string().optional() }),
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: true,
  async execute(ctx, args) {
    const payload = await listNovelSkills(ctx.userId, ctx.novelId)
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
    const invites = await listSkillShareInvites(ctx.userId)
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
    await acceptSkillShareInvite(ctx.userId, args.inviteId, ctx.novelId)
    return { output: '共享作品技能已安装并启用，将从下一轮任务开始由服务端按需路由。', summary: '安装共享作品技能' }
  },
})

async function skillResources(userId: string, novelId: string, skillIds: string[], phase: SkillPhase, freedom: CreativeFreedom): Promise<string> {
  const runtime = await resolveEnabledRuntimeSkills(userId, novelId)
  return skillIds.map((id) => loadSkill(id, phase, freedom, runtime)).filter(Boolean).join('\n\n')
}

async function ownedChapter(userId: string, novelId: string, chapterId: string) {
  return prisma.chapter.findFirst({ where: { id: chapterId, novelId, authorId: userId }, select: { id: true, title: true, content: true, revision: true } })
}

export const creativeCritiqueTool = defineTool({
  name: 'creative_critique', title: '独立创作批评',
  description: '在与 Draft 分离的模型上下文中审阅指定正文，只给有原文证据的问题，不改正文。结果保存为审阅产物，供作者选择。',
  parameters: z.object({
    chapterId: z.string().min(1), start: z.number().int().min(0).optional(), end: z.number().int().positive().optional(),
    skillIds: z.array(z.string()).min(1).max(3), creativeFreedom: FREEDOM,
  }),
  permission: { plan: 'deny', build: 'allow', review: 'allow' }, readOnly: false,
  async execute(ctx, args) {
    const chapter = await ownedChapter(ctx.userId, ctx.novelId, args.chapterId)
    if (!chapter) return { output: '章节不存在或不属于当前作品。' }
    const start = args.start ?? 0
    const end = Math.min(args.end ?? chapter.content.length, chapter.content.length)
    const text = chapter.content.slice(start, end)
    const resources = await skillResources(ctx.userId, ctx.novelId, args.skillIds, 'critique', args.creativeFreedom)
    const critique = await generateTextCompletion(
      `你是与写作者上下文隔离的小说批评编辑。只依据给定原文指出问题，不续写、不改写、不套固定检查表。每条含编号、短引文、问题和修改方向；把事实硬伤与审美建议分开。\n${resources}`,
      `章节：${chapter.title}，revision=${chapter.revision}，范围=[${start},${end})\n原文：\n${text}`,
      { modelRuntime: auxiliaryTextModel(ctx.modelRuntime), signal: ctx.signal, userId: ctx.userId, action: 'agentCreativeCritique', novelId: ctx.novelId, chapterId: chapter.id, targetType: 'chapter', targetId: chapter.id, temperature: 0.25 },
    )
    const artifact = await prisma.agentArtifact.create({
      data: { runId: ctx.runId, artifactType: 'continuityReview', title: `${chapter.title} · 独立批评`, content: critique, summary: `revision ${chapter.revision} / ${args.skillIds.join(',')}`, metadata: { chapterId: chapter.id, revision: chapter.revision, start, end, skillIds: args.skillIds, phase: 'critique' } },
    })
    return { output: `独立批评已保存为 artifactId=${artifact.id}。\n${critique.slice(0, 5000)}`, summary: `独立批评《${chapter.title}》` }
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
    const [chapter, critique] = await Promise.all([
      ownedChapter(ctx.userId, ctx.novelId, args.chapterId),
      prisma.agentArtifact.findFirst({ where: { id: args.critiqueArtifactId, run: { userId: ctx.userId, novelId: ctx.novelId } } }),
    ])
    if (!chapter || !critique) return { output: '章节或批评产物不存在，或不属于当前作品。' }
    const metadata = critique.metadata as { revision?: unknown } | null
    if (metadata?.revision !== chapter.revision) return { output: `章节已从批评时的 revision=${String(metadata?.revision)} 变为 ${chapter.revision}，请重新批评，避免基于旧文本修订。` }
    const start = args.start ?? 0
    const end = Math.min(args.end ?? chapter.content.length, chapter.content.length)
    const source = chapter.content.slice(start, end)
    const resources = await skillResources(ctx.userId, ctx.novelId, args.skillIds, 'revision', args.creativeFreedom)
    const revised = await generateTextCompletion(
      `你是与 Draft/Critique 上下文隔离的修订编辑。只落实 selectedFindings，不顺手应用其他建议，不改变未授权事实和情节。只输出可替换原文的修订文本。\n${resources}`,
      `作者选中的批评项：\n${args.selectedFindings.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n待修订原文：\n${source}`,
      { modelRuntime: auxiliaryTextModel(ctx.modelRuntime), signal: ctx.signal, userId: ctx.userId, action: 'agentCreativeRevision', novelId: ctx.novelId, chapterId: chapter.id, targetType: 'chapter', targetId: chapter.id, temperature: args.creativeFreedom === 'stable' ? 0.35 : args.creativeFreedom === 'bold' ? 0.75 : 0.55 },
    )
    const artifact = await prisma.agentArtifact.create({
      data: { runId: ctx.runId, artifactType: 'rewriteSelection', title: `${chapter.title} · 选择性修订稿`, content: revised, summary: `${args.selectedFindings.length} 项选中意见`, metadata: { chapterId: chapter.id, revision: chapter.revision, start, end, critiqueArtifactId: critique.id, phase: 'revision' } },
    })
    return { output: `选择性修订稿已保存为 artifactId=${artifact.id}，尚未写入章节。\n${revised.slice(0, 8000)}`, summary: `生成选择性修订稿《${chapter.title}》` }
  },
})
