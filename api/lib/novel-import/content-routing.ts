import { limit } from './parsers/limits.js'
import type { NovelImportVolume, ParsedNovelImport } from './parsers/types.js'

/**
 * 标题关键词启发式路由：把解析产物里的计划/设定段落从章节桶分流出去，
 * 提交时分别写入计划文件夹与创作记忆，避免设定资料被当成正文导入或覆盖原作品。
 * 纯确定性字符串匹配，不调用 AI、不扣模型额度。
 */
const PLAN_TITLE = /(大纲|计划|规划|梗概|主线|剧情线|outline|plan)/i
const MEMORY_TITLE = /(设定|人物|角色|世界观|背景|资料|设定集|worldbuilding|character|setting)/i
const CHARACTER_MEMORY = /(人物|角色|character)/i
const WORLD_MEMORY = /(世界观|背景|设定|worldbuilding|setting)/i
// A narrative chapter may mention a plan/character in its title; that alone is
// not evidence that the source is a planning document or a memory card.
const CHAPTER_TITLE = /^(?:第\s*[零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟０-９\d]+\s*[章回节集]|chapter\s+[\divxlcdm]+\b)/i
const EXPORT_CHAPTER_SOURCE = /!\/(?:[^/]+\/)?正文\/[^/]+\/第\d+章\s+[^/]+\.txt$/i

export type RoutedImportPlan = { title: string; content: string; source?: string }
export type RoutedImportMemory = { memoryType: 'characterCard' | 'worldbuilding' | 'storyBible'; title: string; content: string; source?: string }

/** 与提交期章节合并使用同一归一口径：trim + 小写 + 压缩空白。 */
export function normalizeImportTitle(title: string): string {
  return title.trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, '')
}

export function routeImportContent(parsed: ParsedNovelImport): ParsedNovelImport {
  const plans: RoutedImportPlan[] = [...(parsed.plans ?? [])]
  const memories: RoutedImportMemory[] = [...(parsed.memories ?? [])]
  const volumes: NovelImportVolume[] = []
  for (const volume of parsed.volumes) {
    const chapters: NovelImportVolume['chapters'] = []
    for (const chapter of volume.chapters) {
      const title = chapter.title.trim()
      // 空正文段落没有路由价值，保持原样交给既有完整性报告处理。
      if (chapter.content.trim() && !CHAPTER_TITLE.test(title) && !EXPORT_CHAPTER_SOURCE.test(chapter.source)) {
        if (PLAN_TITLE.test(title)) {
          limit(plans.length < 200, '识别出的计划段落超过 200 个，请拆分文件。')
          plans.push({ title, content: chapter.content, source: chapter.source })
          continue
        }
        if (MEMORY_TITLE.test(title)) {
          limit(memories.length < 500, '识别出的设定段落超过 500 个，请拆分文件。')
          memories.push({
            memoryType: CHARACTER_MEMORY.test(title) ? 'characterCard' : WORLD_MEMORY.test(title) ? 'worldbuilding' : 'storyBible',
            title, content: chapter.content, source: chapter.source,
          })
          continue
        }
      }
      chapters.push(chapter)
    }
    // 被完全路由空的卷不再进入预览，避免留下空卷噪音。
    if (chapters.length) volumes.push({ ...volume, chapters })
  }
  return { ...parsed, volumes, ...(plans.length ? { plans } : {}), ...(memories.length ? { memories } : {}) }
}
