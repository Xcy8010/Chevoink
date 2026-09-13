import { createHash } from 'node:crypto'
import { IMPORT_RESOURCE_LIMITS, type ImportImage } from '../document-types.js'
import { limit, ParseContext } from './limits.js'
import { runConverter } from './isolated.js'
import { NovelImportParseError } from './types.js'

export const imageExtension = /\.(?:png|jpe?g|webp|tiff?)$/i
export const stableImportId = (kind: string, source: string) => `${kind}_${createHash('sha256').update(source).digest('hex').slice(0, 40)}`

/** Decode and re-encode in a supervised process. No SVG, external URLs, metadata, animation
 * or original active/polyglot bytes are exposed as images. Native protocol PNGs use this too. */
export async function sanitizeImportImage(bytes: Buffer, source: string, context: ParseContext): Promise<ImportImage> {
  limit(bytes.length > 0 && bytes.length <= 50 * 1024 * 1024, '图片超过安全大小。', source)
  const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  const tiff = ['49492a00', '4d4d002a'].includes(bytes.subarray(0, 4).toString('hex'))
  if (!png && !jpeg && !webp && !tiff) throw new NovelImportParseError('IMPORT_IMAGE_UNSUPPORTED', '图片格式不能安全解码；原文件保留，请另存 PNG/JPEG/WebP/单页 TIFF。', source)
  const converted = await runConverter<{ base64: string; width: number; height: number }>('sharp', `
    library.cache(false); library.concurrency(1);
    const image = library(buffer, {limitInputPixels:20000000, failOn:'warning', sequentialRead:true});
    const metadata = await image.metadata();
    if (!['png','jpeg','webp','tiff'].includes(metadata.format) || (metadata.pages || 1) !== 1 ||
      !metadata.width || !metadata.height || metadata.width*metadata.height > 20000000)
      throw Object.assign(new Error('image limit'), {code:'IMPORT_LIMIT_EXCEEDED'});
    const {data,info} = await image.rotate().png({compressionLevel:9}).toBuffer({resolveWithObject:true});
    if (data.length > 4194304) throw Object.assign(new Error('image limit'), {code:'IMPORT_LIMIT_EXCEEDED'});
    return {base64:data.toString('base64'),width:info.width,height:info.height};
  `, bytes, context)
  context.check()
  limit(typeof converted.base64 === 'string' && converted.base64.length <= Math.ceil(IMPORT_RESOURCE_LIMITS.imageBytes / 3) * 4,
    '图片转码输出超过限制。', source)
  const output = Buffer.from(converted.base64, 'base64')
  limit(output.length <= IMPORT_RESOURCE_LIMITS.imageBytes && output.length >= 24 &&
    converted.width > 0 && converted.height > 0 && converted.width * converted.height <= IMPORT_RESOURCE_LIMITS.pixels &&
    output.readUInt32BE(16) === converted.width && output.readUInt32BE(20) === converted.height, '图片转码输出无效。', source)
  return { id: stableImportId('image', source), source, bytes: output, byteLength: output.length,
    sha256: createHash('sha256').update(output).digest('hex'), mediaType: 'image/png',
    width: converted.width, height: converted.height, coverCandidate: true }
}

export function checkImportImages(images: ImportImage[]) {
  limit(images.length <= IMPORT_RESOURCE_LIMITS.images && images.reduce((sum, image) => sum + image.byteLength, 0) <= IMPORT_RESOURCE_LIMITS.bytes,
    '图片资源总量超过 128 张或 32 MiB，请拆分文件。')
}
