import { z } from 'zod'

import { craftSearchQuerySchema } from '../../../../shared/contracts/index.js'
import {
  checkStyleLeakage,
  extractAuthorStyleProfile,
  getAuthorStyleProfile,
  readRetrievalTrace,
  searchCraftLibrary,
} from '../craft-library.js'
import { defineTool } from './types.js'

const ALLOW_ALL = { plan: 'allow', build: 'allow', review: 'allow' } as const

export const craftSearchTool = defineTool({
  name: 'craft_search',
  title: '检索写作技法',
  description:
    '在写完整章节、长场景、重大改稿或作者明确要求改善文风时，按题材、场景功能、关系阶段、节奏与当前缺陷检索 3-5 张互补中文网文技法卡。返回的是不可逆抽象方法和统计画像，绝不返回小说原文，也不支持克隆在世作者。只改错字、标题、元数据或一个局部短句时禁止调用；普通续写已有明确场景任务且无风格问题时也不要为了展示流程强行调用。',
  parameters: craftSearchQuerySchema,
  permission: ALLOW_ALL,
  readOnly: true,
  async execute(ctx, query) {
    const result = await searchCraftLibrary({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, query }, ctx.transaction)
    if (result.cards.length === 0) {
      return { output: '合法文笔库没有满足当前题材与场景边界的技法卡；不要强行套用其他题材，也不要联网抓取小说原文。', summary: '文笔库无合适技法卡' }
    }
    const lines = result.cards.map((card, index) => [
      `${index + 1}. ${card.title}｜目标：${card.readerEffect}｜匹配 ${(card.score * 100).toFixed(0)}%`,
      `   做法：${card.techniques.join('；')}`,
      `   避免：${card.avoid.join('；')}`,
    ].join('\n'))
    return {
      output: [
        `检索记录 traceId=${result.traceId}。仅把以下卡片当作高层创作判断，不得复写任何来源措辞：`,
        ...lines,
        result.profile ? `已保存作者统计画像（profileId=${result.profile.id}）；画像不代表模型已学习，已确认启用的风格规则以当前任务上下文为准。` : '当前作品尚无作者 Style DNA；通用卡只作底线参考，不要统一腔。',
      ].join('\n'),
      summary: `检索写作技法 · ${result.cards.length} 张`,
    }
  },
})

export const styleProfileExtractTool = defineTool({
  name: 'style_profile_extract',
  title: '提取作者 Style DNA',
  description:
    '仅当作者明确要求把自己当前作品中的已选章节作为私有样章，并明确同意仅用于本作品风格学习时调用。不得自行挑选章节、不得默认授权、不得跨作品或跨作者使用。只保存统计画像；原文隔离在当前作者/作品作用域，可随时撤回。',
  parameters: z.object({
    title: z.string().trim().min(1).max(160).describe('作者给这组私有样章起的名称'),
    chapterIds: z.array(z.string().min(1)).min(1).max(12).describe('作者明确选定的当前作品章节 ID'),
    authorConfirmed: z.literal(true).describe('作者是否明确确认仅用于本作品 Style DNA；不是 true 就禁止调用'),
  }),
  permission: { plan: 'ask', build: 'ask', review: 'ask' },
  readOnly: false,
  alwaysConfirm: true,
  async execute(ctx, args) {
    const result = await extractAuthorStyleProfile({ userId: ctx.userId, novelId: ctx.novelId, title: args.title, chapterIds: args.chapterIds }, ctx.transaction)
    return {
      output: `已从作者明确选定的 ${result.stats.sampleCount} 个章节提取私有 Style DNA（profileId=${result.profileId}，${result.stats.sampleChars} 字符）。仅限当前作品召回；原文不会进入公共技法库。sourceId=${result.sourceId} 可用于撤回。`,
      summary: `提取 Style DNA · ${result.stats.sampleCount} 个样章`,
    }
  },
})

export const styleProfileGetTool = defineTool({
  name: 'style_profile_get',
  title: '读取作者 Style DNA',
  description: '在写完整章节、检查文风漂移或作者询问当前风格画像时读取当前作品已确认的 Style DNA。只返回统计画像和 hash，不返回私有样章原文。局部事实修改不需要调用。',
  parameters: z.object({}),
  permission: ALLOW_ALL,
  readOnly: true,
  async execute(ctx) {
    const profile = await getAuthorStyleProfile(ctx.userId, ctx.novelId, true, ctx.transaction)
    if (!profile) return { output: '当前作品尚无已确认的作者 Style DNA。不要凭空推断作者文风。', summary: '未找到 Style DNA' }
    return {
      output: `Style DNA profileId=${profile.id}，样本 ${profile.sampleCount} 章/${profile.sampleChars} 字符，统计画像：${JSON.stringify(profile.stats)}。这些是柔性风格参照，不是逐句模板。`,
      summary: `读取 Style DNA「${profile.name}」`,
    }
  },
})

export const retrievalTraceReadTool = defineTool({
  name: 'retrieval_trace_read',
  title: '读取技法检索记录',
  description: '仅在作者追问“本轮为什么用了这些技法”或需要审计某次 craft_search 时，按 traceId 读取结构化检索记录。普通写作不要重复读取。',
  parameters: z.object({ traceId: z.string().min(1) }),
  permission: ALLOW_ALL,
  readOnly: true,
  async execute(ctx, args) {
    const trace = await readRetrievalTrace(ctx.userId, ctx.novelId, args.traceId, ctx.transaction)
    return { output: `检索查询：${JSON.stringify(trace.query)}\n选择结果：${JSON.stringify(trace.selected)}\n记录时间：${trace.createdAt.toISOString()}`, summary: '读取技法检索记录' }
  },
})

export const styleLeakageCheckTool = defineTool({
  name: 'style_leakage_check',
  title: '检查文本复写风险',
  description: '对即将写入的完整章节或长场景做版权泄漏检查。章节写工具本身也会强制执行，因此一般不必重复调用；仅在生成候选尚未写入、作者主动要求检查或需要解释阻断原因时调用。不得用它判断“AI 率”。',
  parameters: z.object({
    content: z.string().min(80).max(60_000).describe('待检查的候选正文'),
    chapterId: z.string().optional(),
  }),
  permission: ALLOW_ALL,
  readOnly: true,
  async execute(ctx, args) {
    const result = await checkStyleLeakage({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, chapterId: args.chapterId ?? ctx.chapterId, content: args.content }, ctx.transaction)
    return {
      output: result.decision === 'blocked'
        ? `复写风险检查已阻断：最长连续重合 ${result.longestCommonSubstring} 字，8-gram 重合 ${(result.ngramOverlap * 100).toFixed(1)}%，语义近似 ${(result.semanticSimilarity * 100).toFixed(1)}%。必须脱离来源措辞重写后再检查。checkId=${result.id}`
        : `复写风险检查通过：最长连续重合 ${result.longestCommonSubstring} 字，8-gram 重合 ${(result.ngramOverlap * 100).toFixed(1)}%。checkId=${result.id}`,
      summary: result.decision === 'blocked' ? '复写风险：已阻断' : '复写风险：通过',
    }
  },
})
