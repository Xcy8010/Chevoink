import { z } from 'zod'
import { createHash } from 'node:crypto'
import { runtimeJson } from './runtime-common.js'
import { inspectContinuityResponse } from './continuity-format-recovery.js'
import type { TerminalEvidenceContext } from './terminal-evidence-context.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import { continuityResponseInput, fixedContinuityResponseFields } from './continuity-response-contract.js'
import { terminalAddressResponseFields, terminalReviewAddressCatalog, normalizeTerminalResponseRows } from './terminal-review-addresses.js'
import type { ContinuityBodies } from './continuity-review-context.js'

type Inspection = ReturnType<typeof inspectContinuityResponse>
const tables = ['terminalVerdicts', 'terminalProofVerdicts', 'terminalDispositions', 'proposalDispositions'] as const
const keys = ['claimIndex', 'proofIndex', 'obligationIndex', 'proposalIndex'] as const
const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null

/** Protocol4 only. A reviewer replaces each bad addressed ROW, including its
 * outcome and evidence. The server never chooses a different semantic target.
 * Good rows/opinions are immutable; raw first/second replies remain separate. */
export function continuityResponseRepairPlan(original: Inspection, bodies: ContinuityBodies) {
  if (original.audit.responseContract !== 3 || original.audit.classification !== 'terminal_invalid'
    || !original.audit.terminalCandidate || bodies.terminalEvidence?.verdictProtocol !== 6
    || !fixedContinuityResponseFields(original)) return null
  try {
    const raw: unknown = JSON.parse(original.audit.rawResponse.content)
    if (typeof raw !== 'string') return null
    const wire = object(parseQualityJsonObject(raw, 'continuity', 3))
    if (!wire) return null
    const normalized = normalizeTerminalResponseRows(wire)
    if (normalized.error) return null
    const record = normalized.record, candidate = original.audit.terminalCandidate
    const fields = terminalAddressResponseFields(candidate, bodies.terminalEvidence, undefined, true)
    const catalog = terminalReviewAddressCatalog(candidate, bodies.terminalEvidence)
    const addresses = [catalog.ordinary.map(row => row.claimIndex), catalog.proofs.map(row => row.proofIndex),
      catalog.obligations.map(row => row.obligationIndex), catalog.proposals.map(row => row.proposalIndex)]
    const bad: Array<{ table: typeof tables[number]; key: typeof keys[number]; address: number; index: number; row: unknown; schema: z.ZodType }> = []
    for (const [i, table] of tables.entries()) {
      const schema = fields[table]
      if (schema.safeParse(record[table]).success) continue
      // Ambiguous/missing/extra addresses require the existing full independent
      // reassessment. Sparse recovery cannot silently discard or invent rows.
      const rows = record[table], key = keys[i], expected = addresses[i]
      if (!Array.isArray(rows) || rows.length !== expected.length
        || new Set(rows.map(row => object(row)?.[key])).size !== rows.length
        || rows.some(row => !expected.includes(object(row)?.[key] as number))) return null
      const array = schema instanceof z.ZodDefault ? schema.unwrap() : schema
      if (!(array instanceof z.ZodArray)) return null
      const element = array.element
      for (const [index, row] of rows.entries()) if (!element.safeParse(row).success) {
        bad.push({ table, key, address: object(row)![key] as number, index, row, schema: element })
      }
    }
    if (!bad.length) return null
    const variants = bad.map(row => z.object({ table: z.literal(row.table), address: z.literal(row.address), replacement: row.schema }).strict())
    const entry = variants.length === 1 ? variants[0] : z.union(variants)
    const schema = z.object({ baseResponseHash: z.literal(original.audit.contentHash), corrections: z.array(entry).length(bad.length) }).strict()
      .superRefine((value, ctx) => {
        const seen = new Set<string>()
        for (const item of value.corrections) {
          const row = bad.find(row => row.table === item.table && row.address === item.address)
          const id = `${item.table}:${item.address}`
          if (!row || seen.has(id) || object(item.replacement)?.[row.key] !== row.address) ctx.addIssue({ code: 'custom', message: 'Every failed address must be replaced exactly once with the same address' })
          seen.add(id)
        }
      })
    const replacements = catalog.claims.filter(row => ['knowledge', 'body', 'objects', 'relationships', 'openLoops'].includes(row.field))
      .map(({ claimIndex: candidateIndex, field, claim }) => ({ candidateIndex, field, claim }))
    return { record, bad, schema, replacements }
  } catch { return null }
}

export function continuitySparseRepairRequest(system: string, content: string, original: Inspection, bodies: ContinuityBodies) {
  const plan = continuityResponseRepairPlan(original, bodies)
  if (!plan) return null
  // Do not feed the failed complete answer back as an apparent template. The
  // full frozen source/candidate remain available, followed by only bad rows.
  const purpose = system.split('\n只输出一个完整 JSON 对象，不编码成带外层引号的字符串。')[0]
  return { system: `${purpose}\n本次是同一检查唯一第二槽的稀疏响应修复。只输出下列 JSON 合同，不重输 findings、semanticChecks 或其余有效表。每个坏地址须独立核对后替换整行，不能只换整数或把无依据事实改成通过。unknown 保留义务；ended 需要本章明确解除证据；replaced 仅能指向已独立支持的持久候选。\n${JSON.stringify(z.toJSONSchema(plan.schema, { io: 'input' }))}`,
    content: `${content}\n唯一修复基准 baseResponseHash=${original.audit.contentHash}。其余有效行和独立意见已冻结，不得更改。合法持久替代目标（candidateIndex 与普通 claimIndex 同值，但不能选瞬时动作/地点）：${JSON.stringify(plan.replacements)}\n仅以下坏地址须重新判断 outcome、reason、sourceEvidence、candidateIndex：${JSON.stringify(plan.bad.map(({ table, address, row }) => ({ table, address, originalRow: row })))}。当前诊断：${JSON.stringify(original.audit.terminalReviewDiagnostics ?? [])}` }
}

export function applyContinuitySparseRepair(original: Inspection, raw: string, bodies: ContinuityBodies) {
  const plan = continuityResponseRepairPlan(original, bodies)
  if (!plan) return null
  const patch = plan.schema.parse(parseContinuityRepairResponse(raw))
  const record = structuredClone(plan.record)
  for (const item of patch.corrections) {
    const row = plan.bad.find(row => row.table === item.table && row.address === item.address)!
    ;(record[row.table] as unknown[])[row.index] = item.replacement
  }
  return { raw: JSON.stringify(record), projection: { version: 1, kind: 'addressed_row_repair',
    originalResponseHash: original.audit.contentHash, repairResponseHash: createHash('sha256').update(raw).digest('hex'),
    projectedResponseHash: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
    mask: plan.bad.map(({ table, address }) => ({ table, address })) } }
}


export function parseContinuityRepairResponse(raw: string) {
  // Require one complete object; the existing corrections parser also rejects
  // duplicate keys. No fallback to a nested or second JSON object.
  JSON.parse(raw)
  return parseQualityJsonObject(raw, 'corrections', 3)
}

/** Mandatory replay at commit/proof reads for a composed response. Either
 * marker alone is invalid. Provider replies are preserved independently and
 * every projected row must come from that exact frozen first+second pair. */
export function validContinuitySparseProjection(audit: unknown, content: string, context?: TerminalEvidenceContext) {
  const saved = object(audit), reassessment = object(saved?.reassessment), marker = object(saved?.responseProjection)
  if (marker === null && reassessment?.kind !== 'sparse_table_repair') return true
  if (!context || context.verdictProtocol !== 6 || marker === null || reassessment?.kind !== 'sparse_table_repair'
    || saved?.responseContract !== 3 || !object(reassessment.projection) || runtimeJson(marker).hash !== runtimeJson(reassessment.projection).hash) return false
  try {
    const bodies = object(reassessment.frozenBodies)
    if (!bodies || bodies.current !== content || bodies.previous !== null && typeof bodies.previous !== 'string'
      || runtimeJson(bodies.terminalEvidence).hash !== runtimeJson(context).hash) return false
    const original = object(reassessment.original), originalRaw = object(original?.rawResponse), repairRaw = object(reassessment.rawResponse), projectedRaw = object(saved.rawResponse)
    if (!original || originalRaw?.complete !== true || typeof originalRaw.content !== 'string'
      || repairRaw?.complete !== true || typeof repairRaw.content !== 'string' || projectedRaw?.complete !== true || typeof projectedRaw.content !== 'string') return false
    const first: unknown = JSON.parse(originalRaw.content), second: unknown = JSON.parse(repairRaw.content)
    if (typeof first !== 'string' || typeof second !== 'string' || original.responseContract !== 3
      || original.parserVersion !== 8 || runtimeJson(original.terminalEvidence).hash !== runtimeJson(context).hash
      || original.terminalContentHash !== runtimeJson({ content }).hash) return false
    const rebuilt = inspectContinuityResponse(first, bodies as ContinuityBodies, true, 8, original.terminalCandidate as Inspection['audit']['terminalCandidate'],
      original.sourceScope as Inspection['audit']['sourceScope'], { responseContract: 3 })
    if (runtimeJson(rebuilt.audit).hash !== runtimeJson(original).hash) return false
    const projection = applyContinuitySparseRepair(rebuilt, second, bodies as ContinuityBodies)
    return !!projection && JSON.parse(projectedRaw.content) === projection.raw
      && runtimeJson(projection.projection).hash === runtimeJson(marker).hash
      && saved.characterCount === projection.raw.length
      && saved.contentHash === createHash('sha256').update(projection.raw).digest('hex')
  } catch { return false }
}


export function continuitySparseRepairDiagnostics(original: Inspection, raw: string, bodies: ContinuityBodies) {
  if (!continuityResponseRepairPlan(original, bodies)) return null
  try {
    const repaired = applyContinuitySparseRepair(original, raw, bodies)!
    const checked = inspectContinuityResponse(repaired.raw, bodies, true, 8, original.audit.terminalCandidate, original.audit.sourceScope, { responseContract: 3 })
    return { classification: checked.audit.classification, terminalReviewDiagnostics: checked.audit.terminalReviewDiagnostics ?? [] }
  } catch (error) {
    return { classification: 'terminal_invalid', terminalReviewDiagnostics: error instanceof z.ZodError
      ? error.issues.slice(0, 8).map(row => ({ code: row.code, path: row.path.join('.'), message: row.message }))
      : [{ code: 'repair_invalid', path: 'corrections', message: error instanceof Error ? error.message : 'Invalid sparse repair' }] }
  }
}


/** Only newly admitted4 inputs get this unambiguous foreign-key directory. */
export function continuityResponseInput4(content: string, bodies: ContinuityBodies, candidate: NonNullable<Inspection['audit']['terminalCandidate']>) {
  const targets = terminalReviewAddressCatalog(candidate, bodies.terminalEvidence!).claims
    .filter(row => ['knowledge', 'body', 'objects', 'relationships', 'openLoops'].includes(row.field))
    .map(({ claimIndex: candidateIndex, field, claim }) => ({ candidateIndex, field, claim }))
  return `${continuityResponseInput(content, bodies, candidate)}\nreplaced 唯一合法 candidateIndex 目录：${JSON.stringify(targets)}。必须逐项独立支持完整持久主张，不能使用 action/location/lastUnfinishedAction 的普通 claimIndex 作为替代目标。`
}
