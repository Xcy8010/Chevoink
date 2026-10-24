import { z } from 'zod'
import { continuityCandidateSchema, inspectContinuityResponse } from './continuity-format-recovery.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import { terminalResponseFields, terminalVerdictSchema, inheritedTerminalVerdictSchema, sourcedTerminalVerdictSchema, terminalSpanVerdictSchema, type TerminalCandidate } from './terminal-review-engine.js'
import { terminalAddressResponseFields, terminalReviewAddressCatalog, normalizeTerminalResponseRows } from './terminal-review-addresses.js'
import { continuitySourceCatalog, resolveContinuitySources, type ContinuityBodies } from './continuity-review-context.js'
import { runtimeJson } from './runtime-common.js'
import { continuityFindingInputSchema } from '../../../shared/contracts/story-compiler-contracts.js'
import { terminalProofVerdictSchema } from './terminal-proof-verdict.js'
import { terminalDispositionSchema } from './terminal-fact-coverage.js'
import { invalidContinuitySourceClaim } from './continuity-source-authority.js'

/** One model-facing contract for new v6 reviews. Historical requests keep their
 * frozen system, schema and reassessment protocol unchanged. */
export function continuityResponseContract(bodies: ContinuityBodies, candidate: TerminalCandidate, decisions?: z.ZodType) {
  const context = bodies.terminalEvidence
  if (context?.verdictProtocol !== 6) throw new Error('Continuity response contract 3 requires frozen v6 evidence')
  const sources = context.spanAddressProtocol === 2 ? continuitySourceCatalog(bodies).terminalSources.map(part => part.segmentId) : undefined
  return z.object({ ...(decisions ? { decisions } : {}), findings: z.array(continuityCandidateSchema),
    ...terminalResponseFields(true, 5, sources), ...terminalAddressResponseFields(candidate, context, sources, true) }).strict()
}

export function continuityResponseSystem(system: string, schema: z.ZodType) {
  const header = '只输出一个完整 JSON 对象，不编码成带外层引号的字符串。以下是本次唯一响应合同；不要套用其他工具或历史响应格式。'
  const purpose = system.split(`\n${header}`)[0].split('\n').map(line => line
    .replace('无问题返回 {"findings":[]}。', '没有事实冲突时 findings 为空；其他必需字段仍按本次唯一响应合同返回。'))
    .filter(line => !line.includes('合法结构示例：')).join('\n')
  return `${purpose}\n${header}\n${JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))}`
}

export function continuityResponseInput(content: string, bodies: ContinuityBodies, candidate: TerminalCandidate) {
  const catalog = terminalReviewAddressCatalog(candidate, bodies.terminalEvidence!)
  const counts = { terminalVerdicts: catalog.ordinary.length, terminalProofVerdicts: catalog.proofs.length,
    terminalDispositions: catalog.obligations.length, proposalDispositions: catalog.proposals.length }
  const lines = content.split('\n').filter(line => !line.startsWith('完整响应 JSON Schema（'))
  if (lines[0]?.startsWith('本次待回复表精确行数：') && lines[1]?.startsWith('持续事实：replaced')) lines.splice(0, 2)
  const input = lines.join('\n')
  return `本次待回复表精确行数：${JSON.stringify(counts)}。每个目录地址恰好一次。历史原文证明是参考资料，不等于本次待回复证明表；terminalProofVerdicts 为0时必须返回[]，不能抄历史全部证明。\n持续事实：replaced 必须指向本次 supported 的 knowledge/body/objects/relationships/openLoops 候选，不能指向 action/location/storyTime/emotion；unknown 和 ended 不得携带 candidateIndex，ended 必须有本章实际解除的证据。缺乏判断依据仍返回 unknown，不改成通过。\n${input}`
}

/** Only independently valid opinions/semantic checks can be held fixed. The
 * second response is still a real complete provider response, never assembled
 * or supplemented with server-invented reviewer conclusions. */
export function fixedContinuityResponseFields(original: { structured: boolean; invalidSourceReferences: unknown[];
  audit: { classification: string; rawResponse: { content: string } } }) {
  if (!original.structured || original.invalidSourceReferences.length
    || !['terminal_invalid', 'semantic_invalid'].includes(original.audit.classification)) return null
  try {
    const parsed = parseQualityJsonObject(JSON.parse(original.audit.rawResponse.content) as string, 'continuity', 3) as Record<string, unknown>
    if (!Array.isArray(parsed.findings)) return null
    return { findings: parsed.findings, ...(original.audit.classification === 'terminal_invalid' ? { semanticChecks: parsed.semanticChecks } : {}) }
  } catch { return null }
}

export function assertFixedContinuityResponseFields(fixed: NonNullable<ReturnType<typeof fixedContinuityResponseFields>>, response: Record<string, unknown>) {
  for (const [field, value] of Object.entries(fixed)) {
    if (runtimeJson({ value }).hash !== runtimeJson({ value: response[field] ?? null }).hash) {
      throw new Error(`Continuity field repair changed frozen ${field}`)
    }
  }
}

export function continuityReassessmentDiagnostics(original: ReturnType<typeof inspectContinuityResponse>, raw: string, bodies: ContinuityBodies) {
  const inspected = inspectContinuityResponse(raw, bodies, true, original.audit.parserVersion, original.audit.terminalCandidate,
    original.audit.sourceScope, original.audit.responseContract === 3 ? { responseContract: 3 } : {})
  const fixed = original.audit.responseContract === 3 ? fixedContinuityResponseFields(original) : null
  let fixedFieldError: string | undefined
  if (fixed) try { assertFixedContinuityResponseFields(fixed, parseQualityJsonObject(raw, 'continuity', 3) as Record<string, unknown>) }
  catch (error) { fixedFieldError = error instanceof Error ? error.message : 'Fixed reviewer fields changed' }
  if (original.audit.responseContract === 3 && !fixed) {
    try { continuityReassessmentEnvelope(original, raw, bodies, 3) }
    catch (error) {
      const terminalReviewDiagnostics = error instanceof z.ZodError ? error.issues.slice(0, 8).map(issue => ({ code: issue.code, path: issue.path.join('.'), message: issue.message }))
        : [{ code: 'reassessment_invalid', path: 'decisions', message: error instanceof Error ? error.message.slice(0, 1000) : 'Invalid reassessment decisions' }]
      return { classification: 'terminal_invalid', terminalReviewDiagnostics }
    }
  }
  return { classification: fixedFieldError ? 'fixed_fields_changed' : inspected.audit.classification,
    ...(fixedFieldError ? { fixedFieldError } : {}), terminalReviewDiagnostics: inspected.audit.terminalReviewDiagnostics ?? [] }
}


const proofSchema = z.object({ source: z.enum(['previous', 'current']), segmentId: z.string().min(1).optional(), quote: z.string().min(2).max(360).optional() }).strict()
  .refine(value => value.segmentId !== undefined || value.quote !== undefined)
export const decisionSchema = z.object({ index: z.number().int().nonnegative(), action: z.enum(['confirm', 'retract', 'replace']),
  reason: z.string().trim().min(1).max(1000), sourceEvidence: z.array(proofSchema).min(1).max(8), findingIndex: z.number().int().nonnegative().optional() }).strict()

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
export function continuityReassessmentCandidates(raw: string): unknown[] | null {
  try {
    const value = object(parseQualityJsonObject(raw, 'continuity', 3))
    if (!value) return null
    const keys = ['findings', 'issues', 'problems'].filter(key => Object.prototype.hasOwnProperty.call(value, key))
    return keys.length === 1 && Array.isArray(value[keys[0]]) ? value[keys[0]] as unknown[] : null
  } catch {
    try {
      const outer = object(JSON.parse(raw)), keys = Object.keys(outer ?? {})
      const inner = keys.length === 1 ? object(outer![keys[0]]) : null
      return inner && Object.keys(inner).length === 1 && Array.isArray(inner.findings) ? inner.findings : null
    } catch { return null }
  }
}
export function continuityReassessmentEnvelope(original: ReturnType<typeof inspectContinuityResponse>, raw: string, bodies: ContinuityBodies, reassessmentProtocol?: 2 | 3) {
  const candidates = continuityReassessmentCandidates(JSON.parse(original.audit.rawResponse.content) as string)
  const wire = parseQualityJsonObject(raw, 'findings', 3)
  const projection = reassessmentProtocol === 3 && object(wire) ? normalizeTerminalResponseRows(object(wire)!) : null
  if (projection?.error) throw new Error(projection.error)
  const parsed = projection?.record ?? wire
  // No original findings means there are no disposition identities to carry.
  // Derive only that empty bookkeeping array; never infer a reviewer judgment,
  // forgive an explicit invalid value, or drop an unparseable/nonempty report.
  const value = object(parsed)
  const response = (reassessmentProtocol === 2 || reassessmentProtocol === 3) && candidates?.length === 0 && value && !Object.prototype.hasOwnProperty.call(value, 'decisions')
    ? { ...value, decisions: [] } : parsed
  const terminalFields = original.audit.terminalEvidence?.verdictProtocol === 6 && original.audit.terminalCandidate
    ? { ...terminalResponseFields(true, 5), ...terminalAddressResponseFields(original.audit.terminalCandidate, original.audit.terminalEvidence, undefined, reassessmentProtocol === 3) }
    : (original.audit.terminalEvidence?.verdictProtocol === 4 || original.audit.terminalEvidence?.verdictProtocol === 5)
      ? terminalResponseFields(!!original.audit.terminalCandidate, original.audit.terminalEvidence.verdictProtocol, undefined, original.audit.terminalEvidence.proposalChanges) : {}
  const envelope = z.object({ decisions: z.array(decisionSchema), findings: z.array(z.unknown()),
    terminalVerdicts: z.array(original.audit.parserVersion === 8 ? original.audit.terminalEvidence?.verdictProtocol === 3 ? terminalSpanVerdictSchema
      : original.audit.terminalEvidence?.verdictProtocol === 2 ? sourcedTerminalVerdictSchema : inheritedTerminalVerdictSchema : terminalVerdictSchema).max(200).optional(),
    ...(original.audit.parserVersion === 8 && original.audit.terminalEvidence?.verdictProtocol === 3 ? { terminalProofVerdicts: z.array(terminalProofVerdictSchema).max(200).optional() } : {}),
    ...(original.audit.parserVersion === 8 ? { semanticChecks: z.unknown() } : {}),
    ...(original.audit.parserVersion === 8 && original.audit.terminalEvidence?.factCoverage ? { terminalDispositions: z.array(terminalDispositionSchema).max(200).optional() } : {}),
  }).extend(terminalFields).strict().parse(response)
  if (envelope.decisions.length !== (candidates?.length ?? 0) || new Set(envelope.decisions.map(item => item.index)).size !== envelope.decisions.length
    || envelope.decisions.some(item => item.index >= (candidates?.length ?? 0))) throw new Error('Reassessment omitted or invented an original candidate')
  const semantic = (value: unknown) => {
    const item = object(value)
    return runtimeJson({ signal: item?.signal, severity: item?.severity, evidence: item?.evidence, suggestion: item?.suggestion }).hash
  }
  for (const decision of envelope.decisions) {
    if (original.audit.parserVersion >= 7 && (decision.sourceEvidence.some(ref => !ref.quote)
      || !decision.sourceEvidence.some(ref => ref.source === 'current'))) throw new Error('Reassessment disposition requires current manuscript quotations')
    const proof = resolveContinuitySources({ signal: 'object', severity: 'warning', evidence: '复评原文依据', suggestion: '核对实际事件', sourceEvidence: decision.sourceEvidence }, bodies, 4)
    const bound = continuityFindingInputSchema.parse(proof)
    if (bound.sourceEvidence?.some(ref => !(bodies[ref.source] ?? '').includes(ref.quote))) throw new Error('Reassessment disposition has invalid source proof')
    if (original.audit.parserVersion >= 7 && invalidContinuitySourceClaim({ ...bound, evidence: decision.reason }, bodies, decision.sourceEvidence, original.audit.sourceScope)) {
      throw new Error('Reassessment disposition quotes unsupported manuscript evidence')
    }
    if (decision.action === 'retract') {
      if (decision.findingIndex !== undefined) throw new Error('Retracted candidate cannot become a final finding')
    } else {
      if (decision.findingIndex === undefined || decision.findingIndex >= envelope.findings.length) throw new Error('Reassessment has no linked final finding')
      if (decision.action === 'confirm' && semantic(candidates![decision.index]) !== semantic(envelope.findings[decision.findingIndex])) throw new Error('Confirmed candidate changed its judgment')
    }
  }
  return { envelope, derivedEmptyDecisions: response !== parsed }
}
