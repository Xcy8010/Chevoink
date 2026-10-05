import { Router } from 'express'
import { z } from 'zod'
import { env } from '../config/env.js'
import { actOnAgentGoalSchema, createAgentGoalSchema, updateAgentGoalSchema } from '../../shared/contracts/agent-goal.js'
import { requireSessionUserId } from '../lib/auth-session.js'
import { createRequestId, buildSuccess } from '../lib/http.js'
import { parseBody } from '../lib/parse-body.js'
import { sendRouteError } from '../lib/route-error.js'
import { prisma } from '../lib/prisma.js'
import { actOnAgentGoal, createAgentGoal, readAgentGoal, readAgentGoalDetail, updateAgentGoal } from '../lib/agent/goal-service.js'

const router = Router()
router.get('/goal-capabilities', (req, res) => {
  const requestId = createRequestId()
  try {
    requireSessionUserId(req)
    res.json(buildSuccess(requestId, { enabled: env.agentGoalEnabled }))
  } catch (error) { sendRouteError(res, requestId, error) }
})
router.get('/sessions/:sessionId/goal', async (req, res) => {
  const requestId = createRequestId()
  try { res.json(buildSuccess(requestId, await readAgentGoal(requireSessionUserId(req), String(req.params.sessionId)))) }
  catch (error) { sendRouteError(res, requestId, error) }
})
router.post('/sessions/:sessionId/goals', async (req, res) => {
  const requestId = createRequestId()
  try { res.json(buildSuccess(requestId, await createAgentGoal(requireSessionUserId(req), { sessionId: String(req.params.sessionId) },
    parseBody(createAgentGoalSchema, req.body, '目标参数无效。'), { authenticatedHttp: true }))) }
  catch (error) { sendRouteError(res, requestId, error) }
})
// New local window: session + goal + initial scheduling intent commit atomically.
router.post('/goals', async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(createAgentGoalSchema.extend({ novelId: z.string().min(1).max(64) }), req.body, '目标参数无效。')
    const { novelId, ...input } = body
    res.json(buildSuccess(requestId, await createAgentGoal(userId, { novelId }, input, { authenticatedHttp: true })))
  } catch (error) { sendRouteError(res, requestId, error) }
})
router.patch('/sessions/:sessionId/goals/:goalId', async (req, res) => {
  const requestId = createRequestId()
  try { res.json(buildSuccess(requestId, await updateAgentGoal(requireSessionUserId(req), String(req.params.sessionId), String(req.params.goalId),
    parseBody(updateAgentGoalSchema, req.body, '目标修改参数无效。')))) }
  catch (error) { sendRouteError(res, requestId, error) }
})
router.post('/sessions/:sessionId/goals/:goalId/actions', async (req, res) => {
  const requestId = createRequestId()
  try { res.json(buildSuccess(requestId, await actOnAgentGoal(requireSessionUserId(req), String(req.params.sessionId), String(req.params.goalId),
    parseBody(actOnAgentGoalSchema, req.body, '目标操作无效。'), { authenticatedHttp: true }))) }
  catch (error) { sendRouteError(res, requestId, error) }
})
router.get('/sessions/:sessionId/goals/:goalId', async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req)
    const cursor = parseBody(z.object({ revision: z.coerce.number().int().positive().optional(), evidence: z.string().min(1).max(64).optional() }), req.query, '分页参数无效。')
    res.json(buildSuccess(requestId, await readAgentGoalDetail(userId, String(req.params.sessionId), String(req.params.goalId), cursor)))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.get('/sessions/:sessionId/goal-events', async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req), sessionId = String(req.params.sessionId)
    const cursor = parseBody(z.coerce.number().int().nonnegative().max(2_147_483_647), req.query.afterSequence ?? req.headers['last-event-id'] ?? 0, '事件位置无效。')
    // Scope is authenticated before headers. Event IDs never authorize another session.
    const snapshot = await readAgentGoal(userId, sessionId)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
    let sequence = cursor, closed = false, reading = false, ticks = 0
    const close = () => { closed = true; clearInterval(timer); if (!res.writableEnded) res.end() }
    const poll = async () => {
      if (closed || reading) return
      reading = true
      try {
        if (!await prisma.agentSession.findFirst({ where: { id: sessionId, userId }, select: { id: true } })) { close(); return }
        const events = await prisma.agentGoalEvent.findMany({ where: { sessionId, sequence: { gt: sequence } }, orderBy: { sequence: 'asc' }, take: 201 })
        if (events.length > 200) {
          sequence = events[events.length - 1].sequence
          res.write(`id: ${sequence}\nevent: reset\ndata: ${JSON.stringify(await readAgentGoal(userId, sessionId))}\n\n`)
        } else for (const event of events) {
          if (closed) break
          sequence = event.sequence
          res.write(`id: ${sequence}\nevent: goal\ndata: ${JSON.stringify({ sequence, goalId: event.goalId, sessionId,
            stateVersion: event.stateVersion, goalRevision: event.goalRevision, type: event.type, snapshot: event.payload })}\n\n`)
        }
        if (++ticks % 15 === 0 && !closed) res.write(': heartbeat\n\n')
      } catch { close() }
      finally { reading = false }
    }
    const timer = setInterval(() => { void poll() }, 1000)
    timer.unref()
    res.on('close', close)
    void poll()
  } catch (error) { if (!res.headersSent) sendRouteError(res, requestId, error); else res.end() }
})

export default router
