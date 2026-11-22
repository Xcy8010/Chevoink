import { createRequire } from 'node:module'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { inspectDocumentVisuals, readDocumentVisual } from '../../api/lib/attachment-document-visuals.js'

const require = createRequire(import.meta.url)
const JSZip = createRequire(require.resolve('mammoth'))('jszip') as typeof import('jszip')
const signal = new AbortController().signal

function twoPagePdf() {
  const pages = ['0 0 1 rg 0 0 100 20000 re f', 'q 40 0 0 40 0 0 cm BI /W 1 /H 1 /BPC 8 /CS /RGB /F /AHx ID FF0000> EI Q']
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>']
  for (const [i, body] of pages.entries()) {
    const box = i === 0 ? '100 20000' : '40 40'
    objects.push(`<< /Type /Page /Parent 2 0 R /Resources << >> /MediaBox [0 0 ${box}] /Contents ${4 + 2 * i} 0 R >>`,
      `<< /Length ${body.length} >>\nstream\n${body}\nendstream`)
  }
  let file = '%PDF-1.4\n'
  const offsets = []
  for (const [i, object] of objects.entries()) {
    offsets.push(file.length)
    file += `${i + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = file.length
  file += `xref\n0 7\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}`
  return Buffer.from(file + `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}

const rels = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
async function wordWithPictures(photo?: Buffer) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="${rels}/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${rels}"><w:body><w:p><w:r><w:drawing><a:blip r:embed="blue"/><a:blip r:embed="blue"/><a:blip r:link="web"/></w:drawing></w:r></w:p><w:sectPr><w:headerReference r:id="head"/></w:sectPr></w:body></w:document>`)
  zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="blue" Type="${rels}/image" Target="media/blue.png"/><Relationship Id="web" Type="${rels}/image" TargetMode="External" Target="https://example.invalid/picture"/><Relationship Id="head" Type="${rels}/header" Target="header1.xml"/></Relationships>`)
  zip.file('word/header1.xml', `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${rels}" xmlns:v="urn:schemas-microsoft-com:vml"><w:p><w:r><w:pict><v:imagedata r:id="red"/></w:pict></w:r></w:p></w:hdr>`)
  zip.file('word/_rels/header1.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="red" Type="${rels}/image" Target="media/red.png"/></Relationships>`)
  for (const name of ['red', 'blue', 'green']) {
    zip.file('word/media/' + name + '.png', await sharp({create: {width: 8, height: 8, channels: 3, background: name}}).png().toBuffer())
  }
  if (photo) {
    // Replace the fixture relationship so its actual media member is a photographic JPEG.
    zip.file('word/_rels/document.xml.rels', `<Relationships><Relationship Id="blue" Type="${rels}/image" Target="media/photo.jpg"/></Relationships>`)
    zip.file('word/media/photo.jpg', photo)
  }
  return zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'})
}

async function centerRgb(bytes: Buffer) {
  const {data, info} = await sharp(bytes).removeAlpha().raw().toBuffer({resolveWithObject: true})
  const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels
  return [...data.subarray(i, i + 3)]
}

describe('attachment document pixels', () => {
  it('renders actual vectors and scanned pixels from the requested PDF page within both axis limits', async () => {
    const pdf = twoPagePdf()
    expect(await inspectDocumentVisuals(pdf, 'pdf', signal)).toEqual({count: 2, unit: 'page'})
    const vector = await readDocumentVisual(pdf, 'pdf', 1, signal)
    expect(await sharp(vector.buffer).metadata()).toMatchObject({width: 10, height: 2000})
    expect(await centerRgb(vector.buffer)).toEqual([0, 0, 255])
    const scan = await readDocumentVisual(pdf, 'pdf', 2, signal)
    expect(await centerRgb(scan.buffer)).toEqual([255, 0, 0])
  }, 30_000)

  it('indexes only referenced Word rasters, in document order, including header resources', async () => {
    const docx = await wordWithPictures()
    expect(await inspectDocumentVisuals(docx, 'docx', signal)).toMatchObject({count: 2, unit: 'image', notice: expect.stringContaining('链接图片')})
    expect(await centerRgb((await readDocumentVisual(docx, 'docx', 1, signal)).buffer)).toEqual([0, 0, 255])
    expect(await centerRgb((await readDocumentVisual(docx, 'docx', 2, signal)).buffer)).toEqual([255, 0, 0])
    await expect(readDocumentVisual(docx, 'docx', 3, signal)).rejects.toThrow('不存在')
  }, 20_000)

  it('rejects cancelled conversions, invalid document bytes and missing PDF pages', async () => {
    await expect(inspectDocumentVisuals(twoPagePdf(), 'pdf', AbortSignal.abort())).rejects.toThrow('取消')
    await expect(inspectDocumentVisuals(Buffer.from('ordinary text'), 'docx', signal)).rejects.toThrow()
    await expect(readDocumentVisual(twoPagePdf(), 'pdf', 3, signal)).rejects.toThrow('不存在')
  })

  it('keeps a detailed camera image readable even when its lossless preview exceeds the pixel transport limit', async () => {
    const size = 2100
    const pixels = Buffer.alloc(size * size * 3)
    let state = 73013
    for (let i = 0; i < pixels.length; i++) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0
      pixels[i] = state >>> 24
    }
    const photo = await sharp(pixels, {raw:{width:size, height:size, channels:3}}).jpeg({quality:78}).toBuffer()
    const image = await readDocumentVisual(await wordWithPictures(photo), 'docx', 1, signal)
    expect(image.mime).toBe('image/jpeg')
    expect(image.buffer.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(await sharp(image.buffer).metadata()).toMatchObject({width:2000, height:2000})
  }, 20_000)
})
