import { Router } from 'express'
import { z } from 'zod'
import { changeRestrictionSchema, issueRestrictionsSchema, restrictionScopes, safetyReviewSchema } from '../../shared/contracts/governance-restrictions.js'
import { requireAdmin } from '../lib/admin-auth.js'
import { evictUserBanCache } from '../lib/auth-session.js'
import { createRequestId, buildSuccess } from '../lib/http.js'
import { parseBody } from '../lib/parse-body.js'
import { prisma, DataAccessError } from '../lib/prisma.js'
import { sendRouteError } from '../lib/route-error.js'
import { requireAppReleaseCapability } from '../lib/app-releases.js'
import { changeRestriction, issueRestrictions, stopRestrictedAgentWork } from '../lib/governance-restrictions.js'
import { reviewSafetyEvent } from '../lib/governance-safety.js'

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
const policyUpdate = z.object({ mode:z.enum(['observe','enforce']), windowDays:z.number().int().min(1).max(365),
  banDays:z.number().int().min(1).max(365), reason:z.string().trim().min(1).max(1000), expectedUpdatedAt:z.string().datetime(),
  confirmEnforcement:z.boolean().optional() }).refine(v=>v.mode==='observe'||v.confirmEnforcement===true)
router.post('/safety-events/policy',async(req,res)=>{
  const requestId=createRequestId()
  try {
    if (!res.locals.governanceSuper) throw new DataAccessError(403,'SUPER_ADMIN_REQUIRED','策略变更仅限超级管理员。')
    const input=parseBody(policyUpdate,req.body,'请确认模式、期限和变更理由。')
    const policy=await prisma.$transaction(async tx=>{
      const previous=await tx.agentSafetyPolicy.findUniqueOrThrow({where:{id:'active'}})
      const next={mode:input.mode,windowDays:input.windowDays,banDays:input.banDays,updatedAt:new Date()}
      const updated=await tx.agentSafetyPolicy.updateMany({where:{id:'active',updatedAt:new Date(input.expectedUpdatedAt)},data:next})
      if(!updated.count) throw new DataAccessError(409,'POLICY_CHANGED','策略已更新，请刷新后重试。')
      await tx.adminAuditLog.create({data:{adminId:res.locals.governanceActor,action:'governance.safety.policy',targetType:'safety_policy',targetId:'active',
        detail:{before:{mode:previous.mode,windowDays:previous.windowDays,banDays:previous.banDays},after:{mode:next.mode,windowDays:next.windowDays,banDays:next.banDays},reason:input.reason}}})
      return next
    })
    res.json(buildSuccess(requestId,policy))
  } catch(error){sendRouteError(res,requestId,error)}
})
const filters = z.object({ userId: z.string().max(64).optional(), scope: z.enum(restrictionScopes).optional(),
  status: z.enum(['pending','confirmed','dismissed']).optional(), cursor: z.string().max(64).optional() })
router.get('/restrictions', async (req, res) => {
  const requestId = createRequestId()
  try {
    const { userId, scope, cursor } = parseBody(filters, req.query, '筛选条件无效。')
    const items = await prisma.accountRestriction.findMany({ where: { userId, scope }, take: 51,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    res.json(buildSuccess(requestId, { items: items.slice(0, 50), nextCursor: items.length > 50 ? items[49].id : null }))
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
