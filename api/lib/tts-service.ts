import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, stat, unlink, utimes } from 'node:fs/promises'
import path from 'node:path'

import { EdgeTTS } from 'node-edge-tts'

import type { TtsVoice, TtsVoicesPayload } from '../../shared/contracts/index.js'
import { splitTtsBatches, splitTtsParagraphs } from '../../shared/contracts/index.js'
import { env } from '../config/env.js'
import { DataAccessError, prisma } from './prisma.js'

/**
 * 听书 TTS 服务（方案 17）：
 * - 音色白名单（服务端配置，不透传微软全量音色）
 * - 章节正文按 shared 切批函数取出批次文本，Edge TTS 合成 mp3
 * - 磁盘缓存：键 = sha1(chapterId + updatedAt + voiceId + batchIndex)，章节改动天然失效
 * - LRU：目录总大小超上限时按 mtime 淘汰最旧文件
 */

/** 精选中文神经音色白名单（v1 定案，见方案 3.2） */
const TTS_VOICE_WHITELIST: TtsVoice[] = [
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
  const available = env.ttsProvider !== 'disabled'
  const defaultVoiceId = TTS_VOICE_WHITELIST.some((voice) => voice.id === env.ttsDefaultVoice)
    ? env.ttsDefaultVoice
    : TTS_VOICE_WHITELIST[0].id

  return {
    available,
    defaultVoiceId,
    voices: available ? TTS_VOICE_WHITELIST : [],
  }
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
  if (env.ttsProvider === 'disabled') {
    throw new DataAccessError(503, 'TTS_UNAVAILABLE', '听书服务暂未开放。')
  }

  if (!TTS_VOICE_WHITELIST.some((voice) => voice.id === input.voiceId)) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '不支持的音色。')
  }

  const chapter = await prisma.chapter.findUnique({ where: { id: input.chapterId } })

  // 与阅读页口径一致：仅公开已发布章节可听（创作区预览已在前端排除）
  if (
    !chapter ||
    chapter.novelId !== input.novelId ||
    chapter.status !== 'published' ||
    chapter.visibility !== 'public'
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

  const cacheKey = createHash('sha1')
    .update(`${chapter.id}:${chapter.publishedRevision ?? chapter.revision}:${input.voiceId}:${batch.index}`)
    .digest('hex')
  const cacheDirectory = getTtsCacheDirectory()
  const filePath = path.join(cacheDirectory, `${cacheKey}.mp3`)

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
    await synthesizeWithRetry(batch.text, input.voiceId, filePath, input.requestId)
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

/** Edge TTS 合成失败后最多重试一次，握手 403 直接结束。 */
async function synthesizeWithRetry(text: string, voiceId: string, filePath: string, requestId: string): Promise<void> {
  const tts = new EdgeTTS({
    voice: voiceId,
    lang: 'zh-CN',
    outputFormat: TTS_OUTPUT_FORMAT,
    timeout: env.ttsTimeoutMs,
  })

  // The provider writes incrementally. Make only completed audio visible to cache readers.
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await tts.ttsPromise(text, temporaryPath)
      if ((await stat(temporaryPath)).size === 0) {
        throw new Error('empty tts output')
      }
      await rename(temporaryPath, filePath)
      return
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      const message = error instanceof Error ? error.message : ''
      const upstreamStatus = /^Unexpected server response: (\d{3})$/.exec(message)?.[1]
      if (upstreamStatus === '403' || attempt === 2) {
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
        .filter((name) => name.endsWith('.mp3'))
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
