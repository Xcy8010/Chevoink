import { parseHTML } from 'linkedom'
import { decodeFanqieText } from './fanqie-font-map.js'

/** Read the JSON value embedded by the public site without executing its script. */
export function extractFanqieInitialState(html: string): Record<string, unknown> | null {
  const marker = /window\.__INITIAL_STATE__\s*=\s*/u.exec(html)
  if (!marker) return null
  const value = html.slice(marker.index + marker[0].length)
  let depth = 0, quoted = false, escaped = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') {
      if (--depth === 0) {
        try {
          const state: unknown = JSON.parse(value.slice(0, index + 1))
          return state && typeof state === 'object' && !Array.isArray(state) ? state as Record<string, unknown> : null
        } catch { return null }
      }
    } else if (index === 0 && char !== '{') return null
  }
  return null
}

export type FanqieChapter = {
  bookTitle: string
  author: string
  chapterTitle: string
  chapterId: string
  bookId: string
  contentHtml: string
  fontFamily: string
  fontCss: string
  locked: boolean
  declaredCharacters?: number
}

export function extractFanqieChapter(html: string, sourceUrl?: string): FanqieChapter | null {
  if (!sourceUrl) return null
  const url = new URL(sourceUrl)
  if (!/^(?:www\.)?fanqienovel\.com$/iu.test(url.hostname) || !/^\/reader\//u.test(url.pathname)) return null
  const state = extractFanqieInitialState(html)
  const reader = state?.reader as { chapterData?: Record<string, unknown> } | undefined
  const chapter = reader?.chapterData
  if (!chapter) return null
  const common = state?.common as { css?: string } | undefined
  const string = (value: unknown) => typeof value === 'string' ? value : ''
  const declared = Number(chapter.chapterWordNumber)
  return {
    bookTitle: string(chapter.bookName), author: string(chapter.author), chapterTitle: string(chapter.title),
    chapterId: string(chapter.itemId), bookId: string(chapter.bookId), contentHtml: string(chapter.content),
    fontFamily: string(common?.css).match(/font-family\s*:\s*["']?([^;"'}\s]+)/iu)?.[1] ?? '',
    fontCss: string(common?.css),
    locked: chapter.isChapterLock === true || chapter.needPay === 1 || chapter.needPay === true,
    ...(Number.isSafeInteger(declared) && declared > 0 ? { declaredCharacters: declared } : {}),
  }
}

/** DOM parsing decodes numeric/named entities before any glyph conversion. */
export function fanqieChapterText(chapter: FanqieChapter): { text: string; characters: number; unmapped: number } {
  const { document } = parseHTML(`<html><body>${chapter.contentHtml}</body></html>`)
  const characters = document.body.textContent?.length ?? 0
  for (const node of document.querySelectorAll('br')) node.replaceWith(document.createTextNode('\n'))
  for (const node of document.querySelectorAll('p')) node.appendChild(document.createTextNode('\n\n'))
  return { ...decodeFanqieText(document.body.textContent?.trim() ?? '', chapter.fontFamily, chapter.fontCss), characters }
}
