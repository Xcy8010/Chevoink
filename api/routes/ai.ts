import { Router, type Request, type Response } from 'express'
import { z } from 'zod'

import { FIXED_NOVEL_COVER_SIZE } from '../../shared/contracts/index.js'
import { requireSessionUserId } from '../lib/auth-session.js'
import {
  generateCoverImageData,
  generateCoverPromptData,
  getAiConfigPayload,
} from '../lib/ai-service.js'
import { buildError, buildSuccess, createRequestId } from '../lib/http.js'
import { parseBody } from '../lib/parse-body.js'
import { sendRouteError } from '../lib/route-error.js'
import { getTtsVoicesPayload, synthesizeTtsBatchData } from '../lib/tts-service.js'

const router = Router()

const coverPromptSchema = z.object({
  novelId: z.string().min(1).max(64).optional(),
  novelTitle: z.string().min(1),
  summary: z.string().min(1),
  genre: z.string().min(1),
  protagonist: z.string().optional(),
  stylePreference: z.string().optional(),
})

const coverImageSchema = z.object({
  prompt: z.string().min(1),
  count: z.number().int().min(1),
  novelId: z.string().nullable().optional(),
  negativePrompt: z.string().nullable().optional(),
})

/** 非空文本：对齐路由原 `!body.x?.trim()` 判定（空串与纯空白均拒绝，值原样透传） */
const nonEmptyText = z.string().refine((value) => value.trim().length > 0)

const ttsSynthesizeSchema = z.object({
  novelId: nonEmptyText,
  chapterId: nonEmptyText,
  voiceId: nonEmptyText,
  batchIndex: z.number().int().min(0),
})

router.get('/config', async (_req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const payload = await getAiConfigPayload()
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

// 已下线：前端零调用的死端点改 410（观察期，生产日志确认无命中后可物理删除路由）
router.post('/outline', (_req: Request, res: Response): void => {
  const requestId = createRequestId()
  res.status(410).json(buildError(requestId, 'ENDPOINT_DEPRECATED', '该功能已下线。'))
})

// 已下线：前端零调用的死端点改 410（观察期，生产日志确认无命中后可物理删除路由）
router.post('/chapter-assist', (_req: Request, res: Response): void => {
  const requestId = createRequestId()
  res.status(410).json(buildError(requestId, 'ENDPOINT_DEPRECATED', '该功能已下线。'))
})

router.post('/cover-prompt', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(coverPromptSchema, req.body, '请提供作品标题、简介和题材。')

    const payload = await generateCoverPromptData(userId, {
      novelId: body.novelId,
      novelTitle: body.novelTitle.trim(),
      summary: body.summary.trim(),
      genre: body.genre.trim(),
      protagonist: body.protagonist?.trim() || undefined,
      stylePreference: body.stylePreference?.trim() || undefined,
    })

    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/cover-image', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(coverImageSchema, req.body, '请提供提示词和生成张数。')

    // 生成张数钳制在 1-4：count 直传付费 API 的 n 参数，无上限会单请求烧钱
    const count = Math.min(body.count, 4)

    const payload = await generateCoverImageData(userId, {
      prompt: body.prompt.trim(),
      size: FIXED_NOVEL_COVER_SIZE,
      count,
      novelId: body.novelId ?? null,
      negativePrompt: body.negativePrompt ?? null,
    })

    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

/** 听书音色清单（免登录，与公开阅读口径一致） */
router.get('/tts/voices', async (_req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    res.status(200).json(buildSuccess(requestId, getTtsVoicesPayload()))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

// 听书合成限流：同 IP 每分钟最多 20 次（正常听书约 3 分钟一批，防脚本滥用接口）
const TTS_RATE_LIMIT_PER_MINUTE = 20
const ttsRateBuckets = new Map<string, number[]>()

function isTtsRateLimited(key: string): boolean {
  const now = Date.now()
  const windowStart = now - 60_000
  const hits = (ttsRateBuckets.get(key) ?? []).filter((timestamp) => timestamp > windowStart)

  if (hits.length >= TTS_RATE_LIMIT_PER_MINUTE) {
    ttsRateBuckets.set(key, hits)
    return true
  }

  hits.push(now)
  ttsRateBuckets.set(key, hits)

  // 防止 Map 无限增长：超过 2000 个 key 时清空重置（影响仅为限流窗口重置）
  if (ttsRateBuckets.size > 2000) {
    ttsRateBuckets.clear()
  }

  return false
}

/** 听书批次合成：返回 audio/mpeg 二进制，错误仍走 JSON 错误结构 */
router.post('/tts/synthesize', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const body = parseBody(ttsSynthesizeSchema, req.body, '请提供完整的听书合成参数。')

    const rateKey = req.ip ?? 'unknown'
    if (isTtsRateLimited(rateKey)) {
      res.status(429).json(buildError(requestId, 'RATE_LIMITED', '听书请求过于频繁，请稍后再试。'))
      return
    }

    const filePath = await synthesizeTtsBatchData({
      novelId: body.novelId.trim(),
      chapterId: body.chapterId.trim(),
      batchIndex: body.batchIndex,
      voiceId: body.voiceId.trim(),
    })

    res.status(200)
    res.setHeader('Content-Type', 'audio/mpeg')
    // 同章同音色重听让浏览器再缓一层
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.sendFile(filePath)
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

export default router
