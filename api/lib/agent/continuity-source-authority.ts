import type { ContinuityFindingInput } from '../../../shared/contracts/story-compiler-contracts.js'
import type { ContinuityBodies } from './continuity-review-context.js'
import { z } from 'zod'

/** Server-owned ordinal/ranges from the same frozen bodies as the review. */
export const continuitySourceScopeSchema = z.object({
  currentOrderIndex: z.number().int(),
  previous: z.array(z.object({ orderIndex: z.number().int(), startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative() }).strict()),
}).strict()
export type ContinuitySourceScope = z.infer<typeof continuitySourceScopeSchema>

export function compilerEvidenceScope(chapter: { orderIndex: number }, source: {
  id?: string
  preceding?: Array<{ orderIndex: number; joinedStart: number; joinedEnd: number }>
} | null): ContinuitySourceScope {
  return { currentOrderIndex: chapter.orderIndex, previous: source?.preceding?.map(row => ({
    orderIndex: row.orderIndex, startOffset: row.joinedStart, endOffset: row.joinedEnd,
  })) ?? [] }
}

function ordinal(value: string) {
  if (/^\d+$/u.test(value)) return Number(value)
  const digits = '零一二三四五六七八九'
  let result = 0, digit = 0
  for (const char of value) {
    if (digits.includes(char)) digit = digits.indexOf(char)
    else if (char === '两') digit = 2
    else if ('十百千'.includes(char)) { result += (digit || 1) * (({ 十: 10, 百: 100, 千: 1000 } as Record<string, number>)[char] ?? 0); digit = 0 }
    else return NaN
  }
  return result + digit
}

// Extract every complete quoted span, including single characters and newlines.
// Attribution persists within a sentence until an explicit source replaces it.
// The ordinal is resolved against frozen chapter ranges, never a model label.
function attributedQuotes(text: string, scope?: ContinuitySourceScope) {
  const token = /“([^”]*)”|‘([^’]*)’|「([^」]*)」|『([^』]*)』|"([^"]*)"|'([^']*)'|第\s*[零一二三四五六七八九十百千两\d]+\s*(?:[、，,至到\-~～—]\s*(?:第\s*)?[零一二三四五六七八九十百千两\d]+\s*)+章|第\s*([零一二三四五六七八九十百千两\d]+)\s*章|\bchapter\s+(\d+)\b|当前(?:正文|稿|章)?|本章|这(?:一)?章|\bcurrent\b|前章|前文|上(?:一)?章|\bprevious\b|作者要求|原(?:始)?请求|旧稿|历史(?:引用|问题)|[。！？!?;]/giu
  let source: 'current' | 'previous' | 'non_manuscript' | 'ambiguous' | number | undefined
  const quotes: Array<{ quote: string; source: typeof source }> = []
  for (const match of text.matchAll(token)) {
    const quoted = match.slice(1, 7).find(value => value !== undefined)
    if (quoted !== undefined) { quotes.push({ quote: quoted, source }); continue }
    if (match[7] !== undefined || match[8] !== undefined) {
      const index = ordinal(match[7] ?? match[8])
      source = index === scope?.currentOrderIndex ? 'current' : index
    } else if (/^第/u.test(match[0])) source = 'ambiguous'
    else if (/^(当前|本章|这|current)/iu.test(match[0])) source = 'current'
    else if (/^(前|上|previous)/iu.test(match[0])) source = 'previous'
    else if (/^(作者|原|旧|历史)/u.test(match[0])) source = 'non_manuscript'
    else source = undefined
  }
  return quotes
}

/** Opt-in belongs to the original human admission, never a resume or summary. */
export function hasContinuitySourceAuthority(spec: unknown): boolean {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return false
  const scope = (spec as Record<string, unknown>).scope
  return !!scope && typeof scope === 'object' && !Array.isArray(scope)
    && (scope as Record<string, unknown>).continuityEvidenceProtocol === 1
}

export function continuityAuthorRequirements(prompt: string | null) {
  return `原始作者要求（授权与硬性检查门槛仍有效；其中描述的旧稿、历史问题和引文不是当前正文事实，须在本轮 current 重新定位）：\n${JSON.stringify({ source: 'author_request', manuscriptEvidence: false, text: prompt ?? '' })}`
}

export type ContinuitySourceCheckPolicy = 'explicit_source_evidence_v1'

/** Quoted prose is evidence only when it occurs in the explicitly selected
 * current/previous spans. A segment address alone, an author request, a prior
 * report or a matching revision hash cannot substantiate a factual accusation.
 * This is a location/authority check, not a semantic proof of contradiction. */
export function invalidContinuitySourceClaim(finding: ContinuityFindingInput, bodies: ContinuityBodies,
  references: Array<{ source: 'previous' | 'current'; quote?: string }> | undefined, scope?: ContinuitySourceScope, policy?: ContinuitySourceCheckPolicy): boolean {
  if (!references?.length || references.some(ref => !ref.quote || !(bodies[ref.source] ?? '').includes(ref.quote))) return true
  const quotes = attributedQuotes(finding.evidence, scope)
  // Never let an unrelated valid span launder a historical/invented quotation.
  if (quotes.some(({ quote, source }) => {
    if (!quote || source === 'non_manuscript' || source === 'ambiguous') return true
    // Unlabelled prose in a current-chapter accusation must be current prose.
    // An unfamiliar phrase cannot broaden authority to every referenced body.
    const refs = references.filter(ref => ref.source === (typeof source === 'number' ? 'previous' : source ?? 'current'))
    if (!refs.some(ref => ref.quote!.includes(quote))) return true
    if (typeof source !== 'number') return false
    const chapter = scope?.previous.find(row => row.orderIndex === source)
    return !chapter || !(bodies.previous ?? '').slice(chapter.startOffset, chapter.endOffset).includes(quote)
  })) return true
  if (finding.severity !== 'error') return false
  const current = references.filter(ref => ref.source === 'current')
  const distinct = new Set(references.map(ref => `${ref.source}:${ref.quote}`))
  return distinct.size < 2 || !current.length
    || policy !== 'explicit_source_evidence_v1' && !quotes.some(({ quote, source }) => (source === undefined || source === 'current') && current.some(ref => ref.quote!.includes(quote)))
}

export const continuitySourceAuthorityRule = `证据来源协议：author_request 是作者授权及要求，不能当作 previous/current 原文；历史旧句、旧报告和桥接摘要即使写着“第几章”也须在本轮原文重新定位。当前章以本轮 chapterId/revision/contentHash 及 current 原文为唯一依据。每项 sourceEvidence 必须同时给 source、segmentId 和逐字短 quote；段落编号不能代替具体事实引文。error 须包含至少一处 current 及另一处不同事实引用，可为 previous/current 或 current/current；只有前文错误不能指控当前章。evidence 中用引号逐字引用当前指控的具体短句，所有引号内文本必须来自这些 sourceEvidence；前文引文在引号前明确标记“前文”或“第N章”（服务器全书章序），未标明来源的引文按当前正文核对。复评理由也遵守同样来源规则，不能借正确段落地址夹入旧句或编造免责句。原文不支持则撤回候选并说明依据，不改稿凑证据、不放宽硬性检查通过要求。`
