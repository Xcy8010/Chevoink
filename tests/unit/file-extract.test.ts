import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { extractFileText, FILE_EXTRACT_MAX_CHARS } from '../../api/lib/file-extract.js'

const require = createRequire(import.meta.url)
const mammothRequire = createRequire(require.resolve('mammoth'))
const JSZip = mammothRequire('jszip') as typeof import('jszip')

/** Self-authored one-page PDF with correct offsets; no network or external fixture. */
function samplePdf(text = 'BT /F1 12 Tf 50 100 Td (Chevoink runtime extraction) Tj ET') {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

describe('real document extraction dependency compatibility', () => {
  it('extracts a real PDF text layer with the installed parser', async () => {
    const result = await extractFileText(samplePdf(), 'sample.pdf')
    expect(result.text).toBe('Chevoink runtime extraction')
    expect(result.truncated).toBe(false)
  }, 15_000) // Cold-loads PDF.js and its native support; keep the suite default unchanged.

  it('distinguishes image-only PDF pages from extracted text', async () => {
    const image = 'q 80 0 0 80 10 10 cm BI /W 1 /H 1 /BPC 8 /CS /G /F /AHx ID 00> EI Q'
    const result = await extractFileText(samplePdf(image), 'scan.pdf')
    expect(result.text).toBe('')
    expect(result.pdfPages).toEqual({ total: 1, withoutText: [1] })
    const mixed = await extractFileText(samplePdf(image + '\nBT /F1 12 Tf 40 100 Td (Caption) Tj ET'), 'mixed.pdf')
    expect(mixed.text).toBe('Caption')
    expect(mixed.pdfPages).toEqual({ total: 1, withoutText: [] })
  })

  it('extracts Chinese DOCX text and escaped characters through mammoth', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    const document = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>布衣山河 &amp; 安全提取</w:t></w:r></w:p></w:body></w:document>'
    zip.file('word/document.xml', document)
    const result = await extractFileText(await zip.generateAsync({ type: 'nodebuffer' }), 'sample.docx')
    expect(result.text).toBe('布衣山河 & 安全提取')
    zip.file('word/document.xml', document.replace('布衣山河', '布衣�河'))
    const damaged = await extractFileText(await zip.generateAsync({ type: 'nodebuffer' }), 'damaged.docx')
    expect(damaged.text).toBe('布衣�河 & 安全提取')
    expect(damaged.notice).toContain('替换字符')
  }, 15_000) // Includes isolated-worker startup and cold-loading mammoth, like the PDF case above.

  it.each(['pdf', 'docx'])('returns a safe error for corrupt %s', async (extension) => {
    await expect(extractFileText(Buffer.from('invalid document'), `bad.${extension}`)).rejects.toMatchObject({ code: 'FILE_EXTRACT_ERROR' })
  })

  it('retains text pagination and line normalization', async () => {
    const body = `first\r\n${'章'.repeat(FILE_EXTRACT_MAX_CHARS + 2)}`
    const first = await extractFileText(Buffer.from(body), 'chapter.txt')
    const tail = await extractFileText(Buffer.from(body), 'chapter.txt', FILE_EXTRACT_MAX_CHARS)
    expect(first.text.length).toBe(FILE_EXTRACT_MAX_CHARS)
    expect(first.truncated).toBe(true)
    expect(tail.text).toBe('章'.repeat(8))
    expect(tail.truncated).toBe(false)
  })
})
