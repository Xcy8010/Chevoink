import { createRequire } from 'node:module'
import { buildZipBuffer } from '../../api/lib/zip-writer.js'

const require = createRequire(import.meta.url)
const mammothRequire = createRequire(require.resolve('mammoth'))
export const JSZip = mammothRequire('jszip') as typeof import('jszip')

export function zipFiles(files: Record<string, string | Buffer>) {
  return buildZipBuffer(Object.entries(files).map(([path, data]) => ({ path, data: typeof data === 'string' ? Buffer.from(data) : data })))
}

export function centralOffset(zip: Buffer) {
  return zip.readUInt32LE(zip.length - 6)
}

export function docx(body: string, extra: Record<string, string | Buffer> = {}) {
  return zipFiles({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    'word/styles.xml': '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>',
    ...extra,
  })
}

export function paragraph(text: string, style?: string) {
  return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`
}

/** Self-authored physical pages with correct xref offsets. Empty strings are blank pages. */
export function pdf(pages: string[], options: { imagePages?: number[]; corruptPages?: number[] } = {}) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (const [index, text] of pages.entries()) {
    const image = options.imagePages?.includes(index + 1)
    const stream = (text ? `BT /F1 12 Tf 50 100 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET` : '') + (image ? '\nq 300 0 0 200 0 0 cm /Im0 Do Q' : '')
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> ${image ? `/XObject << /Im0 ${4 + 2 * pages.length} 0 R >>` : ''} >> /Contents ${5 + 2 * index} 0 R >>`)
    objects.push(`<< /Length ${Buffer.byteLength(stream)} ${options.corruptPages?.includes(index + 1) ? '/Filter /FlateDecode' : ''} >>\nstream\n${stream}\nendstream`)
  }
  if (options.imagePages?.length) objects.push('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nffffff>\nendstream')
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(output)
}
