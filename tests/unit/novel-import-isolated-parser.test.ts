import { describe, expect, it, vi } from 'vitest'
import { Worker } from 'node:worker_threads'
import { createIsolatedNovelImportParser, parseNovelImportFileIsolated, ISOLATED_NOVEL_IMPORT_LIMITS } from '../../api/lib/novel-import/isolated-parser.js'
import { parseNovelImportFile } from '../../api/lib/novel-import/parser.js'
import * as converters from '../../api/lib/novel-import/parsers/isolated.js'
import { NovelImportParseError } from '../../api/lib/novel-import/parsers/types.js'
import { docx, paragraph, pdf, zipFiles } from './novel-import-parser.fixtures.js'

describe('whole-parser Worker boundary (no DB/native sandbox)', () => {
  it.each(['txt', 'md', 'zip', 'docx', 'pdf'])('runs the real %s path with the same pure result', async (extension) => {
    const body = '# 第一章\n\n原文\n\nFINAL_TAIL'
    const bytes = extension === 'zip' ? zipFiles({ 'book.md': body })
      : extension === 'docx' ? docx(paragraph('第一章', 'Heading1') + paragraph('原文\nFINAL_TAIL'))
        : extension === 'pdf' ? pdf(['FIRST', '', 'FINAL_TAIL']) : Buffer.from(body)
    const pure = await parseNovelImportFile(bytes, `book.${extension}`)
    const isolated = await parseNovelImportFileIsolated(bytes, `book.${extension}`)
    expect(isolated).toEqual(pure)
  }, 30_000)

  it('snapshots input without detaching or mutating the caller Buffer', async () => {
    const bytes = Buffer.from('  原文\n\nFINAL_TAIL')
    const original = Buffer.from(bytes)
    const promise = parseNovelImportFileIsolated(bytes, 'book.txt')
    bytes.fill(0)
    const result = await promise
    expect(result.volumes[0].chapters[0].content).toBe(original.toString())
    expect(bytes.length).toBe(original.length)
  }, 20_000)

  it('preserves stable typed errors across Worker messages', async () => {
    await expect(parseNovelImportFileIsolated(zipFiles({ '../evil.txt': 'x' }), 'bad.zip')).rejects.toMatchObject({ name: 'NovelImportParseError', code: 'IMPORT_ARCHIVE_UNSAFE' })
    await expect(parseNovelImportFileIsolated(Buffer.from('doc'), 'book.doc')).rejects.toMatchObject({ code: 'IMPORT_UNSUPPORTED_FORMAT' })
  }, 20_000)

  it('handles an already-aborted request without spawning a Worker', async () => {
    await expect(parseNovelImportFileIsolated(Buffer.from('x'), 'book.md', { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
  })

  it('keeps the API timer responsive during Markdown parsing and terminates on cancel', async () => {
    const controller = new AbortController()
    const body = '# 第一章\n' + '*[词](https://example.invalid)*\n'.repeat(100_000)
    const pending = parseNovelImportFileIsolated(Buffer.from(body), 'large.md', { signal: controller.signal })
    const start = performance.now()
    setTimeout(() => controller.abort(), 150)
    await expect(pending).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
    // A coarse responsiveness guard, not a performance benchmark or hard real-time guarantee.
    expect(performance.now() - start).toBeLessThan(5000)
  }, 15_000)

  it('uses a parent-owned hard deadline even if the Worker has not yielded', async () => {
    const parse = createIsolatedNovelImportParser({ timeoutMs: 50 })
    await expect(parse(Buffer.from('# 标题\n' + '[a](x) '.repeat(100_000)), 'large.md')).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
  }, 15_000)

  it('never raises heap/deadline defaults through trusted configuration', () => {
    expect(ISOLATED_NOVEL_IMPORT_LIMITS.heapMb).toBe(256)
    expect(ISOLATED_NOVEL_IMPORT_LIMITS.timeoutMs).toBe(120_000)
    for (const config of [{ heapMb: 257 }, { heapMb: 0 }, { timeoutMs: 120001 }, { timeoutMs: 0 }]) expect(() => createIsolatedNovelImportParser(config)).toThrow()
  })

  it('contains actual Markdown AST heap exhaustion without killing the caller', async () => {
    const parse = createIsolatedNovelImportParser({ heapMb: 32, timeoutMs: 15_000 })
    await expect(parse(Buffer.from('# title\n' + '[link](url) '.repeat(150_000)), 'large.md')).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' })
    expect((await parseNovelImportFileIsolated(Buffer.from('still alive'), 'book.txt')).volumes[0].chapters[0].content).toBe('still alive')
  }, 25_000)

  it('supervisor owns converter cancellation, even when it kills the requesting Worker', async () => {
    const controller = new AbortController()
    let received: AbortSignal | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const converter = vi.spyOn(converters, 'runConverter').mockImplementation((_module, _code, _buffer, context) => {
      received = context.signal
      markStarted!()
      return new Promise((_, reject) => context.signal!.addEventListener('abort', () => reject(new NovelImportParseError('IMPORT_CANCELLED', 'cancelled')), { once: true }))
    })
    try {
      const pending = parseNovelImportFileIsolated(pdf(['text']), 'cancel.pdf', { signal: controller.signal })
      const rejected = expect(pending).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
      await started
      controller.abort()
      await rejected
      expect(received?.aborted).toBe(true)
      expect(converter).toHaveBeenCalledTimes(1)
    } finally { converter.mockRestore() }
  }, 20_000)

  it('contains a synchronous converter context-deadline throw inside the parser rejection chain', async () => {
    const converter = vi.spyOn(converters, 'runConverter').mockImplementation((_module, _source, _buffer, context) => {
      // Reproduce deadline skew without waiting for the 120s supervisor timer. This is the
      // real synchronous check at the start of runConverter, before it returns a Promise.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(context.deadline + 1)
      try {
        context.check()
        return Promise.reject(new Error('Expected expired context'))
      } finally { clock.mockRestore() }
    })
    try {
      await expect(createIsolatedNovelImportParser({ timeoutMs: 10_000 })(pdf(['text']), 'late.pdf'))
        .rejects.toMatchObject({ name: 'NovelImportParseError', code: 'IMPORT_LIMIT_EXCEEDED' })
      expect(converter).toHaveBeenCalledTimes(1)
    } finally { converter.mockRestore() }
    // The failed job must leave the API process usable for the next upload.
    expect((await parseNovelImportFileIsolated(Buffer.from('still alive'), 'next.txt')).volumes[0].chapters[0].content).toBe('still alive')
  }, 25_000)

  it('redacts unexpected synchronous converter failures instead of escaping the message handler', async () => {
    const converter = vi.spyOn(converters, 'runConverter').mockImplementation(() => { throw new Error('private /host/path') })
    try {
      await expect(createIsolatedNovelImportParser({ timeoutMs: 10_000 })(pdf(['text']), 'bad.pdf'))
        .rejects.toMatchObject({ code: 'IMPORT_CONVERT_FAILED', message: '文档转换失败。' })
    } finally { converter.mockRestore() }
  }, 20_000)

  it('rejects a completed result when the caller aborts during deferred Worker cleanup', async () => {
    const controller = new AbortController()
    const originalTerminate = Worker.prototype.terminate
    let markCleanup: (() => void) | undefined
    const cleanupStarted = new Promise<void>((resolve) => { markCleanup = resolve })
    let releaseCleanup: (() => void) | undefined
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })
    const terminate = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
      const exiting = originalTerminate.call(this)
      markCleanup!()
      return exiting.then(async (code) => { await cleanupGate; return code })
    })
    try {
      const pending = parseNovelImportFileIsolated(Buffer.from('complete result'), 'book.txt', { signal: controller.signal })
      const rejected = expect(pending).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
      await cleanupStarted // Worker already delivered its valid result; cleanup is still pending.
      controller.abort()
      releaseCleanup!()
      await rejected
      expect(terminate).toHaveBeenCalledTimes(1)
    } finally {
      releaseCleanup!()
      terminate.mockRestore()
    }
  }, 20_000)
})
