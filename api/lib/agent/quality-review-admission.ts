import type { AgentRun, Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { readHumanAdmission } from './goal-activation-authority.js'
import { readGoalConsentSourceRun } from './goal-consent.js'
import { runtimeJson } from './runtime-common.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export type QualityReviewAdmission = { id: string; at: Date }

/** Reuse actual author admissions. A new run, copied request, ordinary worker
 * restart or new compilation never grants another paid recovery by itself. */
export async function readQualityReviewAdmission(tx: Prisma.TransactionClient, run: AgentRun): Promise<QualityReviewAdmission | null> {
  if (run.taskRootId) {
    let source: AgentRun
    try { source = await readGoalConsentSourceRun(tx, run) } catch (error) {
      if (error instanceof DataAccessError) return null
      throw error
    }
    if (source.id !== run.id) {
      // readGoalConsentSourceRun verifies the owned root, pause receipt and frame.
      const resumed = await tx.agentExecutionOutbox.findFirst({ where: { taskRootId: run.taskRootId,
        runId: run.id, type: 'run.resume.queued' } })
      return resumed ? { id: resumed.eventKey, at: resumed.createdAt } : null
    }
  } else {
    const starts = await tx.agentRunEvent.findMany({ where: { runId: run.id, type: 'run.started' }, orderBy: { seq: 'desc' } })
    for (const start of starts) {
      const proof = object(object(start.payload).authorContinue)
      if (typeof proof.eventId !== 'string' || !Number.isSafeInteger(proof.afterSeq) || start.seq !== Number(proof.afterSeq) + 1) continue
      const terminal = await tx.agentRunEvent.findFirst({ where: { id: proof.eventId, runId: run.id,
        type: { in: ['run.paused', 'run.finished'] }, seq: { lte: Number(proof.afterSeq) } } })
      if (!terminal || await tx.agentRunEvent.count({ where: { runId: run.id, type: { in: ['run.paused', 'run.finished'] },
        seq: { gt: terminal.seq, lt: start.seq } } })) continue
      const first = [...starts].reverse().find(candidate => {
        const marker = object(object(candidate.payload).authorContinue)
        return marker.eventId === terminal.id && Number.isSafeInteger(marker.afterSeq)
          && Number(marker.afterSeq) >= terminal.seq && candidate.seq === Number(marker.afterSeq) + 1
      })!
      return { id: `author-continue:${terminal.id}`, at: first.createdAt }
    }
  }
  const admission = readHumanAdmission(run.startRequest)
  if (!admission || admission.request.sessionId !== run.sessionId || admission.request.novelId !== run.novelId) return null
  const message = await tx.agentMessage.findFirst({ where: { runId: run.id, sessionId: run.sessionId, role: 'user' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const parts = [{ type: 'text', text: admission.request.prompt }, ...(admission.request.attachments ?? []).map(part => ({
    type: 'attachment', kind: part.kind, name: part.name, url: part.url, size: part.size,
  }))]
  return message && runtimeJson(message.parts).hash === runtimeJson(JSON.parse(JSON.stringify(parts))).hash
    ? { id: `author-message:${message.id}`, at: message.createdAt } : null
}
