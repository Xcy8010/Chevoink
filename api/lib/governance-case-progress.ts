import { auditCase, caseMissing, notifyCase, reporterReceipt, workdayDue } from './governance-cases.js'
import { prisma, DataAccessError } from './prisma.js'
import { lockAccountKey } from './email-verification.js'

export async function updateCaseProgress(
  id: string,
  actor: string,
  action: 'request_materials' | 'extend',
  reason: string,
  until?: Date,
) {
  return prisma.$transaction(async (tx) => {
    await lockAccountKey(tx, 'case:' + id)
    const item = await tx.governanceCase.findUnique({ where: { id } })
    if (!item) throw caseMissing()
    if (!['pending', 'investigating'].includes(item.status))
      throw new DataAccessError(409, 'CASE_CLOSED', '此案件已结案或已关联。')
    const now = new Date()
    if (
      action === 'extend' &&
      (!until || !item.feedbackBy || now >= item.feedbackBy || until <= item.feedbackBy)
    )
      throw new DataAccessError(
        400,
        'INVALID_EXTENSION',
        '请在原期限内说明延期依据，选择晚于当前期限的预计完成时间。',
      )
    if (action === 'request_materials' && !item.materialsAt)
      throw new DataAccessError(409, 'ALREADY_REQUESTED', '已在等待补充材料。')
    const message =
      action === 'extend'
        ? '处理进展：' + reason + '。预计完成时间 ' + until!.toISOString()
        : '请补充必要材料：' + reason
    await auditCase(tx, actor, id, action, item.status, 'investigating', message)
    await tx.governanceCase.update({
      where: { id },
      data: {
        status: 'investigating',
        acknowledgedAt: item.acknowledgedAt ?? now,
        materialsAt: action === 'request_materials' ? null : item.materialsAt,
        feedbackBy: action === 'request_materials' ? null : until,
        publicProgress: message,
      },
    })
    await notifyCase(tx, item.reporterId, id, message)
    return { id, message }
  })
}
export async function supplementCase(
  id: string,
  proof: { kind: 'appeal'; userId: string } | { kind: 'report'; receipt: string },
  statement: string,
) {
  return prisma.$transaction(async (tx) => {
    await lockAccountKey(tx, 'case:' + id)
    const item = await tx.governanceCase.findUnique({ where: { id } })
    if (
      !item ||
      proof.kind !== item.kind ||
      (proof.kind === 'appeal'
        ? item.reporterId !== proof.userId
        : reporterReceipt(item).receipt !== proof.receipt)
    )
      throw caseMissing()
    if (item.materialsAt || item.status !== 'investigating')
      throw new DataAccessError(409, 'MATERIALS_NOT_REQUESTED', '此案件当前未请求补充材料。')
    const updated = [item.statement, statement].filter(Boolean).join('\n\n')
    if (updated.length > 16000)
      throw new DataAccessError(400, 'EVIDENCE_LIMIT', '请精简至案件所需的必要材料。')
    const now = new Date(),
      message = '已收到补充材料，我们会在 15 个工作日内反馈结果或进展。'
    await tx.governanceCase.update({
      where: { id },
      data: {
        statement: updated,
        materialsAt: now,
        feedbackBy: workdayDue(now, 15),
        publicProgress: message,
        events: { create: { action: 'supplemented', result: 'investigating' } },
      },
    })
    await notifyCase(tx, item.reporterId, id, message)
    return { id, message }
  })
}
