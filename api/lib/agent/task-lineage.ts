import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { MAIN_RUN_FILTER } from './runtime-child.js'

/** The task immediately preceding the original request. Resuming that request
 * later must not move this boundary; inline children have no author task. */
export async function previousHistoryTask(userId: string, sessionId: string, runId: string, db: Prisma.TransactionClient = prisma) {
  // One snapshot and round trip. Read only the legacy JSON identity, never a
  // task's full prompt/specification or any manuscript into the runtime.
  const runs = await db.$queryRaw<{ id: string; requestId: string | null }[]>`
    WITH owned AS (
      SELECT r.id, r.created_at, COALESCE('task:' || r.task_root_id,
        CASE WHEN jsonb_typeof(r.task_spec->'id') = 'string' THEN 'task:' || NULLIF(r.task_spec->>'id', '') END,
        'run:' || r.id) AS task_id
      FROM agent_runs r
      WHERE r.user_id = ${userId} AND r.session_id = ${sessionId}
        AND NOT EXISTS (SELECT 1 FROM agent_child_execution_grants g WHERE g.child_run_id = r.id AND g.kind = 'inline')
    ), first_current AS (
      SELECT created_at, id FROM owned WHERE task_id = (SELECT task_id FROM owned WHERE id = ${runId})
      ORDER BY created_at, id LIMIT 1
    ), earlier AS (
      SELECT r.* FROM owned r, first_current c WHERE (r.created_at, r.id) < (c.created_at, c.id)
    ), previous AS (
      SELECT id, created_at FROM earlier WHERE task_id = (SELECT task_id FROM earlier ORDER BY created_at DESC, id DESC LIMIT 1)
    )
    SELECT p.id, (SELECT m.id FROM previous r JOIN agent_messages m ON m.run_id = r.id
      WHERE m.session_id = ${sessionId} AND m.role = 'user' ORDER BY m.created_at, m.id LIMIT 1) AS "requestId"
    FROM previous p ORDER BY p.created_at, p.id`
  return { runIds: runs.map(run => run.id), requestId: runs[0]?.requestId ?? null }
}

/** A conversation contains many unrelated tasks. Only explicit continuation retains TaskSpec.id. */
export async function getTaskRunIds(sessionId: string, runId: string, db: Prisma.TransactionClient = prisma): Promise<string[]> {
  const run = await db.agentRun.findFirst({ where: { id: runId, sessionId }, select: { taskSpec: true } })
  const spec = run?.taskSpec
  const taskId = spec && typeof spec === 'object' && !Array.isArray(spec) && typeof spec.id === 'string' ? spec.id : null
  // Legacy records without identity fail closed: never infer ownership from session membership.
  if (!taskId) return [runId]
  const runs = await db.agentRun.findMany({
    where: { sessionId, engine: 'loop', taskSpec: { path: ['id'], equals: taskId }, ...MAIN_RUN_FILTER },
    select: { id: true },
  })
  return [...new Set([runId, ...runs.map(item => item.id)])]
}
