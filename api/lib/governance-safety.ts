import type { AgentSafetyEvent, Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { DataAccessError, prisma } from './prisma.js'
import { readHumanAdmission } from './agent/goal-activation-authority.js'
import { changeRestriction, governanceAvailableFor, issueRestrictions, lockGovernanceAccount } from './governance-restrictions.js'
import { queueGovernanceMail } from './governance-mail.js'
import { z } from 'zod'
import { env } from '../config/env.js'
import { selectAppReleaseForUser } from './app-releases.js'
import { effectiveRestrictionWhere } from './governance-access.js'
import { parseBody } from './parse-body.js'
import type { safetyReviewSchema } from '../../shared/contracts/governance-restrictions.js'

type Tx = Prisma.TransactionClient

const policyUpdateSchema = z.object({
  mode: z.enum(['observe', 'enforce']),
  windowDays: z.number().int().min(1).max(365),
  banDays: z.number().int().min(1).max(365),
  reason: z.string().trim().min(1).max(1000),
  expectedUpdatedAt: z.string().datetime(),
  confirmEnforcement: z.boolean().optional(),
}).refine(input => input.mode !== 'enforce' || input.confirmEnforcement === true)

export async function updateGovernanceSafetyPolicy(actorId: string, input: unknown) {
  return prisma.$transaction(async tx => {
    if (!actorId) throw new DataAccessError(403, 'SUPER_ADMIN_REQUIRED', '策略变更仅限超级管理员。')
    await lockGovernanceAccount(tx, actorId)
    const actor = await tx.user.findFirst({
      where: {
        id: actorId, role: 'admin', isSuperAdmin: true, bannedAt: null,
        accountRestrictions: { none: { scope: 'platform', ...effectiveRestrictionWhere(new Date()) } },
      },
      select: { id: true },
    })
    if (!actor) throw new DataAccessError(403, 'SUPER_ADMIN_REQUIRED', '策略变更仅限超级管理员。')
    // Keep the effective assignments fixed until the policy and its audit entry commit.
    await tx.$queryRaw`SELECT channel FROM app_release_channels WHERE channel IN ('stable', 'test') ORDER BY channel FOR SHARE`
    if (!await governanceAvailableFor(actor.id, tx)) {
      throw new DataAccessError(403, 'APP_RELEASE_CAPABILITY_DISABLED', '当前账号尚未开放平台治理。')
    }
    const policy = parseBody(policyUpdateSchema, input, '请确认模式、期限和变更理由。')
    if (policy.mode === 'enforce' && env.appEnv === 'production') {
      const stable = await selectAppReleaseForUser(null, tx)
      if (stable.mode !== 'artifact' || !stable.release?.capabilities.includes('platformGovernance')) {
        throw new DataAccessError(409, 'GOVERNANCE_STABLE_REQUIRED', '匿名稳定版开放平台治理后才能启用自动处置。')
      }
    }

    const previous = await tx.agentSafetyPolicy.findUniqueOrThrow({ where: { id: 'active' } })
    const stale = () => new DataAccessError(409, 'POLICY_CHANGED', '策略已更新，请刷新后重试。')
    if (previous.updatedAt.getTime() !== Date.parse(policy.expectedUpdatedAt)) throw stale()
    const after = { mode: policy.mode, windowDays: policy.windowDays, banDays: policy.banDays }
    const next = { ...after, updatedAt: new Date(Math.max(Date.now(), previous.updatedAt.getTime() + 1)) }
    const updated = await tx.agentSafetyPolicy.updateMany({
      where: { id: 'active', updatedAt: previous.updatedAt }, data: next,
    })
    if (!updated.count) throw stale()
    const before = { mode: previous.mode, windowDays: previous.windowDays, banDays: previous.banDays }
    await tx.adminAuditLog.create({ data: {
      adminId: actor.id, action: 'governance.safety.policy', targetType: 'safety_policy', targetId: 'active',
      detail: { before, after, reason: policy.reason },
    } })
    return next
  })
}

type Reviewed = Pick<AgentSafetyEvent, 'id' | 'createdAt' | 'status' | 'evasion'>
export function assessSafety(events: Reviewed[], windowDays: number, now: Date) {
  const cutoff = now.getTime() - windowDays * 86_400_000
  const confirmed = events.filter(e => e.status === 'confirmed' && e.createdAt.getTime() >= cutoff && e.createdAt <= now)
  const level = confirmed.length >= 5 && confirmed.some(e => e.evasion === 'high') ? 'platform'
    : confirmed.length >= 3 && confirmed.some(e => e.evasion === 'credible' || e.evasion === 'high') ? 'warning' : 'record'
  return { level, eventIds: confirmed.map(e => e.id) }
}

async function originalAction(userId: string, runId: string) {
  const select = { id: true, startRequest: true, session: { select: { spawnedFromRunId: true } }, taskRoot: { select: { sourceMessageId: true } } } as const
  const run = await prisma.agentRun.findFirst({ where: { id: runId, userId }, select })
  if (!run) return null
  const grant = await prisma.agentChildExecutionGrant.findFirst({ where: { childRunId: run.id }, select: { admissionRunId: true } })
  const parentId = grant?.admissionRunId ?? run.session.spawnedFromRunId
  const origin = parentId ? await prisma.agentRun.findFirst({ where: { id: parentId, userId }, select }) : run
  if (!origin || !readHumanAdmission(origin.startRequest)) return null
  return origin.taskRoot ? 'message:' + origin.taskRoot.sourceMessageId : 'run:' + origin.id
}

/** A refusal is a review lead. Preserve only source references, never the manuscript or conversation. */
export async function observeSafetySignal(userId: string, source: string, observationId: string, runId?: string) {
  if (!await governanceAvailableFor(userId)) return
  const actionKey = runId ? await originalAction(userId, runId) : source === 'cover_http' ? 'cover:' + observationId : null
  const key = actionKey ?? 'unverified:' + observationId
  await prisma.agentSafetyEvent.upsert({ where: { userId_actionKey: { userId, actionKey: key } },
    create: { userId, actionKey: key, source, policyVersion: 'generative-content-v1', category: '模型或供应商拦截', status: 'pending', evasion: 'none' }, update: {} })
}

async function correctLinkedActions(tx: Tx, actorId: string, userId: string, invalid: string[], reason: string) {
  const escalations = await tx.agentSafetyEscalation.findMany({ where: { userId, correctedAt: null, eventIds: { hasSome: invalid } } })
  for (const escalation of escalations) {
    const events = await tx.agentSafetyEvent.findMany({ where: { userId, id: { in: escalation.eventIds }, status: 'confirmed' } })
    const remaining = assessSafety(events, escalation.windowDays, escalation.createdAt)
    if (remaining.level === escalation.level || (escalation.level === 'warning' && remaining.level === 'platform')) continue
    if (escalation.restrictionId) {
      const active = await tx.accountRestriction.findUnique({ where: { id: escalation.restrictionId } })
      if (active && !active.revokedAt) {
        await changeRestriction(tx, actorId, active.id, { action: 'revoke', reason }, userId)
      }
    }
    await tx.agentSafetyEscalation.update({ where: { id: escalation.id }, data: { correctedAt: new Date() } })
    await tx.adminAuditLog.create({ data: { adminId: actorId, action: 'governance.safety.correct', targetType: 'safety_escalation', targetId: escalation.id, detail: { userId, reason, invalid } } })
  }
}

export async function correctSafetyEscalation(tx: Tx, actorId: string, escalationId: string, userId: string, reason: string, invalidEventIds: string[]) {
  await lockGovernanceAccount(tx, userId)
  const escalation = await tx.agentSafetyEscalation.findFirst({ where: { id: escalationId, userId, correctedAt: null } })
  if (!escalation || !invalidEventIds.length || invalidEventIds.some(id => !escalation.eventIds.includes(id))) {
    throw new DataAccessError(409, 'SAFETY_CORRECTION_INVALID', '请选择此次提醒中经核实有误的事件。')
  }
  const selected = await tx.agentSafetyEvent.findMany({ where: { userId, id: { in: invalidEventIds }, status: 'confirmed' } })
  if (selected.length !== new Set(invalidEventIds).size) throw new DataAccessError(409, 'SAFETY_EVENT_CHANGED', '选中的事件已变更，请重新核实。')
  await tx.agentSafetyEvent.updateMany({ where: { userId, id: { in: invalidEventIds } }, data: { status: 'dismissed', reviewedAt: new Date(), reviewerId: actorId, reviewReason: reason } })
  await tx.adminAuditLog.createMany({ data: selected.map(event => ({
    adminId: actorId, action: 'governance.safety.review', targetType: 'safety_event', targetId: event.id,
    detail: { userId, escalationId, before: { status: event.status, evasion: event.evasion, evidenceRef: event.evidenceRef }, after: { status: 'dismissed', reason } },
  })) })
  await correctLinkedActions(tx, actorId, userId, invalidEventIds, reason)
}

export async function reviewSafetyEvent(tx: Tx, actorId: string, id: string, input: z.infer<typeof safetyReviewSchema>) {
  const event = await tx.agentSafetyEvent.findUnique({ where: { id } })
  if (!event) throw new DataAccessError(404, 'SAFETY_EVENT_NOT_FOUND', '未找到该事件。')
  const { userId } = event
  await lockGovernanceAccount(tx, userId)
  if (input.decision === 'confirmed' && event.actionKey.startsWith('unverified:')) {
    throw new DataAccessError(409, 'ORIGINAL_ACTION_UNKNOWN', '原始用户动作尚未核实，不能累计违规。')
  }
  const previous = await tx.agentSafetyEvent.findUniqueOrThrow({ where: { id } })
  const now = new Date()
  await tx.agentSafetyEvent.update({ where: { id }, data: { category: input.category, status: input.decision, evasion: input.evasion,
    reviewReason: input.reason, evidenceRef: input.evidenceRef, reviewedAt: now, reviewerId: actorId } })
  await tx.adminAuditLog.create({ data: { adminId: actorId, action: 'governance.safety.review', targetType: 'safety_event', targetId: id,
    detail: { userId, before: { status: previous.status, evasion: previous.evasion, evidenceRef: previous.evidenceRef }, after: input } } })
  await tx.$queryRaw`SELECT id FROM agent_safety_policy WHERE id = 'active' FOR SHARE`
  const policy = await tx.agentSafetyPolicy.findUniqueOrThrow({ where: { id: 'active' } })
  if (previous.status === 'confirmed') await correctLinkedActions(tx, actorId, userId, [id], input.reason)
  const since = new Date(now.getTime() - policy.windowDays * 86_400_000)
  const eligible = await tx.agentSafetyEvent.findMany({ where: { userId, status: 'confirmed', createdAt: { gte: since } } })
  const assessment = assessSafety(eligible, policy.windowDays, now)
  if (policy.mode !== 'enforce' || assessment.level === 'record' || input.decision !== 'confirmed') return { ...assessment, mode: policy.mode, applied: false, userId }
  if (await tx.agentSafetyEscalation.findFirst({ where: { userId, correctedAt: null, level: assessment.level, eventIds: { hasSome: assessment.eventIds } } })) return { ...assessment, mode: policy.mode, applied: false, userId }
  if (!await governanceAvailableFor(userId, tx)) throw new DataAccessError(403, 'APP_RELEASE_CAPABILITY_DISABLED', '该账号尚未开放治理测试。')
  const escalationId = randomUUID()
  let restrictionId: string | null = null
  if (assessment.level === 'platform') {
    const [restriction] = await issueRestrictions(tx, actorId, { userId, scopes: ['platform'], confirmPlatform: true, sourceId: escalationId,
      reason: input.reason, clause: '用户服务协议第五至七节', expiresAt: new Date(now.getTime() + policy.banDays * 86_400_000).toISOString() })
    restrictionId = restriction.id
  } else {
    await queueGovernanceMail(tx, { userId, eventId: escalationId, kind: 'warning', reason: input.reason })
  }
  await tx.agentSafetyEscalation.create({ data: { id: escalationId, userId, eventId: id, eventIds: assessment.eventIds, windowDays: policy.windowDays, level: assessment.level, restrictionId } })
  return { ...assessment, mode: policy.mode, applied: true, userId }
}
