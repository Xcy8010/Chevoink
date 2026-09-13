import type { NovelImportPreviewSummary } from '../../../../shared/contracts/novel-import-preview.js'
import type { ImportStructureEdit } from '../import-preview-api'

export type ImportStructureVolumes = ImportStructureEdit['volumes']
export type ImportSegments = ImportStructureVolumes[number]['chapters'][number]['segments']
export function importStructureFromSummary(summary: NovelImportPreviewSummary): ImportStructureVolumes {
  return summary.volumes.map(volume => ({ title: volume.title, chapters: volume.chapters.map(chapter => ({ title: chapter.title, segments: [{ volumeIndex: chapter.volumeIndex, chapterIndex: chapter.chapterIndex, start: 0, end: chapter.characters }] })) }))
}
export const importSegmentLength = (segments: ImportSegments) => segments.reduce((sum, item) => sum + item.end - item.start, 0)
export function splitImportSegments(segments: ImportSegments, offset: number): [ImportSegments, ImportSegments] | null {
  if (!Number.isInteger(offset) || offset <= 0 || offset >= importSegmentLength(segments)) return null
  let consumed = 0
  const before: ImportSegments = [], after: ImportSegments = []
  for (const segment of segments) {
    const length = segment.end - segment.start
    if (consumed + length <= offset) before.push({ ...segment })
    else if (consumed >= offset) after.push({ ...segment })
    else { before.push({ ...segment, end: segment.start + offset - consumed }); after.push({ ...segment, start: segment.start + offset - consumed }) }
    consumed += length
  }
  return [before, after]
}
export function sameImportSegmentSource(summary: NovelImportPreviewSummary, segments: ImportSegments): boolean {
  const sources = segments.map(item => summary.volumes[item.volumeIndex]?.chapters[item.chapterIndex]?.source)
  const first = sources[0]
  if (!first || !(first.filename?.trim() || first.memberPath?.trim())) return false
  return sources.every(source => source && Object.keys({ ...first, ...source }).every(key => first[key as keyof typeof first] === source[key as keyof typeof source]))
}
