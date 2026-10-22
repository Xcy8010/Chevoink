/** Exact ranges bridge arbitrary presentation chunks, never source gaps. */
export function terminalQuoteRange(ref: { segmentId: string; quote: string },
  segments: ReadonlyArray<{ segmentId: string; quote: string; start?: number; end?: number }>) {
  const original = segments.find(part => part.segmentId === ref.segmentId)
  if (!original || !/^[cp][0-9]+$/u.test(ref.segmentId) || !ref.quote.length) return null
  const prefix = ref.segmentId[0]
  const spans = segments.filter(part => part.segmentId.startsWith(prefix))
    .map(part => ({ ...part, start: part.start ?? Number(part.segmentId.slice(1)) * 300 }))
    .sort((a, b) => a.start - b.start)
  if (spans.some(part => !Number.isSafeInteger(part.start) || part.start < 0
    || part.end !== undefined && part.end !== part.start + part.quote.length)
    || spans.some((part, index) => index > 0 && spans[index - 1].start + spans[index - 1].quote.length > part.start)) return null
  const offset = original.quote.indexOf(ref.quote)
  if (offset >= 0) {
    if (original.quote.indexOf(ref.quote, offset + 1) >= 0) return null
    const start = (original.start ?? Number(original.segmentId.slice(1)) * 300) + offset
    return { start, end: start + ref.quote.length, segmentIds: [original.segmentId] }
  }
  const blocks: Array<{ start: number; end: number; text: string }> = []
  for (const span of spans) {
    const last = blocks.at(-1)
    if (last?.end === span.start) { last.text += span.quote; last.end += span.quote.length }
    else blocks.push({ start: span.start, end: span.start + span.quote.length, text: span.quote })
  }
  let start: number | undefined
  for (const block of blocks) {
    const found = block.text.indexOf(ref.quote)
    if (found < 0) continue
    if (start !== undefined || block.text.indexOf(ref.quote, found + 1) >= 0) return null
    start = block.start + found
  }
  if (start === undefined) return null
  const end = start + ref.quote.length
  return { start, end, segmentIds: spans.filter(span => span.start < end && span.start + span.quote.length > start).map(span => span.segmentId) }
}
