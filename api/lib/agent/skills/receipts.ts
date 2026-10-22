import { DataAccessError, prisma } from '../../prisma.js'
import type { Prisma } from '@prisma/client'
import type { AgentSkill, SkillPhase } from './index.js'

/** Atomic, scoped union; retries/resumes cannot erase loads from earlier phases.
 * No content/prompts are retained. One run counts once per skill, not per load. */
export async function recordSkillLoads(scope: { runId: string; userId: string; novelId: string; routerVersion?: string }, skills: readonly AgentSkill[], phase: SkillPhase, source: 'route' | 'phase' | 'tool', transaction?: Prisma.TransactionClient): Promise<void> {
  if (!skills.length) return
  const rows = skills.map(({ id, name, version }) => ({ id, name, version, phase, source }))
  const db = transaction ?? prisma
  if (transaction && scope.routerVersion) {
    const owned = await db.agentRun.findFirst({ where: { id: scope.runId, userId: scope.userId, novelId: scope.novelId }, select: { id: true } })
    if (!owned) throw new DataAccessError(409, 'SKILL_RUN_SCOPE_MISMATCH', '技能加载不属于当前作者和作品的任务。')
    const existing = await db.agentSkillRun.findUnique({ where: { runId: scope.runId } })
    if (existing && (existing.userId !== scope.userId || existing.novelId !== scope.novelId)) {
      throw new DataAccessError(409, 'SKILL_RUN_SCOPE_MISMATCH', '原技能记录的作品或作者不一致，未覆盖。')
    }
    // A durable task may not have an automatic route receipt. Record only the
    // observed tool load; do not invent router selections or confidence.
    if (!existing) await db.agentSkillRun.create({ data: { runId: scope.runId, userId: scope.userId, novelId: scope.novelId,
      phase, routerVersion: scope.routerVersion, candidates: [], selected: [], loaded: [],
      reasonCodes: ['explicit_tool_load_without_route'], confidence: 0, estimatedTokens: 0 } })
  }
  await db.$executeRaw`
    UPDATE agent_skill_runs SET loaded = (
      SELECT COALESCE(jsonb_agg(DISTINCT item), '[]'::jsonb)
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(loaded) = 'array' THEN loaded ELSE '[]'::jsonb END || ${JSON.stringify(rows)}::jsonb
      ) AS item
    ), updated_at = CURRENT_TIMESTAMP
    WHERE run_id = ${scope.runId} AND user_id = ${scope.userId} AND novel_id = ${scope.novelId}
  `
}

export async function getSkillUsage(userId: string, novelId: string, transaction?: Prisma.TransactionClient): Promise<Map<string, { count: number; lastUsedAt: Date }>> {
  const db = transaction ?? prisma
  const rows = await db.$queryRaw<Array<{ id: string; count: number; lastUsedAt: Date }>>`
    SELECT item->>'id' AS id, count(DISTINCT r.run_id)::int AS count, max(r.updated_at) AS "lastUsedAt"
    FROM agent_skill_runs r CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.loaded) = 'array' AND jsonb_array_length(r.loaded) > 0 THEN r.loaded
      WHEN jsonb_typeof(r.selected) = 'array' THEN r.selected ELSE '[]'::jsonb END
    ) item
    WHERE r.user_id = ${userId} AND r.novel_id = ${novelId} AND jsonb_typeof(item->'id') = 'string'
    GROUP BY item->>'id'
  `
  return new Map(rows.map(row => [row.id, { count: row.count, lastUsedAt: row.lastUsedAt }]))
}
