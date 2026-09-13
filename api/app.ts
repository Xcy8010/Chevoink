import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express'
import cors from 'cors'
import agentRoutes from './routes/agent.js'
import adminRoutes from './routes/admin.js'
import aiRoutes from './routes/ai.js'
import authRoutes from './routes/auth.js'
import commentsRoutes from './routes/comments.js'
import changeSetRoutes from './routes/changesets.js'
import conversationsRoutes from './routes/conversations.js'
import feedbackRoutes from './routes/feedback.js'
import homeRoutes from './routes/home.js'
import metaRoutes from './routes/meta.js'
import novelsRoutes from './routes/novels.js'
import novelImportRoutes from './routes/novel-imports.js'
import postsRoutes from './routes/posts.js'
import recommendationsRoutes from './routes/recommendations.js'
import searchRoutes from './routes/search.js'
import topicsRoutes from './routes/topics.js'
import usersRoutes from './routes/users.js'
import creditsRoutes from './routes/credits.js'
import { env } from './config/env.js'
import { getSessionUserId, markSessionUnavailable, resolveSessionGate } from './lib/auth-session.js'
import { getUploadsStaticDirectory } from './lib/avatar-storage.js'
import { agentAttachmentGateway } from './lib/agent-attachment-http.js'
import { prisma } from './lib/prisma.js'

const app: express.Application = express()

app.use(
  cors({
    origin: env.webUrl,
    credentials: true,
  }),
)
// nginx 反代单跳：让 req.ip 取 X-Forwarded-For 首值，
// 限流/审计按真实客户端 IP 分桶（否则反代下全站共享 127.0.0.1 同一桶）
app.set('trust proxy', 1)
// 发帖最多 9 张 base64 配图，预留到 40mb
const standardJson = express.json({ limit: '40mb' })
const standardForm = express.urlencoded({ extended: true, limit: '40mb' })
// Import payloads are parsed only AFTER authentication, using that router's
// narrower JSON limit or its bounded raw-file stream (never Base64).
const isImportRequest = (req: Request) => /^\/api\/novels\/[^/]+\/imports(?:\/|$)/i.test(req.path)
app.use((req, res, next) => isImportRequest(req) ? next() : standardJson(req, res, next))
app.use((req, res, next) => isImportRequest(req) ? next() : standardForm(req, res, next))
// Inspect aliases before public static decoding; every private read uses the same ACL.
app.use('/api/uploads', agentAttachmentGateway)
// 上传图片文件名含随机 ID、内容不可变，30 天强缓存安全（nginx 直服未命中时的兜底）
app.use(
  '/api/uploads',
  express.static(getUploadsStaticDirectory(), { fallthrough: false, maxAge: '30d', immutable: true }),
)

// 动态接口一律禁缓存：WebView/代理缓存 JSON 会让跨设备刷新读到旧的书架/收藏态
// （uploads 静态资源在上面单独挂载，不经过本中间件，强缓存不受影响）
app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})

// 登录态统一闸口：
// 1. 会话识别（access 优先，refresh 兜底）+ 实时封禁检查 + v2 令牌吊销比对；
//    refresh 命中时静默重签双 cookie，前端无感知；
// 2. 在线状态：每次请求刷新 lastActiveAt（内存节流 60s 写一次库），5 分钟内活跃视为在线
const lastActiveWriteAt = new Map<string, number>()
const LAST_ACTIVE_WRITE_INTERVAL_MS = 60_000
app.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    await resolveSessionGate(req, res)
    const userId = getSessionUserId(req)
    if (userId) {
      const now = Date.now()
      if (now - (lastActiveWriteAt.get(userId) ?? 0) >= LAST_ACTIVE_WRITE_INTERVAL_MS) {
        lastActiveWriteAt.set(userId, now)
        // 异步落库不阻塞请求；用户不存在等异常静默忽略
        prisma.user
          .updateMany({ where: { id: userId }, data: { lastActiveAt: new Date(now) } })
          .catch(() => {})
      }
    }
  } catch {
    // Public routes may explicitly serve anonymous data; protected routes get
    // a recoverable 503. Never fall back to signature-only authentication.
    markSessionUnavailable(req)
  }
  next()
})

app.use('/api/agent', agentRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/ai', aiRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/comments', commentsRoutes)
app.use('/api/changesets', changeSetRoutes)
app.use('/api/conversations', conversationsRoutes)
app.use('/api/feedback', feedbackRoutes)
app.use('/api/home', homeRoutes)
app.use('/api/meta', metaRoutes)
app.use('/api/novels/:novelId/imports', novelImportRoutes)
app.use('/api/novels', novelsRoutes)
app.use('/api/posts', postsRoutes)
app.use('/api/recommendations', recommendationsRoutes)
app.use('/api/search', searchRoutes)
app.use('/api/topics', topicsRoutes)
app.use('/api/users', usersRoutes)
app.use('/api/credits', creditsRoutes)

app.get('/api/health', (_req: Request, res: Response): void => {
  res.status(200).json({
    success: true,
    data: {
      status: 'ok',
      appName: env.appName,
      appEnv: env.appEnv,
    },
  })
})

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  // 内部异常细节（可能含 DB 错误/文件路径）只落日志，不回传客户端
  console.error('[unhandled]', error)
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: '服务暂时不可用，请稍后重试。',
    },
  })
})

app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `未找到接口 ${req.method} ${req.originalUrl}`,
    },
  })
})

export default app
