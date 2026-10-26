import { validateStoredExplicitSourceProjection } from './continuity-explicit-source-projection.js'
import { classifyContinuityFindingAuthority } from './continuity-finding-authority.js'
import type { TerminalEvidenceContext } from './terminal-evidence-context.js'
import { runtimeJson } from './runtime-common.js'
import { continuityFindingInputSchema } from '../../../shared/contracts/story-compiler-contracts.js'
import type { TerminalCandidate } from './terminal-state-review.js'

// Keep the frozen legacy default. Source authority selects 9; bounded terminal
// evidence selects 10/11. Resumes never upgrade an old paid interpretation.
export const COMPILER_CONTINUITY_PROTOCOL = 8

export type CompilerContinuityCoverage = {
  version: 1; contentHash: string; charCount: number; sourceHash: string | null; reviewHash?: string; protocolVersion?: number; terminalHash?: string
}

/** Bookkeeping is not critic input; story state, scene intent and focus are. */
export function continuityStoryInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(continuityStoryInput)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => !['createdAt', 'updatedAt', 'status'].includes(key) && item !== undefined)
    .map(([key, item]) => [key, continuityStoryInput(item)]))
}

export function compilerContinuityCoverage(input: {
  chapter: { id: string; revision: number; content: string; orderIndex: number; title?: string }
  bridge: unknown; sceneTasks: unknown[]; source: unknown | null; focus?: string; terminalCandidate?: TerminalCandidate
}, protocol: 6 | 7 | 8 | 9 | 10 | 11 = COMPILER_CONTINUITY_PROTOCOL): CompilerContinuityCoverage {
  const contentHash = runtimeJson({ content: input.chapter.content }).hash
  const sourceHash = input.source ? runtimeJson(input.source).hash : null
  const terminalHash = input.terminalCandidate ? runtimeJson(input.terminalCandidate).hash : undefined
  return { version: 1, protocolVersion: protocol, contentHash, charCount: input.chapter.content.length, sourceHash, ...(terminalHash ? { terminalHash } : {}),
    reviewHash: runtimeJson({ protocol, chapter: { id: input.chapter.id, title: input.chapter.title ?? '', revision: input.chapter.revision, orderIndex: input.chapter.orderIndex, contentHash },
      bridge: continuityStoryInput(input.bridge), scenes: continuityStoryInput(input.sceneTasks), sourceHash, focus: input.focus ?? '', ...(terminalHash ? { terminalHash } : {}) }).hash }
}

export function compilerContinuityCoverageMatches(actual: unknown, expected: CompilerContinuityCoverage): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
  const value = actual as Record<string, unknown>
  return typeof value.reviewHash === 'string' && value.reviewHash === expected.reviewHash
    && value.protocolVersion === expected.protocolVersion
    && value.version === expected.version && value.contentHash === expected.contentHash
    && value.charCount === expected.charCount && value.sourceHash === expected.sourceHash
    && value.terminalHash === expected.terminalHash
}

/** Recovering paid work must not dispatch a new repair under an older protocol. */
export function hasCurrentCompilerContinuityProtocol(coverage: CompilerContinuityCoverage): boolean {
  return [COMPILER_CONTINUITY_PROTOCOL, 9, 10, 11].includes(coverage.protocolVersion ?? 0) && typeof coverage.reviewHash === 'string' && /^[a-f0-9]{64}$/.test(coverage.reviewHash)
}

/** Preserve the protocol selected by the original admission. */
export function storedContinuityProtocol(validation: unknown): 8 | 9 | 10 | 11 {
  const value = validation && typeof validation === 'object' && !Array.isArray(validation) ? validation as Record<string, unknown> : null
  const coverage = value?.coverage
  const protocol = coverage && typeof coverage === 'object' && !Array.isArray(coverage) ? (coverage as Record<string, unknown>).protocolVersion : 8
  return protocol === 11 ? 11 : protocol === 10 ? 10 : protocol === 9 ? 9 : 8
}

/** The free body report is useful only while its complete immutable lineage
 * still rebuilds. This also protects body-only readiness/cache consumers which
 * deliberately do not enter the terminal fact-certification reader. */
export function validCompilerContinuitySourceProjection(validation: unknown, content?: string): boolean {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) return true
  const value = validation as Record<string, unknown>, audit = value.continuityCriticResponse as Record<string, unknown> | undefined
  if (!audit || audit.sourceProjection === undefined && audit.sourceCheckPolicy === undefined) return true
  try {
    const marker = audit.sourceProjection as { frozenBodies?: { current?: unknown; previous?: string | null } } | undefined
    const body = content ?? marker?.frozenBodies?.current
    if (typeof body !== 'string') return false
    const rebuilt = validateStoredExplicitSourceProjection(audit, body, audit.terminalEvidence as TerminalEvidenceContext | undefined)
    if (!rebuilt || !Array.isArray(value.findings)) return false
    const remaining = [...value.findings]
    for (const finding of rebuilt.findings) {
      const hashes = [finding, classifyContinuityFindingAuthority(finding, undefined,
        { current: body, previous: marker?.frozenBodies?.previous ?? null })].map(item => runtimeJson(item).hash)
      const index = remaining.findIndex(item => hashes.includes(runtimeJson(item).hash))
      if (index < 0) return false
      remaining.splice(index, 1)
    }
    const coverage = value.coverage as Record<string, unknown> | undefined
    return coverage?.contentHash === runtimeJson({ content: body }).hash
      && (audit.terminalEvidence === undefined || (audit.terminalEvidence as TerminalEvidenceContext).current.id === value.checkedChapterId
        && (audit.terminalEvidence as TerminalEvidenceContext).current.revision === value.checkedRevision)
  } catch { return false }
}

/** COMPLETE requires a valid findings envelope, not just a status string. */
export function completeCompilerContinuityAssessment(validation: unknown): { errorCount: number; warningCount: number } | null {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) return null
  const value = validation as Record<string, unknown>
  if (value.independentCheck !== 'complete' || typeof value.checkedChapterId !== 'string' || !Number.isSafeInteger(value.checkedRevision)
    || !Array.isArray(value.findings) || !value.coverage || typeof value.coverage !== 'object' || Array.isArray(value.coverage)
    || typeof (value.coverage as Record<string, unknown>).reviewHash !== 'string') return null
  if (!validCompilerContinuitySourceProjection(validation)) return null
  const findings = value.findings.map(item => continuityFindingInputSchema.safeParse(item))
  if (findings.some(item => !item.success)) return null
  const errorCount = findings.filter(item => item.success && item.data.severity === 'error').length
  const warningCount = findings.filter(item => item.success && item.data.severity === 'warning').length
  return value.errorCount === errorCount && value.warningCount === warningCount ? { errorCount, warningCount } : null
}

export function currentCompilerContinuityAssessment(validation: unknown, chapter: { id: string; revision: number; content?: string }, coverage: CompilerContinuityCoverage): { errorCount: number; warningCount: number } | null {
  const assessment = completeCompilerContinuityAssessment(validation)
  if (!assessment || !validCompilerContinuitySourceProjection(validation, chapter.content)) return null
  const value = validation as Record<string, unknown>
  return value.checkedChapterId === chapter.id && value.checkedRevision === chapter.revision && compilerContinuityCoverageMatches(value.coverage, coverage) ? assessment : null
}
