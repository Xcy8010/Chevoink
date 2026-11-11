import type { NovelStatus } from './models.js'

export const BOOTSTRAP_NOVEL_SUMMARY = '先创建一部作品，再继续完善简介、章节和封面。'
export const NOVEL_PUBLISH_METADATA_REQUIRED = 'NOVEL_PUBLISH_METADATA_REQUIRED'

export const NOVEL_PUBLISH_FIELDS = {
  cover: '封面',
  summary: '简介',
  tags: '标签',
} as const

export type NovelPublishField = keyof typeof NOVEL_PUBLISH_FIELDS

export function getMissingNovelPublishFields(novel: {
  coverAssetId?: string | null
  summary: string
  tags: readonly string[]
}): NovelPublishField[] {
  const missing: NovelPublishField[] = []
  const summary = novel.summary.trim()
  if (!novel.coverAssetId) missing.push('cover')
  if (!summary || summary === BOOTSTRAP_NOVEL_SUMMARY) missing.push('summary')
  if (!novel.tags.some((tag) => tag.trim())) missing.push('tags')
  return missing
}

export function isNovelPublicationTransition(current: NovelStatus, next?: NovelStatus): boolean {
  return (current === 'draft' || current === 'archived') && (next === 'published' || next === 'completed')
}

export function novelPublishMetadataMessage(missing: readonly NovelPublishField[]): string {
  return `请先设置作品的${missing.map((field) => NOVEL_PUBLISH_FIELDS[field]).join('、')}，然后再发布。`
}
