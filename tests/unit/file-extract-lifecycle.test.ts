import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extractFileText } from '../../api/lib/file-extract.js'

const parser = vi.hoisted(() => ({ getText: vi.fn(), destroy: vi.fn(), options: vi.fn() }))
vi.mock('pdf-parse', () => ({
  PDFParse: class {
    constructor(options: unknown) { parser.options(options) }
    getText = parser.getText
    destroy = parser.destroy
  },
}))
beforeEach(() => {
  vi.resetAllMocks()
  parser.getText.mockResolvedValue({ text: '已提取正文', total: 1, pages: [{ num: 1, text: '已提取正文' }] })
  parser.destroy.mockResolvedValue(undefined)
})
describe('PDF resource lifecycle', () => {
  it('uses local bytes, disables eval and releases successful parsers', async () => {
    const buffer = Buffer.from('fixture')
    expect((await extractFileText(buffer, 'chapter.pdf')).text).toBe('已提取正文')
    expect(parser.options).toHaveBeenCalledWith({ data: buffer, isEvalSupported: false })
    expect(parser.getText).toHaveBeenCalledWith({ pageJoiner: '' })
    expect(parser.destroy).toHaveBeenCalledTimes(1)
  })
  it('releases a failed parser without leaking its underlying error', async () => {
    parser.getText.mockRejectedValue(new Error('internal-path-and-details'))
    await expect(extractFileText(Buffer.from('fixture'), 'chapter.pdf')).rejects.toMatchObject({ code: 'FILE_EXTRACT_ERROR' })
    expect(parser.destroy).toHaveBeenCalledTimes(1)
  })
  it('reports resource cleanup failure through the same safe contract', async () => {
    parser.destroy.mockRejectedValue(new Error('worker internals'))
    await expect(extractFileText(Buffer.from('fixture'), 'chapter.pdf')).rejects.toMatchObject({ code: 'FILE_EXTRACT_ERROR' })
    expect(parser.getText).toHaveBeenCalledTimes(1)
  })
})
