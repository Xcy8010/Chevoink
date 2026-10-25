import { Router } from 'express'
import { z } from 'zod'
import { submitManualReviewRepairSchema } from '../../shared/contracts/manual-review-repair.js'
import { requireSessionUserId } from '../lib/auth-session.js'
import { buildSuccess, createRequestId } from '../lib/http.js'
import { parseBody } from '../lib/parse-body.js'
import { sendRouteError } from '../lib/route-error.js'
import { readManualReviewRepair, quoteManualReviewRepair, submitManualReviewRepair } from '../lib/agent/manual-review-repair-service.js'

const router = Router()
router.get('/runs/:runId/manual-review-repair', async (req, res) => {
  const requestId = createRequestId()
  try { res.json(buildSuccess(requestId, await readManualReviewRepair(requireSessionUserId(req), String(req.params.runId)))) }
  catch (error) { sendRouteError(res, requestId, error) }
})
router.post('/runs/:runId/manual-review-repair/quote', async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req)
    parseBody(z.object({}).strict(), req.body, '修复报价参数无效。')
    res.json(buildSuccess(requestId, await quoteManualReviewRepair(userId, String(req.params.runId))))
  } catch (error) { sendRouteError(res, requestId, error) }
})
router.post('/runs/:runId/manual-review-repair', async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req), body = parseBody(submitManualReviewRepairSchema, req.body, '请明确确认本次额外完整修复。')
    res.json(buildSuccess(requestId, await submitManualReviewRepair(userId, String(req.params.runId), body)))
  } catch (error) { sendRouteError(res, requestId, error) }
})
export default router
