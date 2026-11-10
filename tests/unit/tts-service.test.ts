import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { synthesizeTtsBatchData } from '../../api/lib/tts-service.js'

const mocks = vi.hoisted(() => ({
  cacheDir: '',
  findUnique: vi.fn(),
  ttsPromise: vi.fn<(text: string, output: string) => Promise<void>>(),
}))

vi.mock('node-edge-tts', () => ({
  EdgeTTS: class {
    ttsPromise = mocks.ttsPromise
  },
}))

vi.mock('../../api/config/env.js', () => ({
  env: {
    ttsProvider: 'edge',
    get ttsCacheDir() { return mocks.cacheDir },
    ttsCacheMaxMb: 10,
    ttsTimeoutMs: 1000,
  },
}))

vi.mock('../../api/lib/prisma.js', async (original) => ({
  ...await original<object>(),
  prisma: { chapter: { findUnique: mocks.findUnique } },
}))

const input = {
  novelId: 'test-novel',
  chapterId: 'test-chapter',
  batchIndex: 0,
  voiceId: 'zh-CN-YunjianNeural',
  requestId: 'test-request',
}

beforeEach(async () => {
  mocks.cacheDir = await mkdtemp(path.join(tmpdir(), 'chevoink-tts-'))
  mocks.ttsPromise.mockReset()
  mocks.findUnique.mockResolvedValue({
    id: input.chapterId,
    novelId: input.novelId,
    status: 'published',
    visibility: 'public',
    publishedRevision: 2,
    publishedContent: '这是一段合成测试。',
  })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(mocks.cacheDir, { recursive: true, force: true })
})

describe('reader speech synthesis', () => {
  it('does not retry a refused handshake or retain its partial output', async () => {
    mocks.ttsPromise.mockImplementationOnce(async (_text, output) => {
      await writeFile(output, 'partial')
      throw new Error('Unexpected server response: 403')
    })

    await expect(synthesizeTtsBatchData(input)).rejects.toMatchObject({ status: 503, code: 'TTS_UNAVAILABLE' })
    expect(mocks.ttsPromise).toHaveBeenCalledTimes(1)
    expect(await readdir(mocks.cacheDir)).toEqual([])
    expect(console.error).toHaveBeenCalledWith('[tts] synthesize failed', expect.objectContaining({
      requestId: input.requestId, reason: 'upstream_http', upstreamStatus: '403', attempts: 1,
    }))
  })

  it('retries a timeout once and logs the terminal reason separately', async () => {
    mocks.ttsPromise.mockRejectedValue(new Error('Timed out while connecting to Edge TTS'))

    await expect(synthesizeTtsBatchData(input)).rejects.toMatchObject({ status: 503, code: 'TTS_UNAVAILABLE' })
    expect(mocks.ttsPromise).toHaveBeenCalledTimes(2)
    expect(console.error).toHaveBeenCalledWith('[tts] synthesize failed', expect.objectContaining({
      requestId: input.requestId, reason: 'timeout', attempts: 2,
    }))
  })

  it('shares a cache miss and publishes audio only once the batch has completed', async () => {
    const written = Promise.withResolvers<void>()
    const complete = Promise.withResolvers<void>()
    mocks.ttsPromise.mockImplementationOnce(async (_text, output) => {
      await writeFile(output, 'partial')
      written.resolve()
      await complete.promise
      await appendFile(output, ' audio')
    })

    const first = synthesizeTtsBatchData(input)
    await written.promise
    const second = synthesizeTtsBatchData(input)
    const pendingFiles = await readdir(mocks.cacheDir)
    complete.resolve()

    const [firstFile, secondFile] = await Promise.all([first, second])
    expect(pendingFiles.some(file => file.endsWith('.mp3'))).toBe(false)
    expect(secondFile).toBe(firstFile)
    expect(await readFile(firstFile, 'utf8')).toBe('partial audio')
    expect(await synthesizeTtsBatchData(input)).toBe(firstFile)
    expect(mocks.ttsPromise).toHaveBeenCalledTimes(1)
  })
})
