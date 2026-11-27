import type { AgentSafetyEvent, Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { DataAccessError, prisma } from './prisma.js'
import { readHumanAdmission } from './agent/goal-activation-authority.js'
import { changeRestriction, governanceAvailableFor, issueRestrictions, lockGovernanceAccount } from './governance-restrictions.js'
import { queueGovernanceMail } from './governance-mail.js'
import type { z } from 'zod'
import type { safetyReviewSchema } from '../../shared/contracts/governance-restrictions.js'

type Tx = Prisma.TransactionClient
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
