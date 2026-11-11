import { Router, type Request, type Response } from 'express'
import { z } from 'zod'

import { removeManagedAvatar, storeAvatarDataUrl } from '../lib/avatar-storage.js'
import { createSession, getSessionUserId, requireSessionUserId } from '../lib/auth-session.js'
import { removeManagedProfileCover, storeProfileCoverDataUrl } from '../lib/profile-cover-storage.js'
import {
  getInteractionBadgesData,
  getMePayloadData,
  getUserByIdData,
  getUserCredentialData,
  listInteractionsData,
  listFavoriteNovelsData,
  listReadingProgressData,
  listParagraphUnderlinesData,
  listUserFollowersData,
  listUserFollowingData,
  listUserLikedPostsData,
  listUserBookmarkedPostsData,
  listUserRepliesData,
  listReceivedLikesData,
  markInteractionSeenData,
  removeReadingProgressData,
  removeParagraphUnderlineData,
  saveReadingProgressData,
  saveParagraphUnderlineData,
  setUserFollowData,
  updateMyAvatarData,
  updateMyPasswordData,
  updateMyPrivacyData,
  updateMyProfileCoverData,
  updateMyProfileData,
} from '../lib/data-access.js'
import { buildError, buildSuccess, createRequestId } from '../lib/http.js'
import { parseBody } from '../lib/parse-body.js'
import { accountEmailAuthEnabled } from '../lib/account-email-auth-scope.js'
import { hasConfiguredPassword, verifyPassword } from '../lib/password.js'
import { DataAccessError } from '../lib/prisma.js'
import { sendRouteError } from '../lib/route-error.js'
import { sendAuthSmsCode, verifyAuthSmsCode } from '../lib/sms-service.js'

const router = Router()

/* ---------------- 请求体校验 schema（文案与历史提示保持一致） ---------------- */

/** 非空文本：对齐路由原 `!body.x?.trim()` 判定（空串与纯空白均拒绝，值原样透传） */
const nonEmptyText = z.string().refine((value) => value.trim().length > 0)

const updateProfileSchema = z.object({
  nickname: nonEmptyText,
  bio: z.string().optional(),
})

const updateAvatarSchema = z.object({
  avatarDataUrl: z.string().nullable(),
})

const updateCoverSchema = z.object({
  coverDataUrl: z.string().nullable(),
})

const updatePasswordSchema = z.object({
  password: nonEmptyText,
  oldPassword: z.string().optional(),
  code: z.string().optional(),
})

const privacyLevelSchema = z.enum(['public', 'mutual', 'private'])

const updatePrivacySchema = z.object({
  followers: privacyLevelSchema.optional(),
  following: privacyLevelSchema.optional(),
  likes: privacyLevelSchema.optional(),
  favorites: privacyLevelSchema.optional(),
  replies: privacyLevelSchema.optional(),
})

const saveReadingProgressSchema = z.object({
  novelId: nonEmptyText,
  novelTitle: nonEmptyText,
  coverUrl: z.string().nullable().optional(),
  chapterId: z.string().nullable().optional(),
  chapterTitle: z.string().nullable().optional(),
  chapterOrder: z.number().optional(),
  totalChapters: z.number().optional(),
  scrollPercent: z.number().optional(),
  scrollOnly: z.boolean().optional(),
  shelfOnly: z.boolean().optional(),
})

const saveUnderlineSchema = z.object({
  novelId: nonEmptyText,
  chapterId: nonEmptyText,
  paragraphIndex: z.number().int().min(0),
})

const markInteractionSeenSchema = z.object({
  target: z.enum(['interactions', 'followers']),
})

router.get('/me', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const payload = await getMePayloadData(userId)
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.patch('/me/profile', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(updateProfileSchema, req.body, '请输入昵称。')

    const user = await updateMyProfileData(userId, {
      nickname: body.nickname,
      bio: body.bio,
    })
    res.status(200).json(buildSuccess(requestId, { user }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.patch('/me/avatar', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(updateAvatarSchema, req.body, '请上传头像图片。')

    const nextAvatarUrl = body.avatarDataUrl ? await storeAvatarDataUrl(body.avatarDataUrl) : null
    let previousAvatarUrl: string | null = null

    try {
      const payload = await updateMyAvatarData(userId, nextAvatarUrl)
      previousAvatarUrl = payload.previousAvatarUrl

      if (nextAvatarUrl !== previousAvatarUrl) {
        await removeManagedAvatar(previousAvatarUrl)
      }

      res.status(200).json(buildSuccess(requestId, { user: payload.user }))
    } catch (error) {
      if (nextAvatarUrl && nextAvatarUrl !== previousAvatarUrl) {
        await removeManagedAvatar(nextAvatarUrl)
      }

      throw error
    }
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.patch('/me/cover', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(updateCoverSchema, req.body, '请上传封面图片。')

    const nextProfileCoverUrl = body.coverDataUrl ? await storeProfileCoverDataUrl(body.coverDataUrl) : null
    let previousProfileCoverUrl: string | null = null

    try {
      const payload = await updateMyProfileCoverData(userId, nextProfileCoverUrl)
      previousProfileCoverUrl = payload.previousProfileCoverUrl

      if (nextProfileCoverUrl !== previousProfileCoverUrl) {
        await removeManagedProfileCover(previousProfileCoverUrl)
      }

      res.status(200).json(buildSuccess(requestId, { user: payload.user }))
    } catch (error) {
      if (nextProfileCoverUrl && nextProfileCoverUrl !== previousProfileCoverUrl) {
        await removeManagedProfileCover(nextProfileCoverUrl)
      }

      throw error
    }
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/me/password/sms-code', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    if (accountEmailAuthEnabled()) {
      throw new DataAccessError(400, 'AUTH_PASSWORD_VERIFICATION_REQUIRED', '请使用账号设置中的验证码修改密码。')
    }
    const userId = requireSessionUserId(req)
    const credential = await getUserCredentialData(userId)

    if (!credential.phone) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '当前账号未绑定手机号，无法通过验证码重置密码。'))
      return
    }

    const payload = await sendAuthSmsCode({
      phone: credential.phone,
      purpose: 'reset_password',
    })

    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.patch('/me/password', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    if (accountEmailAuthEnabled()) {
      throw new DataAccessError(400, 'AUTH_PASSWORD_VERIFICATION_REQUIRED', '请使用账号设置中的验证码修改密码。')
    }
    const userId = requireSessionUserId(req)
    const body = parseBody(updatePasswordSchema, req.body, '请输入登录密码。')

    if (body.password.trim().length < 6) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '登录密码至少需要 6 位。'))
      return
    }

    const credential = await getUserCredentialData(userId)

    // 已设置过密码的账号，修改前需验证旧密码或手机验证码二选一
    if (hasConfiguredPassword(credential.passwordHash)) {
      if (body.code?.trim()) {
        if (!credential.phone) {
          res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '当前账号未绑定手机号，无法通过验证码重置密码。'))
          return
        }

        await verifyAuthSmsCode({
          phone: credential.phone,
          purpose: 'reset_password',
          code: body.code.trim(),
        })
      } else if (body.oldPassword?.trim()) {
        if (!credential.passwordHash || !verifyPassword(body.oldPassword.trim(), credential.passwordHash)) {
          res.status(400).json(buildError(requestId, 'AUTH_INVALID_CREDENTIALS', '当前密码不正确。'))
          return
        }
      } else {
        res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '请输入当前密码或手机验证码。'))
        return
      }
    }

    const user = await updateMyPasswordData(userId, body.password)
    // 改密已吊销全部旧令牌（tokenVersion+1）：为当前设备静默重签，避免本人立即掉线
    const tokens = await createSession(userId, res)
    res.status(200).json(buildSuccess(requestId, { user, tokens }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

async function handleUserFollow(req: Request, res: Response, following: boolean): Promise<void> {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const payload = await setUserFollowData(userId, req.params.userId, following)

    if (!payload) {
      res.status(404).json(buildError(requestId, 'USER_NOT_FOUND', '未找到用户。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
}

router.post('/:userId/follow', (req, res) => handleUserFollow(req, res, true))
router.delete('/:userId/follow', (req, res) => handleUserFollow(req, res, false))

router.get('/me/received-likes', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const payload = await listReceivedLikesData(userId)
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/me/favorite-novels', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const items = await listFavoriteNovelsData(userId)
    res.status(200).json(buildSuccess(requestId, { items }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

// 云端书架 + 阅读进度：多设备同步的书架列表与阅读位置
router.get('/me/reading-progress', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const items = await listReadingProgressData(userId)
    res.status(200).json(buildSuccess(requestId, { items }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/me/reading-progress', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(saveReadingProgressSchema, req.body, '缺少作品信息。')

    const item = await saveReadingProgressData(userId, body)
    if (!item) {
      res.status(404).json(buildError(requestId, 'NOVEL_NOT_FOUND', '未找到作品。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, { item }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.delete('/me/reading-progress/:novelId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const removed = await removeReadingProgressData(userId, req.params.novelId)
    res.status(200).json(buildSuccess(requestId, { removed }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

// 阅读器段落划线（方案 20 §2.7）：本章列表 / 幂等新增 / 取消
router.get('/me/underlines', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const chapterId = String(req.query.chapterId ?? '').trim()
    if (!chapterId) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '缺少章节信息。'))
      return
    }

    const paragraphIndexes = await listParagraphUnderlinesData(userId, chapterId)
    res.status(200).json(buildSuccess(requestId, { paragraphIndexes }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.put('/me/underlines', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(saveUnderlineSchema, req.body, '划线参数不完整。')

    const saved = await saveParagraphUnderlineData(userId, {
      novelId: body.novelId,
      chapterId: body.chapterId,
      paragraphIndex: body.paragraphIndex,
    })
    if (!saved) {
      res.status(404).json(buildError(requestId, 'CHAPTER_NOT_FOUND', '未找到章节。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, { saved }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.delete('/me/underlines', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const chapterId = String(req.query.chapterId ?? '').trim()
    const paragraphIndex = Number(req.query.paragraphIndex)
    if (!chapterId || !Number.isInteger(paragraphIndex) || paragraphIndex < 0) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '划线参数不完整。'))
      return
    }

    const removed = await removeParagraphUnderlineData(userId, chapterId, paragraphIndex)
    res.status(200).json(buildSuccess(requestId, { removed }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/me/interactions', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const payload = await listInteractionsData(userId)
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/me/interaction-badges', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const payload = await getInteractionBadgesData(userId)
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/me/interaction-badges/seen', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(markInteractionSeenSchema, req.body, '无效的已读标记目标。')

    const payload = await markInteractionSeenData(userId, body.target)
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.patch('/me/privacy', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(updatePrivacySchema, req.body, '隐私级别不合法。')
    const payload = await updateMyPrivacyData(userId, {
      followers: body.followers,
      following: body.following,
      likes: body.likes,
      favorites: body.favorites,
      replies: body.replies,
    })
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/:userId/followers', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const viewerUserId = getSessionUserId(req)
    const targetUserId = req.params.userId === 'me' ? viewerUserId : req.params.userId

    if (!targetUserId) {
      res.status(401).json(buildError(requestId, 'AUTH_REQUIRED', '请先登录后再继续。'))
      return
    }

    const payload = await listUserFollowersData(targetUserId, viewerUserId)
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/:userId/following', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const viewerUserId = getSessionUserId(req)
    const targetUserId = req.params.userId === 'me' ? viewerUserId : req.params.userId

    if (!targetUserId) {
      res.status(401).json(buildError(requestId, 'AUTH_REQUIRED', '请先登录后再继续。'))
      return
    }

    const payload = await listUserFollowingData(targetUserId, viewerUserId)
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/:userId/liked-posts', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const viewerUserId = getSessionUserId(req)
    const targetUserId = req.params.userId === 'me' ? viewerUserId : req.params.userId

    if (!targetUserId) {
      res.status(401).json(buildError(requestId, 'AUTH_REQUIRED', '请先登录后再继续。'))
      return
    }

    const payload = await listUserLikedPostsData(targetUserId, viewerUserId)
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/:userId/bookmarked-posts', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const viewerUserId = getSessionUserId(req)
    const targetUserId = req.params.userId === 'me' ? viewerUserId : req.params.userId

    if (!targetUserId) {
      res.status(401).json(buildError(requestId, 'AUTH_REQUIRED', '请先登录后再继续。'))
      return
    }

    const payload = await listUserBookmarkedPostsData(targetUserId, viewerUserId)
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/:userId/replies', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const viewerUserId = getSessionUserId(req)
    const targetUserId = req.params.userId === 'me' ? viewerUserId : req.params.userId

    if (!targetUserId) {
      res.status(401).json(buildError(requestId, 'AUTH_REQUIRED', '请先登录后再继续。'))
      return
    }

    const payload = await listUserRepliesData(targetUserId, viewerUserId)
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/:userId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const viewerUserId = getSessionUserId(req)
    if (!viewerUserId && req.params.userId === 'me') {
      res.status(401).json(buildError(requestId, 'AUTH_REQUIRED', '请先登录后再继续。'))
      return
    }

    const user = await getUserByIdData(req.params.userId, viewerUserId)
    if (!user) {
      res.status(404).json(buildError(requestId, 'USER_NOT_FOUND', '未找到用户。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, { user }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

export default router
