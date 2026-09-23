/** Incremental SSE framing. Network chunks are not event boundaries. */
export class SseDataDecoder {
  private buffer = ''
  private data: string[] = []
  constructor(private readonly onData: (data: string) => void) {}

  push(chunk: string, eof = false): void {
    this.buffer += chunk
    if (this.buffer.length > 8 * 1024 * 1024) throw new Error('模型事件超出安全长度，未执行工具。')
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer)
      if (!match || (!eof && match[0] === '\r' && match.index === this.buffer.length - 1)) break
      const line = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      this.line(line)
    }
    if (eof) {
      if (this.buffer) this.line(this.buffer)
      this.buffer = ''
      this.line('')
    }
  }

  private line(line: string): void {
    if (!line) {
      if (this.data.length) {
        const data = this.data.join('\n')
        this.data = []
        this.onData(data)
      }
    } else if (line === 'data' || line.startsWith('data:')) {
      this.data.push(line.slice(5).replace(/^ /, ''))
    }
  }
}

/** Guard one stream read with an inactivity window: a silent gateway must fail
 * fast instead of holding the caller until the outer call deadline. */
export function readWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  idleMs: number,
  onTimeout: () => Error,
): Promise<ReadableStreamReadResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), idleMs)
    reader.read().then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}
