import type { NovelImportPreview } from '../../../shared/contracts/novel-import.js'
import { DataAccessError } from '../prisma.js'
import { normalizeImportTitle } from './content-routing.js'

type ExistingVolume = { id: string; title: string; orderIndex: number; revision?: number; summary?: string | null }
type ExistingChapter = { id: string; title: string; volumeId: string; orderIndex: number; orderInVolume: number }
export type ImportChapterPosition = Pick<ExistingChapter, 'id' | 'volumeId' | 'orderIndex' | 'orderInVolume'>
const ambiguous = (): never => { throw new DataAccessError(409, 'IMPORT_PLACEMENT_AMBIGUOUS', '卷章名称存在歧义，未改动作品；请调整来源卷名或重复章名后重新导入。') }
const byOrder = (a: ExistingVolume, b: ExistingVolume) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id)
function volumeLabel(title: string) {
  const name = normalizeImportTitle(title)
  const match = /^第([0-9零〇一二两三四五六七八九十百千]+)卷[·:：、—-]*(.*)$/.exec(name)
  if (!match) return { name, tail: name, ordinal: undefined }
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  let ordinal = 0, current = 0
  if (/^\d+$/.test(match[1])) ordinal = Number(match[1])
  else for (const character of match[1]) {
    const unit = ({ 十: 10, 百: 100, 千: 1000 } as Record<string, number>)[character]
    if (unit) { ordinal += (current || 1) * unit; current = 0 } else current = digits[character]
  }
  return { name, tail: match[2], ordinal: ordinal + current }
}

/** Resolve once before mutations. Matches never cross the chosen volume boundary. */
export function buildNovelImportPlacement(existingVolumes: ExistingVolume[], existingChapters: ExistingChapter[], input: NovelImportPreview['volumes'], newId: () => string) {
  const originals = [...existingVolumes].sort(byOrder)
  const newVolumes: ExistingVolume[] = []
  const renamedVolumes: Array<{ id: string; beforeTitle: string; title: string }> = []
  const claimed = new Set<string>(), archivedChapterIds = new Set<string>()
  const imported: Array<{ id: string; title: string; content: string; volumeId: string; orderIndex: number; orderInVolume: number }> = []
  if (!input.length) return { newVolumes, renamedVolumes, volumeCount: 0, archivedChapterIds: [] as string[], chapters: imported, reorderedBefore: [] as ImportChapterPosition[], reorderedAfter: [] as ImportChapterPosition[], lastChapterTitle: [...existingChapters].sort((a, b) => b.orderIndex - a.orderIndex)[0]?.title ?? '' }
  const layout = new Map(originals.map(volume => [volume.id, existingChapters.filter(chapter => chapter.volumeId === volume.id).sort((a, b) => a.orderInVolume - b.orderInVolume || a.orderIndex - b.orderIndex || a.id.localeCompare(b.id))]))
  if (existingChapters.some(chapter => !layout.has(chapter.volumeId))) ambiguous()
  let volumeOrder = Math.max(0, ...originals.map(volume => volume.orderIndex))
  for (const volume of input) {
    const label = volumeLabel(volume.title)
    let candidates = originals.filter(existing => volumeLabel(existing.title).name === label.name)
    if (!candidates.length && label.ordinal !== undefined) candidates = originals.filter(existing => {
      const other = volumeLabel(existing.title)
      return existing.orderIndex === label.ordinal && (label.tail ? other.tail === label.tail || other.ordinal === label.ordinal && !other.tail : other.ordinal === label.ordinal)
    })
    if (!candidates.length && label.name === '正文卷' && originals.length) {
      if (originals.length !== 1) ambiguous()
      candidates = originals
    }
    // A pristine, sole default volume is the empty-work destination. Never
    // infer a placeholder among multiple volumes or once any chapter exists.
    const placeholder = originals[0]
    if (!candidates.length && label.ordinal === undefined && !claimed.size && originals.length === 1 && !existingChapters.length && placeholder.title === '第一卷' && placeholder.orderIndex === 1 && placeholder.revision === 1 && placeholder.summary === null) {
      candidates = [placeholder]
      renamedVolumes.push({ id: placeholder.id, beforeTitle: placeholder.title, title: volume.title })
    }
    if (candidates.length > 1) ambiguous()
    const destination = candidates[0] ?? { id: newId(), title: volume.title, orderIndex: ++volumeOrder }
    if (claimed.has(destination.id)) ambiguous()
    claimed.add(destination.id)
    if (!candidates.length) { newVolumes.push(destination); layout.set(destination.id, []) }
    const old = layout.get(destination.id)!
    const replacements = new Map<string, ExistingChapter[]>(), additions: ExistingChapter[] = []
    const sourceCounts = new Map<string, number>()
    for (const chapter of volume.chapters) { const key = normalizeImportTitle(chapter.title); sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1) }
    let lastMatchedPosition = -1
    for (const chapter of volume.chapters) {
      const key = normalizeImportTitle(chapter.title), matches = old.filter(existing => normalizeImportTitle(existing.title) === key)
      if (matches.length > 1 || matches.length && sourceCounts.get(key)! > 1) ambiguous()
      const row = { id: newId(), title: chapter.title, content: chapter.content, volumeId: destination.id, orderIndex: 0, orderInVolume: 0 }
      imported.push(row)
      if (matches.length) {
        const position = old.findIndex(existing => existing.id === matches[0].id)
        if (position <= lastMatchedPosition) ambiguous()
        lastMatchedPosition = position
        archivedChapterIds.add(matches[0].id); replacements.set(matches[0].id, [...additions.splice(0), row])
      } else additions.push(row)
    }
    layout.set(destination.id, [...old.flatMap(chapter => replacements.get(chapter.id) ?? [chapter]), ...additions])
  }
  let orderIndex = 0
  const positions: ImportChapterPosition[] = []
  for (const volume of [...originals, ...newVolumes]) for (const [index, chapter] of (layout.get(volume.id) ?? []).entries()) positions.push({ id: chapter.id, volumeId: volume.id, orderIndex: ++orderIndex, orderInVolume: index + 1 })
  const byId = new Map(positions.map(position => [position.id, position]))
  const reordered = existingChapters.filter(chapter => !archivedChapterIds.has(chapter.id) && (chapter.orderIndex !== byId.get(chapter.id)!.orderIndex || chapter.orderInVolume !== byId.get(chapter.id)!.orderInVolume))
  return { newVolumes, renamedVolumes, volumeCount: claimed.size, archivedChapterIds: [...archivedChapterIds],
    chapters: imported.map(chapter => ({ ...chapter, ...byId.get(chapter.id)! })),
    reorderedBefore: reordered.map(({ id, volumeId, orderIndex, orderInVolume }) => ({ id, volumeId, orderIndex, orderInVolume })),
    reorderedAfter: reordered.map(chapter => byId.get(chapter.id)!),
    lastChapterTitle: [...positions].reverse().map(position => imported.find(chapter => chapter.id === position.id) ?? existingChapters.find(chapter => chapter.id === position.id))[0]?.title ?? '',
  }
}
