import type { Prisma } from '@prisma/client'
import { taskSpecSchema, type TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'
import { runCheckpointSchema } from './checkpoint.js'
import { hasReadOnlyRevisionAssessment, originalLocalEditBoundary } from './local-edit-scope.js'
import { originalTaskRunIds } from './original-request.js'
import { runtimeJson } from './runtime-common.js'
import { composeChapterEdit } from './tools/chapter-patches.js'
import { originalSelectionBoundary, readWritingScope } from './writing-scope.js'

export type LegacyAnchorInputRecovery = { key: string; chapterIds: string[]; sourceMessageIds: string[] }
type Subject = { userId: string; novelId: string; runId: string }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}
const bodyTools = new Set(['chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_create'])
const uncertainTools = new Set([...bodyTools, 'continuity_validate', 'quality_analyze', 'creative_critique'])
const specHash = (spec: TaskSpec) => runtimeJson(JSON.parse(JSON.stringify(spec))).hash

/** Reads server-owned legacy rejection cards, never a model explanation or a
 * session-wide failure. This grants no mutation, progress, budget or retry.
 * The caller must persist the existing one-shot marker before any provider. */
export async function readLegacyAnchorInputRecovery(tx: Prisma.TransactionClient, subject: Subject,
  taskSpec: TaskSpec): Promise<LegacyAnchorInputRecovery | null> {
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  if (!run || run.engine !== 'loop' || run.runtimeProtocolVersion !== 0 || run.taskRootId
    || !['running', 'stopped'].includes(run.status) || object(run.usage).authorEnded !== undefined) return null
  const checkpoint = runCheckpointSchema.safeParse(object(run.usage).checkpoint)
  if (!checkpoint.success || checkpoint.data.version !== 2 || checkpoint.data.stagnantBatches < 4
    || checkpoint.data.inputProtocolRecovery || checkpoint.data.pendingReviews?.length) return null
  try {
    const original = await readWritingScope(tx, subject)
    const frozen = taskSpecSchema.safeParse(original.spec)
    const admitted = taskSpecSchema.safeParse(run.taskSpec)
    if (!frozen.success || !admitted.success || original.parentRunId || !original.prompt?.trim()
      || original.taskId !== taskSpec.id || frozen.data.scope.novelId !== subject.novelId
      || !['write', 'revise'].includes(frozen.data.intent)
      || ['proposal_only', 'conversation_only'].includes(frozen.data.writingPacing ?? '')
      || specHash(frozen.data) !== specHash(taskSpec)
      || specHash(admitted.data) !== specHash(frozen.data)
      || original.writing?.kind !== 'bounded' || !original.writing.targets.length
      || frozen.data.scope.localEditProtocol === 1 && hasReadOnlyRevisionAssessment(original.prompt)) return null
    const ids = await originalTaskRunIds(tx, subject, original)
    if (!ids.includes(run.id) || !ids.includes(original.sourceRunId) || new Set(ids).size !== ids.length) return null
    const history = await tx.agentRun.findMany({ where: { id: { in: ids }, userId: subject.userId, novelId: subject.novelId } })
    if (history.length !== ids.length || history.some(item => {
      const spec = taskSpecSchema.safeParse(item.taskSpec)
      return item.userId !== subject.userId || item.novelId !== subject.novelId || item.engine !== 'loop'
        || item.runtimeProtocolVersion !== 0 || item.taskRootId || item.status === 'cancelled'
        || object(item.usage).authorEnded !== undefined || !spec.success || spec.data.id !== original.taskId
        || spec.data.scope.novelId !== subject.novelId
    })) return null
    if (await tx.agentProviderAttempt.count({ where: { runId: { in: ids }, status: { in: ['prepared', 'dispatching', 'dispatched', 'unknown'] } } })) return null
    const messages = await tx.agentMessage.findMany({ where: { runId: { in: ids }, role: 'assistant',
      run: { userId: subject.userId, novelId: subject.novelId } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 2001 })
    if (messages.length >= 2001 || messages.some(item => !ids.includes(item.runId) || item.role !== 'assistant')) return null
    const candidates = new Map<string, { messageId: string; runId: string; callId: string; args: Record<string, unknown> }>()
    const calls = new Set<string>()
    for (const message of messages) for (const value of Array.isArray(message.parts) ? message.parts : []) {
      const part = object(value)
      if (part.type !== 'tool-call') continue
      if (typeof part.callId !== 'string' || !part.callId) return null
      const callKey = `${message.runId}:${part.callId}`
      if (calls.has(callKey)) return null
      calls.add(callKey)
      const args = object(part.args), display = object(part.display)
      const target = typeof args.chapterId === 'string' ? args.chapterId
        : typeof display.chapterId === 'string' ? display.chapterId : null
      if (part.status === 'running' && uncertainTools.has(String(part.toolName))) return null
      if (part.status === 'success' && (bodyTools.has(String(part.toolName)) || display.kind === 'chapterDiff')) {
        if (target) candidates.delete(target)
        else candidates.clear() // Unknown write target cannot preserve an old witness.
      }
      if (part.toolName !== 'chapter_edit_range' || part.status !== 'failed') continue
      if (target) candidates.delete(target)
      // This exact pre-effect summary was emitted by the old range validator.
      // Old cards have neither output nor failureCode; do not invent either.
      if (part.summary !== '正文片段需要纠正定位' || part.preparing || part.subagentCallId
        || part.snapshot !== undefined || part.display !== undefined || !target || args.chapterId !== target
        || typeof args.oldText !== 'string' || !args.oldText.trim() || typeof args.newText !== 'string'
        || args.oldText === args.newText || args.patches !== undefined || args.start !== undefined || args.end !== undefined
        || part.failureCode !== undefined && part.failureCode !== 'CHAPTER_ANCHOR_CONFLICT') continue
      candidates.set(target, { messageId: message.id, runId: message.runId, callId: part.callId, args })
    }
    if (!candidates.size) return null
    const selection = originalSelectionBoundary(frozen.data), local = originalLocalEditBoundary(frozen.data)
    if (local?.kind === 'needs_input' || local?.version === 3) return null
    const witnesses: Array<Record<string, unknown>> = []
    const sourceMessageIds: string[] = [], chapterIds: string[] = []
    for (const [chapterId, card] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
      const chapter = await tx.chapter.findFirst({ where: { id: chapterId, authorId: subject.userId,
        ...activeChapterScope(subject.novelId) }, select: { id: true, novelId: true, authorId: true, orderIndex: true,
        volumeId: true, orderInVolume: true, revision: true, content: true } })
      if (!chapter || chapter.authorId !== subject.userId || chapter.novelId !== subject.novelId
        || !original.writing.targets.some(target => target.orderIndex === chapter.orderIndex
          && (target.chapterId ?? original.bindings?.targets.find(binding => binding.orderIndex === target.orderIndex)?.chapterId) === chapter.id
          && (!target.volumeId || target.volumeId === chapter.volumeId)
          && (!target.positionInVolume || target.positionInVolume === chapter.orderInVolume))) continue
      const boundaries = [selection, ...(local?.regions ?? [])].filter(boundary => boundary?.chapterId === chapter.id)
      if (selection && selection.chapterId !== chapter.id || local && !local.regions.some(region => region.chapterId === chapter.id)
        || boundaries.some(boundary => boundary && (chapter.revision < boundary.revision
          || chapter.content.length < boundary.prefix.length + boundary.suffix.length
          || !chapter.content.startsWith(boundary.prefix) || !chapter.content.endsWith(boundary.suffix)
          || chapter.revision === boundary.revision && runtimeJson({ content: chapter.content }).hash !== boundary.contentHash))) continue
      try { composeChapterEdit(chapter.content, card.args as { oldText: string; newText: string }, 1); continue }
      catch (error) { if (!(error instanceof DataAccessError) || error.code !== 'CHAPTER_ANCHOR_CONFLICT') throw error }
      chapterIds.push(chapter.id); sourceMessageIds.push(card.messageId)
      witnesses.push({ chapterId: chapter.id, revision: chapter.revision, contentHash: runtimeJson({ content: chapter.content }).hash, ...card })
    }
    return witnesses.length ? { key: runtimeJson({ legacyAnchorInputRecovery: 2, taskId: original.taskId,
      sourceRunId: original.sourceRunId, witnesses }).hash, chapterIds, sourceMessageIds: [...new Set(sourceMessageIds)] } : null
  } catch (error) {
    if (error instanceof DataAccessError && ['RUNTIME_SCOPE_MISMATCH', 'RUNTIME_RECEIPT_INVALID'].includes(error.code)) return null
    throw error
  }
}
