import { chapterTitleOrdinal, plainChapterTitle } from '../../../../shared/structure/chapter-title'

export function formatNumberedChapterTitle(title: string, ordinal: number) {
  const label = `第 ${ordinal} 章`
  const name = plainChapterTitle(title)
  if (!name || (name === title.trim() && chapterTitleOrdinal(name) !== null)) return label
  return `${label} · ${name}`
}
