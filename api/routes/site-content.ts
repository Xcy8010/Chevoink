import { Router } from 'express'
import { z } from 'zod'
import { contentDraftSchema } from '../../shared/contracts/site-content.js'
import { requireAdmin, getRequestIp } from '../lib/admin-auth.js'
import { createSiteContent, listSiteContent, mutateSiteContent, readPublicSiteContent } from '../lib/site-content.js'
import { parseBody } from '../lib/parse-body.js'
import { buildSuccess, createRequestId } from '../lib/http.js'
import { sendRouteError } from '../lib/route-error.js'

export const publicSiteContentRouter = Router()
publicSiteContentRouter.get('/', async (_req,res) => {
  const requestId = createRequestId()
  try { res.json(buildSuccess(requestId,await readPublicSiteContent())) } catch(error) { sendRouteError(res,requestId,error) }
})
const router = Router()
router.get('/',async(req,res)=>{
  const requestId = createRequestId()
  try { await requireAdmin(req); res.json(buildSuccess(requestId,await listSiteContent())) } catch(error) { sendRouteError(res,requestId,error) }
})
router.post('/',async(req,res)=>{
  const requestId = createRequestId()
  try { const actor=await requireAdmin(req); const input=parseBody(contentDraftSchema,req.body,'内容格式不正确。'); res.status(201).json(buildSuccess(requestId,await createSiteContent(input,actor.id,getRequestIp(req)))) } catch(error) { sendRouteError(res,requestId,error) }
})
const operationSchema = z.object({expectedRevision:z.number().int().positive(),action:z.enum(['save','publish','withdraw','delete','restore']),draft:contentDraftSchema.optional(),replace:z.object({id:z.string().min(1).max(64),expectedRevision:z.number().int().positive()}).optional()}).refine(input => !input.replace || input.action === 'publish','只有发布可以替换公告')
router.post('/:id',async(req,res)=>{
  const requestId = createRequestId()
  try { const actor=await requireAdmin(req); const input=parseBody(operationSchema,req.body,'内容操作格式不正确。'); res.json(buildSuccess(requestId,await mutateSiteContent(req.params.id,input,actor.id,getRequestIp(req)))) } catch(error) { sendRouteError(res,requestId,error) }
})
export default router