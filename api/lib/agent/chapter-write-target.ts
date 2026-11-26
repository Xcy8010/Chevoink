import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { activeChapterScope } from '../data/internal.js'
import { getChapterBaseline, getLastTouchedChapter, getLastWritingTarget, hasCreatedChapter, recordChapterBaseline, recordChapterWrite, recordCreatedChapter } from './baseline.js'
import { readObservedBaseline } from './runtime-observed-baseline.js'
import { readWritingScope } from './writing-scope.js'

type WritingSubject = Parameters<typeof readWritingScope>[1] & { chapterId: string | null; inlineChild?: boolean }
type BodyWriteAction = 'chapter_write' | 'chapter_append' | 'chapter_edit_range'

export function isBodyWriteAction(action: string): action is BodyWriteAction {
  return action === 'chapter_write' || action === 'chapter_append' || action === 'chapter_edit_range'
}

const observedChapterActions = ['chapter_read', 'chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range'] as const
const savedChapterCreateCall = z.object({
  callId: z.string(), args: z.object({ title: z.string() }),
})
const savedChapterObservation = z.object({
  ok: z.literal(true), toolName: z.enum(observedChapterActions),
  callId: z.string().optional(),
  chapterCreated: z.literal(true).optional(),
  display: z.object({ kind: z.enum(['chapterRef', 'chapterDiff']), chapterId: z.string(), revision: z.number().int().positive(),
    title: z.string().optional(), chapterTitle: z.string().optional() }),
})

/** Restore only confirmed observations from a continued legacy task. The
 * recorded revision stays the baseline even if the database has a newer draft. */
export async function restoreLegacyChapterWrites(tx: Prisma.TransactionClient, subject: Parameters<typeof readWritingScope>[1] & { sessionId: string }, taskRunIds: string[]) {
  if (!taskRunIds.length) return
  // Project only the saved identifiers and version, excluding full text in
  // chapter diffs and tool arguments.
  const events = await tx.$queryRaw<Array<{ runId: string; type: string; payload: unknown }>>`
    SELECT e.run_id AS "runId", e.type,
      jsonb_strip_nulls(jsonb_build_object(
        'callId', e.payload->'callId',
        'ok', e.payload->'ok',
        'toolName', e.payload->'toolName',
        'chapterCreated', e.payload->'chapterCreated',
        'args', jsonb_build_object('title', e.payload #> '{args,title}'),
        'display', jsonb_build_object(
          'kind', e.payload #> '{display,kind}',
          'chapterId', e.payload #> '{display,chapterId}',
          'revision', e.payload #> '{display,revision}',
          'title', e.payload #> '{display,title}',
          'chapterTitle', e.payload #> '{display,chapterTitle}'
        )
      )) AS payload
    FROM agent_run_events e
    JOIN agent_runs r ON r.id = e.run_id
    WHERE e.run_id IN (${Prisma.join(taskRunIds)})
      AND r.user_id = ${subject.userId} AND r.novel_id = ${subject.novelId} AND r.session_id = ${subject.sessionId}
      AND r.engine = 'loop' AND r.runtime_protocol_version = 0 AND r.task_root_id IS NULL
      AND e.payload->>'subagentCallId' IS NULL
      AND (
        (e.type = 'tool.call' AND e.payload->>'toolName' = 'chapter_create')
        OR (e.type = 'tool.result' AND e.payload->>'toolName' IN (${Prisma.join(observedChapterActions)}))
      )
    ORDER BY e.created_at, e.seq, e.id
  `
  const createTitles = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool.call') {
      const call = savedChapterCreateCall.safeParse(event.payload)
      if (call.success) createTitles.set(`${event.runId}/${call.data.callId}`, call.data.args.title)
      continue
    }
    const observed = savedChapterObservation.safeParse(event.payload)
    if (!observed.success) continue
    const { toolName, chapterCreated, callId, display } = observed.data
    if (toolName === 'chapter_read') recordChapterBaseline(subject.runId, display.chapterId, display.revision)
    else recordChapterWrite(subject.runId, display.chapterId, display.revision)
    const title = (callId && createTitles.get(`${event.runId}/${callId}`)) || display.title || display.chapterTitle
    if (toolName === 'chapter_create' && chapterCreated && title) recordCreatedChapter(subject.runId, title, display.chapterId)
  }
}

/** Resolve only destination identity. The selected chapter's existing version
 * and authorization checks still govern the actual write. */
export async function resolveChapterWriteTarget(tx: Prisma.TransactionClient, subject: WritingSubject,
  action: BodyWriteAction, args: { chapterId?: unknown; targetOrderIndex?: unknown },
  cursor?: { rootId: string; revision: number }) {
  const requestedId = typeof args.chapterId === 'string' ? args.chapterId.trim() : ''
  if (action === 'chapter_edit_range' && requestedId) return requestedId
  const remembered = cursor || subject.inlineChild ? null : getLastWritingTarget(subject.runId)
  if (requestedId && !cursor && (!remembered || requestedId === remembered) && args.targetOrderIndex === undefined) return requestedId

  const scope = await readWritingScope(tx, subject)
  const targets = scope.writing?.kind === 'bounded' ? scope.writing.targets.map(target => ({
    orderIndex: target.orderIndex,
    chapterId: target.chapterId ?? scope.bindings?.targets.find(binding => binding.orderIndex === target.orderIndex)?.chapterId,
  })) : undefined

  if (typeof args.targetOrderIndex === 'number') {
    if (targets) return targets.find(target => target.orderIndex === args.targetOrderIndex)?.chapterId ?? null
    const chapter = await tx.chapter.findFirst({
      where: { ...activeChapterScope(subject.novelId), authorId: subject.userId, orderIndex: args.targetOrderIndex },
      select: { id: true },
    })
    return chapter?.id ?? null
  }

  // A plain ID still identifies an ordinary edit. In a multi-chapter writing
  // run, a newly created/selected chapter remains the destination through
  // reference reads, even if the model copied the ID of a preceding target.
  if (targets?.length === 1) return requestedId || targets[0].chapterId || null
  const active = cursor
    ? (await readObservedBaseline(tx, cursor.rootId, cursor.revision, { kind: 'chapter' }))?.id ?? null
    : remembered
  const activeTarget = active && (!targets || targets.some(target => target.chapterId === active)) ? active : null
  if (requestedId) {
    if (!activeTarget || requestedId === activeTarget) return requestedId
    if (targets) {
      const current = targets.find(target => target.chapterId === activeTarget)
      const requested = targets.find(target => target.chapterId === requestedId)
      if (current && requested) return requested.orderIndex < current.orderIndex ? activeTarget : requestedId
    }
    const activeWasCreated = cursor
      ? await readObservedBaseline(tx, cursor.rootId, cursor.revision, { kind: 'chapter', id: activeTarget, creationOnly: true })
      : hasCreatedChapter(subject.runId, activeTarget)
    if (!activeWasCreated) return requestedId
    const requestedWasObserved = cursor
      ? await readObservedBaseline(tx, cursor.rootId, cursor.revision, { kind: 'chapter', id: requestedId })
      : getChapterBaseline(subject.runId, requestedId) !== null
    if (!requestedWasObserved) return requestedId
    const chapters = await tx.chapter.findMany({
      where: { ...activeChapterScope(subject.novelId), authorId: subject.userId, id: { in: [requestedId, activeTarget] } },
      select: { id: true },
      orderBy: { orderIndex: 'asc' },
    })
    return chapters.length === 2 && chapters[0].id === requestedId ? activeTarget : requestedId
  }
  if (activeTarget) return activeTarget
  if (targets) return targets.find(target => target.chapterId === subject.chapterId)?.chapterId ?? null
  if (scope.writing?.kind === 'needs_input') return cursor ? subject.chapterId : null
  return subject.chapterId ?? (cursor ? null : getLastTouchedChapter(subject.runId))
}

export async function resolveDurableChapterTarget(tx: Prisma.TransactionClient, subject: WritingSubject, action: string,
  args: { chapterId?: unknown; targetOrderIndex?: unknown }, cursor: { rootId: string; revision: number },
  publishedParameters: Record<string, unknown>) {
  const explicitId = typeof args.chapterId === 'string' ? args.chapterId.trim() : ''
  const fields = publishedParameters.properties
  const supportsPosition = fields !== null && typeof fields === 'object' && 'targetOrderIndex' in fields
  if (isBodyWriteAction(action) && (supportsPosition || !explicitId)) {
    return resolveChapterWriteTarget(tx, subject, action, args, cursor)
  }
  return explicitId || subject.chapterId
}
