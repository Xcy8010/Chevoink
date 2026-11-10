import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DataAccessError } from '../../api/lib/prisma.js'
import { getTtsVoicesPayload, synthesizeTtsBatchData } from '../../api/lib/tts-service.js'

const mocks = vi.hoisted(() => ({
  cacheDir: '',
  provider: 'edge',
  defaultVoice: '',
  localReady: true,
  localVoices: [
    { id: 'zh-CN-local-21', label: '本地女声', gender: 'female' },
    { id: 'zh-CN-local-33', label: '本地男声', gender: 'male' },
  ],
  localNamespace: 'sherpa-onnx-aishell3-vits-2024-04-06-v1',
  findUnique: vi.fn(),
  synthesizeLocalTts: vi.fn<(text: string, voiceId: string, output: string) => Promise<void>>(),
  ttsPromise: vi.fn<(text: string, output: string) => Promise<void>>(),
}))

vi.mock('node-edge-tts', () => ({
  EdgeTTS: class {
    ttsPromise = mocks.ttsPromise
  },
}))

vi.mock('../../api/config/env.js', () => ({
  env: {
    get ttsProvider() { return mocks.provider },
    get ttsDefaultVoice() { return mocks.defaultVoice },
    get ttsCacheDir() { return mocks.cacheDir },
    ttsCacheMaxMb: 10,
    ttsTimeoutMs: 1000,
  },
}))

vi.mock('../../api/lib/prisma.js', async (original) => ({
  ...await original<object>(),
  prisma: { chapter: { findUnique: mocks.findUnique } },
}))

vi.mock('../../api/lib/tts-local.js', () => ({
  LOCAL_TTS_CACHE_NAMESPACE: mocks.localNamespace,
  LOCAL_TTS_VOICES: mocks.localVoices,
  isLocalTtsReady: () => mocks.localReady,
  synthesizeLocalTts: mocks.synthesizeLocalTts,
}))

const { localVoices, localNamespace } = mocks
const input = {
  novelId: 'test-novel',
  chapterId: 'test-chapter',
  batchIndex: 0,
  voiceId: 'zh-CN-YunjianNeural',
  requestId: 'test-request',
}

const publishedChapter = {
  id: input.chapterId,
  novelId: input.novelId,
  status: 'published',
  visibility: 'public',
  publishedRevision: 2,
  publishedContent: '这是一段合成测试。',
  content: '尚未发布的稿件内容。',
  publishedAt: null,
  novel: { status: 'published', visibility: 'public' },
}

beforeEach(async () => {
  mocks.cacheDir = await mkdtemp(path.join(tmpdir(), 'chevoink-tts-'))
  mocks.provider = 'edge'
  mocks.defaultVoice = 'zh-CN-YunjianNeural'
  mocks.localReady = true
  mocks.ttsPromise.mockReset()
  mocks.synthesizeLocalTts.mockReset()
  mocks.findUnique.mockReset().mockResolvedValue(publishedChapter)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(mocks.cacheDir, { recursive: true, force: true })
})

describe('reader speech synthesis', () => {
  it.each(['403', '429'])('does not retry handshake %s or retain its partial output', async (status) => {
    mocks.ttsPromise.mockImplementationOnce(async (_text, output) => {
      await writeFile(output, 'partial')
      throw new Error(`Unexpected server response: ${status}`)
    })

    await expect(synthesizeTtsBatchData(input)).rejects.toMatchObject({ status: 503, code: 'TTS_UNAVAILABLE' })
    expect(mocks.ttsPromise).toHaveBeenCalledTimes(1)
    expect(await readdir(mocks.cacheDir)).toEqual([])
    expect(console.error).toHaveBeenCalledWith('[tts] synthesize failed', expect.objectContaining({
      requestId: input.requestId, reason: 'upstream_http', upstreamStatus: status, attempts: 1,
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

describe('local reader speech synthesis', () => {
  it('hides listening and rejects synthesis when the selected local model is missing', async () => {
    mocks.provider = 'local'
    mocks.localReady = false

    expect(getTtsVoicesPayload()).toEqual({
      available: false, defaultVoiceId: localVoices[0].id, voices: [],
    })
    await expect(synthesizeTtsBatchData(input)).rejects.toMatchObject({ status: 503, code: 'TTS_UNAVAILABLE' })
    expect(mocks.findUnique).not.toHaveBeenCalled()
    expect(mocks.ttsPromise).not.toHaveBeenCalled()
    expect(mocks.synthesizeLocalTts).not.toHaveBeenCalled()
  })

  it('shares local WAV cache between a stale Edge selection and the actual local default', async () => {
    mocks.ttsPromise.mockImplementationOnce(async (_text, output) => writeFile(output, 'legacy mp3'))
    const edgeFile = await synthesizeTtsBatchData(input)

    mocks.provider = 'local'
    mocks.defaultVoice = localVoices[1].id
    expect(getTtsVoicesPayload()).toEqual({
      available: true, defaultVoiceId: localVoices[1].id, voices: localVoices,
    })
    mocks.synthesizeLocalTts.mockImplementationOnce(async (_text, _voice, output) => writeFile(output, 'local wav'))

    const [localFile, sameFile] = await Promise.all([
      synthesizeTtsBatchData(input),
      synthesizeTtsBatchData({ ...input, voiceId: localVoices[1].id }),
    ])
    const identity = `${localNamespace}:${input.chapterId}:2:${localVoices[1].id}:0`
    expect(path.basename(localFile)).toBe(`${createHash('sha1').update(identity).digest('hex')}.wav`)
    expect(sameFile).toBe(localFile)
    expect(await readFile(localFile, 'utf8')).toBe('local wav')
    expect(await readFile(edgeFile, 'utf8')).toBe('legacy mp3')
    expect(mocks.synthesizeLocalTts).toHaveBeenCalledExactlyOnceWith(
      '这是一段合成测试。', localVoices[1].id, expect.stringMatching(/\.tmp$/),
    )
    expect(mocks.ttsPromise).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown voices and private chapters without starting either provider', async () => {
    mocks.provider = 'local'

    await expect(synthesizeTtsBatchData({ ...input, voiceId: 'unlisted-voice' })).rejects.toMatchObject({
      status: 400, code: 'VALIDATION_ERROR',
    })
    expect(mocks.findUnique).not.toHaveBeenCalled()
    mocks.findUnique.mockResolvedValueOnce({ ...publishedChapter, visibility: 'private' })
    await expect(synthesizeTtsBatchData(input)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(mocks.synthesizeLocalTts).not.toHaveBeenCalled()
    expect(mocks.ttsPromise).not.toHaveBeenCalled()
  })

  it.each([
    ['private novel', { novel: { status: 'published', visibility: 'private' } }],
    ['draft novel', { novel: { status: 'draft', visibility: 'public' } }],
    ['archived novel', { novel: { status: 'archived', visibility: 'public' } }],
    ['scheduled chapter', { publishedAt: new Date('2999-01-01T00:00:00Z') }],
  ])('does not serve cached audio or synthesize for a %s', async (_name, restriction) => {
    mocks.provider = 'local'
    mocks.synthesizeLocalTts.mockImplementationOnce(async (_text, _voice, output) => writeFile(output, 'local wav'))
    await synthesizeTtsBatchData(input)
    mocks.synthesizeLocalTts.mockClear()

    mocks.findUnique.mockResolvedValueOnce({ ...publishedChapter, ...restriction })
    await expect(synthesizeTtsBatchData(input)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(mocks.synthesizeLocalTts).not.toHaveBeenCalled()
    expect(mocks.ttsPromise).not.toHaveBeenCalled()
  })

  it('reads a retained published chapter of a completed novel from its published snapshot', async () => {
    mocks.provider = 'local'
    mocks.findUnique.mockResolvedValueOnce({
      ...publishedChapter,
      archivedAt: new Date(0),
      publishedAt: new Date(0),
      novel: { status: 'completed', visibility: 'public' },
    })
    mocks.synthesizeLocalTts.mockImplementationOnce(async (_text, _voice, output) => writeFile(output, 'local wav'))

    const file = await synthesizeTtsBatchData(input)
    expect(await readFile(file, 'utf8')).toBe('local wav')
    expect(mocks.synthesizeLocalTts).toHaveBeenCalledExactlyOnceWith(
      publishedChapter.publishedContent, localVoices[0].id, expect.stringMatching(/\.tmp$/),
    )
  })

  it('cleans up partial local output and preserves a typed busy response without retrying', async () => {
    mocks.provider = 'local'
    mocks.synthesizeLocalTts.mockImplementationOnce(async (_text, _voice, output) => {
      await writeFile(output, 'partial')
      throw new DataAccessError(503, 'TTS_BUSY', '当前听书人数较多，请稍后再试。')
    })

    await expect(synthesizeTtsBatchData(input)).rejects.toMatchObject({ status: 503, code: 'TTS_BUSY' })
    expect(mocks.synthesizeLocalTts).toHaveBeenCalledTimes(1)
    expect(mocks.ttsPromise).not.toHaveBeenCalled()
    expect(await readdir(mocks.cacheDir)).toEqual([])
  })
})
