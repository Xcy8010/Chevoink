import { createHash } from 'node:crypto'
import { parentPort } from 'node:worker_threads'
import { adaptNativeNovelImportResult } from './native-parser.js'
import { ParseContext } from './parsers/limits.js'
import { NovelImportParseError } from './parsers/types.js'
import { checkImportImages, sanitizeImportImage, stableImportId } from './parsers/images.js'
import type { ImportDocumentItem } from './document-types.js'
import type { DocumentWorkerResult } from '../../../workers/document-import/protocol.js'

let sequence = 0
/** Private parser Worker RPC; the API supervisor, not a parser thread, owns Docker cleanup. */
export async function parseNativeThroughSupervisor(bytes: Buffer, filename: string, signal?: AbortSignal) {
  if (!parentPort) throw new NovelImportParseError('IMPORT_NATIVE_DISABLED', '原生解析必须由隔离管线调度。')
  const port = parentPort
  const sourceId = stableImportId('source', filename)
  const sourceHash = createHash('sha256').update(bytes).digest('hex')
  const format = /\.doc$/i.test(filename) ? 'doc' : /\.pdf$/i.test(filename) ? 'pdf' : 'image'
  const id = ++sequence
  const native = await new Promise<DocumentWorkerResult>((resolve, reject) => {
    const clean = () => { port.removeListener('message', reply); signal?.removeEventListener('abort', abort) }
    const abort = () => { clean(); reject(new NovelImportParseError('IMPORT_CANCELLED', '原生解析已取消。')) }
    const reply = (message: { type?: string; id?: number; value?: DocumentWorkerResult; error?: { code: string; message: string } }) => {
      if (message.type !== 'native-result' || message.id !== id) return
      clean()
      if (message.error) reject(new NovelImportParseError(message.error.code, message.error.message))
      else if (!message.value) reject(new NovelImportParseError('IMPORT_PROTOCOL_INVALID', '原生解析结果缺失。'))
      else resolve(message.value)
    }
    port.on('message', reply); signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    else port.postMessage({ type: 'native', id, sourceId, sourceHash, format, buffer: bytes })
  })
  const { parsed, native: verified } = await adaptNativeNovelImportResult(native, { sourceId, sourceHash, filename, format }, { signal, resources: true })
  const context = new ParseContext(signal)
  const fileId = stableImportId('file', filename)
  const source = `${filename}#source=${sourceId}&sha256=${sourceHash}`
  const items: ImportDocumentItem[] = [{ id: fileId, kind: 'file', source: filename,
    status: verified.coverage.complete ? 'native' : 'needs_review', excludable: true }]
  const images = parsed.images ?? []
  for (const artifact of verified.artifacts) {
    if (artifact.mediaType !== 'image/png') continue
    const imageSource = `${source}&artifact=${artifact.id}`
    const image = await sanitizeImportImage(Buffer.from(artifact.bytes), imageSource, context)
    images.push(image); checkImportImages(images)
  }
  for (const page of verified.pages) {
    const pageSource = `${source}&page=${page.page}`
    const pageId = stableImportId('page', pageSource)
    items.push({ id: pageId, kind: 'page', source: pageSource, parentId: fileId, status: page.state,
      excludable: page.state !== 'verified_blank', page: page.page })
    for (const block of page.blocks) items.push({ id: stableImportId('block', `${pageSource}&block=${block.id}`),
      kind: 'block', source: `${pageSource}&block=${block.id}`, parentId: pageId, status: block.method,
      text: block.text, bbox: block.bbox, confidence: block.confidence, excludable: true,
      ...(block.duplicateOf ? { duplicateOf: stableImportId('block', `${pageSource}&block=${block.duplicateOf}`) } : {}) })
    for (const region of page.regions) {
      const image = images.find(value => value.source === `${source}&artifact=${region.artifactId}`)
      items.push({ id: stableImportId('region', `${pageSource}&region=${region.id}`), kind: 'region', source: `${pageSource}&region=${region.id}`,
        parentId: pageId, status: region.status, excludable: true, bbox: region.bbox, ...(image ? { artifactId: image.id } : {}) })
    }
  }
  // This warning now has a real bounded in-memory artifact. Persistence is a separate service
  // invariant; pipeline results must never be committed unless every image was stored privately.
  parsed.warnings = parsed.warnings.filter(w => w.code !== 'IMPORT_NATIVE_ARTIFACT_UNSTORED' && !(format === 'image' && w.code === 'IMPORT_NO_BODY'))
  parsed.images = images
  parsed.evidence = { items: [...items, ...(parsed.evidence?.items ?? [])] }
  return parsed
}
