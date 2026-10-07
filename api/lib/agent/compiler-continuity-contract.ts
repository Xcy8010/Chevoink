import { runtimeJson } from './runtime-common.js'
import { continuityFindingInputSchema } from '../../../shared/contracts/story-compiler-contracts.js'

// Bump when the critic's required coverage or interpretation changes.
export const COMPILER_CONTINUITY_PROTOCOL = 3

export type CompilerContinuityCoverage = {
  version: 1; contentHash: string; charCount: number; sourceHash: string | null; reviewHash?: string; protocolVersion?: number
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
  bridge: unknown; sceneTasks: unknown[]; source: unknown | null; focus?: string
}): CompilerContinuityCoverage {
  const contentHash = runtimeJson({ content: input.chapter.content }).hash
  const sourceHash = input.source ? runtimeJson(input.source).hash : null
  return { version: 1, protocolVersion: COMPILER_CONTINUITY_PROTOCOL, contentHash, charCount: input.chapter.content.length, sourceHash,
    reviewHash: runtimeJson({ protocol: COMPILER_CONTINUITY_PROTOCOL, chapter: { id: input.chapter.id, title: input.chapter.title ?? '', revision: input.chapter.revision, orderIndex: input.chapter.orderIndex, contentHash },
      bridge: continuityStoryInput(input.bridge), scenes: continuityStoryInput(input.sceneTasks), sourceHash, focus: input.focus ?? '' }).hash }
}

export function compilerContinuityCoverageMatches(actual: unknown, expected: CompilerContinuityCoverage): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
  const value = actual as Record<string, unknown>
  return typeof value.reviewHash === 'string' && value.reviewHash === expected.reviewHash
    && value.protocolVersion === COMPILER_CONTINUITY_PROTOCOL
    && value.version === expected.version && value.contentHash === expected.contentHash
    && value.charCount === expected.charCount && value.sourceHash === expected.sourceHash
}

/** Recovering paid work must not dispatch a new repair under an older protocol. */
export function hasCurrentCompilerContinuityProtocol(coverage: CompilerContinuityCoverage): boolean {
  return coverage.protocolVersion === COMPILER_CONTINUITY_PROTOCOL && typeof coverage.reviewHash === 'string' && /^[a-f0-9]{64}$/.test(coverage.reviewHash)
}

/** COMPLETE requires a valid findings envelope, not just a status string. */
export function completeCompilerContinuityAssessment(validation: unknown): { errorCount: number; warningCount: number } | null {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) return null
  const value = validation as Record<string, unknown>
  if (value.independentCheck !== 'complete' || typeof value.checkedChapterId !== 'string' || !Number.isSafeInteger(value.checkedRevision)
    || !Array.isArray(value.findings) || !value.coverage || typeof value.coverage !== 'object' || Array.isArray(value.coverage)
    || typeof (value.coverage as Record<string, unknown>).reviewHash !== 'string') return null
  const findings = value.findings.map(item => continuityFindingInputSchema.safeParse(item))
  if (findings.some(item => !item.success)) return null
  const errorCount = findings.filter(item => item.success && item.data.severity === 'error').length
  const warningCount = findings.filter(item => item.success && item.data.severity === 'warning').length
  return value.errorCount === errorCount && value.warningCount === warningCount ? { errorCount, warningCount } : null
}

export function currentCompilerContinuityAssessment(validation: unknown, chapter: { id: string; revision: number }, coverage: CompilerContinuityCoverage): { errorCount: number; warningCount: number } | null {
  const assessment = completeCompilerContinuityAssessment(validation)
  if (!assessment) return null
  const value = validation as Record<string, unknown>
  return value.checkedChapterId === chapter.id && value.checkedRevision === chapter.revision && compilerContinuityCoverageMatches(value.coverage, coverage) ? assessment : null
}
