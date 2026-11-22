import { Prisma } from '@prisma/client'
import type { AgentAttachmentMeta } from '../../../shared/contracts/agent-attachments.js'
import { DataAccessError, prisma } from '../prisma.js'
import type { ToolResult } from './tools/types.js'

type ReadEvent = {
  type: string; messageId: string | null; callId: string | null
  url: string | null; offset: unknown; ok: boolean | null; summary: string | null
}
type Range = { start: number; end: number; total?: number }
type Coverage = { url: string; spans: Range[]; total?: number; contentHash?: string }
export type AttachmentResume = { note: string; coverage: Coverage[] }
const stageReadLimit = 3
const contextWindowStop = '当前任务上下文已达到所选模型的安全窗口上限。'

function mergeRanges(ranges: Range[]) {
  const spans: Range[] = []
  for (const page of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = spans.at(-1)
    if (previous && page.start <= previous.end) previous.end = Math.max(previous.end, page.end)
    else spans.push({ start: page.start, end: page.end })
  }
  return spans
}
const firstMissing = (file: Coverage) => file.spans[0]?.start === 0 ? file.spans[0].end : 0

export function requestsWholeAttachment(prompt: string) {
  return prompt.split(/[，,。；;！!？?\n]/u).some(clause =>
    !/不(?:必|用|需要|要)|无需|只(?:读|看|需)|别(?:读|看)/u.test(clause)
    && /(?:通读|读完|看完|完整(?:读|阅读|看)|逐页(?:阅读|读|看))[^。；]{0,16}(?:附件|文件|文档|原稿|全文|全书|手稿)|(?:阅读|读|看|分析|梳理|概括)(?:整份|全部|整个)(?:附件|文件|文档|原稿)|(?:附件|文档|文件)[^。；]{0,12}(?:全文|全部)(?:仔细)?(?:读完|看完|阅读)/u.test(clause))
}

// An explicit request to compare/reread a particular passage keeps its model
// offsets. Only an unambiguous sequential instruction can redirect offset 0.
export function requestsSequentialAttachment(prompt: string) {
  return /^(?:请)?(?:继续)?(?:通读|读完|看完|逐页阅读|完整阅读)(?:整份|整个|这份|该)?(?:附件|文件|文档|原稿|全文|全书|手稿)[。！!]?$/u.test(prompt.trim())
}

/** An unfinished attachment can support observations, never a whole-file or
 * manuscript commit claim. Fall back to direct excerpts without retrying. */
const claimsCompleteReading = /(?:我|我们)?(?:已(?:经)?|现已)(?:全部|完整)?(?:读完|看完|通读|阅读完)(?:了)?(?:全部|整个|整份|整本|这份|该)?(?:附件|文件|原稿|文档|全文|全书)|(?:全文|全书|整个附件)(?:都|均)?已(?:经)?(?:读完|阅读完毕|分析完毕)|\bI (?:have )?(?:read|reviewed) the (?:entire|whole) (?:file|document|manuscript)\b/iu
export function attachmentStageFindings(text: string) {
  return claimsCompleteReading.test(text) || /(?:已(?:经)?|现已)(?:成功)?(?:保存|写入|提交)(?:了)?(?:本章|章节|正文|整章|作品)/u.test(text) ? '' : text.trim()
}

/** Counts actual page work, including overlap, separately from newly exposed
 * ranges. A tool receipt never certifies analysis or manuscript delivery. */
export class AttachmentReadStage {
  private readonly files = new Map<string, Coverage>()
  private readonly touched = new Set<string>()
  private samples: Array<{ url: string; text: string }> = []
  private calls = 0
  private freshReads = 0

  constructor(private readonly attachments: readonly AgentAttachmentMeta[] = [], prior?: AttachmentResume) {
    for (const file of prior?.coverage ?? []) this.files.set(file.url, structuredClone(file))
  }

  private filename(url: string) {
    return (this.attachments.find(item => item.url === url)?.name ?? url.split('/').at(-1) ?? '附件').replace(/[\r\n]/gu, ' ').slice(0, 180)
  }

  observe(read: NonNullable<ToolResult['observedAttachment']>, sample?: string): boolean {
    if (!/^[a-f0-9]{64}$/u.test(read.contentHash) || ![read.offset, read.end, read.totalChars].every(Number.isSafeInteger)
      || read.offset < 0 || read.offset > read.end || read.end > read.totalChars || read.totalChars < 1) return false
    let file = this.files.get(read.url)
    if (!file || (file.total !== undefined && file.total !== read.totalChars) || file.spans.some(span => span.end > read.totalChars)
      || (file.contentHash && file.contentHash !== read.contentHash)) {
      this.samples = this.samples.filter(sample => sample.url !== read.url)
      file = { url: read.url, spans: [] }
    }
    file.total = read.totalChars
    file.contentHash = read.contentHash
    const fresh = read.end > read.offset && !file.spans.some(span => span.start <= read.offset && span.end >= read.end)
    if (fresh) {
      this.freshReads++
      file.spans = mergeRanges([...file.spans, { start: read.offset, end: read.end }])
    }
    // Even an explicitly rechecked passage can supply a direct local excerpt.
    // It does not count as new coverage or earn another summary request.
    if (sample && read.end > read.offset && (fresh || !this.samples.length) && this.samples.length < stageReadLimit) {
      const quote = sample.slice(0, Math.min(140, read.end - read.offset)).replace(/[\uD800-\uDBFF]$/u, '')
      const fence = '~'.repeat(Math.max(3, ...[...quote.matchAll(/~+/gu)].map(run => run[0].length + 1)))
      this.samples.push({ url: read.url, text: `《${this.filename(read.url)}》字符 [${read.offset},${read.offset + quote.length}) 的原文片段\n${fence}\n${quote}\n${fence}` })
    }
    this.files.set(read.url, file)
    this.touched.add(read.url)
    this.calls++
    return fresh
  }

  excerpts() { return this.samples.map(sample => sample.text).join('\n\n') }
  hasNewRange() { return this.freshReads > 0 }

  unfinishedAnswer(needsWhole: boolean, proposed: string) {
    return needsWhole || claimsCompleteReading.test(proposed) ? this.pauseNotice(true) : undefined
  }

  reused(args: unknown) {
    if (args && typeof args === 'object' && 'url' in args && typeof args.url === 'string' && this.files.has(args.url)) {
      this.calls++
      this.touched.add(args.url)
    }
  }

  resumeOffset(args: unknown): number | undefined {
    if (!args || typeof args !== 'object' || !('url' in args) || typeof args.url !== 'string'
      || ('offset' in args && args.offset !== undefined && args.offset !== 0)) return
    const file = this.files.get(args.url)
    if (!file || firstMissing(file) === 0 || firstMissing(file) === file.total) return
    return firstMissing(file)
  }

  pauseNotice(atBudgetLimit = false): string | undefined {
    if (!atBudgetLimit && this.calls < stageReadLimit) return
    const files = atBudgetLimit ? [...this.files.values()] : [...this.touched].map(url => this.files.get(url)!)
    const partial = files.filter(file => firstMissing(file) !== file.total)
    if (!partial.length) return
    return this.describe(partial) + '\n附件分段读取已暂停。需要后文时可点击「继续」。'
  }

  tokenLimitNotice(limit: number | undefined, consumed: number, requestTokens: number) {
    if (limit === undefined || consumed + requestTokens <= limit || (!this.files.size && !this.attachments.some(file => file.kind === 'file'))) return
    return [this.describe([...this.files.values()]), '原任务剩余的模型额度不足以执行本次请求，已保留现有进度并暂停。'].filter(Boolean).join('\n')
  }

  private describe(files: Coverage[]) {
    return files.map(file => {
      const name = this.filename(file.url)
      const shown = file.spans.slice(0, 4).map(span => `[${span.start},${span.end})`).join('、') || '无'
      const next = firstMissing(file) === file.total ? '工具已返回全部提取文字。' : `下次从首个未读位置 offset=${firstMissing(file)} 继续。`
      return `《${name}》${file.total === undefined ? '' : `共 ${file.total} 个字符，`}已返回 ${shown}${file.spans.length > 4 ? ' 等范围' : ''}。${next}`
    }).join('\n')
  }
}

function returnedRange(offset: number, summary: string): Range | undefined {
  const legacy = /^读取文件 · (\d+) 字$/u.exec(summary)
  if (legacy) {
    const end = offset + Number(legacy[1])
    if (Number.isSafeInteger(end) && end > offset && end - offset <= 20000) return { start: offset, end }
    return
  }
  const page = /^返回字符 \[(\d+),(\d+)\)，提取文字共 (\d+) 字符；(?:续读 offset=(\d+)|已到提取文字末尾)$/u.exec(summary)
  if (!page) return
  const [start, end, total] = page.slice(1, 4).map(Number)
  if (![start, end, total].every(Number.isSafeInteger) || start !== Math.min(offset, total)
    || end <= start || end > total || end - start > 20000 || (end < total ? Number(page[4]) !== end : page[4] !== undefined)) return
  return { start, end, total }
}

/** The journal contains server-generated lengths. It does not preserve a model's understanding or certify analysis. */
export function legacyAttachmentResumeNote(events: ReadEvent[], urls: string[], windowStopped: boolean): AttachmentResume | undefined {
  const ranges = new Map<string, Range[]>()
  const calls = new Map<string, { url: string; offset: number }>()
  const seen = new Set<string>()
  const startsFromZero = new Map<string, Set<number>>()
  let attempt = 0
  for (const event of events) {
    if (event.type === 'run.started') { attempt++; calls.clear(); seen.clear(); continue }
    if (!event.messageId || !event.callId) continue
    const key = JSON.stringify([event.messageId, event.callId])
    if (event.type === 'tool.call') {
      calls.delete(key)
      if (seen.has(key)) continue
      seen.add(key)
      const offset = event.offset ?? 0
      if (!event.url || !urls.includes(event.url) || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) continue
      calls.set(key, { url: event.url, offset })
      if (offset === 0) {
        const attempts = startsFromZero.get(event.url) ?? new Set<number>()
        attempts.add(attempt)
        startsFromZero.set(event.url, attempts)
      }
    } else if (event.type === 'tool.result') {
      const call = calls.get(key)
      calls.delete(key)
      if (!call || event.ok !== true || !event.summary) continue
      const range = returnedRange(call.offset, event.summary)
      if (!range) continue
      const saved = ranges.get(call.url) ?? []
      saved.push(range)
      ranges.set(call.url, saved)
    }
  }

  const notes: string[] = []
  const coverage: Coverage[] = []
  for (const url of urls) {
    const pages = ranges.get(url)
    // Image-only documents have a legitimate non-text result. An absent cursor for them
    // doesn't imply another text-reading loop.
    if (!pages) {
      if (windowStopped && /\.(?:txt|md)$/iu.test(url) && (startsFromZero.get(url)?.size ?? 0) > 1) {
        throw new DataAccessError(409, 'ATTACHMENT_RESUME_UNCONFIRMED', '这个附件在多次执行中都从开头读取，随后达到上下文上限。缺少能核对的成功读取范围，已停止重复启动。请说明要处理的具体片段或提供分段文件。')
      }
      continue
    }
    const spans = mergeRanges(pages)
    const firstMissing = spans[0].start === 0 ? spans[0].end : 0
    const totals = new Set(pages.flatMap(page => page.total === undefined ? [] : [page.total]))
    const total = [...totals][0]
    if (totals.size > 1 || total !== undefined && spans.some(span => span.end > total)) {
      notes.push(url + '：既有回执中的文档长度不一致，按当前文档重新核对后再续读。')
      continue
    }
    coverage.push({ url, spans, total })
    const complete = spans.length === 1 && totals.size === 1 && totals.has(firstMissing)
    const shown = spans.slice(0, 4).map(range => '[' + range.start + ',' + range.end + ')').join('、')
    notes.push(url + '：工具曾返回字符 ' + shown + (spans.length > 4 ? '等 ' + spans.length + ' 段' : '') + '。' +
      (complete ? '工具已返回全部提取文字。' : '如需后文，从第一个未核实位置 offset=' + firstMissing + ' 继续。'))
  }
  if (notes.length) return { coverage, note: '原任务附件读取回执（按原附件地址和字符偏移）：\n' + notes.join('\n')
    + '\n这些范围只表示工具曾返回文字。沿用已保存的分析，按需核对缺失的依据；若没有相应分析，请如实说明。旧回执对应当时的提取文字；若本次解码或文本长度不同，重新核对位置。' }
}

export async function readLegacyAttachmentResumeNote(runId: string, attachments: AgentAttachmentMeta[] | undefined, errorMessage: string | null) {
  const urls = [...new Set(attachments?.filter(file => file.kind === 'file').map(file => file.url))]
  if (!urls.length) return
  // Admission already established the run owner and verified the attachment grants.
  // Project only call identity, range and server summary, not the uploaded text or screenshots.
  const events = await prisma.$queryRaw<ReadEvent[]>(Prisma.sql`
    SELECT type, payload->>'messageId' AS "messageId", payload->>'callId' AS "callId",
      payload->'args'->>'url' AS url, payload->'args'->'offset' AS "offset",
      (payload->'ok' = 'true'::jsonb) AS ok, payload->>'summary' AS summary
    FROM agent_run_events WHERE run_id = ${runId}
      AND (type = 'run.started' OR (type IN ('tool.call', 'tool.result') AND payload->>'toolName' = 'read_file'
        AND NOT (payload ? 'subagentCallId')))
    ORDER BY seq
  `)
  return legacyAttachmentResumeNote(events, urls, errorMessage === contextWindowStop)
}
