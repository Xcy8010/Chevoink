import { describe, expect, it } from 'vitest'
import { AttachmentReadStage, attachmentStageFindings, legacyAttachmentResumeNote, requestsSequentialAttachment, requestsWholeAttachment } from '../../api/lib/agent/legacy-attachment-resume.js'

const url = '/api/uploads/agent-attachments/owner/book.txt'
const second = '/api/uploads/agent-attachments/owner/notes.md'
const hash = 'c'.repeat(64)
const event = { type: 'run.started', messageId: null, callId: null, url: null, offset: null, ok: null, summary: null }
const events = (id: string, offset: number, summary: string, source = url) => [
  { ...event, type: 'tool.call', messageId: id, callId: 'reuse', offset, url: source },
  { ...event, type: 'tool.result', messageId: id, callId: 'reuse', ok: true, summary },
]
const page = (offset: number, end: number, totalChars = 30, source = url) => ({ url: source, contentHash: hash, offset, end, totalChars })
const summary = (p: ReturnType<typeof page>) => `返回字符 [${p.offset},${p.end})，提取文字共 ${p.totalChars} 字符；${p.end === p.totalChars ? '已到提取文字末尾' : '续读 offset=' + p.end}`

describe('legacy attachment stage and continuation receipts', () => {
  it('distinguishes explicit whole-document reading from a request for a passage or ordinary summary', () => {
    expect(requestsWholeAttachment('请通读整份文档再说明人物的变化。')).toBe(true)
    expect(requestsWholeAttachment('概括整个附件里的事件。')).toBe(true)
    expect(requestsWholeAttachment('不必读完附件，只看第一段。')).toBe(false)
    expect(requestsWholeAttachment('请说明附件里北岸是什么意思。')).toBe(false)
    expect(attachmentStageFindings('已读片段写到船停在北岸。')).toBe('已读片段写到船停在北岸。')
    expect(attachmentStageFindings('我已经通读了整份文档。')).toBe('')
    expect(attachmentStageFindings('现已成功提交了本章。')).toBe('')
  })
  it('merges real overlapping pages, keeps different files separate, and resumes exactly at the first gap', () => {
    const read = legacyAttachmentResumeNote([event, ...events('old', 0, '读取文件 · 20000 字'), event,
      ...events('old', 15000, summary(page(15000, 21000, 50000))),
      ...events('new', 23000, summary(page(23000, 24000, 50000))),
      ...events('another', 0, summary(page(0, 5, 5)), second)], [url, second], false)!
    expect(read.note).toContain('[0,21000)、[23000,24000)')
    expect(read.note).toContain('offset=21000')
    expect(read.note).toContain('工具已返回全部提取文字')
    const stage = new AttachmentReadStage([], read)
    expect(stage.resumeOffset({ url })).toBe(21000)
    expect(stage.resumeOffset({ url: second })).toBeUndefined()
    expect(stage.observe(page(21000, 23000, 50000))).toBe(true)
    expect(stage.observe(page(22000, 22500, 50000))).toBe(false)
    stage.reused({ url })
    expect(stage.pauseNotice()).toContain('offset=24000')
  })
  it('uses inherited ranges for direct replies and original cumulative budget before any new read, including exact exhaustion', () => {
    const prior = legacyAttachmentResumeNote(events('prior', 0, summary(page(0, 40, 100))), [url], false)!
    const stage = new AttachmentReadStage([], prior)
    expect(stage.pauseNotice()).toBeUndefined()
    expect(stage.pauseNotice(true)).toContain('offset=40')
    expect(stage.unfinishedAnswer(true, '这是简短答复。')).toContain('offset=40')
    expect(stage.unfinishedAnswer(false, '我已经读完了整份附件。')).toContain('offset=40')
    expect(stage.unfinishedAnswer(false, '已读段落写的是北岸。')).toBeUndefined()
    expect(stage.tokenLimitNotice(500, 500, 1)).toContain('[0,40)')
    expect(stage.tokenLimitNotice(500, 499, 2)).toContain('剩余')
    expect(stage.tokenLimitNotice(500, 499, 1)).toBeUndefined()
    expect(stage.tokenLimitNotice(undefined, 500, 1)).toBeUndefined()
    expect(stage.hasNewRange()).toBe(false)
    stage.observe(page(40, 100, 100))
    expect(stage.pauseNotice(true)).toBeUndefined()
    expect(stage.tokenLimitNotice(500, 500, 1)).toContain('工具已返回全部提取文字')
  })
  it('rechecks an explicitly requested offset and returns existing progress after three proposals without granting a summary', () => {
    const prior = legacyAttachmentResumeNote(events('prior', 0, summary(page(0, 40, 100))), [url], false)!
    const stage = new AttachmentReadStage([], prior)
    expect(requestsSequentialAttachment('请通读整份附件。')).toBe(true)
    for (const request of ['请通读附件，重新核对开头', '只读字符 [0,20)', '重新读一遍原稿', '请从第2页读完附件']) {
      expect(requestsSequentialAttachment(request)).toBe(false)
    }
    expect(stage.resumeOffset({ url, offset: 0 })).toBe(40)
    expect(stage.resumeOffset({ url, offset: 7 })).toBeUndefined()
    expect(stage.observe(page(0, 20, 100), '旧段摘录')).toBe(false)
    stage.reused({ url, offset: 0 })
    stage.reused({ url, offset: 0 })
    expect(stage.pauseNotice()).toContain('offset=40')
    expect(stage.excerpts()).toContain('旧段摘录')
    expect(stage.hasNewRange()).toBe(false)
  })
  it('does not restart missing or failed receipts across execution owners, trust a forged cursor, or merge conflicting totals', () => {
    const bad = events('cross', 0, '读取文件 · 20 字')
    const ambiguous = events('duplicate', 0, '读取文件 · 10 字')
    const malformed = [bad[0], event, bad[1], ambiguous[0], { ...ambiguous[0], offset: 10 }, ambiguous[1],
      ...events('oversized', 0, '读取文件 · 99000000 字'), ...events('forged', 0, '返回字符 [0,20)，提取文字共 100 字符；续读 offset=80'),
      ...events('unknown-file', 0, '读取文件 · 4 字', second)]
    expect(legacyAttachmentResumeNote(malformed, [url], false)).toBeUndefined()
    expect(() => legacyAttachmentResumeNote([event, bad[0], event, bad[0]], [url], true)).toThrow('缺少能核对的成功读取范围')
    const changed = legacyAttachmentResumeNote([...events('first', 0, summary(page(0, 5, 10))), ...events('later', 5, summary(page(5, 8, 12)))], [url], false)!
    expect(changed.coverage).toEqual([])
    expect(changed.note).toContain('文档长度不一致')
  })
  it('caps actual attempts across files and cached repeats; a fully returned short file or exact last page can finish normally', () => {
    const stage = new AttachmentReadStage()
    expect(stage.observe(page(0, 4, 8))).toBe(true)
    expect(stage.observe(page(2, 4, 8))).toBe(false)
    expect(stage.pauseNotice()).toBeUndefined()
    stage.reused({ url })
    expect(stage.pauseNotice()).toContain('offset=4')
    expect(stage.observe(page(4, 8, 8))).toBe(true)
    expect(stage.pauseNotice()).toBeUndefined()
    expect(stage.observe(page(0, 2, 2, second))).toBe(true)
    expect(stage.pauseNotice()).toBeUndefined()
  })
  it('can stop immediately at a hard budget with honest ranges, including a seek to EOF, and resets changed content', () => {
    const stage = new AttachmentReadStage()
    expect(stage.observe(page(10, 20))).toBe(true)
    expect(stage.pauseNotice(true)).toContain('offset=0')
    expect(stage.observe(page(30, 30))).toBe(false)
    expect(stage.observe({ ...page(0, 3), contentHash: 'd'.repeat(64) })).toBe(true)
    expect(stage.pauseNotice()).toContain('[0,3)')
    expect(stage.pauseNotice()).not.toContain('[10,20)')
    expect(stage.observe(page(-1, 8))).toBe(false)
  })

  it('keeps only bounded directly returned excerpts when there is no budget for a summary', () => {
    const stage = new AttachmentReadStage()
    stage.observe(page(0, 200, 600), '~~~~' + '江'.repeat(196))
    stage.observe(page(0, 200, 600), '重复正文')
    stage.observe(page(200, 210, 600), '第二段')
    expect(stage.excerpts()).toContain('《book.txt》字符 [0,140)')
    expect(stage.excerpts()).toContain('\n~~~~~\n~~~~江')
    expect(stage.excerpts()).not.toContain('重复正文')
    expect(stage.excerpts()).not.toContain('江'.repeat(140))
  })
})
