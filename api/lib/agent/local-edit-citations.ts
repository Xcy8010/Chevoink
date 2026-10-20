import { createHash } from 'node:crypto'
import type { TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { lexAuthorWritingRequest, parseAuthorWritingRequest, type AuthorWritingRequest } from './author-writing-request.js'
import { runtimeJson } from './runtime-common.js'

type Boundary = NonNullable<TaskSpec['scope']['localEditBoundary']>
type CitationBoundary = Extract<Boundary, { version: 2 }>
type Region = CitationBoundary['regions'][number]
const issue = /(?:确认|发现|存在|出现|有).{0,24}(?:问题|矛盾|冲突|错误|不一致)|(?:问题|矛盾|冲突|错误|不一致).{0,12}(?:如下|在于|表现)/u
const currentSource = /本章|当前(?:章|这章|正文)|该章/u
const uncertainSource = /前章|前文|旧稿|原先|历史|曾经|参考|例如|举例|假设|如果|是否|有没有|有无|需不需要|没有.{0,12}(?:问题|矛盾|冲突|错误)|并无/u
const localScope = /局部|片段|句子|这句话|这句|一句|几句|这段|这一段|那段|该段|某段|段落|对白|对话|开头|结尾|首段|末段|paragraph|passage|sentence/iu

/** Resolve protection using the same AST and saved body as the positive
 * locator. Unknown or repeated local protections cannot silently disappear. */
export function localEditProtectionRanges(prompt: string, content: string, parsed: AuthorWritingRequest = parseAuthorWritingRequest(prompt)) {
  const regions: Array<{ start: number; end: number }> = []
  for (const operation of parsed.evidence.operations.filter(operation => operation.polarity === 'negative'
    && ['negated', 'protected'].includes(operation.reason) && ['revise', 'write'].includes(operation.kind))) {
    for (const index of operation.targetIndices) {
      const target = parsed.evidence.targets[index]
      if (target.kind !== 'local') continue
      const quote = parsed.evidence.quoted.find(item => item.kind === 'quotation' && item.start === target.span.start && item.end === target.span.end)
      if (!quote?.closed) return null
      const text = prompt.slice(quote.contentStart, quote.contentEnd), start = content.indexOf(text)
      if (!text || start < 0 || content.indexOf(text, start + 1) >= 0) return null
      regions.push({ start, end: start + text.length })
    }
  }
  return regions
}

/** An outer author action gives issue quotations locator status. Text inside
 * quotations never supplies an action, a target, or an exception to a denial. */
export function freezeIssueQuoteBoundary(prompt: string, writing: TaskSpec['scope']['writing'],
  chapters: Array<{ id: string; revision: number; content: string }>): CitationBoundary | undefined {
  const parsed = parseAuthorWritingRequest(prompt)
  const localActions = parsed.evidence.operations.filter(operation => operation.accepted
    && operation.polarity === 'affirmative' && operation.kind === 'revise'
    && localScope.test(prompt.slice(operation.clauseSpan.start, operation.clauseSpan.end)))
  if (!localActions.length) return undefined
  const denied: CitationBoundary = { version: 2, kind: 'needs_input', regions: [] }
  if (writing?.kind !== 'bounded' || writing.targets.length !== 1 || !writing.targets[0].chapterId) return denied
  const chapter = chapters.find(item => item.id === writing.targets[0].chapterId)
  if (!chapter) return denied
  const lexed = lexAuthorWritingRequest(prompt)
  const protections = localEditProtectionRanges(prompt, chapter.content, parsed)
  if (!protections) return denied
  const sentences = new Map<number, typeof lexed.clauses>()
  for (const clause of lexed.clauses) sentences.set(clause.sentence, [...(sentences.get(clause.sentence) ?? []), clause])
  const inner = (quote: typeof lexed.quoted[number]) => prompt.slice(quote.contentStart, quote.contentEnd)
  const anchors: Array<{ text: string; start: number; end: number; issueStart: number; issueEnd: number }> = []
  for (const clauses of sentences.values()) {
    const start = clauses[0].start, end = clauses.at(-1)!.end
    const masked = lexed.masked.slice(start, end)
    if (!currentSource.test(masked) || !issue.test(masked) || uncertainSource.test(masked)) continue
    // Negated or interrogative issue statements cannot become mutable spans.
    if (/(?:不|未|无|不是|并非).{0,8}(?:确认|发现|存在|出现)|(?:不要|禁止|不得).{0,24}(?:修|改)|[?？]/u.test(masked)) continue
    for (const quote of lexed.quoted.filter(item => item.kind === 'quotation' && item.start >= start && item.end <= end)) {
      if (!quote.closed) return denied
      const text = inner(quote)
      if (!text || text.length > 512) return denied
      anchors.push({ text, start: quote.start, end: quote.end, issueStart: start, issueEnd: end })
    }
  }
  if (!anchors.length || anchors.length > 8) return denied
  const requestHash = createHash('sha256').update(prompt).digest('hex')
  const regions: Region[] = []
  for (const anchor of anchors) {
    const start = chapter.content.indexOf(anchor.text)
    if (start < 0 || chapter.content.indexOf(anchor.text, start + 1) >= 0) return denied
    if (regions.some(region => region.start === start && region.text === anchor.text)) continue
    const end = start + anchor.text.length
    if (protections.some(region => start < region.end && region.start < end)) return denied
    if (start === 0 && end === chapter.content.length) return denied
    regions.push({ chapterId: chapter.id, revision: chapter.revision, contentHash: runtimeJson({ content: chapter.content }).hash,
      start, end, prefix: chapter.content.slice(0, start), suffix: chapter.content.slice(end), text: anchor.text,
      // Relative to the initial quote, never refreshed after a repair batch.
      maxNewChars: Math.max(32, anchor.text.length * 2),
      source: { kind: 'author_issue_quote', requestHash, quoteStart: anchor.start, quoteEnd: anchor.end,
        issueStart: anchor.issueStart, issueEnd: anchor.issueEnd } })
  }
  regions.sort((a, b) => a.start - b.start)
  if (regions.some((region, index) => index > 0 && region.start <= regions[index - 1].end)) return denied
  return { version: 2, kind: 'bounded', regions }
}

/** Validate every independently frozen row before using any one of them. */
export function validIssueQuoteBoundary(boundary: CitationBoundary): boolean {
  if (boundary.kind === 'needs_input') return boundary.regions.length === 0
  if (!boundary.regions.length || boundary.regions.length > 8) return false
  const first = boundary.regions[0]
  const baseline = first.prefix + first.text + first.suffix
  return boundary.regions.every((region, index) => region.chapterId === first.chapterId && region.revision === first.revision
    && region.contentHash === first.contentHash && region.prefix + region.text + region.suffix === baseline
    && runtimeJson({ content: baseline }).hash === region.contentHash && region.prefix.length === region.start
    && region.end === region.start + region.text.length && region.maxNewChars >= region.text.length
    && region.maxNewChars === Math.max(32, region.text.length * 2)
    && !(region.start === 0 && region.end === baseline.length)
    && (index === 0 || region.start > boundary.regions[index - 1].end)
    && region.source.requestHash === first.source.requestHash && region.source.quoteEnd - region.source.quoteStart === region.text.length + 2
    && region.source.issueStart <= region.source.quoteStart && region.source.issueEnd >= region.source.quoteEnd)
}

/** The immutable gaps identify the current mutable islands. A second possible
 * gap location rejects the edit; no search can relocate an ambiguous window. */
export function currentIssueQuoteRegions(boundary: CitationBoundary, chapterId: string, revision: number, content: string) {
  if (boundary.kind !== 'bounded' || !validIssueQuoteBoundary(boundary)) return null
  const regions = boundary.regions
  if (regions[0].chapterId !== chapterId || revision < regions[0].revision) return null
  const baseline = regions[0].prefix + regions[0].text + regions[0].suffix
  if (revision === regions[0].revision && content !== baseline) return null
  const prefix = baseline.slice(0, regions[0].start), suffix = baseline.slice(regions.at(-1)!.end)
  if (!content.startsWith(prefix) || !content.endsWith(suffix) || content.length < prefix.length + suffix.length) return null
  const result: Array<{ start: number; end: number; maxNewChars: number }> = []
  let start = prefix.length
  const tail = content.length - suffix.length
  for (let index = 0; index < regions.length; index++) {
    let end = tail
    if (index < regions.length - 1) {
      const gap = baseline.slice(regions[index].end, regions[index + 1].start)
      if (!gap) return null
      end = content.indexOf(gap, start)
      if (end < 0 || end + gap.length > tail) return null
      const second = content.indexOf(gap, end + 1)
      if (second >= 0 && second + gap.length <= tail) return null
      if (end - start > regions[index].maxNewChars) return null
      result.push({ start, end, maxNewChars: regions[index].maxNewChars })
      start = end + gap.length
    } else {
      if (end < start || end - start > regions[index].maxNewChars) return null
      result.push({ start, end, maxNewChars: regions[index].maxNewChars })
    }
  }
  return result
}
