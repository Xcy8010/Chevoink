import { createHash } from 'node:crypto'
import { z } from 'zod'
import { runtimeJson } from './runtime-common.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import { terminalCandidateSchema, type TerminalCandidate } from './terminal-candidate-contract.js'
import { terminalEvidenceContextSchema, validContinuitySemanticChecks } from './terminal-evidence-context.js'
import { continuitySourceScopeSchema, type ContinuitySourceScope } from './continuity-source-authority.js'
import { continuitySourceCatalog, type ContinuityBodies } from './continuity-review-context.js'
import { terminalAddressResponseFields, terminalReviewAddressCatalog, terminalReviewAddressInput } from './terminal-review-addresses.js'
import { inspectTerminalReview, inspectTerminalCandidateEvidence, type TerminalReviewDiagnostic } from './terminal-review-engine.js'
import { terminalReviewRowDiagnostics } from './terminal-review-row-diagnostics.js'
import { continuityFindingInputSchema, type ContinuityFindingInput } from '../../../shared/contracts/story-compiler-contracts.js'
import type { inspectContinuityResponse } from './continuity-format-recovery.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const textHash = (raw: string) => createHash('sha256').update(raw).digest('hex')
const rawReceipt = (raw: string, complete: boolean) => ({ version: 1 as const, encoding: 'json-string' as const, content: JSON.stringify(raw), complete })
const tables = ['findings', 'semanticChecks', 'terminalVerdicts', 'terminalProofVerdicts', 'terminalDispositions', 'proposalDispositions'] as const
type Table = typeof tables[number]
type Diagnostic = { table: Table; index: number; code: string; path?: string }
type V4RepairPlan = { version: 1; manifestHash: string; firstHash: string; mask: Array<{ table: Table; index: number }>;
  fixedHash: string; fixed: Record<string, unknown[]> }
const evidenceReference = z.object({ segmentId: z.string().regex(/^[cp][0-9]+$/u), quote: z.string().min(2).max(300).optional() }).strict()
const findingSchema = z.object({ findingId: z.string().regex(/^f[0-9]+$/u), signal: continuityFindingInputSchema.shape.signal,
  severity: continuityFindingInputSchema.shape.severity, reason: z.string().trim().min(1).max(400), suggestion: z.string().trim().min(1).max(500),
  sourceEvidence: z.array(evidenceReference).min(1).max(8) }).strict()
const semanticSchema = z.object({ kind: z.enum(['action_direction', 'state_progression']), result: z.enum(['clear', 'conflict', 'not_applicable']),
  reason: z.string().trim().min(1).max(1500), findingIds: z.array(z.string().regex(/^f[0-9]+$/u)).max(20) }).strict()
const subjectSchema = z.object({ userId: z.string().min(1), novelId: z.string().min(1), taskId: z.string().min(1),
  targetType: z.literal('story_compilation'), targetId: z.string().min(1), chapterId: z.string().min(1), revision: z.number().int().positive() }).strict()
export const continuityReviewManifestSchema = z.object({ version: z.literal(1), subject: subjectSchema,
  bodyHash: hash, previousBodyHash: hash.nullable(), sourceHash: hash.nullable(), sourceScope: continuitySourceScopeSchema,
  candidateHash: hash, contextHash: hash, catalogHash: hash, verifiedCoverage: z.unknown(), draftProposals: z.unknown(),
  sourceVersions: z.unknown(), hash }).strict()
export type ContinuityReviewManifest = z.infer<typeof continuityReviewManifestSchema>
export type ContinuityV4Frozen = { manifest: ContinuityReviewManifest; bodies: ContinuityBodies; candidate: TerminalCandidate; sourceScope: ContinuitySourceScope }
type LegacyInspection = ReturnType<typeof inspectContinuityResponse>
type V4Marker = { version: 1; manifest: ContinuityReviewManifest; frozen: ContinuityV4Frozen; first: ReturnType<typeof rawReceipt>;
  projections: ReturnType<typeof inspectRecord>['projections'] | null;
  failedRepair?: { response: ReturnType<typeof rawReceipt> };
  repair?: { response: ReturnType<typeof rawReceipt>; plan: V4RepairPlan;
    dispositions: Array<Record<string, unknown>>; recordHash: string } }
export type ContinuityV4Inspection = Omit<LegacyInspection, 'audit'> & { audit: Omit<LegacyInspection['audit'], 'parserVersion' | 'responseContract'> & {
  parserVersion: 9; responseContract: 4; continuityV4: V4Marker; assessmentRequest?: { version: number; key: string; inputHash: string } };
  terminalReview: ReturnType<typeof inspectTerminalReview>; parsed: ReturnType<typeof inspectRecord> | null }

export function buildContinuityReviewCatalog(bodies: ContinuityBodies, candidate: TerminalCandidate) {
  const context = terminalEvidenceContextSchema.parse(bodies.terminalEvidence)
  return { sources: continuitySourceCatalog(bodies), terminal: terminalReviewAddressCatalog(terminalCandidateSchema.parse(candidate), context) }
}

/** The server freezes hashes. The model receives short catalogue addresses and
 * never computes or echoes a manifest/proof hash to authenticate its answer. */
export function buildContinuityReviewManifest(input: {
  subject: z.infer<typeof subjectSchema>; bodies: ContinuityBodies; candidate: TerminalCandidate; sourceScope: ContinuitySourceScope;
  sourceHash: string | null; sourceVersions: unknown; verifiedCoverage: unknown; draftProposals: unknown;
}): ContinuityReviewManifest {
  const subject = subjectSchema.parse(input.subject), context = terminalEvidenceContextSchema.parse(input.bodies.terminalEvidence)
  const candidate = terminalCandidateSchema.parse(input.candidate)
  if (context.verdictProtocol !== 6 || context.spanAddressProtocol !== 2 || context.current.id !== subject.chapterId
    || context.current.revision !== subject.revision || context.current.orderIndex !== input.sourceScope.currentOrderIndex
    || context.current.contentHash !== runtimeJson({ content: input.bodies.current }).hash
    || context.factCoverage !== undefined && context.factCoverage.taskId !== subject.taskId || input.bodies.previous !== null && !input.sourceHash) throw Error('Continuity manifest identity mismatch')
  const value = { version: 1 as const, subject, bodyHash: runtimeJson({ content: input.bodies.current }).hash,
    previousBodyHash: input.bodies.previous === null ? null : runtimeJson({ content: input.bodies.previous }).hash,
    sourceHash: input.sourceHash, sourceScope: continuitySourceScopeSchema.parse(input.sourceScope), candidateHash: runtimeJson(candidate).hash,
    contextHash: runtimeJson(context).hash, catalogHash: runtimeJson(buildContinuityReviewCatalog(input.bodies, candidate)).hash,
    verifiedCoverage: input.verifiedCoverage, draftProposals: input.draftProposals, sourceVersions: input.sourceVersions }
  return continuityReviewManifestSchema.parse({ ...value, hash: runtimeJson(value).hash })
}

export function validContinuityReviewManifest(frozen: ContinuityV4Frozen) {
  try {
    const parsed = continuityReviewManifestSchema.parse(frozen.manifest), { hash: _hash, ...value } = parsed
    return runtimeJson(frozen.sourceScope).hash === runtimeJson(parsed.sourceScope).hash
      && runtimeJson(value).hash === parsed.hash && runtimeJson(buildContinuityReviewManifest({ ...value,
      bodies: frozen.bodies, candidate: frozen.candidate })).hash === runtimeJson(parsed).hash
  } catch { return false }
}

function responseFields(frozen: ContinuityV4Frozen) {
  const ids = continuitySourceCatalog(frozen.bodies).terminalSources.map(part => part.segmentId)
  const fields = terminalAddressResponseFields(frozen.candidate, frozen.bodies.terminalEvidence!, ids, true, true)
  return { findings: z.array(findingSchema).max(30), semanticChecks: z.array(semanticSchema).length(2), ...fields,
    terminalProofVerdicts: fields.terminalProofVerdicts instanceof z.ZodDefault ? fields.terminalProofVerdicts.unwrap() : fields.terminalProofVerdicts,
    terminalDispositions: fields.terminalDispositions instanceof z.ZodDefault ? fields.terminalDispositions.unwrap() : fields.terminalDispositions }
}
export function continuityReviewV4ResponseSchema(frozen: ContinuityV4Frozen) {
  return z.object(responseFields(frozen)).strict()
}
export function continuityReviewV4Request(frozen: ContinuityV4Frozen, authorRequest: string | null, context: string) {
  if (!validContinuityReviewManifest(frozen)) throw Error('Continuity manifest cannot be rebuilt')
  return { system: `你是独立连续性审阅者。完整审阅本次材料，不改正文。author_request与场景计划不是已发生事实。
只输出本次完整JSON合同。findings.sourceEvidence只能选服务端目录的segmentId；quote可省略，若提供则必须逐字包含在该段。终态各表的sourceEvidence只返回segmentId，不重抄quote。reason是你的解释，可讨论或引用原意见，其中文字不被服务器冒充原文；只有显式sourceEvidence是正文证据。error必须至少包含一处本章和另一处不同事实证据，不能将仅前文问题指控本章。真实冲突、严重度及未知判断必须完整保留，不为通过而删意见或改判。findings的findingId依次为f0、f1…，semanticChecks用这些ID引用意见。候选/历史事实/proposal按原目录逐项核验；合法unknown不是格式错误。
${JSON.stringify(z.toJSONSchema(continuityReviewV4ResponseSchema(frozen), { io: 'input' }))}`,
    content: JSON.stringify({ author_request: { manuscriptEvidence: false, text: authorRequest }, context,
      // Rendering uses the existing short addresses. The full server catalogue
      // still authenticates the manifest and every stored response/repair.
      manifestSubject: frozen.manifest.subject, catalog: { sources: continuitySourceCatalog(frozen.bodies),
        terminal: terminalReviewAddressInput(frozen.candidate, frozen.bodies.terminalEvidence!) } }) }
}

function bindFinding(value: unknown, index: number, frozen: ContinuityV4Frozen, expectedId = `f${index}`) {
  const parsed = findingSchema.safeParse(value)
  if (!parsed.success || parsed.data.findingId !== expectedId) return null
  const row = parsed.data, catalog = continuitySourceCatalog(frozen.bodies).continuitySources
  const refs = row.sourceEvidence.map(ref => {
    const source = catalog.find(part => part.segmentId === ref.segmentId)
    return source && (ref.quote === undefined || source.quote.includes(ref.quote))
      ? { source: source.source, quote: ref.quote ?? source.quote } : null
  })
  if (refs.some(ref => !ref || ref.quote.length < 2) || row.severity === 'error'
    && (!refs.some(ref => ref?.source === 'current') || new Set(refs.map(ref => `${ref?.source}:${ref?.quote}`)).size < 2)) return null
  // Prose explanations remain in their own labelled field. Only server-bound
  // explicit references become manuscript evidence for downstream write gates.
  const finding: ContinuityFindingInput = { signal: row.signal, severity: row.severity,
    evidence: `独立意见 ${row.findingId}；证据地址：${row.sourceEvidence.map(ref => ref.segmentId).join('、')}`,
    suggestion: `说明：${row.reason}；建议：${row.suggestion}`, sourceEvidence: refs.filter((ref): ref is NonNullable<typeof ref> => !!ref) }
  return { row, finding }
}

function inspectRecord(record: Record<string, unknown>, frozen: ContinuityV4Frozen, expectedFindingIds?: string[]) {
  const diagnostics: Diagnostic[] = [], bad = new Map<Table, Set<number>>()
  let repairable = true
  const add = (table: Table, index: number, code: string, path?: string) => {
    const entries = bad.get(table) ?? new Set<number>(); entries.add(index); bad.set(table, entries)
    diagnostics.push({ table, index, code, ...(path ? { path } : {}) })
  }
  const fields = responseFields(frozen), keys = Object.keys(fields)
  if (Object.keys(record).some(key => !keys.includes(key))) { repairable = false; add('findings', -1, 'unexpected_response_field') }
  const findings: ContinuityFindingInput[] = [], findingRows = record.findings
  if (!Array.isArray(findingRows) || findingRows.length > 30
    || new Set(findingRows.map(row => object(row)?.findingId)).size !== findingRows.length) {
    repairable = false; add('findings', -1, 'finding_addresses_invalid')
  } else for (const [index, row] of findingRows.entries()) {
    const expectedId = expectedFindingIds?.[index] ?? `f${index}`
    if (object(row)?.findingId !== expectedId) { repairable = false; add('findings', index, 'finding_address_invalid'); continue }
    const bound = bindFinding(row, index, frozen, expectedId)
    if (!bound) add('findings', index, 'finding_source_or_schema_invalid')
    else findings.push(bound.finding)
  }
  const semantic = record.semanticChecks
  const normalizedSemantic: Array<{ kind: string; result: string; reason: string; findingIndexes: number[] }> = []
  if (!Array.isArray(semantic) || semantic.length !== 2 || new Set(semantic.map(row => object(row)?.kind)).size !== 2
    || semantic.some(row => !['action_direction', 'state_progression'].includes(String(object(row)?.kind)))) {
    repairable = false; add('semanticChecks', -1, 'semantic_addresses_invalid')
  } else for (const [index, raw] of semantic.entries()) {
    const parsed = semanticSchema.safeParse(raw)
    if (!parsed.success) { add('semanticChecks', index, 'semantic_schema_invalid'); continue }
    const row = parsed.data, indexes = row.findingIds.map(id => Array.isArray(findingRows) ? findingRows.findIndex(item => object(item)?.findingId === id) : -1)
    if (new Set(row.findingIds).size !== row.findingIds.length || (row.result === 'conflict'
      ? !indexes.length || indexes.some(i => i < 0 || object((findingRows as unknown[])[i])?.severity !== 'error' || bad.get('findings')?.has(i))
      : row.findingIds.length !== 0)) add('semanticChecks', index, 'semantic_finding_binding_invalid')
    else normalizedSemantic.push({ kind: row.kind, result: row.result, reason: row.reason, findingIndexes: indexes })
  }
  const rowFields = ['terminalVerdicts', 'terminalProofVerdicts', 'terminalDispositions', 'proposalDispositions'] as const
  const addresses = { terminalVerdicts: 'claimIndex', terminalProofVerdicts: 'proofIndex', terminalDispositions: 'obligationIndex', proposalDispositions: 'proposalIndex' }
  const catalog = terminalReviewAddressCatalog(frozen.candidate, frozen.bodies.terminalEvidence!)
  const expectedAddresses = { terminalVerdicts: catalog.ordinary.map(row => row.claimIndex), terminalProofVerdicts: catalog.proofs.map(row => row.proofIndex),
    terminalDispositions: catalog.obligations.map(row => row.obligationIndex), proposalDispositions: catalog.proposals.map(row => row.proposalIndex) }
  for (const table of rowFields) {
    const schema = fields[table], value = record[table]
    if (table === 'proposalDispositions' && !frozen.bodies.terminalEvidence?.proposalChanges) {
      if (value !== undefined) { repairable = false; add(table, -1, 'unexpected_table') }
      continue
    }
    if (!Array.isArray(value) || value.length !== expectedAddresses[table].length
      || new Set(value.map(row => object(row)?.[addresses[table]])).size !== value.length
      || value.some(row => !expectedAddresses[table].includes(object(row)?.[addresses[table]] as number))) {
      repairable = false; add(table, -1, 'table_addresses_invalid'); continue
    }
    const parsed = schema.safeParse(value)
    if (parsed.success) continue
    if (!Array.isArray(value) || value.length > 200 || new Set(value.map(row => object(row)?.[addresses[table]])).size !== value.length) {
      repairable = false; add(table, -1, 'table_addresses_invalid'); continue
    }
    for (const issue of parsed.error.issues) {
      const index = issue.path.find(part => typeof part === 'number')
      if (typeof index !== 'number') { repairable = false; add(table, -1, 'table_addresses_incomplete'); continue }
      add(table, index, issue.code, issue.path.join('.'))
    }
  }
  const terminalDiagnostics: TerminalReviewDiagnostic[] = []
  const candidateEvidence = inspectTerminalCandidateEvidence(frozen.candidate, frozen.bodies.current, record,
    frozen.bodies.terminalEvidence!, terminalDiagnostics, true)
  // V4 selects exact server-owned addresses. Materialize only those explicit
  // disposition references for the unchanged strict legacy semantic engine;
  // neither the received rows nor the frozen raw response are rewritten.
  const engineRecord = { ...record }
  const currentSources = continuitySourceCatalog(frozen.bodies).terminalSources.filter(part => /^c[0-9]+$/u.test(part.segmentId))
  for (const table of ['terminalDispositions', 'proposalDispositions'] as const) {
    if (bad.has(table) || !Array.isArray(record[table])) continue
    engineRecord[table] = (record[table] as Array<Record<string, unknown>>).map(row => ({ ...row,
      sourceEvidence: (row.sourceEvidence as Array<{ segmentId: string }>).map(ref => ({ ...ref,
        quote: currentSources.find(part => part.segmentId === ref.segmentId)?.quote ?? '' })) }))
  }
  const terminal = inspectTerminalReview(frozen.candidate, frozen.bodies.current, JSON.stringify(engineRecord), true,
    frozen.bodies.terminalEvidence, terminalDiagnostics, { responseContract: 3 })
  const rows = terminalReviewRowDiagnostics(frozen.candidate, frozen.bodies, engineRecord)
  if (rows) for (const [table, indexes] of rows.bad) for (const index of indexes) add(table, index, 'terminal_evidence_invalid')
  if (!terminal && !rowFields.some(table => bad.has(table))) { repairable = false; add('terminalVerdicts', -1, 'terminal_binding_invalid') }
  const proseValid = !bad.has('findings') && !bad.has('semanticChecks')
    && normalizedSemantic.length === 2 && validContinuitySemanticChecks(normalizedSemantic, findings, 2, false)
  const currentValid = !bad.has('terminalVerdicts') && !bad.has('terminalProofVerdicts') && !!candidateEvidence
  const coverageValid = !bad.has('terminalDispositions') && !!candidateEvidence && !!rows
  const proposalsValid = !bad.has('proposalDispositions') && !!candidateEvidence && !!rows
  const projection = (valid: boolean, value: unknown, scope: Table[]) => ({ valid, value, diagnostics: diagnostics.filter(d => scope.includes(d.table)) })
  return { record, terminal, findings: proseValid ? findings : [], bad, repairable, diagnostics, terminalDiagnostics,
    valid: proseValid && currentValid && coverageValid && proposalsValid && !!terminal,
    projections: { prose: projection(proseValid, { findings, semanticChecks: normalizedSemantic }, ['findings', 'semanticChecks']),
      // Only the engine's absent optional basis is omitted. No coercion of
      // other values, projections or actual response rows is permitted.
      currentTerminal: projection(currentValid, candidateEvidence ? { verdicts: candidateEvidence.verdicts.map(value => {
        if (!('basis' in value)) return value
        const { basis, ...verdict } = value
        return { ...verdict, ...(basis === undefined ? {} : { basis }) }
      }),
        ...(candidateEvidence.inherited && 'proofChecks' in candidateEvidence.inherited ? { proofChecks: candidateEvidence.inherited.proofChecks } : {}) } : null, ['terminalVerdicts', 'terminalProofVerdicts']),
      historicalCoverage: projection(coverageValid, { input: frozen.bodies.terminalEvidence!.factCoverage ?? null, rows: record.terminalDispositions ?? [] }, ['terminalDispositions']),
      draftProposals: projection(proposalsValid, { input: frozen.bodies.terminalEvidence!.proposalChanges ?? null, rows: record.proposalDispositions ?? [] }, ['proposalDispositions']) } }
}

export function inspectContinuityV4(raw: string, frozen: ContinuityV4Frozen, responseComplete = true): ContinuityV4Inspection {
  let parsed: ReturnType<typeof inspectRecord> | null = null, classification = responseComplete ? 'json_invalid' : 'response_incomplete'
  if (responseComplete && raw.length <= 262_144 && validContinuityReviewManifest(frozen)) try {
    const record = object(parseQualityJsonObject(raw, 'continuity', 3))
    if (record) parsed = inspectRecord(record, frozen)
    classification = parsed?.valid ? 'complete' : 'projection_invalid'
  } catch (error) { classification = error instanceof Error && 'classification' in error ? String(error.classification) : 'json_invalid' }
  if (!validContinuityReviewManifest(frozen)) classification = 'manifest_invalid'
  if (raw.length > 262_144) classification = 'response_too_large'
  const audit: ContinuityV4Inspection['audit'] = { version: 1, parserVersion: 9 as const, responseContract: 4 as const, classification,
    rawResponse: rawReceipt(raw, responseComplete), contentHash: textHash(raw), characterCount: raw.length, unwrapped: false,
    terminalCandidate: frozen.candidate, terminalContentHash: runtimeJson({ content: frozen.bodies.current }).hash,
    terminalEvidence: frozen.bodies.terminalEvidence!, sourceScope: frozen.sourceScope,
    terminalReviewDiagnostics: parsed?.terminalDiagnostics ?? [], candidateFindings: [], invalidSourceReferences: [], sourceRelocations: [],
    continuityV4: { version: 1 as const, manifest: frozen.manifest, frozen,
      first: rawReceipt(raw, responseComplete), projections: parsed?.projections ?? null } }
  return { findings: parsed?.valid ? parsed.findings : [], structured: !!parsed, complete: !!parsed?.valid,
    candidateFindings: [], invalidSourceReferences: [], terminalReview: parsed?.terminal ?? null, parsed, audit }
}

export function buildContinuityInvalidRowRepair(first: ContinuityV4Inspection): V4RepairPlan | null {
  if (first.complete || !first.parsed?.repairable || !first.audit.rawResponse.complete) return null
  const mask = [...first.parsed.bad].flatMap(([table, indexes]) => [...indexes].map(index => ({ table, index })))
  if (!mask.length || mask.some(row => row.index < 0)) return null
  const record = first.parsed.record, fixed = Object.fromEntries(tables.filter(table => Array.isArray(record[table])).map(table => [table,
    (record[table] as unknown[]).map((row, index) => mask.some(item => item.table === table && item.index === index) ? null : row)]))
  return { version: 1 as const, manifestHash: first.audit.continuityV4.manifest.hash, firstHash: first.audit.contentHash,
    mask, fixedHash: runtimeJson(fixed).hash, fixed }
}

export function continuityV4RepairRequest(first: ContinuityV4Inspection) {
  const plan = buildContinuityInvalidRowRepair(first)
  if (!plan) return null
  const fields = responseFields(first.audit.continuityV4.frozen)
  const schemas = plan.mask.map(item => {
    const array = fields[item.table]
    if (!(array instanceof z.ZodArray)) throw Error('Invalid repair table schema')
    const value = item.table === 'findings' ? z.union([findingSchema, z.object({ findingId: z.literal(String(object((first.parsed!.record.findings as unknown[])[item.index])?.findingId)),
      action: z.literal('retract'), reason: z.string().min(1).max(400), sourceEvidence: z.array(evidenceReference).min(1).max(8) }).strict()]) : array.element
    return z.object({ table: z.literal(item.table), index: z.literal(item.index), value }).strict()
  })
  const schema = z.object({ corrections: z.array(z.union(schemas)).length(plan.mask.length) }).strict()
  return { system: '只纠正本次明确无效行，严格返回 {"corrections":[{"table":"findings","index":0,"value":{...}}]}。每个mask地址恰好一次，其他表/行保持原独立结论。合法unknown不是无效行，不得改成supported。finding行可显式 {"findingId":"f0","action":"retract","reason":"实际核对后的撤回原因","sourceEvidence":[{"segmentId":"c0"}]}，不得静默删除意见；替换finding必须保留findingId并返回完整新行。reason是说明，只有显式sourceEvidence才是原文证据。不得重发完整报告、计算hash或更改正文。' + JSON.stringify(z.toJSONSchema(schema, { io: 'input' })),
    content: JSON.stringify({ catalog: buildContinuityReviewCatalog(first.audit.continuityV4.frozen.bodies, first.audit.continuityV4.frozen.candidate),
      invalid: plan.mask.map(item => ({ ...item, original: (first.parsed!.record[item.table] as unknown[])[item.index] })),
      fixed: plan.fixed, diagnostics: first.parsed!.diagnostics }) }
}

export function applyContinuityV4Repair(first: ContinuityV4Inspection, raw: string, complete: boolean): ContinuityV4Inspection {
  const plan = buildContinuityInvalidRowRepair(first)
  if (!plan || !complete) throw Error('No complete one-slot continuity repair')
  JSON.parse(raw)
  const envelope = z.object({ corrections: z.array(z.object({ table: z.enum(tables), index: z.number().int().nonnegative(), value: z.unknown() }).strict()).max(1000) }).strict()
    .parse(parseQualityJsonObject(raw, 'corrections', 3))
  if (envelope.corrections.length !== plan.mask.length || new Set(envelope.corrections.map(row => `${row.table}:${row.index}`)).size !== envelope.corrections.length
    || envelope.corrections.some(row => !plan.mask.some(item => item.table === row.table && item.index === row.index))) throw Error('Continuity repair mask mismatch')
  const record = structuredClone(first.parsed!.record), dispositions: Array<Record<string, unknown>> = [], retracted = new Set<string>()
  for (const row of envelope.corrections) {
    if (row.table !== 'findings') {
      const address = ({ semanticChecks: 'kind', terminalVerdicts: 'claimIndex', terminalProofVerdicts: 'proofIndex',
        terminalDispositions: 'obligationIndex', proposalDispositions: 'proposalIndex' } as const)[row.table]
      if (object(row.value)?.[address] !== object((record[row.table] as unknown[])[row.index])?.[address]) throw Error('Repair changed frozen row address')
    }
    if (row.table === 'findings' && object(row.value)?.action === 'retract') {
      const decision = z.object({ findingId: findingSchema.shape.findingId, action: z.literal('retract'), reason: z.string().min(1).max(400),
        sourceEvidence: z.array(evidenceReference).min(1).max(8) }).strict().parse(row.value)
      const original = object((record.findings as unknown[])[row.index])
      if (decision.findingId !== original?.findingId || !bindFinding({ findingId: decision.findingId, signal: 'object', severity: 'warning',
        reason: decision.reason, suggestion: '原意见独立撤回，正文未改。', sourceEvidence: decision.sourceEvidence }, row.index, first.audit.continuityV4.frozen)) throw Error('Invalid original finding disposition')
      dispositions.push(decision); retracted.add(decision.findingId)
      continue
    }
    if (row.table === 'findings' && object(row.value)?.findingId !== object((record.findings as unknown[])[row.index])?.findingId) throw Error('Repair changed original finding identity')
    ;(record[row.table] as unknown[])[row.index] = row.value
    if (row.table === 'findings') dispositions.push({ findingId: object(row.value)!.findingId, action: 'replace', value: row.value })
  }
  // Retractions remain explicit audited rows. The interpretation below keeps
  // original IDs; only its final report/index projection removes those rows.
  const frozen = first.audit.continuityV4.frozen
  const removed = (record.findings as unknown[]).flatMap((row, index) => retracted.has(String(object(row)?.findingId)) ? [index] : [])
  let expectedFindingIds: string[] | undefined
  if (removed.length) {
    const semantic = record.semanticChecks as unknown[]
    if (semantic.some(row => (object(row)?.findingIds as unknown[] | undefined)?.some(id => retracted.has(String(id))))) throw Error('Repair retained a reference to a retracted finding')
    // Reuse the same validator with canonical final row positions, while the
    // original-to-final ID map remains in the common lineage.
    const kept = (record.findings as unknown[]).filter((_, index) => !removed.includes(index))
    expectedFindingIds = kept.map(row => String(object(row)?.findingId))
    record.findings = kept
  }
  const inspected = inspectRecord(record, frozen, expectedFindingIds)
  if (!inspected.valid) throw Error('Continuity repaired rows remain invalid')
  const audit = { ...first.audit, classification: 'complete', continuityV4: { ...first.audit.continuityV4,
    repair: { response: rawReceipt(raw, true), plan, dispositions, recordHash: runtimeJson(record).hash }, projections: inspected.projections } }
  return { ...first, complete: true, structured: true, findings: inspected.findings, terminalReview: inspected.terminal, parsed: inspected, audit }
}

export function failedContinuityV4Repair(first: ContinuityV4Inspection, raw: string, complete: boolean): ContinuityV4Inspection {
  return { ...first, complete: false, audit: { ...first.audit, classification: complete ? 'projection_invalid' : 'response_incomplete',
    continuityV4: { ...first.audit.continuityV4, failedRepair: { response: rawReceipt(raw, complete) } } } }
}

/** Rebuild, never trust stored projection booleans or an assembled JSON value. */
export function validateStoredContinuityV4Projection(value: unknown, content: string, context: ContinuityBodies['terminalEvidence']) {
  try {
    const audit = object(value), marker = object(audit?.continuityV4)
    if (!audit || audit.parserVersion !== 9 || audit.responseContract !== 4 || marker?.version !== 1 || !object(marker.frozen)) return null
    const frozen = marker.frozen as ContinuityV4Frozen
    if (frozen.bodies.current !== content || runtimeJson(frozen.bodies.terminalEvidence).hash !== runtimeJson(context).hash
      || runtimeJson(audit.terminalCandidate).hash !== frozen.manifest.candidateHash || runtimeJson(marker.manifest).hash !== runtimeJson(frozen.manifest).hash) return null
    const first = object(marker.first)
    if (first?.complete !== true || first.encoding !== 'json-string' || typeof first.content !== 'string') return null
    const raw: unknown = JSON.parse(first.content)
    if (typeof raw !== 'string') return null
    let rebuilt = inspectContinuityV4(raw, frozen, true)
    if (marker.failedRepair !== undefined) {
      if (marker.repair !== undefined) return null
      const response = object(object(marker.failedRepair)?.response)
      if (response?.encoding !== 'json-string' || typeof response.content !== 'string' || typeof response.complete !== 'boolean') return null
      const second: unknown = JSON.parse(response.content)
      if (typeof second !== 'string') return null
      if (response.complete) {
        let validRepair = false
        try { validRepair = applyContinuityV4Repair(rebuilt, second, true).complete } catch { /* Retain the actual failed second response. */ }
        if (validRepair) return null
      }
      rebuilt = failedContinuityV4Repair(rebuilt, second, response.complete)
    }
    if (marker.repair !== undefined) {
      const repair = object(marker.repair), response = object(repair?.response)
      if (response?.complete !== true || response.encoding !== 'json-string' || typeof response.content !== 'string') return null
      const second: unknown = JSON.parse(response.content)
      if (typeof second !== 'string') return null
      rebuilt = applyContinuityV4Repair(rebuilt, second, true)
    }
    const { assessmentRequest: _request, ...stored } = audit
    return runtimeJson(stored).hash === runtimeJson(rebuilt.audit).hash ? rebuilt : null
  } catch { return null }
}
