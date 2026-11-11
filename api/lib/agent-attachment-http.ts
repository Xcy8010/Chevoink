import path from 'node:path'
import { createHash } from 'node:crypto'
import type { RequestHandler } from 'express'
import { assertStudioAccountAccess } from './account-access.js'
import { getSessionUserId, resolveSessionGate } from './auth-session.js'
import { MANAGED_AGENT_ATTACHMENT_PREFIX, readAuthorizedAgentAttachment } from './agent-attachment-storage.js'
import { DataAccessError } from './prisma.js'

// Existing static namespaces only. Unknown names must not reach the filesystem:
// on Windows, e.g. AGENT-~1 may resolve to the private directory via an 8.3 alias.
// message/feedback image access policy is unchanged by this Agent-attachment gate.
const EXISTING_STATIC_NAMESPACES = new Set([
  'avatars', 'profile-covers', 'novel-covers', 'post-images', 'message-images', 'feedback-images',
])

/** Mounted BEFORE the broad public /api/uploads static handler. */
export const agentAttachmentGateway: RequestHandler = async (req, res, next) => {
  let decoded: string
  try { decoded = decodeURIComponent(req.path) } catch {
    res.status(404).end()
    return
  }
  const normalized = path.posix.normalize(decoded.replace(/\\/g, '/'))
  if (!/^\/agent-attachments(?:[ .:]|\/|$)/i.test(normalized)) {
    const segments = decoded.slice(1).split('/')
    const canonicalSegments = segments.every(segment => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(segment) && !segment.endsWith('.'))
    if (decoded === req.path && normalized === decoded && canonicalSegments && EXISTING_STATIC_NAMESPACES.has(segments[0])) {
      next()
    } else {
      res.status(404).setHeader('Cache-Control', 'private, no-store')
      res.end()
    }
    return
  }
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  // Never let encoded, repeated-slash or dot aliases reach a second static mount.
  if (decoded !== req.path || normalized !== decoded || !decoded.startsWith('/agent-attachments/')) {
    res.status(404).end()
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).setHeader('Allow', 'GET, HEAD'); res.end(); return }
  try {
    await resolveSessionGate(req, res)
    const userId = getSessionUserId(req)
    if (!userId) throw new DataAccessError(401, 'UNAUTHORIZED', '请登录后查看附件。')
    await assertStudioAccountAccess(userId)
    const url = `${MANAGED_AGENT_ATTACHMENT_PREFIX}${decoded.slice('/agent-attachments/'.length)}`
    const bytes = await readAuthorizedAgentAttachment(url, userId)
    res.type(path.extname(url))
    const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`
    res.setHeader('ETag', etag)
    res.setHeader('Accept-Ranges', 'bytes')
    // Preserve PDF/browser partial reads, but only after identity + content verification.
    const ifRange = req.get('If-Range')
    const ranges = (!ifRange || ifRange === etag) ? req.range(bytes.length) : undefined
    if (ranges === -1) {
      res.status(416).setHeader('Content-Range', `bytes */${bytes.length}`)
      res.end()
      return
    }
    if (ranges && typeof ranges !== 'number' && ranges.type === 'bytes' && ranges.length === 1) {
      const { start, end } = ranges[0]
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`)
      res.send(bytes.subarray(start, end + 1))
      return
    }
    // Authorize and verify bytes even for HEAD/conditional requests; no cached 304 bypass.
    res.status(200).send(bytes)
  } catch (error) {
    const known = error instanceof DataAccessError
    res.status(known ? error.status : 503).json({ success: false, error: {
      code: known ? error.code : 'ATTACHMENT_ACCESS_UNAVAILABLE',
      message: known ? error.message : '暂时无法核验附件归属，请稍后重试。',
    } })
  }
}
