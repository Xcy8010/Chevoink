import { z } from 'zod'

// These names and schemas were published to already-frozen tasks.
const legacyTypes = z.enum(['novelSummary', 'worldbuilding', 'characterCard', 'chapterSummary', 'timelineEvent', 'foreshadowing', 'stylePreference', 'continuityRule', 'volumeSummary', 'storyArc', 'sceneState', 'relationshipState', 'storyBible', 'authorProfile'])
export const storyMemoryTypeSchema = z.enum([...legacyTypes.options, 'itemCard', 'locationCard', 'sceneCard'])

export const legacyMemorySaveParameters = z.object({
  memoryType: legacyTypes
    .describe('记忆类型'),
  title: z.string().min(1).max(120).describe('记忆标题（如角色名、章节名、设定名）'),
  content: z.string().min(1).max(4000).describe('记忆内容，事实化、结构化表述，最多4000字符；不同主题分别保存，不截断事实'),
  importance: z.number().int().min(1).max(100).describe('重要性 1-100：核心主角/主线设定 80+，一般设定 50-70'),
  sourceChapterId: z.string().optional().describe('可选的真实来源章节 ID'),
  revision: z.number().int().positive().optional().describe('读取到的来源章节版本'),
  sourceQuote: z.string().trim().min(1).max(4000).optional().describe('可选的逐字章节引文。能在来源章节中定位时附为证据'),
  memoryId: z.string().optional().describe('已知时传要就地修订的既有卡片 ID，改标题时使用原卡 ID'),
  overwrite: z.boolean().optional().describe('兼容旧调用，同类型同标题的卡片会就地更新'),
})

export const legacyMemorySearchParameters = z.object({
  query: z.string().min(1).describe('检索关键词（人名、地名、设定名等）'),
  memoryType: legacyTypes
    .optional()
    .describe('限定记忆类型，缺省为全部'),
  limit: z.number().int().min(1).max(20).optional().describe('返回条数，默认 8'),
})

export const previousMemorySaveParameters = legacyMemorySaveParameters.extend({
  memoryType: storyMemoryTypeSchema.describe('记忆类型'),
  content: z.string().min(1).describe('Markdown 正文；更新长档案时传 section 与该小节的新内容，其余小节保留'),
  identityKey: z.string().trim().min(1).max(160).optional().describe('同名不同对象的稳定区分键；后续优先用原卡 memoryId'),
  aliases: z.array(z.string().trim().min(1).max(128)).optional().describe('同一对象的其他称呼'),
  section: z.string().trim().min(1).max(160).optional().describe('要更新的 Markdown 二级小节名，如当前处境、持有人或关键经历'),
  effectiveFromChapterId: z.string().min(1).optional().describe('事实起效的章节 ID；默认沿用来源章，追溯设定时填写实际起始章'),
  knownBy: z.array(z.string().min(1)).nullable().optional().describe('已知此事实的人物卡 ID；[] 表示仅作者知情，null 表示公开，省略沿用该段设置'),
})

export const memorySaveParameters = previousMemorySaveParameters.extend({
  title: legacyMemorySaveParameters.shape.title.describe('建卡时填对象名称；有 memoryId 的小节更新沿用原卡名'),
  renameTo: z.string().trim().min(1).max(120).optional().describe('确需将既有档案更名时填写新名称，必须带原 memoryId；可指定起效章'),
  restoreTitle: z.string().trim().min(1).max(120).optional().describe('作者要求纠正误名时，填该卡上一有效名称并带原 memoryId；保留改名历史，移除误名的别名'),
}).superRefine((value, ctx) => {
  if ((value.renameTo || value.restoreTitle) && (!value.memoryId || value.renameTo && value.restoreTitle)) {
    ctx.addIssue({ code: 'custom', path: ['memoryId'], message: '改名或纠正误名时须提供原卡 ID，且一次只执行其中一种。' })
  }
})

export const memorySearchParameters = legacyMemorySearchParameters.extend({
  memoryType: storyMemoryTypeSchema.optional().describe('限定记忆类型，缺省为全部'),
  atChapterId: z.string().min(1).optional().describe('按此章当时的状态检索'),
  viewpointMemoryId: z.string().min(1).optional().describe('按此人物卡 ID 检索其知情范围'),
})
