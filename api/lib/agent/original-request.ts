import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { runtimeJson } from './runtime-common.js'

type Subject = { userId: string; novelId: string; runId: string }
type OriginalRequest = { prompt: string | null; spec: unknown; taskId: string; sourceRunId: string; parentRunId: string | null }
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
function originalPrompt(value: unknown): string | null {
  const object = record(value)
  if (typeof object?.prompt === 'string') return object.prompt
  const texts = Array.isArray(value) ? value.flatMap(part => {
    const item = record(part)
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
  }) : []
  return texts.length ? texts.join('\n') : null
}

/** Read the authenticated admission lineage, never a tool answer, summary or
 * child's generated brief. Saved inputs and their hashes are left untouched. */
export async function readOriginalTaskRequest(tx: Prisma.TransactionClient, subject: Subject): Promise<OriginalRequest> {
  let run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  if (!run) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '原任务身份无法核实。')
  const incoming = await tx.agentChildExecutionGrant.findUnique({ where: { childRunId: run.id } })
  if (incoming && runtimeJson(incoming.snapshot).hash !== incoming.snapshotHash) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '子任务授权来源损坏。')
  if (incoming) (await import('./runtime-child.js')).verifyChildGrant(incoming)
  const session = await tx.agentSession.findFirst({ where: { id: run.sessionId, userId: subject.userId, novelId: subject.novelId }, select: { spawnedFromRunId: true, spawnedFromSessionId: true } })
  if (!incoming && session?.spawnedFromRunId) {
    const parent = await tx.agentRun.findFirst({ where: { id: session.spawnedFromRunId, sessionId: session.spawnedFromSessionId ?? undefined,
      userId: subject.userId, novelId: subject.novelId }, include: { session: { select: { spawnedFromRunId: true } } } })
    if (!parent || parent.session.spawnedFromRunId) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '派生任务原授权链无法核实。')
    const original = await readOriginalTaskRequest(tx, { ...subject, runId: parent.id })
    return { ...original, parentRunId: parent.id }
  }
  const rootId = incoming?.parentRootId ?? run.taskRootId
  if (rootId) {
    const root = await tx.agentTaskRoot.findFirst({ where: { id: rootId, userId: subject.userId, novelId: subject.novelId } })
    if (!root) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '原任务范围无法核实。')
    if (runtimeJson({ spec: root.specSnapshot, request: root.requestSnapshot }).hash !== root.inputHash) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原任务输入损坏。')
    return { prompt: originalPrompt(root.requestSnapshot),
      spec: root.specSnapshot, taskId: root.id, parentRunId: incoming?.currentParentRunId ?? null, sourceRunId: (await tx.agentRun.findFirst({ where: { taskRootId: root.id, userId: subject.userId, novelId: subject.novelId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } }))?.id ?? run.id }
  }
  const taskId = record(run.taskSpec)?.id
  if (typeof taskId === 'string') {
    run = await tx.agentRun.findFirstOrThrow({ where: { userId: subject.userId, novelId: subject.novelId, sessionId: run.sessionId,
      taskSpec: { path: ['id'], equals: taskId }, incomingChildGrant: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  }
  const request = record(run.startRequest)
  const admissionMessage = request?.prompt ? null : await tx.agentMessage.findFirst({ where: { runId: run.id, role: 'user' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { parts: true } })
  const textParts = Array.isArray(admissionMessage?.parts) ? admissionMessage.parts.flatMap(part => {
    const value = record(part)
    return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }) : []
  const prompt = typeof request?.prompt === 'string' ? request.prompt : textParts.length ? textParts.join('\n') : null
  return { prompt, spec: run.taskSpec, taskId: typeof taskId === 'string' ? taskId : run.id, sourceRunId: run.id, parentRunId: null }
}

/** Audit only runs whose owned admission/child lineage resolves to this same
 * human request. Child briefs and unrelated runs in the session add no scope. */
export async function originalTaskRunIds(tx: Prisma.TransactionClient, subject: Subject, original: OriginalRequest): Promise<string[]> {
  const source = await tx.agentRun.findFirstOrThrow({ where: { id: original.sourceRunId, userId: subject.userId, novelId: subject.novelId } })
  const main = source.taskRootId
    ? await tx.agentRun.findMany({ where: { taskRootId: source.taskRootId, userId: subject.userId, novelId: subject.novelId }, select: { id: true } })
    : await tx.agentRun.findMany({ where: { id: { in: await (await import('./task-lineage.js')).getTaskRunIds(source.sessionId, source.id, tx) },
        userId: subject.userId, novelId: subject.novelId }, select: { id: true } })
  const ids = new Set([source.id, ...main.map(run => run.id)])
  if (source.taskRootId) {
    const grants = await tx.agentChildExecutionGrant.findMany({ where: { parentRootId: source.taskRootId }, include: { childRun: true } })
    for (const grant of grants) {
      (await import('./runtime-child.js')).verifyChildGrant(grant)
      if (grant.childRun.userId !== subject.userId || grant.childRun.novelId !== subject.novelId) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '子任务原授权身份不一致。')
      const childOriginal = await readOriginalTaskRequest(tx, { ...subject, runId: grant.childRunId })
      if (childOriginal.sourceRunId !== source.id) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '子任务不属于原章节请求。')
      ids.add(grant.childRunId)
    }
  } else {
    const children = await tx.agentRun.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
      session: { spawnedFromRunId: { in: [...ids] }, userId: subject.userId, novelId: subject.novelId } }, select: { id: true } })
    for (const child of children) {
      if ((await readOriginalTaskRequest(tx, { ...subject, runId: child.id })).sourceRunId !== source.id) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '派生任务不属于原章节请求。')
      ids.add(child.id)
    }
  }
  return [...ids]
}

export function hasOriginalRepairAuthority(prompt: string | null): boolean {
  if (!prompt) return false
  return prompt.split(/[。！？!?；;\n，,]+/u).some(clause => !/(?:不要|无需|不用|不必|禁止|不得|不能|只读|不改|do not|don't)/iu.test(clause)
    && /(?:修复|修正|纠正|纠错|改写|修改|润色|重写|整改|repair|revise|rewrite|polish|fix\b)/iu.test(clause))
}

export async function assertOriginalRepairAuthority(tx: Prisma.TransactionClient, subject: Subject) {
  if (!hasOriginalRepairAuthority((await readOriginalTaskRequest(tx, subject)).prompt)) {
    throw new DataAccessError(409, 'REPAIR_NOT_AUTHORIZED', '原始请求未授权检查后改写正文；保留报告与当前正文。')
  }
}
