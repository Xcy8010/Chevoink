import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { activeChapterScope } from '../data/internal.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { runtimeJson } from './runtime-common.js'

type Subject = { userId: string; novelId: string; runId: string }
const bodyWriters = new Set(['chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_create'])
const diff = z.object({ kind: z.literal('chapterDiff'), chapterId: z.string(), before: z.string(), after: z.string(), revision: z.number().int().positive() })
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Saved text is a fact independent of compiler/report stages. A successful
 * same-task body effect must match the current owned manuscript. This does not
 * certify literary goals, report completion or unknown provider outcomes. */
export async function readCurrentSavedTaskChapters(tx: Prisma.TransactionClient, subject: Subject) {
  const original = await readOriginalTaskRequest(tx, subject)
  const runIds = await originalTaskRunIds(tx, subject, original)
  const proofs = new Map<string, { after: string; revision: number; sourceHash: string }>()
  const observe = (name: unknown, display: unknown, source: unknown) => {
    if (typeof name !== 'string' || !bodyWriters.has(name)) return
    const parsed = diff.safeParse(display)
    if (!parsed.success || !parsed.data.after.trim() || parsed.data.before === parsed.data.after) return
    proofs.set(parsed.data.chapterId, { after: parsed.data.after, revision: parsed.data.revision, sourceHash: runtimeJson(source).hash })
  }
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId }, select: { taskRootId: true } })
  if (run?.taskRootId) {
    const state = await (await import('./runtime-state.js')).readExecutionStateInTransaction(tx, run.taskRootId)
    const evidence = await (await import('./runtime-evidence.js')).collectDurableToolEvidence(tx, run.taskRootId, state.frame.revision)
    for (const effect of evidence.effects) {
      if (!bodyWriters.has(effect.action)) continue
      const receipt = await tx.agentEffectReceipt.findUniqueOrThrow({ where: { operationId: effect.operationId } })
      observe(effect.action, object(object(receipt.result).toolResult).display, { operationId: effect.operationId, resultHash: receipt.resultHash })
    }
  } else {
    const messages = await tx.agentMessage.findMany({ where: { runId: { in: runIds }, role: 'assistant', run: { userId: subject.userId, novelId: subject.novelId } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, parts: true } })
    for (const message of messages) for (const part of Array.isArray(message.parts) ? message.parts : []) {
      const saved = object(part)
      if (saved.type === 'tool-call' && saved.status === 'success') observe(saved.toolName, saved.display, { messageId: message.id, callId: saved.callId, display: saved.display })
    }
  }
  if (!proofs.size) return []
  const chapters = await tx.chapter.findMany({ where: { authorId: subject.userId, ...activeChapterScope(subject.novelId), id: { in: [...proofs.keys()] } },
    select: { id: true, title: true, orderIndex: true, content: true, revision: true }, orderBy: { orderIndex: 'asc' } })
  return chapters.flatMap(chapter => {
    const proof = proofs.get(chapter.id)!
    return chapter.content === proof.after && chapter.revision >= proof.revision
      ? [{ ...chapter, contentHash: runtimeJson({ content: chapter.content }).hash, sourceHash: proof.sourceHash }] : []
  })
}
