/**
 * 零依赖 ZIP 打包器（store 不压缩）：文本类内容压缩收益低，
 * 省去引入 jszip 等依赖；产物为标准 zip，任意解压工具可开。
 * 文件名按 UTF-8 写入并置通用位 11，中文目录/文件名不乱码。
 */

export type ZipEntry = {
  /** zip 内路径，用 / 分隔，如「作品名/章节/第0001章 开头.txt」 */
  path: string
  data: Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)

  for (let n = 0; n < 256; n += 1) {
    let c = n

    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }

    table[n] = c >>> 0
  }

  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff

  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

export function freezeZipTimestamp(date: Date): { time: number; date: number } {
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f)
  const dosDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f)

  return { time, date: dosDate }
}

const encoder = new TextEncoder()

/** 把若干文件条目打包成 zip Buffer（store 方式） */
export function buildZipBuffer(entries: ZipEntry[], stamp = freezeZipTimestamp(new Date())): Buffer {
  const { time, date } = stamp
  if (![time, date].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffff)
    || entries.length > 0xffff) throw new RangeError('ZIP_FORMAT_LIMIT')
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  let centralBytes = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path)
    const size = entry.data.length
    centralBytes += 46 + nameBytes.length
    if (nameBytes.length > 0xffff || size > 0xffffffff || offset + 30 + nameBytes.length + size + centralBytes + 22 > 0xffffffff) throw new RangeError('ZIP_FORMAT_LIMIT')
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // general purpose bit 11：UTF-8 文件名
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18) // compressed
    local.writeUInt32LE(size, 22) // uncompressed
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra len

    chunks.push(local, Buffer.from(nameBytes), Buffer.from(entry.data))

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0) // central directory signature
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(time, 12)
    centralHeader.writeUInt16LE(date, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(size, 20)
    centralHeader.writeUInt32LE(size, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra
    centralHeader.writeUInt16LE(0, 32) // comment
    centralHeader.writeUInt16LE(0, 34) // disk
    centralHeader.writeUInt16LE(0, 36) // internal attrs
    centralHeader.writeUInt32LE(0, 38) // external attrs
    centralHeader.writeUInt32LE(offset, 42) // local header offset

    central.push(Buffer.concat([centralHeader, Buffer.from(nameBytes)]))

    offset += local.length + nameBytes.length + size
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuffer, end])
}
