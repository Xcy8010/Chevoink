import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, stat, unlink, utimes } from 'node:fs/promises'
import path from 'node:path'

import { EdgeTTS } from 'node-edge-tts'

import type { TtsVoice, TtsVoicesPayload } from '../../shared/contracts/index.js'
import { splitTtsBatches, splitTtsParagraphs } from '../../shared/contracts/index.js'
import { env } from '../config/env.js'
import { DataAccessError, prisma } from './prisma.js'
import { isLocalTtsReady, LOCAL_TTS_CACHE_NAMESPACE, LOCAL_TTS_VOICES, synthesizeLocalTts } from './tts-local.js'

/**
 * 听书 TTS 服务（方案 17）：
 * - 音色白名单（服务端配置，不透传微软全量音色）
 * - 章节正文按 shared 切批函数取出批次文本，离线合成 WAV 或 Edge 合成 MP3
 * - 缓存按发布修订、音色和批次区分，离线音频另按模型版本区分
 * - LRU：目录总大小超上限时按 mtime 淘汰最旧文件
 */

/** 精选中文神经音色白名单（v1 定案，见方案 3.2） */
const EDGE_TTS_VOICES: TtsVoice[] = [
  { id: 'zh-CN-YunjianNeural', label: '云健 · 沉稳男声', gender: 'male', recommended: true },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼少女', gender: 'female' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 清朗青年', gender: 'male', recommended: true },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔女声', gender: 'female' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 新闻男声', gender: 'male' },
  { id: 'zh-CN-XiaochenNeural', label: '晓辰 · 知性女声', gender: 'female' },
]

const TTS_OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3'

function getTtsCacheDirectory(): string {
  if (env.ttsCacheDir) {
    return path.resolve(env.ttsCacheDir)
  }

  // 与 uploads 同款目录策略：生产落 release 外的 shared 目录，重新部署不丢缓存
  return env.appEnv === 'production'
    ? path.resolve(process.cwd(), '..', '..', 'shared', 'tts-cache')
    : path.resolve(process.cwd(), '.local-storage', 'tts-cache')
}

export function getTtsVoicesPayload(): TtsVoicesPayload {
  const local = env.ttsProvider === 'local'
  const voices = local ? LOCAL_TTS_VOICES : EDGE_TTS_VOICES
  const available = env.ttsProvider !== 'disabled' && (!local || isLocalTtsReady())
  const defaultVoiceId = voices.find((voice) => voice.id === env.ttsDefaultVoice)?.id ?? voices[0].id

  return { available, defaultVoiceId, voices: available ? voices : [] }
}

type SynthesizeTtsInput = {
  novelId: string
  chapterId: string
  batchIndex: number
  voiceId: string
  requestId: string
}

/** 相同缓存键的并发请求合并为一次合成 */
const inflightSyntheses = new Map<string, Promise<string>>()

export async function synthesizeTtsBatchData(input: SynthesizeTtsInput): Promise<string> {
  const local = env.ttsProvider === 'local'
  const { available, defaultVoiceId, voices } = getTtsVoicesPayload()
  if (!available) {
    throw new DataAccessError(503, 'TTS_UNAVAILABLE', '听书服务暂未开放。')
  }

  // Old readers can still send a previously selected Edge voice after the switch.
  const voiceId = voices.find((voice) => voice.id === input.voiceId)?.id
    ?? (local && EDGE_TTS_VOICES.some((voice) => voice.id === input.voiceId) ? defaultVoiceId : null)
  if (!voiceId) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '不支持的音色。')
  }

  const chapter = await prisma.chapter.findUnique({
    where: { id: input.chapterId },
    include: { novel: { select: { visibility: true, status: true } } },
  })

  // 和匿名阅读页一致，导入归档不撤回保留的已发布版本。
  const now = new Date()
  if (
    !chapter ||
    chapter.novelId !== input.novelId ||
    chapter.status !== 'published' ||
    chapter.visibility !== 'public' ||
    (chapter.publishedAt !== null && chapter.publishedAt > now) ||
    chapter.novel.visibility !== 'public' ||
    (chapter.novel.status !== 'published' && chapter.novel.status !== 'completed')
  ) {
    throw new DataAccessError(404, 'NOT_FOUND', '未找到可收听的章节。')
  }

  const publishedContent = chapter.publishedRevision == null ? chapter.content : chapter.publishedContent ?? ''
  const paragraphs = splitTtsParagraphs(publishedContent)
  const batches = splitTtsBatches(paragraphs)
  const batch = batches[input.batchIndex]

  if (!batch) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '批次超出章节范围。')
  }

  const cacheIdentity = `${chapter.id}:${chapter.publishedRevision ?? chapter.revision}:${voiceId}:${batch.index}`
  const cacheKey = createHash('sha1')
    .update(local ? `${LOCAL_TTS_CACHE_NAMESPACE}:${cacheIdentity}` : cacheIdentity)
    .digest('hex')
  const cacheDirectory = getTtsCacheDirectory()
  const filePath = path.join(cacheDirectory, `${cacheKey}.${local ? 'wav' : 'mp3'}`)

  // 缓存命中：touch mtime 供 LRU 参考，直接返回
  try {
    const fileStat = await stat(filePath)
    if (fileStat.size > 0) {
      const now = new Date()
      await utimes(filePath, now, now).catch((): undefined => undefined)
      return filePath
    }
  } catch {
    // 未命中，走合成
  }

  const existing = inflightSyntheses.get(cacheKey)
  if (existing) {
    return existing
  }

  const task = (async () => {
    await mkdir(cacheDirectory, { recursive: true })
    if (local) {
      try {
        await writeTtsCache(filePath, (temporaryPath) => synthesizeLocalTts(batch.text, voiceId, temporaryPath))
      } catch (error) {
        if (error instanceof DataAccessError) throw error
        console.error('[tts] local synthesize failed', { requestId: input.requestId, voiceId })
        throw new DataAccessError(503, 'TTS_UNAVAILABLE', '语音合成暂时不可用，请稍后重试。')
      }
    } else {
      await synthesizeWithRetry(batch.text, voiceId, filePath, input.requestId)
    }
    void cleanupTtsCache(cacheDirectory).catch((): undefined => undefined)
    return filePath
  })()

  inflightSyntheses.set(cacheKey, task)

  try {
    return await task
  } finally {
    inflightSyntheses.delete(cacheKey)
  }
}

/** A cache reader must only see complete audio. */
async function writeTtsCache(filePath: string, render: (temporaryPath: string) => Promise<unknown>): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await render(temporaryPath)
    if ((await stat(temporaryPath)).size === 0) throw new Error('empty tts output')
    await rename(temporaryPath, filePath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

/** Edge TTS 合成失败后最多重试一次，握手拒绝或限流时直接结束。 */
async function synthesizeWithRetry(text: string, voiceId: string, filePath: string, requestId: string): Promise<void> {
  const tts = new EdgeTTS({
    voice: voiceId,
    lang: 'zh-CN',
    outputFormat: TTS_OUTPUT_FORMAT,
    timeout: env.ttsTimeoutMs,
  })

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await writeTtsCache(filePath, (temporaryPath) => tts.ttsPromise(text, temporaryPath))
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const upstreamStatus = /^Unexpected server response: (\d{3})$/.exec(message)?.[1]
      if (upstreamStatus === '403' || upstreamStatus === '429' || attempt === 2) {
        const timedOut = /^Timed out\b/.test(message) || (error as NodeJS.ErrnoException | null)?.code === 'ETIMEDOUT'
        console.error('[tts] synthesize failed', {
          requestId,
          voiceId,
          reason: upstreamStatus ? 'upstream_http' : timedOut ? 'timeout' : 'synthesis_error',
          upstreamStatus,
          attempts: attempt,
        })
        break
      }
    }
  }

  throw new DataAccessError(503, 'TTS_UNAVAILABLE', '语音合成暂时不可用，请稍后重试。')
}

/** LRU 清理：目录总大小超上限时按 mtime 从旧到新删除 */
let cleanupRunning = false

async function cleanupTtsCache(cacheDirectory: string): Promise<void> {
  if (cleanupRunning) return
  cleanupRunning = true

  try {
    const maxBytes = env.ttsCacheMaxMb * 1024 * 1024
    const names = await readdir(cacheDirectory)
    const files = await Promise.all(
      names
        .filter((name) => name.endsWith('.mp3') || name.endsWith('.wav'))
        .map(async (name) => {
          const filePath = path.join(cacheDirectory, name)
          const fileStat = await stat(filePath).catch((): null => null)
          return fileStat ? { filePath, size: fileStat.size, mtimeMs: fileStat.mtimeMs } : null
        }),
    )

    const validFiles = files.filter((file): file is NonNullable<typeof file> => file !== null)
    let totalBytes = validFiles.reduce((total, file) => total + file.size, 0)

    if (totalBytes <= maxBytes) return

    validFiles.sort((a, b) => a.mtimeMs - b.mtimeMs)

    for (const file of validFiles) {
      if (totalBytes <= maxBytes) break
      await unlink(file.filePath).catch((): undefined => undefined)
      totalBytes -= file.size
    }
  } finally {
    cleanupRunning = false
  }
}
