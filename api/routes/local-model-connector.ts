import { Router, json } from 'express'
import { z } from 'zod'
import { authenticateConnector } from '../lib/local-model-transport.js'
import { localModelBroker } from '../lib/local-model-broker.js'
import { buildSuccess, createRequestId } from '../lib/http.js'
import { sendRouteError } from '../lib/route-error.js'
import { parseBody } from '../lib/parse-body.js'

const router = Router()
const frameSchema = z.object({ sequence: z.number().int().min(0).max(100000), status: z.number().int().min(200).max(599).optional(),
  contentType: z.enum(['text/event-stream', 'application/json']).optional(), chunk: z.string().max(44000).optional(), done: z.boolean().optional(), error: z.boolean().optional() }).strict()
router.use(async (req, res, next) => {
  try { const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''; res.locals.connector = await authenticateConnector(token); next() }
  catch (error) { sendRouteError(res, createRequestId(), error) }
})
router.use(json({ limit: '64kb' }))
router.get('/poll', async (_req, res) => {
  const requestId = createRequestId(), controller = new AbortController()
  res.once('close', () => controller.abort())
  try {
    const job = await localModelBroker.poll(res.locals.connector.key, controller.signal)
    if (!controller.signal.aborted) res.json(buildSuccess(requestId, { job }))
  } catch (error) { if (!controller.signal.aborted) sendRouteError(res, requestId, error) }
})
router.post('/responses/:id', async (req, res) => {
  const requestId = createRequestId()
  try {
    const frame = parseBody(frameSchema, req.body, '连接器响应无效。')
    await localModelBroker.frame(res.locals.connector.key, req.params.id, frame)
    res.json(buildSuccess(requestId, { ok: true }))
  } catch (error) { sendRouteError(res, requestId, error) }
})
router.get('/requests/:id', (req, res) => {
  res.json(buildSuccess(createRequestId(), { active: localModelBroker.active(res.locals.connector.key, req.params.id) }))
})
export default router
