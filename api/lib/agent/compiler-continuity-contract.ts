import { runtimeJson } from './runtime-common.js'

// Bump when the critic's required coverage or interpretation changes.
export const COMPILER_CONTINUITY_PROTOCOL = 2

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
