import { Router } from 'express'
import { z } from 'zod'
import { changeRestrictionSchema, issueRestrictionsSchema, restrictionScopes, safetyReviewSchema } from '../../shared/contracts/governance-restrictions.js'
import { requireAdmin } from '../lib/admin-auth.js'
import { evictUserBanCache } from '../lib/auth-session.js'
import { createRequestId, buildSuccess } from '../lib/http.js'
import { parseBody } from '../lib/parse-body.js'
import { prisma } from '../lib/prisma.js'
import { sendRouteError } from '../lib/route-error.js'
import { requireAppReleaseCapability } from '../lib/app-releases.js'
import { changeRestriction, governanceAvailableFor, issueRestrictions, stopRestrictedAgentWork } from '../lib/governance-restrictions.js'
import { reviewSafetyEvent, updateGovernanceSafetyPolicy } from '../lib/governance-safety.js'

const router = Router()
router.use(['/restrictions', '/safety-events'], async (req, res, next) => {
  try {
    const admin = await requireAdmin(req)
    await requireAppReleaseCapability(req, 'platformGovernance')
    res.locals.governanceActor = admin.id
    res.locals.governanceSuper = admin.isSuperAdmin
    res.setHeader('Cache-Control', 'private, no-store')
    next()
  } catch (error) { sendRouteError(res, createRequestId(), error) }
})
router.post('/safety-events/policy', async (req, res) => {
  const requestId = createRequestId()
  try {
    const policy = await updateGovernanceSafetyPolicy(res.locals.governanceActor, req.body)
    res.json(buildSuccess(requestId, policy))
  } catch (error) { sendRouteError(res, requestId, error) }
})
const filters = z.object({ userId: z.string().max(64).optional(), scope: z.enum(restrictionScopes).optional(),
  status: z.enum(['pending','confirmed','dismissed']).optional(), cursor: z.string().max(64).optional() })
router.get('/restrictions', async (req, res) => {
  const requestId = createRequestId()
  try {
    const { userId, scope, cursor } = parseBody(filters, req.query, '筛选条件无效。')
    const items = await prisma.accountRestriction.findMany({ where: { userId, scope }, take: 51,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    const legacyOnly = Boolean(userId && !await governanceAvailableFor(userId))
    res.json(buildSuccess(requestId, { items: items.slice(0, 50), legacyOnly, nextCursor: items.length > 50 ? items[49].id : null }))
  } catch (error) { sendRouteError(res, requestId, error) }
})
router.post('/restrictions', async (req, res) => {
  const requestId = createRequestId()
  try {
    const body = parseBody(issueRestrictionsSchema, req.body, '请填写处罚范围、期限、原因及协议依据。')
    const items = await prisma.$transaction(tx => issueRestrictions(tx, res.locals.governanceActor, body))
    evictUserBanCache(body.userId)
    const stopping = body.scopes.some(s => s === 'platform' || s === 'agent')
    const taskStopPending = stopping && !await stopRestrictedAgentWork(body.userId).then(()=>true,()=>false)
    res.status(201).json(buildSuccess(requestId, { items, taskStopPending }))
  } catch (error) { sendRouteError(res, requestId, error) }
})
router.patch('/restrictions/:id', async (req, res) => {
  const requestId = createRequestId()
  try {
    const body = parseBody(changeRestrictionSchema, req.body, '请填写操作、期限和复核理由。')
    const row = await prisma.$transaction(tx => changeRestriction(tx, res.locals.governanceActor, req.params.id, body))
    evictUserBanCache(row.userId)
    res.json(buildSuccess(requestId, row))
  } catch (error) { sendRouteError(res, requestId, error) }
})
router.get('/safety-events', async (req, res) => {
  const requestId = createRequestId()
  try {
    const { userId, status, cursor } = parseBody(filters, req.query, '筛选条件无效。')
    const items = await prisma.agentSafetyEvent.findMany({ where: { userId, status }, take: 51,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    const policy = await prisma.agentSafetyPolicy.findUniqueOrThrow({ where: { id: 'active' } })
    res.json(buildSuccess(requestId, { items: items.slice(0,50), policy, canConfigure:res.locals.governanceSuper===true, nextCursor: items.length > 50 ? items[49].id : null }))
  } catch (error) { sendRouteError(res, requestId, error) }
})
router.post('/safety-events/:id/review', async (req, res) => {
  const requestId = createRequestId()
  try {
    const input = parseBody(safetyReviewSchema, req.body, '请填写复核证据、分类和结论。')
    const result = await prisma.$transaction(tx => reviewSafetyEvent(tx, res.locals.governanceActor, req.params.id, input))
    evictUserBanCache(result.userId)
    const taskStopPending = result.applied && result.level === 'platform' && !await stopRestrictedAgentWork(result.userId).then(()=>true,()=>false)
    res.json(buildSuccess(requestId, {...result, taskStopPending}))
  } catch (error) { sendRouteError(res, requestId, error) }
})
export default router
