export const IMPORT_BODY_WINDOW = 20_000

/** Translate the textarea's normalized LF selection to the untouched UTF-16 source. */
export function importRawCursor(text: string, visibleOffset: number): number {
  let raw = 0
  for (let visible = 0; visible < visibleOffset && raw < text.length; visible++, raw++) {
    if (text[raw] === '\r' && text[raw + 1] === '\n') raw++
  }
  return raw
}
