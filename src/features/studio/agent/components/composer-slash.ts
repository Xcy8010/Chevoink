export type ComposerSlashToken = { start: number; end: number; query: string }

function isQuotedOrCode(prefix: string): boolean {
  const quotes: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』', '《': '》' }
  let quote: string | null = null
  let code: { char: string; length: number } | null = null
  let lineIndent = 0
  let lineWhitespaceOnly = true
  for (let index = 0; index < prefix.length; index += 1) {
    const char = prefix[index]
    const fencePosition = lineWhitespaceOnly && lineIndent <= 3
    if (char === '\n') { lineIndent = 0; lineWhitespaceOnly = true }
    else if (char === ' ' || char === '\t') lineIndent += 1
    else lineWhitespaceOnly = false
    if (char === '\\') {
      if (prefix[index + 1] === '\n') { lineIndent = 0; lineWhitespaceOnly = true }
      index += 1
      continue
    }
    if (quote) { if (char === quote) quote = null; continue }
    if (char === '`' || (char === '~' && fencePosition)) {
      let length = 1
      while (prefix[index + length] === char) length += 1
      if (char === '`' || length >= 3) {
        if (!code) code = { char, length }
        else if (code.char === char && code.length === length) code = null
        index += length - 1
        continue
      }
    }
    if (code) continue
    // Apostrophes within words are prose, rather than the start of a quote.
    if (quotes[char] && !(char === "'" && /[\p{L}\p{N}]/u.test(prefix[index - 1] ?? ''))) quote = quotes[char]
  }
  return quote !== null || code !== null
}

/** Only a standalone token at the caret; paths, URLs and goal commands remain prose. */
export function findComposerSlashToken(draft: string, caret: number): ComposerSlashToken | null {
  const prefix = draft.slice(0, caret)
  const match = /(?:^|\s)\/([\p{L}\p{N}_-]*)$/u.exec(prefix)
  if (!match) return null
  const start = caret - match[1].length - 1
  if (isQuotedOrCode(draft.slice(0, start))) return null
  const tail = /^[\p{L}\p{N}_-]*/u.exec(draft.slice(caret))?.[0] ?? ''
  const end = caret + tail.length
  const token = draft.slice(start + 1, end)
  if (/^(?:goal|目标)$/i.test(token) || draft[end] === '/') return null
  return { start, end, query: match[1].toLocaleLowerCase('zh-CN') }
}
