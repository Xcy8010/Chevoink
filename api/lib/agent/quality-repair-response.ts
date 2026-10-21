import { z } from 'zod'

const reason = z.string().trim().min(1).max(2_000)
const legacyEnvelope = z.object({
  patches: z.array(z.object({ findingId: z.string().min(1), replacement: z.string().max(2_000) }).strict()).max(12),
  retainedFindings: z.array(z.object({ findingId: z.string().min(1), reason }).strict()).max(12).optional(),
}).strict()
const durableEnvelope = z.object({
  patches: z.array(z.object({ key: z.string().min(1), replacement: z.string().max(2_000) }).strict()).max(8),
  retainedFindings: z.array(z.object({ key: z.string().min(1), reason }).strict()).max(8).optional(),
}).strict()

/** New repair responses can decline an unsafe edit explicitly. This is a
 * proposal for the writer, never a finding disposition or a passed check. */
export function parseQualityRepairResponse(value: unknown, identity: 'findingId' | 'key' = 'findingId') {
  const normalized = identity === 'key' ? (() => {
    const parsed = durableEnvelope.parse(value)
    return { patches: parsed.patches.map(({ key, replacement }) => ({ id: key, replacement })),
      retainedFindings: (parsed.retainedFindings ?? []).map(({ key, reason }) => ({ id: key, reason })) }
  })() : (() => {
    const parsed = legacyEnvelope.parse(value)
    return { patches: parsed.patches.map(({ findingId, replacement }) => ({ id: findingId, replacement })),
      retainedFindings: (parsed.retainedFindings ?? []).map(({ findingId, reason }) => ({ id: findingId, reason })) }
  })()
  if (!normalized.patches.length && !normalized.retainedFindings.length) throw new Error('empty_quality_repair_response')
  return normalized
}

/** Conflicting patch/retain entries and duplicate identities are unresolved.
 * Their absence must never be interpreted as an implicit retain decision. */
export function partitionQualityRepairResponse(response: ReturnType<typeof parseQualityRepairResponse>, requestedIds: string[]) {
  const entries = [...response.patches, ...response.retainedFindings], requested = new Set(requestedIds)
  const frequencies = new Map<string, number>()
  for (const item of entries) frequencies.set(item.id, (frequencies.get(item.id) ?? 0) + 1)
  const valid = (item: { id: string }) => requested.has(item.id) && frequencies.get(item.id) === 1
  return { patches: response.patches.filter(valid), retainedFindings: response.retainedFindings.filter(valid),
    counts: { returned: entries.length, missing: requestedIds.filter(id => !frequencies.has(id)).length,
      unknown: entries.filter(item => !requested.has(item.id)).length,
      duplicate: entries.filter(item => requested.has(item.id) && frequencies.get(item.id)! > 1).length } }
}

export const QUALITY_REPAIR_RETAIN_RULE = '先核对 explanation 与证据及前后文的真实语义。原文事实、否定、比较对象、动作归属和时序优先于评论；原文已有支撑时不要为了迎合评论补写解释。没有安全且必要的局部修改时，返回 retainedFindings 中的原始标识和具体 reason，patches 可为空；不得用照抄原文的 replacement 代替保留。每个请求标识必须且只能出现在 patches 或 retainedFindings 一处。保留仅是待主模型复核的建议，不改变原 finding、不代表通过，也不扩大写入权限。'
