import { createInflateRaw } from 'node:zlib'
import iconv from 'iconv-lite'
import { hasUnsafeControls, limit, NOVEL_IMPORT_LIMITS as LIMITS, ParseContext } from './limits.js'
import { NovelImportParseError } from './types.js'

export type ArchiveEntry = {
  path: string; directory: boolean; compressedSize: number; size: number
  method: number; crc: number; dataOffset: number
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function unsafe(condition: boolean, message: string, source?: string): asserts condition {
  if (!condition) throw new NovelImportParseError('IMPORT_ARCHIVE_UNSAFE', message, source)
}

function extras(buffer: Buffer, start: number, length: number, rawName: Buffer): string | undefined {
  const end = start + length
  let unicode: string | undefined
  for (let cursor = start; cursor < end;) {
    unsafe(cursor + 4 <= end, 'ZIP 扩展字段损坏。')
    const id = buffer.readUInt16LE(cursor)
    const size = buffer.readUInt16LE(cursor + 2)
    cursor += 4
    unsafe(cursor + size <= end, 'ZIP 扩展字段越界。')
    unsafe(![0x0001, 0x000d, 0x756e, 0x9901].includes(id), '不支持 ZIP64、加密或可能含链接的 ZIP 扩展字段。')
    if (id === 0x7075) {
      unsafe(unicode === undefined && size >= 5 && buffer[cursor] === 1 && buffer.readUInt32LE(cursor + 1) === crc32(rawName), 'ZIP Unicode 文件名校验失败。')
      try { unicode = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(cursor + 5, cursor + size)) }
      catch { unsafe(false, 'ZIP Unicode 文件名无效。') }
    }
    cursor += size
  }
  return unicode
}

function safePath(name: string) {
  unsafe(name.length > 0 && name.length <= 1024 && !/[\\:]/.test(name) && !hasUnsafeControls(name) && !name.startsWith('/'), 'ZIP 含绝对路径、盘符、控制字符或反斜线路径。', name)
  const path = name.endsWith('/') ? name.slice(0, -1) : name
  const parts = path.split('/')
  unsafe(parts.length <= 32 && parts.every((part) => part !== '' && part !== '.' && part !== '..' && !/[ .]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'ZIP 含路径穿越、保留名称或异常层级。', name)
  // Also validate compatibility-normalized characters (e.g. fullwidth separators/dots).
  const normalized = path.normalize('NFKC')
  unsafe(!/[\\:]/.test(normalized) && !hasUnsafeControls(normalized) && normalized.split('/').length === parts.length && normalized.split('/').every((part) => part !== '.' && part !== '..' && part !== '' && !/[ .]$/.test(part)), 'ZIP 含歧义 Unicode 路径。', name)
  return normalized.toLowerCase()
}

/** Validates the entire central/local directory before any decompression. Never writes files. */
export function scanArchive(buffer: Buffer, context: ParseContext): ArchiveEntry[] {
  context.check()
  limit(buffer.length <= LIMITS.fileBytes, 'ZIP 文件超过 50 MiB。')
  unsafe(buffer.length >= 22, 'ZIP 文件不完整。')
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { eocd = i; break }
  }
  unsafe(eocd >= 0, 'ZIP 目录缺失或文件尾损坏。')
  const count = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  unsafe(buffer.readUInt16LE(eocd + 4) === 0 && buffer.readUInt16LE(eocd + 6) === 0 && count === buffer.readUInt16LE(eocd + 8), '不支持分卷 ZIP。')
  unsafe(count !== 0xffff && cdOffset !== 0xffffffff && cdSize !== 0xffffffff, '不支持 ZIP64。')
  context.entries += count
  limit(context.entries <= LIMITS.entries, 'ZIP 成员数超过 3000。')
  unsafe(cdOffset + cdSize === eocd, 'ZIP 目录偏移无效或含未声明内容。')
  const entries: ArchiveEntry[] = []
  const names = new Map<string, boolean>()
  const ranges: Array<[number, number]> = []
  let declaredBytes = 0
  let cursor = cdOffset
  for (let i = 0; i < count; i++) {
    unsafe(cursor + 46 <= eocd && buffer.readUInt32LE(cursor) === 0x02014b50, 'ZIP 中央目录损坏。')
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameSize = buffer.readUInt16LE(cursor + 28)
    const extraSize = buffer.readUInt16LE(cursor + 30)
    const commentSize = buffer.readUInt16LE(cursor + 32)
    const attrs = buffer.readUInt32LE(cursor + 38)
    const local = buffer.readUInt32LE(cursor + 42)
    unsafe(cursor + 46 + nameSize + extraSize + commentSize <= eocd, 'ZIP 成员元数据越界。')
    unsafe((flags & ~0x080e) === 0 && (method === 0 || method === 8), 'ZIP 含加密成员或不支持的压缩方法。')
    unsafe(buffer.readUInt16LE(cursor + 34) === 0 && local !== 0xffffffff && size !== 0xffffffff && compressedSize !== 0xffffffff, '不支持分卷或 ZIP64 成员。')
    const unixType = (attrs >>> 16) & 0xf000
    unsafe([0, 0x4000, 0x8000].includes(unixType) && (attrs & 0x400) === 0, 'ZIP 含链接、设备或重解析成员。')
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameSize)
    let name: string
    try { name = flags & 0x800 ? new TextDecoder('utf-8', { fatal: true }).decode(rawName) : iconv.decode(rawName, 'cp437') }
    catch { throw new NovelImportParseError('IMPORT_ARCHIVE_UNSAFE', 'ZIP 文件名编码无效。') }
    const unicode = extras(buffer, cursor + 46 + nameSize, extraSize, rawName)
    if (unicode !== undefined) {
      unsafe(!(flags & 0x800) || unicode === name, 'ZIP 文件名字段不一致。')
      name = unicode
    }
    const key = safePath(name)
    unsafe(!names.has(key), 'ZIP 含重名或大小写/Unicode 冲突路径。', name)
    const directory = name.endsWith('/')
    unsafe(unixType !== 0x4000 || directory, 'ZIP 目录类型与文件名不一致。', name)
    unsafe(!(attrs & 0x10) || directory, 'ZIP 目录属性不一致。', name)
    names.set(key, directory)
    limit(size <= LIMITS.entryBytes, 'ZIP 单成员超过 50 MiB。', name)
    limit(size <= Math.max(1, compressedSize) * LIMITS.compressionRatio, 'ZIP 压缩比超过 200:1。', name)
    declaredBytes += size
    limit(declaredBytes + context.decompressedBytes <= LIMITS.decompressedBytes, 'ZIP 解压总量超过 200 MiB。')
    unsafe(!directory || size === 0, 'ZIP 目录含隐藏数据。', name)
    unsafe(method !== 0 || compressedSize === size, 'ZIP store 成员大小不一致。', name)
    unsafe(local + 30 <= cdOffset && buffer.readUInt32LE(local) === 0x04034b50, 'ZIP 本地头损坏。', name)
    const localNameSize = buffer.readUInt16LE(local + 26)
    const localExtraSize = buffer.readUInt16LE(local + 28)
    const dataOffset = local + 30 + localNameSize + localExtraSize
    unsafe(dataOffset + compressedSize <= cdOffset && buffer.readUInt16LE(local + 6) === flags && buffer.readUInt16LE(local + 8) === method && rawName.equals(buffer.subarray(local + 30, local + 30 + localNameSize)), 'ZIP 本地头与中央目录不一致。', name)
    const localUnicode = extras(buffer, local + 30 + localNameSize, localExtraSize, rawName)
    unsafe(localUnicode === undefined || localUnicode === name, 'ZIP 本地 Unicode 文件名不一致。', name)
    const descriptor = Boolean(flags & 8)
    for (const [position, expected] of [[14, crc], [18, compressedSize], [22, size]]) {
      const actual = buffer.readUInt32LE(local + position)
      unsafe(actual === expected || (descriptor && actual === 0), 'ZIP 本地成员大小或 CRC 声明不一致。', name)
    }
    let end = dataOffset + compressedSize
    if (descriptor) {
      unsafe(end + 12 <= cdOffset, 'ZIP 数据描述符缺失。', name)
      if (buffer.readUInt32LE(end) === 0x08074b50) end += 4
      unsafe(end + 12 <= cdOffset && buffer.readUInt32LE(end) === crc && buffer.readUInt32LE(end + 4) === compressedSize && buffer.readUInt32LE(end + 8) === size, 'ZIP 数据描述符不一致。', name)
      end += 12
    }
    ranges.push([local, end])
    entries.push({ path: name, directory, compressedSize, size, method, crc, dataOffset })
    cursor += 46 + nameSize + extraSize + commentSize
  }
  unsafe(cursor === eocd, 'ZIP 中央目录长度不一致。')
  ranges.sort((a, b) => a[0] - b[0])
  let end = 0
  for (const range of ranges) { unsafe(range[0] === end, 'ZIP 成员重叠或含未声明数据。'); end = range[1] }
  unsafe(end === cdOffset, 'ZIP 含未声明成员数据。')
  for (const key of names.keys()) {
    const parts = key.split('/')
    for (let i = 1; i < parts.length; i++) unsafe(names.get(parts.slice(0, i).join('/')) !== false, 'ZIP 文件与目录路径冲突。')
  }
  return entries
}

export async function readArchiveEntry(buffer: Buffer, entry: ArchiveEntry, context: ParseContext): Promise<Buffer> {
  await context.checkpoint()
  const compressed = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize)
  let data: Buffer
  if (entry.method === 0) data = compressed
  else {
    data = await new Promise<Buffer>((resolve, reject) => {
      // Stream and count actual output before retaining it. A lying central directory cannot
      // bypass the cap, and cancellation can destroy the inflater between output chunks.
      const inflater = createInflateRaw({ chunkSize: 16 * 1024 })
      const chunks: Buffer[] = []
      let size = 0
      const maximum = Math.min(entry.size, LIMITS.entryBytes, LIMITS.decompressedBytes - context.decompressedBytes)
      const cancel = () => inflater.destroy(new NovelImportParseError('IMPORT_CANCELLED', '文档解析已取消。'))
      const timer = setTimeout(() => inflater.destroy(new NovelImportParseError('IMPORT_LIMIT_EXCEEDED', 'ZIP 解压超时。')), Math.max(1, context.deadline - Date.now()))
      context.signal?.addEventListener('abort', cancel, { once: true })
      inflater.once('close', () => { clearTimeout(timer); context.signal?.removeEventListener('abort', cancel) })
      inflater.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maximum) inflater.destroy(new NovelImportParseError('IMPORT_LIMIT_EXCEEDED', 'ZIP 成员实际解压大小超过声明或限额。', entry.path))
        else chunks.push(chunk)
      })
      inflater.once('error', (error) => reject(error instanceof NovelImportParseError ? error : new NovelImportParseError('IMPORT_ARCHIVE_CORRUPT', 'ZIP 成员解压失败。', entry.path)))
      inflater.once('end', () => {
        if (inflater.bytesWritten !== compressed.length) reject(new NovelImportParseError('IMPORT_ARCHIVE_UNSAFE', 'ZIP 压缩流含未消费的隐藏数据。', entry.path))
        else resolve(Buffer.concat(chunks, size))
      })
      if (context.signal?.aborted) cancel()
      else inflater.end(compressed)
    })
  }
  context.check()
  context.decompressedBytes += data.length
  limit(context.decompressedBytes <= LIMITS.decompressedBytes, 'ZIP 实际解压总量超过 200 MiB。')
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new NovelImportParseError('IMPORT_ARCHIVE_CORRUPT', 'ZIP 成员大小或 CRC 校验失败。', entry.path)
  return data
}

/** Locale-independent numeric ordering; explicit tie-breaker keeps same-number names distinct. */
export function naturalCompare(a: string, b: string): number {
  const left = a.normalize('NFC').match(/\d+|\D+/g) ?? []
  const right = b.normalize('NFC').match(/\d+|\D+/g) ?? []
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue
    if (/^\d+$/.test(left[i]) && /^\d+$/.test(right[i])) {
      const l = left[i].replace(/^0+/, '') || '0'
      const r = right[i].replace(/^0+/, '') || '0'
      if (l.length !== r.length) return l.length - r.length
      if (l !== r) return l < r ? -1 : 1
    } else return left[i] < right[i] ? -1 : 1
  }
  return left.length - right.length || (a < b ? -1 : a > b ? 1 : 0)
}
