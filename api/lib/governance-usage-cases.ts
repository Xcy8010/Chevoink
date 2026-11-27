import { DataAccessError, prisma } from './prisma.js'
import { auditCase, caseMissing, deadlines, privateDigest } from './governance-cases.js'
import { lockAccountKey } from './email-verification.js'
import type { usageCategories } from '../../shared/contracts/governance-cases.js'
type Input = {
  requestKey: string
  userId: string
  category: keyof typeof usageCategories
  risk: 'observe' | 'review' | 'urgent'
  statement: string
  evidence: string[]
}
export async function openUsageCase(adminId: string, input: Input) {
  const evidence = [...new Set(input.evidence)]
  if (input.risk !== 'observe' && evidence.length < 2)
    throw new DataAccessError(400, 'INDEPENDENT_EVIDENCE_REQUIRED', '升级核查前请列出相互独立的证据来源。')
  return prisma.$transaction(async (tx) => {
    await lockAccountKey(tx, 'report-key:' + input.requestKey)
    const existing = await tx.governanceCase.findUnique({ where: { requestKey: input.requestKey } })
    if (existing) {
      if (
        existing.kind !== 'usage' ||
        existing.subjectId !== input.userId ||
        existing.requesterKey !== privateDigest('admin:' + adminId)
      )
        throw caseMissing()
      return { id: existing.id }
    }
    if (!(await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } })))
      throw caseMissing()
    const row = await tx.governanceCase.create({
      data: {
        requestKey: input.requestKey,
        kind: 'usage',
        category: input.category,
        targetKind: input.risk,
        targetId: input.userId,
        subjectId: input.userId,
        requesterKey: privateDigest('admin:' + adminId),
        statement: input.statement,
        snapshot: evidence.join('\n'),
        ...deadlines(new Date()),
      },
    })
    await auditCase(tx, adminId, row.id, 'open_usage', undefined, 'pending')
    return { id: row.id }
  })
}
