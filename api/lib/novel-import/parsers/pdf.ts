import { NOVEL_IMPORT_LIMITS as LIMITS, ParseContext, checkStructure } from './limits.js'
import { runConverter } from './isolated.js'
import { emptyImport, NovelImportParseError } from './types.js'
import { splitText } from './text.js'

type PdfExtraction = { total: number; pages: Array<{ num: number; text?: string; failed?: boolean }> }

export async function parsePdf(buffer: Buffer, source: string, context: ParseContext) {
  if (!/^%PDF-\d\.\d/.test(buffer.subarray(0, 16).toString('ascii'))) throw new NovelImportParseError('FILE_TYPE_MISMATCH', '文件不是有效 PDF。', source)
  const extracted = await runConverter<PdfExtraction>('pdf-parse', `
    const parser = new library.PDFParse({ data: buffer, isEvalSupported: false,
      useWasm: false, useSystemFonts: false, disableFontFace: true,
      isImageDecoderSupported: false, maxImageSize: 1, canvasMaxAreaInBytes: 1,
      stopAtErrors: true });
    try {
      const info = await parser.getInfo();
      if (!Number.isInteger(info.total) || info.total < 1 || info.total > ${LIMITS.pdfPages})
        throw Object.assign(new Error('page limit'), {code: 'IMPORT_LIMIT_EXCEEDED'});
      const pages = [];
      let chars = 0;
      for (let num = 1; num <= info.total; num++) {
        try {
          const result = await parser.getText({partial: [num], pageJoiner: '', parseHyperlinks: false, disableNormalization: true});
          const page = result.pages.find(page => page.num === num);
          if (!page || typeof page.text !== 'string') throw new Error('missing page');
          chars += page.text.length;
          if (chars > ${LIMITS.sourceChars}) throw Object.assign(new Error('text limit'), {code: 'IMPORT_LIMIT_EXCEEDED'});
          pages.push({num, text: page.text});
        } catch (error) {
          if (error && error.code === 'IMPORT_LIMIT_EXCEEDED') throw error;
          pages.push({num, failed: true});
        }
      }
      return {total: info.total, pages};
    } finally { await parser.destroy(); }
  `, buffer, context)
  context.check()
  const result = emptyImport()
  let native = 0
  let review = 0
  let failed = 0
  // Each physical page has an outcome, including blank-looking/scanned and failed pages.
  // No OCR/image-coverage implementation: even a text page requires completeness review.
  for (let num = 1; num <= extracted.total; num++) {
    const page = extracted.pages.find((page) => page.num === num)
    const pageSource = `${source}#page=${num}`
    if (!page || page.failed || page.text === undefined) {
      failed++
      result.warnings.push({ code: 'IMPORT_PDF_PAGE_FAILED', message: `第 ${num} 页文字提取失败，未跳过为成功。`, source: pageSource, blocking: true })
      continue
    }
    const text = page.text.replace(/\r\n?/g, '\n')
    context.addChars(text.length)
    result.sourceChars += text.length
    if (!text.trim()) {
      review++
      result.warnings.push({ code: 'IMPORT_VISION_REQUIRED', message: `第 ${num} 页没有可确认的文字层，可能为空白或扫描页；尚未执行 OCR。`, source: pageSource, blocking: true })
    } else {
      native++
      const parsed = splitText(text, pageSource)
      for (const volume of parsed.volumes) {
        const last = result.volumes.at(-1)
        if (last && (volume.title === '正文卷' || last.title === volume.title)) last.chapters.push(...volume.chapters)
        else result.volumes.push(volume)
      }
      result.warnings.push({ code: 'IMPORT_PDF_COMPLETENESS_UNVERIFIED', message: `第 ${num} 页已提取文字；图片内正文、阅读顺序及复杂布局未经核验，请逐页确认。`, source: pageSource, blocking: true })
      if (text.includes('\ufffd')) result.warnings.push({ code: 'IMPORT_PDF_TEXT_INVALID', message: `第 ${num} 页含替换字符。`, source: pageSource, blocking: true })
    }
    checkStructure(result)
  }
  result.warnings.push({ code: 'IMPORT_PDF_COVERAGE', message: `共 ${extracted.total} 页；有原生文字 ${native} 页；无文字待核 ${review} 页；失败 ${failed} 页；OCR 0 页。所有页面仍需完整性核验。`, source, blocking: true })
  return result
}
