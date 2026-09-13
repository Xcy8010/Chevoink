import type { NovelImportModelSelection, NovelImportPreview, NovelImportVolume } from '../../../../shared/contracts/novel-import.js'
import { NOVEL_IMPORT_LIMITS } from '../../../../shared/contracts/novel-import.js'

export function importModelSelection(tier: string | null, customModelId: string | null): NovelImportModelSelection {
  if (tier !== 'custom') return { kind: 'basic' }
  if (!customModelId?.trim()) throw new Error('当前自定义模型未选择，请先在输入框选择模型。')
  return { kind: 'custom', customModelId }
}

export function importPreviewCounts(volumes: NovelImportVolume[]) {
  return volumes.reduce((result, volume) => {
    result.chapters += volume.chapters.length
    for (const chapter of volume.chapters) {
      if (chapter.content.trim()) result.nonEmpty++
      result.characters += chapter.content.length
    }
    return result
  }, { chapters: 0, nonEmpty: 0, characters: 0 })
}

export function canSaveImportPreview(preview: NovelImportPreview | null): boolean {
  return !!preview && preview.volumes.length > 0 && importPreviewCounts(preview.volumes).nonEmpty > 0
    && preview.volumes.every(volume => volume.title.trim() && volume.chapters.every(chapter => chapter.title.trim()))
}

export function canSubmitImport(preview: NovelImportPreview | null): boolean {
  return !!preview && canSaveImportPreview(preview)
    && preview.volumes.every(volume => volume.chapters.every(chapter => chapter.content.length <= NOVEL_IMPORT_LIMITS.chapterCharacters))
    && !preview.warnings.some(warning => warning.blocking)
}

/** UTF-16 textarea offset; splitting changes boundaries only, never trims or normalizes text. */
export function splitImportChapter(volumes: NovelImportVolume[], volumeIndex: number, chapterIndex: number, cursor: number): NovelImportVolume[] {
  const chapter = volumes[volumeIndex]?.chapters[chapterIndex]
  if (!chapter || !Number.isInteger(cursor) || cursor <= 0 || cursor >= chapter.content.length
    || importPreviewCounts(volumes).chapters >= NOVEL_IMPORT_LIMITS.chapters) return volumes
  // Do not divide a Unicode surrogate pair between two independently stored chapters.
  if (/[\uD800-\uDBFF]/.test(chapter.content[cursor - 1]) && /[\uDC00-\uDFFF]/.test(chapter.content[cursor])) return volumes
  const continuation = `${chapter.title.slice(0, 125).replace(/[\uD800-\uDBFF]$/, '')}（续）`
  const parts = [{ ...chapter, content: chapter.content.slice(0, cursor) }, { ...chapter, title: continuation, content: chapter.content.slice(cursor) }]
  return volumes.map((volume, index) => index === volumeIndex
    ? { ...volume, chapters: [...volume.chapters.slice(0, chapterIndex), ...parts, ...volume.chapters.slice(chapterIndex + 1)] }
    : volume)
}

/** Deliberately empty: no inserted newline, trimming, heading injection or dropped boundary text. */
export const IMPORT_MERGE_DELIMITER = ''

export function importChapterMergeIssue(volumes: NovelImportVolume[], volumeIndex: number, chapterIndex: number): string | null {
  const first = volumes[volumeIndex]?.chapters[chapterIndex]
  const second = volumes[volumeIndex]?.chapters[chapterIndex + 1]
  if (!first || !second) return '当前卷没有可合并的下一章；仅支持同卷相邻章节。'
  const source = first.source
  const other = second.source
  // Matching empty descriptors do not establish provenance. Compare every recorded field,
  // including page/range, not just filename (nor insertion-dependent JSON key ordering).
  const keys = [...new Set([...Object.keys(source), ...Object.keys(other)])] as Array<keyof typeof source>
  if (!(source.filename?.trim() || source.memberPath?.trim()) || !keys.every(key => source[key] === other[key])) {
    return '来源信息不同或不完整，已禁用合并。文件、页码及来源范围须完全一致；跨来源合并尚未开放。'
  }
  const length = first.content.length + IMPORT_MERGE_DELIMITER.length + second.content.length
  if (length > NOVEL_IMPORT_LIMITS.chapterCharacters) {
    return `合并后为 ${length} 字符，超过单章 ${NOVEL_IMPORT_LIMITS.chapterCharacters} 字符上限。请保留分章，或先用光标拆分后再选择较短的相邻章节；不会截断正文。`
  }
  return null
}

export function mergeImportChapters(volumes: NovelImportVolume[], volumeIndex: number, chapterIndex: number): { volumes: NovelImportVolume[]; error: string | null } {
  const error = importChapterMergeIssue(volumes, volumeIndex, chapterIndex)
  if (error) return { volumes, error }
  const chapters = volumes[volumeIndex].chapters
  const merged = { ...chapters[chapterIndex], content: chapters[chapterIndex].content + IMPORT_MERGE_DELIMITER + chapters[chapterIndex + 1].content }
  return {
    error: null,
    volumes: volumes.map((volume, index) => index === volumeIndex
      ? { ...volume, chapters: [...chapters.slice(0, chapterIndex), merged, ...chapters.slice(chapterIndex + 2)] }
      : volume),
  }
}

export function reorderImportItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction
  if (target < 0 || target >= items.length) return items
  const next = [...items]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export function moveImportChapter(volumes: NovelImportVolume[], from: number, chapter: number, to: number): NovelImportVolume[] {
  if (from === to || !volumes[from]?.chapters[chapter] || !volumes[to]) return volumes
  const item = volumes[from].chapters[chapter]
  return volumes.map((volume, index) => index === from
    ? { ...volume, chapters: volume.chapters.filter((_, i) => i !== chapter) }
    : index === to ? { ...volume, chapters: [...volume.chapters, item] } : volume)
}
