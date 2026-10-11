import { composeChapterEdit, type ChapterPatch } from './chapter-patches.js'
import { DataAccessError } from '../../prisma.js'

/** Pure shared before→effect kernel. Adapters retain transaction, CAS, review
 * consumption and receipt ownership; composition never persists partial work. */
export function composeChapterBody(before: string, action: 'replace' | 'append' | 'range', args: {
  content?: string; patches?: ChapterPatch[]; oldText?: string; newText?: string; start?: number; end?: number
}, anchorProtocol: 1 | 2 = 2) {
  if (action === 'range') return composeChapterEdit(before, args, anchorProtocol)
  if (typeof args.content !== 'string') throw new DataAccessError(400, 'RUNTIME_INPUT_INVALID', '正文内容缺失。')
  const after = action === 'replace' || !before.trim() ? args.content : `${before.replace(/\s+$/, '')}\n\n${args.content}`
  return { after, ranges: undefined }
}
