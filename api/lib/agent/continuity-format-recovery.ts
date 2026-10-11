import { createHash } from 'node:crypto'
import { z } from 'zod'
import { continuityFindingInputSchema, type ContinuityFindingInput } from '../../../shared/contracts/story-compiler-contracts.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import { resolveContinuitySources, type ContinuityBodies, type ContinuitySourceRelocation } from './continuity-review-context.js'
import { unlocatedContinuityEvidence } from './continuity-finding-authority.js'

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
export function inspectContinuityResponse(raw: string, bodies?: ContinuityBodies, responseComplete = true, parserVersion: 3 | 4 = 3) {
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
  let structured = false
  if (record) {
    const keys = ['findings', 'issues', 'problems'].filter(key => Object.prototype.hasOwnProperty.call(record, key))
    if (keys.length !== 1) classification = 'ambiguous_envelope'
    else {
      const candidate = record[keys[0]]
      const parsed = z.array(continuityFindingInputSchema).safeParse(Array.isArray(candidate) ? candidate.map((item, index) => normalize(item, bodies, parserVersion, sourceRelocations, index)) : candidate)
      if (!parsed.success) classification = 'findings_invalid'
      else {
        structured = true
        findings = parsed.data
        classification = bodies && findings.some(item => unlocatedContinuityEvidence(item, bodies, true, true, true)) ? 'source_invalid' : 'complete'
      }
    }
  }
  if (raw.length > MAX_AUDIT_CHARS) classification = 'response_too_large'
  const audit = { version: 1, parserVersion, classification, unwrapped, ...(parserVersion === 4 ? { sourceRelocations } : {}), contentHash: createHash('sha256').update(raw).digest('hex'),
    characterCount: raw.length, rawResponse: { version: 1, encoding: 'json-string', content: JSON.stringify(raw.slice(0, MAX_AUDIT_CHARS)), complete: raw.length <= MAX_AUDIT_CHARS } }
  return { structured, findings, audit }
}
