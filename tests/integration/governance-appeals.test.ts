import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
const ready = await verifyTestDatabase(isTestDatabaseRequired())
describe.skipIf(!ready)('independent appeal rights and manual abnormal-use cases', () => {
  it('keeps private cases separate, updates the appealed permission only, and queues one final result', async () => {
    const { prisma } = await import('../../api/lib/prisma.js')
    const { readAppeals, submitAppeal, reviewAppeal } = await import('../../api/lib/governance-appeals.js')
    const { openUsageCase } = await import('../../api/lib/governance-usage-cases.js')
    const { issueRestrictions } = await import('../../api/lib/governance-restrictions.js')
    const ids = Array.from({ length: 3 }, () => randomUUID()),
      [owner, other, admin] = ids,
      req = randomUUID()
    try {
      await prisma.user.createMany({
        data: ids.map((id) => ({ id, nickname: 'Synthetic person', passwordHash: 'unset:synthetic' })),
      })
      const usage = {
        requestKey: randomUUID(),
        userId: owner,
        category: 'billing' as const,
        risk: 'review' as const,
        statement: 'Verify original receipts and the account action',
        evidence: ['synthetic:case-log'],
      }
      await expect(openUsageCase(admin, usage)).rejects.toMatchObject({ status: 400 })
      const risk = await openUsageCase(admin, {
        ...usage,
        evidence: [...usage.evidence, 'synthetic:independent-account-action'],
      })
      expect(risk.id).toBeTruthy()
      expect(await prisma.accountRestriction.count({ where: { userId: owner } })).toBe(0)
      const restrictions = await prisma.$transaction((tx) =>
        issueRestrictions(tx, admin, {
          userId: owner,
          scopes: ['platform', 'agent'],
          expiresAt: null,
          confirmPlatform: true,
          reason: 'Synthetic restriction',
          clause: 'Synthetic terms',
        }),
      )
      const platform = restrictions.find((r) => r.scope === 'platform')!
      expect((await readAppeals(owner)).subjects.map((s) => s.id)).toContain(platform.id)
      expect((await readAppeals(other)).subjects).toHaveLength(0)
      await expect(
        submitAppeal(other, { requestKey: randomUUID(), targetId: platform.id, statement: 'Not the owner' }),
      ).rejects.toMatchObject({ status: 404 })
      const appeal = await submitAppeal(owner, {
        requestKey: req,
        targetId: platform.id,
        statement: 'Synthetic correction',
      })
      expect(
        await submitAppeal(owner, {
          requestKey: req,
          targetId: platform.id,
          statement: 'Synthetic correction',
        }),
      ).toEqual(appeal)
      const events = Array.from({ length: 5 }, () => randomUUID())
      await prisma.agentSafetyEvent.createMany({
        data: events.map((id) => ({
          id,
          userId: owner,
          actionKey: id,
          source: 'synthetic',
          policyVersion: 'test',
          category: 'test',
          status: 'confirmed',
          evasion: 'high',
        })),
      })
      const escalation = await prisma.agentSafetyEscalation.create({
        data: {
          eventId: events[4],
          eventIds: events,
          userId: owner,
          level: 'platform',
          restrictionId: platform.id,
          windowDays: 30,
        },
      })
      await reviewAppeal(admin, appeal.id, {
        status: 'lifted',
        reason: 'Synthetic review reversed this restriction',
        invalidEventIds: [events[4]],
      })
      expect(await prisma.agentSafetyEvent.count({ where: { userId: owner, status: 'confirmed' } })).toBe(4)
      expect(
        (await prisma.agentSafetyEscalation.findUniqueOrThrow({ where: { id: escalation.id } })).correctedAt,
      ).not.toBeNull()
      expect(
        (await prisma.accountRestriction.findUniqueOrThrow({ where: { id: platform.id } })).revokedAt,
      ).not.toBeNull()
      expect(
        await prisma.accountRestriction.count({ where: { userId: owner, scope: 'agent', revokedAt: null } }),
      ).toBe(1)
      expect((await readAppeals(owner)).cases[0]).toMatchObject({
        id: appeal.id,
        status: 'lifted',
        conclusion: 'Synthetic review reversed this restriction',
      })
      expect(
        await prisma.governanceMail.count({
          where: { eventId: 'appeal:' + appeal.id, userId: owner, kind: 'appeal_result' },
        }),
      ).toBe(1)
      await expect(
        reviewAppeal(admin, appeal.id, { status: 'maintained', reason: 'duplicate' }),
      ).rejects.toMatchObject({ status: 409 })
    } finally {
      const rows = await prisma.governanceCase.findMany({ where: { subjectId: owner }, select: { id: true } })
      await prisma.governanceCaseEvent.deleteMany({ where: { caseId: { in: rows.map((r) => r.id) } } })
      await prisma.governanceCase.deleteMany({ where: { subjectId: owner } })
      await prisma.governanceMail.deleteMany({ where: { userId: owner } })
      await prisma.accountRestriction.deleteMany({ where: { userId: owner } })
      await prisma.adminAuditLog.deleteMany({ where: { adminId: admin } })
      await prisma.user.deleteMany({ where: { id: { in: ids } } })
    }
  })
})
