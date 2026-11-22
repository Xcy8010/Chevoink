import { describe, expect, it, vi } from 'vitest'
import { readFileTool, readViewImageInput, viewImageTool } from '../../api/lib/agent/tools/attachment-tools.js'
import { readAuthorizedAgentAttachment } from '../../api/lib/agent-attachment-storage.js'
import { extractFileText } from '../../api/lib/file-extract.js'
import { inspectDocumentVisuals, readDocumentVisual } from '../../api/lib/attachment-document-visuals.js'
import { describeImageWithVision } from '../../api/lib/vision-service.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

vi.mock('../../api/lib/agent-attachment-storage.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent-attachment-storage.js')>(),
  readAuthorizedAgentAttachment: vi.fn(),
}))
vi.mock('../../api/lib/attachment-document-visuals.js', () => ({ inspectDocumentVisuals: vi.fn(), readDocumentVisual: vi.fn() }))
vi.mock('../../api/lib/file-extract.js', () => ({ extractFileText: vi.fn() }))
vi.mock('../../api/lib/vision-service.js', () => ({ describeImageWithVision: vi.fn() }))

const ctx = { userId: 'author', runId: 'run', novelId: 'book', signal: new AbortController().signal } as ToolContext
const base = '/api/uploads/agent-attachments/author/book'
const source = Buffer.from('original document')

describe('chat document vision handoff', () => {
  it('exposes actual blank-text page numbers without putting a vision call in read_file', async () => {
    vi.mocked(readAuthorizedAgentAttachment).mockResolvedValue(source)
    vi.mocked(extractFileText).mockResolvedValue({ text: 'caption', totalChars: 7, truncated: false, pdfPages: { total: 3, withoutText: [2] } })
    const read = await readFileTool.execute(ctx, { url: base + '.pdf' })
    expect(read.output).toContain(base + '.pdf#page=1')
    expect(read.output).toContain('无文字层的页码：2')
    expect(read.output).toContain('caption')
    expect(inspectDocumentVisuals).not.toHaveBeenCalled()
    expect(describeImageWithVision).not.toHaveBeenCalled()
  })

  it('can discover an image even if the Word text layer fails, then passes its pixels to the existing vision route', async () => {
    vi.mocked(readAuthorizedAgentAttachment).mockResolvedValue(source)
    vi.mocked(extractFileText).mockRejectedValue(new Error('unreadable text layer'))
    vi.mocked(inspectDocumentVisuals).mockResolvedValue({ count: 1, unit: 'image' })
    const url = base + '.docx'
    const read = await readFileTool.execute(ctx, { url })
    const ref = url + '#image=1'
    expect(read.output).toContain(ref)
    expect(read.output).toContain('文字层解析失败')
    expect(read.summary).toContain('1 张内嵌图可查看')
    expect(read.observedAttachment).toBeUndefined()
    const image = { buffer: Buffer.from('rendered pixels'), mime: 'image/png' }
    vi.mocked(readDocumentVisual).mockResolvedValue(image)
    vi.mocked(describeImageWithVision).mockResolvedValue('蓝色柱形图')
    const seen = await viewImageTool.execute(ctx, { url: ref, focus: '读图表' })
    expect(readAuthorizedAgentAttachment).toHaveBeenLastCalledWith(url, 'author')
    expect(readDocumentVisual).toHaveBeenCalledWith(source, 'docx', 1, ctx.signal)
    expect(describeImageWithVision).toHaveBeenCalledWith(image, expect.stringContaining('读图表'), expect.objectContaining({ runId: 'run', userId: 'author' }))
    expect(seen.output).toContain('Word 内嵌图 1')
    expect(seen.display).toMatchObject({ kind: 'markdown', markdown: expect.stringContaining('蓝色柱形图') })
    vi.mocked(describeImageWithVision).mockRejectedValueOnce(new Error('视觉服务暂不可用'))
    expect(await viewImageTool.execute(ctx, { url: ref })).toMatchObject({ outcome: 'failed', output: expect.stringContaining('视觉服务暂不可用') })
  })

  it('refuses malformed document selectors and enforces ownership before rasterization', async () => {
    vi.mocked(readDocumentVisual).mockClear()
    vi.mocked(readAuthorizedAgentAttachment).mockRejectedValue(new Error('附件不属于当前用户'))
    for (const suffix of ['.pdf#page=0', '.pdf#image=1', '.docx#page=1', '.pdf#page=1&url=other']) {
      expect(await readViewImageInput(ctx, { url: base + suffix })).toMatchObject({ outcome: 'failed' })
    }
    await expect(readViewImageInput(ctx, { url: '/api/uploads/agent-attachments/other/book.pdf#page=1' })).rejects.toThrow('不属于')
    expect(readDocumentVisual).not.toHaveBeenCalled()
  })
})
