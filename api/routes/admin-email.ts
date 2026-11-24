import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import {
  ADMIN_EMAIL_BATCH_LIMIT, ADMIN_EMAIL_PURPOSE, ADMIN_EMAIL_TEMPLATE,
  adminEmailPurposeSchema, adminEmailSelectionSchema, adminEmailConfirmSchema, adminEmailId, adminEmailPreviewSchema, type AdminEmailInfo, type AdminEmailMode,
} from '../../shared/contracts/admin-email.js'
import { getRequestIp, requireAdmin } from '../lib/admin-auth.js'
import { cancelEmailBatch, confirmEmailBatch, createEmailPreview, getEmailBatch, listEmailBatches, listEmailCandidates } from '../lib/admin-email-batches.js'
import { configuredAdminEmailDelivery } from '../lib/admin-email-config.js'
import type { AdminEmailDelivery } from '../lib/admin-email-provider.js'
import { buildSuccess, createRequestId } from '../lib/http.js'
import { parseBody } from '../lib/parse-body.js'
import { emailLibraryEntrySchema, type EmailLibraryEntry } from '../../shared/contracts/email-library.js'
import { DataAccessError, prisma } from '../lib/prisma.js'
import { sendRouteError } from '../lib/route-error.js'

const router = Router()
const candidateQuery = z.object({ purpose: adminEmailPurposeSchema.default(ADMIN_EMAIL_PURPOSE), search: z.string().trim().max(100).default(''), page: z.coerce.number().int().min(1).max(10_000).default(1) })

function emailAction(handler: (req: Request, adminId: string, delivery: AdminEmailDelivery) => unknown) {
  return async (req: Request, res: Response) => {
    const requestId = createRequestId()
    try {
      const admin = await requireAdmin(req)
      if (!admin.isSuperAdmin) throw new DataAccessError(403, 'SUPER_ADMIN_REQUIRED', '定向邮件仅限超级管理员。')
      res.json(buildSuccess(requestId, await handler(req, admin.id, configuredAdminEmailDelivery())))
    } catch (error) {
      sendRouteError(res, requestId, error)
    }
  }
}

function assertDeliveryMode(expected: AdminEmailMode, delivery: AdminEmailDelivery) {
  if (expected !== delivery.mode) {
    throw new DataAccessError(409, 'ADMIN_EMAIL_MODE_CHANGED', '邮件发送模式已变化，请刷新后重新预览。')
  }
}

router.get('/segments', emailAction(async () => ({
  items: await prisma.$queryRaw`SELECT id, name, filters FROM admin_email_segments ORDER BY created_at DESC, id DESC`,
})))
router.post('/segments', emailAction(async req => {
  const { name, filters } = parseBody(z.object({name:z.string().trim().min(1).max(48), filters:z.unknown()}), req.body, '请输入分群名称和筛选条件。')
  const selection = parseBody(adminEmailSelectionSchema, { mode:'filter', filters }, '分群条件无效。')
  if(selection.mode !== 'filter') throw new DataAccessError(400,'INVALID_FILTER','分群条件无效。')
  const id = randomUUID()
  const saved = await prisma.$executeRaw`INSERT INTO admin_email_segments (id,name,filters) VALUES (${id},${name},${JSON.stringify(selection.filters)}::jsonb) ON CONFLICT (name) DO NOTHING`
  if (!saved) throw new DataAccessError(409,'EMAIL_SEGMENT_EXISTS','已有同名分群标签。')
  return { id, name, filters:selection.filters }
}))
router.get('/templates', emailAction(async () => ({
  items: await prisma.$queryRaw<EmailLibraryEntry[]>`SELECT id, name, subject, body FROM admin_email_templates ORDER BY created_at DESC, id DESC`,
})))
router.post('/templates', emailAction(async req => {
  const template = parseBody(emailLibraryEntrySchema, req.body, '模板 ID、名称、主题或正文无效。')
  const rows = await prisma.$executeRaw`INSERT INTO admin_email_templates (id, name, subject, body)
    VALUES (${template.id}, ${template.name}, ${template.subject}, ${template.body}) ON CONFLICT (id) DO NOTHING`
  if (!rows) throw new DataAccessError(409, 'EMAIL_TEMPLATE_EXISTS', '这个模板 ID 已在模板库中。')
  return template
}))

router.get('/settings', emailAction((_, __, delivery): AdminEmailInfo => ({
  mode: delivery.mode, template: ADMIN_EMAIL_TEMPLATE, purpose: ADMIN_EMAIL_PURPOSE, batchLimit: ADMIN_EMAIL_BATCH_LIMIT,
})))
router.get('/candidates', emailAction((req, _, delivery) => {
  const { search, page, purpose } = parseBody(candidateQuery, req.query, '收件人搜索条件无效。')
  return listEmailCandidates(search, page, delivery, purpose)
}))
router.get('/batches', emailAction((_, adminId, delivery) => listEmailBatches(adminId, delivery.mode)))
router.post('/previews', emailAction((req, adminId, delivery) => {
  const { mode, selection, replaces, campaign, customTemplate } = parseBody(adminEmailPreviewSchema, req.body, '收件条件无效。')
  assertDeliveryMode(mode, delivery)
  return createEmailPreview(adminId, selection, { replaces, delivery, campaign, customTemplate })
}))
router.get('/batches/:batchId', emailAction((req, adminId, delivery) => {
  const batchId = parseBody(adminEmailId, req.params.batchId, '邮件批次无效。')
  return getEmailBatch(adminId, batchId, delivery.mode)
}))
router.post('/batches/:batchId/confirm', emailAction((req, adminId, delivery) => {
  const batchId = parseBody(adminEmailId, req.params.batchId, '邮件批次无效。')
  const { mode, previewHash } = parseBody(adminEmailConfirmSchema, req.body, '邮件预览无效。')
  assertDeliveryMode(mode, delivery)
  return confirmEmailBatch(adminId, batchId, previewHash, getRequestIp(req), undefined, delivery)
}))
router.post('/batches/:batchId/cancel', emailAction((req, adminId, delivery) => {
  const batchId = parseBody(adminEmailId, req.params.batchId, '邮件批次无效。')
  return cancelEmailBatch(adminId, batchId, getRequestIp(req), delivery.mode)
}))

export default router
