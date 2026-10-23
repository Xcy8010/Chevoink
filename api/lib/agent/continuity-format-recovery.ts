import { createHash } from 'node:crypto'
import { z } from 'zod'
import { continuityFindingInputSchema, type ContinuityFindingInput } from '../../../shared/contracts/story-compiler-contracts.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import { resolveContinuitySources, type ContinuityBodies, type ContinuitySourceRelocation } from './continuity-review-context.js'
import { unlocatedContinuityEvidence } from './continuity-finding-authority.js'
import { invalidContinuitySourceClaim, type ContinuitySourceScope } from './continuity-source-authority.js'
import { inspectTerminalReview, terminalQuoteAddressDiagnostics, terminalResponseFields, type TerminalCandidate, type TerminalReviewDiagnostic } from './terminal-state-review.js'
import { runtimeJson } from './runtime-common.js'
import { validContinuitySemanticChecks } from './terminal-evidence-context.js'
import { terminalAddressResponseFields } from './terminal-review-addresses.js'

const sourceReferenceSchema = z.object({ source: z.enum(['previous', 'current']), segmentId: z.string().min(1).optional(), quote: z.string().min(2).max(360).optional() })
  .refine(value => value.segmentId !== undefined || value.quote !== undefined)
export const continuityCandidateSchema = continuityFindingInputSchema.omit({ sourceEvidence: true }).extend({ sourceEvidence: z.array(sourceReferenceSchema).min(1).max(8).optional() })
export type ContinuityCandidate = z.infer<typeof continuityCandidateSchema>
export type InvalidContinuitySource = { findingIndex: number; referenceIndex: number; source: 'previous' | 'current' }
export function continuityUnlocatedCandidateCount(inspected: { audit: { classification: string }; invalidSourceReferences: InvalidContinuitySource[] }) {
  return inspected.audit.classification === 'source_invalid' ? new Set(inspected.invalidSourceReferences.map(ref => ref.findingIndex)).size : 0
}

const MAX_AUDIT_CHARS = 262_144
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
function normalize(value: unknown, bodies: ContinuityBodies | undefined, parserVersion: 3 | 4, relocations: ContinuitySourceRelocation[], findingIndex: number) {
  const item = object(bodies ? resolveContinuitySources(value, bodies, parserVersion, relocations, findingIndex) : value)
  if (!item || item.sourceEvidence !== undefined || typeof item.evidence !== 'string') return item ?? value
  const quotes = [...item.evidence.matchAll(/(前章已保存原文|当前正文)[:：]\s*(?:'([^']{2,360})'|“([^”]{2,360})”|"([^"]{2,360})")/gu)]
    .map(match => ({ source: match[1] === '前章已保存原文' ? 'previous' : 'current', quote: match[2] ?? match[3] ?? match[4] }))
  return quotes.length ? { ...item, sourceEvidence: quotes } : item
}

/** Mechanical envelope compatibility; no new model call or missing-content reconstruction. */
export function inspectContinuityResponse(raw: string, bodies?: ContinuityBodies, responseComplete = true, parserVersion: 3 | 4 | 5 | 6 | 7 | 8 = 3, terminalCandidate?: TerminalCandidate, sourceScope?: ContinuitySourceScope) {
  const sourceRelocations: ContinuitySourceRelocation[] = []
  let classification = responseComplete ? 'json_invalid' : 'response_incomplete'
  let record: Record<string, unknown> | null = null
  let unwrapped = false
  if (responseComplete && raw.length <= MAX_AUDIT_CHARS) {
    try { record = object(parseQualityJsonObject(raw, 'continuity', 3)) }
    catch (error) {
      classification = error instanceof Error && 'classification' in error && typeof error.classification === 'string' ? error.classification : 'json_invalid'
      // Duplicate keys, multiple envelopes and damaged syntax remain failures.
      if (classification === 'envelope_invalid') try {
        const outer = object(JSON.parse(raw))
        const keys = outer ? Object.keys(outer) : []
        const inner = keys.length === 1 ? object(outer![keys[0]]) : null
        if (inner && Object.keys(inner).length === 1 && Array.isArray(inner.findings) && inner.findings.length) { record = inner; unwrapped = true }
      } catch { /* Retain original response without inventing findings. */ }
    }
  }
  let findings: ContinuityFindingInput[] = []
  let candidateFindings: ContinuityCandidate[] = []
  const invalidSourceReferences: InvalidContinuitySource[] = []
  let structured = false
  if (record) {
    const keys = ['findings', 'issues', 'problems'].filter(key => Object.prototype.hasOwnProperty.call(record, key))
    if (keys.length !== 1) classification = 'ambiguous_envelope'
    else {
      const candidate = record[keys[0]]
      const fields = parserVersion >= 5 ? z.array(continuityCandidateSchema).safeParse(Array.isArray(candidate) ? candidate.map(item => normalize(item, undefined, 4, [], 0)) : candidate) : null
      if (fields?.success) {
        structured = true
        candidateFindings = fields.data
        const bound = candidateFindings.map((item, index) => {
          item.sourceEvidence?.forEach((ref, referenceIndex) => {
            const single = bodies ? resolveContinuitySources({ ...item, sourceEvidence: [ref] }, bodies, 4) : { ...item, sourceEvidence: [ref] }
            const checked = continuityFindingInputSchema.safeParse(single)
            if (!checked.success || bodies && checked.data.sourceEvidence?.some(bound => !(bodies[bound.source] ?? '').includes(bound.quote))) {
              invalidSourceReferences.push({ findingIndex: index, referenceIndex, source: ref.source })
            }
          })
          const resolved = bodies ? resolveContinuitySources(item, bodies, 4, sourceRelocations, index) : item
          const parsed = continuityFindingInputSchema.safeParse(resolved)
          if (parserVersion >= 7 && bodies && parsed.success && invalidContinuitySourceClaim(parsed.data, bodies, item.sourceEvidence, sourceScope)) {
            invalidSourceReferences.push({ findingIndex: index, referenceIndex: -1, source: 'current' })
          }
          // An invented quote inside the judgment cannot be fixed without
          // rewriting that judgment, which an evidence-only call cannot do.
          if (bodies && unlocatedContinuityEvidence({ ...item, sourceEvidence: undefined }, bodies, false, true, false)) {
            invalidSourceReferences.push({ findingIndex: index, referenceIndex: -1, source: 'current' })
          }
          if (!parsed.success || bodies && unlocatedContinuityEvidence(parsed.data, bodies, true, true, true)) {
            // Candidates retain the original references. Empty strings generated
            // by the frozen address resolver are never field-parse failures.
            if (!invalidSourceReferences.some(ref => ref.findingIndex === index)) invalidSourceReferences.push({ findingIndex: index, referenceIndex: -1, source: 'current' })
          }
          return parsed.success ? parsed.data : null
        })
        classification = invalidSourceReferences.length ? 'source_invalid' : 'complete'
        findings = classification === 'complete' ? bound.filter((item): item is ContinuityFindingInput => item !== null) : []
      } else if (parserVersion >= 5) classification = 'findings_invalid'
      else {
        const parsed = z.array(continuityFindingInputSchema).safeParse(Array.isArray(candidate) ? candidate.map((item, index) => normalize(item, bodies, parserVersion as 3 | 4, sourceRelocations, index)) : candidate)
        if (!parsed.success) classification = 'findings_invalid'
        else {
          structured = true
          findings = parsed.data
          classification = bodies && findings.some(item => unlocatedContinuityEvidence(item, bodies, true, true, true)) ? 'source_invalid' : 'complete'
        }
      }
    }
  }
  if (raw.length > MAX_AUDIT_CHARS) classification = 'response_too_large'
  const indexed = bodies?.terminalEvidence?.verdictProtocol === 6
  const freshFields = indexed && terminalCandidate ? { ...terminalResponseFields(true, 5), ...terminalAddressResponseFields(terminalCandidate, bodies!.terminalEvidence!) }
    : bodies?.terminalEvidence?.verdictProtocol === 4 || bodies?.terminalEvidence?.verdictProtocol === 5 ? terminalResponseFields(!!terminalCandidate, bodies.terminalEvidence.verdictProtocol, undefined, bodies.terminalEvidence.proposalChanges) : null
  if (classification === 'complete' && indexed && !terminalCandidate) classification = 'terminal_invalid'
  if (classification === 'complete' && parserVersion === 8 && (!bodies?.terminalEvidence
    || freshFields && !freshFields.semanticChecks.safeParse(record?.semanticChecks).success
    || !validContinuitySemanticChecks(record?.semanticChecks, findings, bodies.terminalEvidence.factCoverage?.version, (bodies.terminalEvidence.verdictProtocol === 4 || bodies.terminalEvidence.verdictProtocol === 5 || indexed)))) classification = 'semantic_invalid'
  const terminalReviewDiagnostics: TerminalReviewDiagnostic[] = []
  if (classification === 'complete' && freshFields) {
    const parsed = z.object(freshFields).passthrough().safeParse(record)
    if (!parsed.success) {
      classification = 'terminal_invalid'
      // New requests receive bounded field diagnostics through the existing
      // full-reassessment channel; old frozen request renderings stay identical.
      if (bodies?.terminalEvidence?.verdictProtocol === 5 || indexed) terminalReviewDiagnostics.push(...parsed.error.issues.slice(0, 8).map(issue => ({
        code: issue.code, path: issue.path.join('.'),
      })))
    }
  }
  if (classification === 'complete' && terminalCandidate && (!bodies || !inspectTerminalReview(terminalCandidate, bodies.current, raw, responseComplete,
    parserVersion === 8 ? bodies.terminalEvidence : undefined, terminalReviewDiagnostics))) classification = 'terminal_invalid'
  const audit = { version: 1, parserVersion, classification, unwrapped, ...(parserVersion >= 4 ? { sourceRelocations } : {}),
    ...(terminalReviewDiagnostics.length ? { terminalReviewDiagnostics } : {}),
    ...(parserVersion === 8 && bodies?.terminalEvidence?.quoteAddressProtocol === 1 ? { terminalAddressDiagnostics: terminalQuoteAddressDiagnostics(raw, bodies.current, bodies.terminalEvidence, terminalCandidate) } : {}),
    ...(parserVersion >= 7 && sourceScope ? { sourceScope } : {}),
    ...(parserVersion === 8 && bodies?.terminalEvidence ? { terminalEvidence: bodies.terminalEvidence } : {}),
    ...(terminalCandidate ? { terminalCandidate, terminalContentHash: bodies ? runtimeJson({ content: bodies.current }).hash : null } : {}),
    ...(parserVersion >= 5 ? { candidateFindings, invalidSourceReferences } : {}), contentHash: createHash('sha256').update(raw).digest('hex'),
    characterCount: raw.length, rawResponse: { version: 1, encoding: 'json-string', content: JSON.stringify(raw.slice(0, MAX_AUDIT_CHARS)), complete: raw.length <= MAX_AUDIT_CHARS } }
  return { structured, findings, complete: structured && classification === 'complete', candidateFindings, invalidSourceReferences, audit }
}

/** Internal model observation only; public summaries and saved raw responses stay intact. */
export function continuityFailureOutput(audit: { classification?: string; terminalReviewDiagnostics?: TerminalReviewDiagnostic[] } | undefined, fallback: string) {
  if (audit?.classification !== 'terminal_invalid' || !audit.terminalReviewDiagnostics?.length) return fallback
  return `${fallback}\n已接收独立响应，终态证据绑定未通过：${JSON.stringify(audit.terminalReviewDiagnostics)}。核对对应候选与冻结证据，使用准确的完整 terminalState 重检；保留正文、原预算及失败记录。`
}
