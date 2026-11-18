import { z } from 'zod'

import { listMemoryReviewInbox, saveStoryMemory } from '../story-memory.js'
import { defineTool } from './types.js'
import { resolveMemorySource } from './memory-source.js'

export const memoryReviewListTool = defineTool({
  name: 'memory_review_list', title: '查看旧记忆记录',
  description: '查看旧版记忆审核记录，当前写作使用 memory_search 查看生效的卡片。',
  parameters: z.object({}), permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: true,
  async execute(ctx) {
    const items = await listMemoryReviewInbox(ctx.userId, ctx.novelId, ctx.transaction)
    return {
      output: items.length ? items.map((item) => `- memoryId=${item.id} [${item.status}] ${item.title}：${item.content}`).join('\n') : '记忆审核箱为空。',
      summary: `记忆审核箱 · ${items.length} 项`,
    }
  },
})

export const memoryRelationSaveTool = defineTool({
  name: 'memory_relation_save', title: '保存人物关系',
  description: '保存或更新作品中的人物关系，供写作召回和关系图使用。关系变化可传 validFrom 和 validTo，章节来源可选。',
  parameters: z.object({
    fromName: z.string().min(1).max(128), toName: z.string().min(1).max(128), relationType: z.string().min(1).max(64),
    state: z.string().max(1000).optional(), validFrom: z.number().int().positive().optional(), validTo: z.number().int().positive().optional(),
    sourceChapterId: z.string().optional(), revision: z.number().int().positive().optional(), confidence: z.number().min(0).max(1).default(1),
    sourceQuote: z.string().trim().min(1).max(4000).optional(),
  }),
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: false,
  async execute(ctx, args) {
    const evidence = await resolveMemorySource(ctx, args)
    const relation = await saveStoryMemory({
      userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, sourceChapterId: args.sourceChapterId,
      memoryType: 'relationshipState', layer: 'L2', title: `${args.fromName}→${args.toName}:${args.relationType}`,
      content: `${args.fromName}与${args.toName}的关系为${args.relationType}${args.state ? `，当前状态：${args.state}` : ''}${args.validFrom ? `；自第${args.validFrom}章` : ''}${args.validTo ? `；至第${args.validTo}章` : ''}`,
      importance: 75, confidence: Math.min(args.confidence, evidence.confidence), status: 'inferred', evidence,
      graphProposal: { kind: 'relation', fromName: args.fromName, toName: args.toName, relationType: args.relationType, state: args.state, validFrom: args.validFrom, validTo: args.validTo },
    }, ctx.transaction)
    return { savedMemoryId: relation.id, output: `已保存人物关系 memoryId=${relation.id}：${args.fromName} → ${args.toName}。`, summary: `保存关系 ${args.fromName}→${args.toName}` }
  },
})

export const memoryEventSaveTool = defineTool({
  name: 'memory_event_save', title: '保存故事事件',
  description: '保存或更新作品中的关键事件，供写作召回。保留时间、地点、参与者和因果，章节来源可选。区分已发生事件和拟定情节。',
  parameters: z.object({
    title: z.string().min(1).max(160), description: z.string().min(1).max(4000), storyTime: z.string().max(160).optional(),
    location: z.string().max(160).optional(), participants: z.array(z.string()).max(30).default([]), causes: z.array(z.string()).max(20).default([]),
    effects: z.array(z.string()).max(20).default([]), sourceChapterId: z.string().optional(), revision: z.number().int().positive().optional(), confidence: z.number().min(0).max(1).default(1),
    sourceQuote: z.string().trim().min(1).max(4000).optional(),
  }),
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, readOnly: false,
  async execute(ctx, args) {
    const evidence = await resolveMemorySource(ctx, args)
    const event = await saveStoryMemory({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId,
      sourceChapterId: args.sourceChapterId, memoryType: 'timelineEvent', layer: 'L1', title: args.title,
      content: [args.description, args.storyTime && `时间：${args.storyTime}`, args.location && `地点：${args.location}`,
        args.participants.length && `参与者：${args.participants.join('、')}`, args.causes.length && `原因：${args.causes.join('；')}`,
        args.effects.length && `结果：${args.effects.join('；')}`].filter(Boolean).join('\n'),
      importance: 75, confidence: Math.min(args.confidence, evidence.confidence), status: 'inferred', evidence,
      graphProposal: { kind: 'event', description: args.description, storyTime: args.storyTime, location: args.location, participants: args.participants, causes: args.causes, effects: args.effects },
    }, ctx.transaction)
    return { savedMemoryId: event.id, output: `已保存故事事件 memoryId=${event.id}：${args.title}。`, summary: `保存事件「${args.title}」` }
  },
})
