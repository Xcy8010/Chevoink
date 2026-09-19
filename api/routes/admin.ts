import { Router, type Request, type Response } from 'express'
import { modelRoutesInputSchema } from '../../shared/contracts/model-routes.js'
import { createRateCard, transitionRateCard, listRateCards, rateCardEvidenceSchema } from '../lib/billing/rate-cards.js'
import { itemizedTokenPriceSchema } from '../lib/billing/token-price.js'
import { z } from 'zod'
import { getSupplierBalances } from '../lib/supplier-balances.js'

import { createAuthCaptchaChallenge, verifyAuthCaptchaChallenge } from '../lib/auth-captcha.js'
import {
  assertAdminLoginAllowed,
  clearAdminLoginFailures,
  getRequestIp,
  recordAdminLoginFailure,
  requireAdmin,
} from '../lib/admin-auth.js'
import {
  clearSession,
  createSession,
  revokeUserSessions,
} from '../lib/auth-session.js'
import {
  adminChangeMyPasswordData,
  adminDeleteChapterData,
  adminDeleteCommentData,
  adminDeleteNovelData,
  adminDeletePostData,
  adminLoginByEmailData,
  adminLoginByPhoneData,
  bindAdminPhoneData,
  findAdminByPhoneData,
  getAdminAgentSessionMessagesData,
  getAdminConversationMessagesData,
  getAdminCreationRecordsData,
  getAdminCreationRecordsIndexData,
  getAdminDashboardData,
  getAdminAnalyticsData,
  getAdminFeedbackDetailData,
  getAdminTokenManagementData,
  getAdminNovelDetailData,
  getAdminChapterContentData,
  getAdminPostDetailData,
  getAdminUserBySessionData,
  getAdminUserDetailData,
  isPhoneTakenByOtherData,
  listAdminAuditLogsData,
  listAdminCommentsData,
  listAdminConversationsData,
  listAdminFeedbacksData,
  listAdminNovelsData,
  listAdminPostsData,
  listAdminUserFavoriteNovelsData,
  listAdminUserFollowersData,
  listAdminUsersData,
  recordAdminAuditLog,
  resetUserPasswordData,
  restoreNovelData,
  setFeedbackStatusData,
  setUserBannedData,
  setUserRoleData,
  takeDownNovelData,
} from '../lib/data-access.js'
import { buildError, buildSuccess, createRequestId, parsePositiveInt } from '../lib/http.js'
import { parseBody } from '../lib/parse-body.js'
import { normalizePhoneNumber } from '../lib/phone.js'
import { DataAccessError } from '../lib/prisma.js'
import { sendRouteError } from '../lib/route-error.js'
import { sendAuthSmsCode, verifyAuthSmsCode } from '../lib/sms-service.js'
import {
  addAgentEvalSample,
  createAgentEvalSuite,
  getAgentEvalResults,
  getNextBlindReview,
  listAgentEvalSuites,
  submitBlindReview,
  updateAgentEvalSuiteStatus,
} from '../lib/agent/blind-review.js'
import {
  AGENT_EVAL_DIMENSIONS,
  AGENT_EVAL_MECHANICAL_REASONS,
  corpusSourceCreateSchema,
  corpusDocumentImportSchema,
  corpusSourceVerifySchema,
  type AgentBlindReviewSubmission,
} from '../../shared/contracts/index.js'
import {
  createCorpusSource,
  importCorpusDocument,
  listCorpusSources,
  revokeCorpusSource,
  verifyCorpusSource,
} from '../lib/agent/craft-library.js'
import { getAgent3OperationsMetrics } from '../lib/agent/writing-experiments.js'
import {
  getAdminCreditsManagement,
  getAdminModelManagement,
  resetAdminUserCredits,
  resetAdminUsersCredits,
  resetAllAdminCredits,
  setAdminUsersSuspended,
  setCreditsGloballyPaused,
  updateAdminModel,
} from '../lib/admin-credit-model.js'

const router = Router()

/* ---------------- 请求体校验 schema（文案与历史提示保持一致） ---------------- */

/** 非空文本：对齐路由原 `!body.x?.trim()` 判定（空串与纯空白均拒绝，值原样透传） */
const nonEmptyText = z.string().refine((value) => value.trim().length > 0)

const adminSmsSendCodeSchema = z.object({
  phone: nonEmptyText,
  captchaId: nonEmptyText,
  captchaAnswer: nonEmptyText,
})

const adminChangePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(1),
})

const adminBindPhoneSchema = z.object({
  phone: nonEmptyText,
  code: nonEmptyText,
})

const adminSetRoleSchema = z.object({
  role: z.enum(['user', 'admin']),
})

const adminDeleteNovelSchema = z.object({
  confirmTitle: nonEmptyText,
})

const agentEvalSuiteSchema = z.object({
  name: z.string().trim().min(1).max(160),
  datasetVersion: z.string().trim().min(1).max(64),
  rubricVersion: z.string().trim().min(1).max(64),
})

const agentEvalCandidateSchema = z.object({
  origin: z.enum(['agent2', 'agent3', 'human']),
  content: z.string().trim().min(1).max(20_000),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const agentEvalSampleSchema = z.object({
  code: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(160),
  genre: z.string().trim().min(1).max(48),
  task: z.string().trim().min(1).max(48),
  style: z.string().trim().min(1).max(48),
  evaluationBrief: z.string().trim().min(1).max(2_000),
  sourceClass: z.enum(['synthetic', 'public_domain', 'licensed', 'user_opt_in']),
  sourceReference: z.string().trim().min(1).max(500),
  consentReceiptId: z.string().trim().max(160).optional(),
  candidates: z.array(agentEvalCandidateSchema).length(3),
})

const agentEvalStatusSchema = z.object({ status: z.enum(['active', 'completed']) })
const agentEvalRatingSchema = z.record(
  z.string(),
  z.object(Object.fromEntries(AGENT_EVAL_DIMENSIONS.map((dimension) => [dimension, z.number().int().min(1).max(5)])) as Record<(typeof AGENT_EVAL_DIMENSIONS)[number], z.ZodNumber>),
)
const agentEvalReviewSchema = z.object({
  candidateRatings: agentEvalRatingSchema,
  guessedOrigins: z.record(z.string(), z.enum(['agent2', 'agent3', 'human', 'unsure'])),
  mechanicalReasons: z.record(z.string(), z.array(z.enum(AGENT_EVAL_MECHANICAL_REASONS)).max(AGENT_EVAL_MECHANICAL_REASONS.length)),
  preferredLabel: z.string().trim().min(1).max(8),
  notes: z.string().trim().max(2_000).optional(),
})
const corpusSourceRevokeSchema = z.object({ reason: z.string().trim().min(1).max(500) })
const adminDangerActionSchema = z.object({
  requestKey: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/).optional(),
  captchaId: nonEmptyText,
  captchaAnswer: nonEmptyText,
  confirmation: nonEmptyText,
})
const adminPauseCreditsSchema = adminDangerActionSchema.extend({ paused: z.boolean() })
const adminBatchCreditsSchema = adminDangerActionSchema.extend({ userIds: z.array(z.string().trim().min(1).max(64)).min(1).max(200) })
const adminBatchPauseCreditsSchema = adminBatchCreditsSchema.extend({ paused: z.boolean() })
const modelReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const adminModelUpdateSchema = z.object({
  routes: modelRoutesInputSchema.optional(),
  provider: z.string().trim().min(1).max(40).optional(),
  displayName: z.string().trim().min(1).max(80).optional(),
  modelName: z.string().trim().min(1).max(160).optional(),
  baseUrl: z.string().trim().url().max(512).nullable().optional(),
  apiKey: z.string().trim().min(8).max(2_000).optional(),
  multiplier: z.number().min(0).max(100).optional(),
  enabled: z.boolean().optional(),
  selectable: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  reasoningEfforts: z.array(modelReasoningEffortSchema).min(1).max(7).optional(),
  defaultReasoningEffort: modelReasoningEffortSchema.optional(),
  visionEnabled: z.boolean().optional(),
  contextWindowTokens: z.number().int().min(16_000).max(4_000_000).optional(),
})

function requireSuperAdmin(admin: { isSuperAdmin: boolean }): void {
  if (!admin.isSuperAdmin) {
    throw new DataAccessError(403, 'SUPER_ADMIN_REQUIRED', '该操作仅限超级管理员。')
  }
}

/** 强密码校验：至少 12 位，含大小写、数字与符号 */
function validateStrongPassword(password: string): string | null {
  if (password.length < 12) {
    return '密码至少 12 位。'
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return '密码需同时包含大写字母、小写字母与数字。'
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return '密码需包含至少一个特殊符号。'
  }
  return null
}

/* ---------------- 认证 ---------------- */

router.get('/captcha', (_req: Request, res: Response): void => {
  const requestId = createRequestId()
  const challenge = createAuthCaptchaChallenge()
  res.status(200).json(buildSuccess(requestId, challenge))
})

router.post('/auth/login', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  const body = (req.body ?? {}) as {
    email?: string
    phone?: string
    password?: string
    code?: string
    captchaId?: string
    captchaAnswer?: string
  }

  try {
    const hasEmail = Boolean(body.email?.trim())
    const hasPhone = Boolean(body.phone?.trim())
    const hasPassword = Boolean(body.password)
    const hasCode = Boolean(body.code?.trim())

    // 三种模式：邮箱+密码 / 手机号+密码 / 手机号+短信验证码
    if (hasEmail === hasPhone) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '请使用邮箱或手机号其中一种方式登录。'))
      return
    }
    if (hasEmail && !hasPassword) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '请输入密码。'))
      return
    }
    if (hasPhone && !hasPassword && !hasCode) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '请输入密码或短信验证码。'))
      return
    }
    if (hasPassword && (!body.captchaId?.trim() || !body.captchaAnswer?.trim())) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '请完成人机验证。'))
      return
    }

    const identifier = hasEmail ? body.email!.trim().toLowerCase() : normalizePhoneNumber(body.phone!)
    const rateLimitKey = `${getRequestIp(req) ?? 'unknown'}:${identifier}`
    assertAdminLoginAllowed(rateLimitKey)

    // 密码模式登录前校验人机验证；验证码模式的人机验证在发码环节完成
    if (hasPassword) {
      verifyAuthCaptchaChallenge(body.captchaId!.trim(), body.captchaAnswer!.trim())
    }

    let result: { userId: string; nickname: string } | null = null
    if (hasEmail) {
      result = await adminLoginByEmailData(identifier, body.password!)
    } else if (hasPassword) {
      result = await adminLoginByPhoneData(identifier, body.password)
    } else {
      await verifyAuthSmsCode({ phone: identifier, purpose: 'admin_login', code: body.code!.trim() })
      result = await adminLoginByPhoneData(identifier)
    }

    if (!result) {
      recordAdminLoginFailure(rateLimitKey)
      res.status(401).json(buildError(requestId, 'ADMIN_AUTH_FAILED', '账号或凭证不正确，仅管理员可登录。'))
      return
    }

    clearAdminLoginFailures(rateLimitKey)
    const tokens = await createSession(result.userId, res)
    await recordAdminAuditLog({
      adminId: result.userId,
      action: 'admin.login',
      targetType: 'user',
      targetId: result.userId,
      detail: { channel: hasEmail ? 'email' : hasPassword ? 'phone_password' : 'phone_code' },
      ip: getRequestIp(req),
    })
    res.status(200).json(
      buildSuccess(requestId, {
        admin: { id: result.userId, nickname: result.nickname },
        tokens,
      }),
    )
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

/** 管理后台手机号登录发码：必须先过人机验证，且手机号已绑定有效管理员 */
router.post('/auth/sms/send-code', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const body = parseBody(adminSmsSendCodeSchema, req.body, '请输入手机号并完成人机验证。')

    const phone = normalizePhoneNumber(body.phone)
    const rateLimitKey = `${getRequestIp(req) ?? 'unknown'}:${phone}`
    assertAdminLoginAllowed(rateLimitKey)
    verifyAuthCaptchaChallenge(body.captchaId.trim(), body.captchaAnswer.trim())

    const admin = await findAdminByPhoneData(phone)
    if (!admin) {
      recordAdminLoginFailure(rateLimitKey)
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '该手机号未绑定管理员账号，无法使用手机号登录。'))
      return
    }

    const sent = await sendAuthSmsCode({ phone, purpose: 'admin_login' })
    res.status(200).json(buildSuccess(requestId, sent))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/me', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    const payload = await getAdminUserBySessionData(admin.id)
    if (!payload) {
      res.status(401).json(buildError(requestId, 'AUTH_REQUIRED', '请先登录管理后台。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    // 登出即吊销该管理员全部 v2 会话令牌
    const admin = await requireAdmin(req).catch((error: unknown) => {
      if (error instanceof DataAccessError && error.status === 401) return null
      throw error
    })
    if (admin) {
      await revokeUserSessions(admin.id)
    }
  } catch (error) {
    sendRouteError(res, requestId, error)
    return
  }
  clearSession(res)
  res.status(200).json(buildSuccess(requestId, { ok: true }))
})

router.post('/me/change-password', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    const body = parseBody(adminChangePasswordSchema, req.body, '请输入旧密码和新密码。')

    const strengthError = validateStrongPassword(body.newPassword)
    if (strengthError) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', strengthError))
      return
    }

    const changed = await adminChangeMyPasswordData(admin.id, body.oldPassword, body.newPassword)
    if (!changed) {
      res.status(401).json(buildError(requestId, 'ADMIN_AUTH_FAILED', '旧密码不正确。'))
      return
    }

    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'admin.change_own_password',
      targetType: 'user',
      targetId: admin.id,
      ip: getRequestIp(req),
    })
    // 改密已吊销全部旧令牌：为当前设备静默重签，避免本人立即掉线
    const tokens = await createSession(admin.id, res)
    res.status(200).json(buildSuccess(requestId, { ok: true, tokens }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

/** 管理员绑定手机号发码：人机验证 + 手机号未被占用 */
router.post('/me/sms/send-code', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    const body = parseBody(adminSmsSendCodeSchema, req.body, '请输入手机号并完成人机验证。')

    const phone = normalizePhoneNumber(body.phone)
    verifyAuthCaptchaChallenge(body.captchaId.trim(), body.captchaAnswer.trim())

    // 占用检查在绑定环节兜底；此处仅校验未被任意账号占用，避免浪费短信
    const taken = await isPhoneTakenByOtherData(phone, admin.id)
    if (taken) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '该手机号已被其他账号绑定。'))
      return
    }

    const sent = await sendAuthSmsCode({ phone, purpose: 'admin_bind' })
    res.status(200).json(buildSuccess(requestId, sent))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

/** 管理员绑定手机号：校验短信码后写入 */
router.post('/me/bind-phone', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    const body = parseBody(adminBindPhoneSchema, req.body, '请输入手机号和短信验证码。')

    const phone = normalizePhoneNumber(body.phone)
    await verifyAuthSmsCode({ phone, purpose: 'admin_bind', code: body.code.trim() })

    const result = await bindAdminPhoneData(admin.id, phone)
    if (!result.ok) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '该手机号已被其他账号绑定。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, { ok: true, phone }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

/* ---------------- 仪表盘 ---------------- */

router.get('/supplier-balances', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    await requireAdmin(req)
    res.status(200).json(buildSuccess(requestId, await getSupplierBalances()))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.get('/analytics', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    await requireAdmin(req)
    const input = z.object({
      period: z.enum(['day', 'week', 'month']).default('day'),
      scope: z.enum(['dashboard', 'creation', 'credits', 'cost']).default('dashboard'),
    }).parse(req.query)
    res.status(200).json(buildSuccess(requestId, await getAdminAnalyticsData(input.period, input.scope)))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/dashboard', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await getAdminDashboardData()
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

/* ---------------- 用户管理 ---------------- */

router.get('/users', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await listAdminUsersData({
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      role: typeof req.query.role === 'string' ? req.query.role : undefined,
      banned:
        req.query.banned === 'true' ? true : req.query.banned === 'false' ? false : undefined,
      online: req.query.online === 'true' ? true : undefined,
      page: parsePositiveInt(req.query.page, 1),
      pageSize: parsePositiveInt(req.query.pageSize, 20),
    })
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/users/:userId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await getAdminUserDetailData(req.params.userId)
    if (!payload) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '用户不存在。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/users/:userId/ban', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    if (req.params.userId === admin.id) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '不能封禁当前登录的管理员账号。'))
      return
    }

    const result = await setUserBannedData(req.params.userId, true)
    if (!result) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '用户不存在。'))
      return
    }

    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'user.ban',
      targetType: 'user',
      targetId: req.params.userId,
      detail: { nickname: result.nickname },
      ip: getRequestIp(req),
    })
    res.status(200).json(buildSuccess(requestId, { ok: true }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/users/:userId/unban', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    const result = await setUserBannedData(req.params.userId, false)
    if (!result) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '用户不存在。'))
      return
    }

    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'user.unban',
      targetType: 'user',
      targetId: req.params.userId,
      detail: { nickname: result.nickname },
      ip: getRequestIp(req),
    })
    res.status(200).json(buildSuccess(requestId, { ok: true }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/users/:userId/role', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    if (!admin.isSuperAdmin) {
      res.status(403).json(buildError(requestId, 'SUPER_REQUIRED', '仅超级管理可以设置用户身份。'))
      return
    }
    if (req.params.userId === admin.id) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '不能修改当前登录管理员自己的角色。'))
      return
    }

    const body = parseBody(adminSetRoleSchema, req.body, '不支持的角色，仅可设置用户或管理。')

    const result = await setUserRoleData(req.params.userId, body.role)
    if (result === null) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '用户不存在。'))
      return
    }
    if ('blocked' in result) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '超级管理身份唯一，不可修改。'))
      return
    }

    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'user.set_role',
      targetType: 'user',
      targetId: req.params.userId,
      detail: { nickname: result.nickname, role: result.role },
      ip: getRequestIp(req),
    })
    res.status(200).json(buildSuccess(requestId, { ok: true }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/users/:userId/followers', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await listAdminUserFollowersData(req.params.userId)
    if (!payload) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '用户不存在。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/users/:userId/favorites', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await listAdminUserFavoriteNovelsData(req.params.userId)
    if (!payload) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '用户不存在。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/creation-records', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const search = typeof req.query.search === 'string' ? req.query.search : undefined
    const payload = await getAdminCreationRecordsIndexData({
      search,
      page: parsePositiveInt(req.query.page, 1),
      pageSize: parsePositiveInt(req.query.pageSize, 24),
    })
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/users/:userId/creation-records', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await getAdminCreationRecordsData(req.params.userId)
    if (!payload) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '用户不存在。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/agent-sessions/:sessionId/messages', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await getAdminAgentSessionMessagesData(req.params.sessionId, {
      before: typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined,
      pageSize: parsePositiveInt(req.query.pageSize, 20),
    })
    if (!payload) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '会话不存在。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/users/:userId/reset-password', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    if (req.params.userId === admin.id) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '请通过「修改密码」修改自己的密码。'))
      return
    }

    const tempPassword = await resetUserPasswordData(req.params.userId)
    if (!tempPassword) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '用户不存在。'))
      return
    }

    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'user.reset_password',
      targetType: 'user',
      targetId: req.params.userId,
      ip: getRequestIp(req),
    })
    res.status(200).json(buildSuccess(requestId, { tempPassword }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

/* ---------------- 作品管理 ---------------- */

router.get('/novels', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await listAdminNovelsData({
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      page: parsePositiveInt(req.query.page, 1),
      pageSize: parsePositiveInt(req.query.pageSize, 20),
    })
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/novels/:novelId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await getAdminNovelDetailData(req.params.novelId)
    if (!payload) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '作品不存在。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/novels/:novelId/chapters/:chapterId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await getAdminChapterContentData(req.params.novelId, req.params.chapterId)
    if (!payload) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '章节不存在。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/novels/:novelId/take-down', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    const result = await takeDownNovelData(req.params.novelId)
    if (!result) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '作品不存在。'))
      return
    }

    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'novel.take_down',
      targetType: 'novel',
      targetId: req.params.novelId,
      detail: { title: result.title, previousVisibility: result.previousVisibility },
      ip: getRequestIp(req),
    })
    res.status(200).json(buildSuccess(requestId, { ok: true }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/novels/:novelId/restore', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    const result = await restoreNovelData(req.params.novelId)
    if (!result) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '作品不存在。'))
      return
    }

    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'novel.restore',
      targetType: 'novel',
      targetId: req.params.novelId,
      detail: { title: result.title },
      ip: getRequestIp(req),
    })
    res.status(200).json(buildSuccess(requestId, { ok: true }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.delete('/novels/:novelId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    const detail = await getAdminNovelDetailData(req.params.novelId)
    if (!detail) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '作品不存在。'))
      return
    }

    const expectedTitle = detail.novel.displayTitle ?? detail.novel.title
    const body = parseBody(adminDeleteNovelSchema, req.body, '请输入正确的作品名以确认删除。')
    if (body.confirmTitle.trim() !== expectedTitle) {
      res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '请输入正确的作品名以确认删除。'))
      return
    }

    await adminDeleteNovelData(req.params.novelId)
    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'novel.delete',
      targetType: 'novel',
      targetId: req.params.novelId,
      detail: { title: expectedTitle, authorId: detail.novel.author.id },
      ip: getRequestIp(req),
    })
    res.status(200).json(buildSuccess(requestId, { ok: true }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.delete('/chapters/:chapterId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    const result = await adminDeleteChapterData(req.params.chapterId)
    if (!result) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '章节不存在。'))
      return
    }

    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'chapter.delete',
      targetType: 'chapter',
      targetId: req.params.chapterId,
      detail: { title: result.title, novelId: result.novelId },
      ip: getRequestIp(req),
    })
    res.status(200).json(buildSuccess(requestId, { ok: true }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

/* ---------------- 帖子与评论管理 ---------------- */

router.get('/posts', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await listAdminPostsData({
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      page: parsePositiveInt(req.query.page, 1),
      pageSize: parsePositiveInt(req.query.pageSize, 20),
    })
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.delete('/posts/:postId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    const deleted = await adminDeletePostData(req.params.postId)
    if (deleted === null) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '帖子不存在。'))
      return
    }

    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'post.delete',
      targetType: 'post',
      targetId: req.params.postId,
      ip: getRequestIp(req),
    })
    res.status(200).json(buildSuccess(requestId, { ok: true }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/posts/:postId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await getAdminPostDetailData(req.params.postId)
    if (!payload) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '帖子不存在。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/comments', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await listAdminCommentsData({
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      page: parsePositiveInt(req.query.page, 1),
      pageSize: parsePositiveInt(req.query.pageSize, 20),
    })
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.delete('/comments/:commentId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    const deleted = await adminDeleteCommentData(req.params.commentId)
    if (deleted === null) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '评论不存在。'))
      return
    }

    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'comment.delete',
      targetType: 'comment',
      targetId: req.params.commentId,
      detail: { deletedCount: deleted.deletedCount },
      ip: getRequestIp(req),
    })
    res.status(200).json(buildSuccess(requestId, { ok: true }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

/* ---------------- 审计日志 ---------------- */

router.get('/conversations', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await listAdminConversationsData({
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      page: parsePositiveInt(req.query.page, 1),
      pageSize: parsePositiveInt(req.query.pageSize, 20),
    })
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/conversations/:conversationId/messages', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await getAdminConversationMessagesData(req.params.conversationId)
    if (payload === null) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '会话不存在。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, { messages: payload }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/token-usage', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    await requireAdmin(req)
    const rawPeriod = typeof req.query.period === 'string' ? req.query.period : 'today'
    const period = rawPeriod === 'week' || rawPeriod === 'month' ? rawPeriod : 'today'
    res.status(200).json(buildSuccess(requestId, await getAdminTokenManagementData(period)))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/credits', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    await requireAdmin(req)
    res.status(200).json(buildSuccess(requestId, await getAdminCreditsManagement()))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/credits/users/:userId/reset', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(adminDangerActionSchema, req.body, '请完成人机验证并输入确认词。')
    verifyAuthCaptchaChallenge(body.captchaId.trim(), body.captchaAnswer.trim())
    if (body.confirmation.trim() !== 'RESET_USER') throw new DataAccessError(400, 'CONFIRMATION_MISMATCH', '确认词不正确。')
    const result = await resetAdminUserCredits(req.params.userId, admin.id, body.requestKey)
    await recordAdminAuditLog({ adminId: admin.id, action: 'credits.reset_user', targetType: 'user', targetId: req.params.userId, detail: result, ip: getRequestIp(req) })
    res.status(200).json(buildSuccess(requestId, result))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/credits/reset-all', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(adminDangerActionSchema, req.body, '请完成人机验证并输入确认词。')
    verifyAuthCaptchaChallenge(body.captchaId.trim(), body.captchaAnswer.trim())
    if (body.confirmation.trim() !== 'RESET_ALL') throw new DataAccessError(400, 'CONFIRMATION_MISMATCH', '确认词不正确。')
    const result = await resetAllAdminCredits(admin.id, body.requestKey)
    await recordAdminAuditLog({ adminId: admin.id, action: 'credits.reset_all', targetType: 'creditSystem', targetId: 'global', detail: result, ip: getRequestIp(req) })
    res.status(200).json(buildSuccess(requestId, result))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/credits/users/reset-selected', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(adminBatchCreditsSchema, req.body, '请选择用户并完成人机验证。')
    verifyAuthCaptchaChallenge(body.captchaId.trim(), body.captchaAnswer.trim())
    if (body.confirmation.trim() !== 'RESET_SELECTED') throw new DataAccessError(400, 'CONFIRMATION_MISMATCH', '确认词不正确。')
    const result = await resetAdminUsersCredits(body.userIds, admin.id, body.requestKey)
    await recordAdminAuditLog({ adminId: admin.id, action: 'credits.reset_selected', targetType: 'users', targetId: `${result.users}`, detail: { ...result, userIds: body.userIds }, ip: getRequestIp(req) })
    res.status(200).json(buildSuccess(requestId, result))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/credits/users/:userId/pause', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(adminPauseCreditsSchema, req.body, '请完成人机验证并输入确认词。')
    verifyAuthCaptchaChallenge(body.captchaId.trim(), body.captchaAnswer.trim())
    const expected = body.paused ? 'PAUSE_USER' : 'RESUME_USER'
    if (body.confirmation.trim() !== expected) throw new DataAccessError(400, 'CONFIRMATION_MISMATCH', '确认词不正确。')
    const result = await setAdminUsersSuspended([req.params.userId], body.paused)
    await recordAdminAuditLog({ adminId: admin.id, action: body.paused ? 'credits.pause_user' : 'credits.resume_user', targetType: 'user', targetId: req.params.userId, detail: result, ip: getRequestIp(req) })
    res.status(200).json(buildSuccess(requestId, result))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/credits/users/pause-selected', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(adminBatchPauseCreditsSchema, req.body, '请选择用户并完成人机验证。')
    verifyAuthCaptchaChallenge(body.captchaId.trim(), body.captchaAnswer.trim())
    const expected = body.paused ? 'PAUSE_SELECTED' : 'RESUME_SELECTED'
    if (body.confirmation.trim() !== expected) throw new DataAccessError(400, 'CONFIRMATION_MISMATCH', '确认词不正确。')
    const result = await setAdminUsersSuspended(body.userIds, body.paused)
    await recordAdminAuditLog({ adminId: admin.id, action: body.paused ? 'credits.pause_selected' : 'credits.resume_selected', targetType: 'users', targetId: `${result.users}`, detail: { ...result, userIds: body.userIds }, ip: getRequestIp(req) })
    res.status(200).json(buildSuccess(requestId, result))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/credits/pause', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(adminPauseCreditsSchema, req.body, '请完成人机验证并输入确认词。')
    verifyAuthCaptchaChallenge(body.captchaId.trim(), body.captchaAnswer.trim())
    const expected = body.paused ? 'PAUSE_ALL' : 'RESUME_ALL'
    if (body.confirmation.trim() !== expected) throw new DataAccessError(400, 'CONFIRMATION_MISMATCH', '确认词不正确。')
    const result = await setCreditsGloballyPaused(body.paused)
    await recordAdminAuditLog({ adminId: admin.id, action: body.paused ? 'credits.pause_all' : 'credits.resume_all', targetType: 'creditSystem', targetId: 'global', detail: result, ip: getRequestIp(req) })
    res.status(200).json(buildSuccess(requestId, result))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/model-rate-cards', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    res.json(buildSuccess(requestId, { cards: await listRateCards(admin.id) }))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.post('/model-rate-cards', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(itemizedTokenPriceSchema, req.body, '费率卡格式不正确。')
    res.json(buildSuccess(requestId, { card: await createRateCard(admin.id, body) }))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.post('/model-rate-cards/:cardId/transition', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(z.object({ expectedRevision: z.number().int().nonnegative(), status: z.enum(['shadow', 'approved', 'active', 'retired']), evidence: rateCardEvidenceSchema }).strict(), req.body, '费率状态变更格式不正确。')
    res.json(buildSuccess(requestId, { card: await transitionRateCard(admin.id, { ...body, id: req.params.cardId }) }))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.get('/models', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    await requireAdmin(req)
    res.status(200).json(buildSuccess(requestId, await getAdminModelManagement()))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.patch('/models/:modelId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(adminModelUpdateSchema, req.body, '模型配置格式不正确。')
    await updateAdminModel(req.params.modelId, body)
    await recordAdminAuditLog({ adminId: admin.id, action: 'models.update', targetType: 'aiModelConfig', targetId: req.params.modelId, detail: { ...body, routes: body.routes?.map(({ apiKey, ...route }) => ({ ...route, ...(apiKey ? { apiKey: '[REPLACED]' } : {}) })), apiKey: body.apiKey ? '[REPLACED]' : undefined }, ip: getRequestIp(req) })
    res.status(200).json(buildSuccess(requestId, { ok: true }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

/* ---------------- Agent 3.0 专家盲评 ---------------- */

router.get('/agent3/operations', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    res.status(200).json(buildSuccess(requestId, await getAgent3OperationsMetrics()))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/evals/suites', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    await requireAdmin(req)
    res.status(200).json(buildSuccess(requestId, { suites: await listAgentEvalSuites() }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/evals/suites', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(agentEvalSuiteSchema, req.body, '请完整填写评测套件信息。')
    const suite = await createAgentEvalSuite({ ...body, adminId: admin.id })
    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'agent_eval.suite_create',
      targetType: 'agent_eval_suite',
      targetId: suite.id,
      detail: { datasetVersion: suite.datasetVersion, rubricVersion: suite.rubricVersion },
      ip: getRequestIp(req),
    })
    res.status(201).json(buildSuccess(requestId, suite))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/evals/suites/:suiteId/samples', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(agentEvalSampleSchema, req.body, '请完整填写盲评样本。')
    const sample = await addAgentEvalSample(req.params.suiteId, body)
    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'agent_eval.sample_create',
      targetType: 'agent_eval_sample',
      targetId: sample.id,
      detail: { suiteId: req.params.suiteId, code: sample.code },
      ip: getRequestIp(req),
    })
    res.status(201).json(buildSuccess(requestId, sample))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.patch('/evals/suites/:suiteId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(agentEvalStatusSchema, req.body, '请选择有效的套件状态。')
    const suite = await updateAgentEvalSuiteStatus(req.params.suiteId, body.status)
    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'agent_eval.suite_status',
      targetType: 'agent_eval_suite',
      targetId: suite.id,
      detail: { status: suite.status },
      ip: getRequestIp(req),
    })
    res.status(200).json(buildSuccess(requestId, suite))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/evals/review/next', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    const suiteId = typeof req.query.suiteId === 'string' && req.query.suiteId.trim() ? req.query.suiteId : undefined
    const assignment = await getNextBlindReview(admin.id, suiteId)
    res.status(200).json(buildSuccess(requestId, { assignment }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/evals/samples/:sampleId/reviews', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    const body = parseBody(agentEvalReviewSchema, req.body, '请完成全部候选评分后提交。')
    const result = await submitBlindReview(admin.id, req.params.sampleId, body as AgentBlindReviewSubmission)
    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'agent_eval.review_submit',
      targetType: 'agent_eval_sample',
      targetId: req.params.sampleId,
      detail: { submitted: true },
      ip: getRequestIp(req),
    })
    res.status(201).json(buildSuccess(requestId, result))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/evals/suites/:suiteId/results', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    res.status(200).json(buildSuccess(requestId, await getAgentEvalResults(req.params.suiteId)))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

/* ---------------- Agent 3.0 合法文笔库 ---------------- */

router.get('/craft/sources', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    await requireAdmin(req)
    res.status(200).json(buildSuccess(requestId, { sources: await listCorpusSources() }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/craft/sources', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(corpusSourceCreateSchema, req.body, '请完整填写来源、权利范围和证据。')
    const source = await createCorpusSource(admin.id, body)
    await recordAdminAuditLog({
      adminId: admin.id, action: 'craft.source_create', targetType: 'corpus_source', targetId: source.id,
      detail: { sourceClass: source.sourceClass, rightsStatus: source.rightsStatus }, ip: getRequestIp(req),
    })
    res.status(201).json(buildSuccess(requestId, { source }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/craft/sources/:sourceId/documents', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(corpusDocumentImportSchema, req.body, '请填写合法来源文档的标题和正文。')
    const document = await importCorpusDocument({ adminId: admin.id, sourceId: req.params.sourceId, document: body })
    await recordAdminAuditLog({
      adminId: admin.id, action: 'craft.document_import', targetType: 'corpus_document', targetId: document.documentId,
      detail: { sourceId: req.params.sourceId, passageCount: document.passageCount, contentHash: document.contentHash }, ip: getRequestIp(req),
    })
    res.status(201).json(buildSuccess(requestId, { document }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.patch('/craft/sources/:sourceId/verify', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(corpusSourceVerifySchema, req.body, '请给出审批结论和审计说明。')
    const source = await verifyCorpusSource({ adminId: admin.id, sourceId: req.params.sourceId, ...body })
    await recordAdminAuditLog({
      adminId: admin.id, action: 'craft.source_verify', targetType: 'corpus_source', targetId: source.id,
      detail: { decision: body.decision }, ip: getRequestIp(req),
    })
    res.status(200).json(buildSuccess(requestId, { source }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/craft/sources/:sourceId/revoke', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const admin = await requireAdmin(req)
    requireSuperAdmin(admin)
    const body = parseBody(corpusSourceRevokeSchema, req.body, '请填写撤权原因。')
    const receipt = await revokeCorpusSource({ actorUserId: admin.id, sourceId: req.params.sourceId, admin: true, reason: body.reason })
    await recordAdminAuditLog({
      adminId: admin.id, action: 'craft.source_revoke', targetType: 'corpus_source', targetId: req.params.sourceId,
      detail: { receiptHash: receipt.receiptHash }, ip: getRequestIp(req),
    })
    res.status(200).json(buildSuccess(requestId, { receipt }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

/* ---------------- 用户反馈 / 建议 ---------------- */

const feedbackStatusSchema = z.object({ status: z.enum(['pending', 'accepted', 'ignored']) })

router.get('/feedback', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const status = req.query.status
    const kind = req.query.kind
    const payload = await listAdminFeedbacksData({
      status: status === 'pending' || status === 'accepted' || status === 'ignored' ? status : undefined,
      kind: kind === 'bug' || kind === 'suggestion' ? kind : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      page: parsePositiveInt(req.query.page, 1),
      pageSize: parsePositiveInt(req.query.pageSize, 20),
    })
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/feedback/:feedbackId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const feedback = await getAdminFeedbackDetailData(req.params.feedbackId)
    if (!feedback) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '反馈不存在。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, { feedback }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

/** 标记已采纳/已忽略，或撤销回待处理（status = pending 即撤销） */
router.post('/feedback/:feedbackId/status', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const admin = await requireAdmin(req)
    const body = parseBody(feedbackStatusSchema, req.body, '请选择要执行的处理动作。')
    const result = await setFeedbackStatusData(req.params.feedbackId, body.status, admin.id)
    if (!result) {
      res.status(404).json(buildError(requestId, 'NOT_FOUND', '反馈不存在。'))
      return
    }

    await recordAdminAuditLog({
      adminId: admin.id,
      action: 'feedback.status',
      targetType: 'feedback',
      targetId: req.params.feedbackId,
      detail: { kind: result.kind, from: result.previousStatus, to: body.status },
      ip: getRequestIp(req),
    })
    res.status(200).json(buildSuccess(requestId, { ok: true }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/logs', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    await requireAdmin(req)
    const payload = await listAdminAuditLogsData({
      action: typeof req.query.action === 'string' ? req.query.action : undefined,
      targetType: typeof req.query.targetType === 'string' ? req.query.targetType : undefined,
      page: parsePositiveInt(req.query.page, 1),
      pageSize: parsePositiveInt(req.query.pageSize, 20),
    })
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

export default router
