import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { testerUpdateSchema } from '../../shared/contracts/tester.js'
import { requireAdmin, getRequestIp } from '../lib/admin-auth.js'
import { listTesters, updateTester } from '../lib/tester-entitlement.js'
import { parseBody } from '../lib/parse-body.js'
import { buildSuccess, createRequestId } from '../lib/http.js'
import { sendRouteError } from '../lib/route-error.js'
const router = Router()
router.get('/', async (req: Request, res: Response) => {
 const id = createRequestId()
 try { await requireAdmin(req); const query = parseBody(z.object({ q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).max(100000).default(1) }), req.query, '筛选参数无效。'); res.json(buildSuccess(id, await listTesters(query.q, query.page))) }
 catch (error) { sendRouteError(res, id, error) }
})
router.put('/:userId', async (req: Request, res: Response) => {
 const id = createRequestId()
 try { const actor = await requireAdmin(req); const input = parseBody(testerUpdateSchema, req.body, '请填写资格变更原因和有效期。'); res.json(buildSuccess(id, await updateTester(actor.id, req.params.userId, input, getRequestIp(req)))) }
 catch (error) { sendRouteError(res, id, error) }
})
export default router
