import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { activeChapterScope } from '../data/internal.js'
import { terminalCarriedFactSchema, type TerminalCarriedFact, type TerminalEvidenceContext } from './terminal-evidence-context.js'
import { currentTerminalReview, terminalClaims, readTerminalCandidate, type TerminalDeliveryBinding } from './terminal-state-review.js'
import { runtimeJson } from './runtime-common.js'
import { terminalQuoteRange } from './terminal-quote-range.js'
import { continuitySourceSegments } from './continuity-review-context.js'
import { attachTerminalProposalInput, terminalProposalTaskId } from './terminal-proposal-context.js'
import { readOriginalTaskRequest } from './original-request.js'
import { DataAccessError } from '../prisma.js'

export const TERMINAL_INHERITANCE_MAX_DEPTH = 16
const bodyHash = (content: string) => createHash('sha256').update(content).digest('hex')
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Cache bookkeeping cannot invalidate an otherwise identical paid judgment. */
export function terminalAssessmentHash(validation: unknown) {
  const value = object(validation)
  return runtimeJson({ checkedChapterId: value.checkedChapterId, checkedRevision: value.checkedRevision,
    independentCheck: value.independentCheck, coverage: value.coverage, terminalCandidate: value.terminalCandidate,
    continuityCriticResponse: value.continuityCriticResponse }).hash
}
const factHash = (fact: Pick<TerminalCarriedFact, 'field' | 'claim' | 'anchors' | 'nodes'>) => runtimeJson(fact).hash

/** Build a flat per-fact chain from this transaction's independent response.
 * New facts establish a new root; a bridge summary never supplies evidence. */
export function buildTerminalFactProofs(input: { compilationId: string; chapter: { id: string; revision: number; orderIndex: number; content: string };
  validation: unknown; stateHash: string; evidence: TerminalEvidenceContext; review: NonNullable<ReturnType<typeof currentTerminalReview>> }): TerminalCarriedFact[] {
  const facts: TerminalCarriedFact[] = []
  for (const claim of terminalClaims(input.review.candidate)) {
    const field = claim.path.split('.')[1]
    if (!['knowledge', 'body', 'objects', 'relationships', 'openLoops'].includes(field)) continue
    const verdict = input.review.verdicts.find(item => item.path === claim.path)
    if (!verdict || verdict.verdict !== 'supported' || !('sourceEvidence' in verdict) || !Array.isArray(verdict.sourceEvidence)) continue
    const refs = verdict.sourceEvidence as Array<{ segmentId: string; quote: string }>
    const anchors: TerminalCarriedFact['anchors'] = []
    let nodes: TerminalCarriedFact['nodes'] = []
    for (const ref of refs) {
      if (ref.segmentId.startsWith('t')) {
        const carried = input.evidence.previous?.carried?.find(part => part.segmentId === ref.segmentId && part.field === field && part.claim === claim.claim)
        if (!carried || refs.length !== 1) return []
        anchors.push(...carried.anchors); nodes = [...carried.nodes]
      } else if (ref.segmentId.startsWith('c')) {
        if (input.evidence.factCoverage?.version === 2) {
          const range = terminalQuoteRange(ref, continuitySourceSegments({ previous: null, current: input.chapter.content }))
          if (!range) return []
          anchors.push({ chapterId: input.chapter.id, revision: input.chapter.revision, contentHash: bodyHash(input.chapter.content),
            start: range.start, end: range.end, quote: ref.quote })
          continue
        }
        const base = Number(ref.segmentId.slice(1)) * 300, offset = input.chapter.content.slice(base, base + 300).indexOf(ref.quote)
        if (offset < 0) return []
        anchors.push({ chapterId: input.chapter.id, revision: input.chapter.revision, contentHash: bodyHash(input.chapter.content),
          start: base + offset, end: base + offset + ref.quote.length, quote: ref.quote })
      } else if (input.evidence.previous) {
        if (input.evidence.factCoverage?.version === 2) {
          const previous = input.evidence.previous, range = terminalQuoteRange(ref, previous.segments)
          if (!range) return []
          const start = previous.start + range.start - previous.joinedStart
          anchors.push({ chapterId: previous.id, revision: previous.revision, contentHash: previous.contentHash, start, end: start + ref.quote.length, quote: ref.quote })
          continue
        }
        const previous = input.evidence.previous, span = previous.segments.find(part => part.segmentId === ref.segmentId)
        const offset = span?.quote.indexOf(ref.quote) ?? -1
        if (!span || offset < 0) return []
        const start = previous.start + span.start - previous.joinedStart + offset
        anchors.push({ chapterId: previous.id, revision: previous.revision, contentHash: previous.contentHash, start, end: start + ref.quote.length, quote: ref.quote })
      }
    }
    if (nodes.length >= TERMINAL_INHERITANCE_MAX_DEPTH || !anchors.length) continue
    nodes.unshift({ compilationId: input.compilationId, chapterId: input.chapter.id, revision: input.chapter.revision,
      orderIndex: input.chapter.orderIndex, bodyHash: bodyHash(input.chapter.content), candidateHash: input.review.candidateHash,
      validationHash: terminalAssessmentHash(input.validation), stateHash: input.stateHash, path: claim.path,
      previousChapterId: 'basis' in verdict && verdict.basis === 'inherited' ? input.evidence.previous?.id ?? null : null })
    const fact = { field, claim: claim.claim, anchors, nodes }
    facts.push({ ...fact, segmentId: `t${facts.length}`, proofHash: factHash(fact), depth: nodes.length })
  }
  return facts
}

/** Validate facts independently, without recursively rebuilding unrelated
 * sources: <=16 nodes per fact and <=128 distinct identities per request. */
export async function readTerminalInheritance(db: Prisma.TransactionClient, subject: { userId: string; novelId: string },
  predecessor: { id: string; revision: number; orderIndex: number; content: string }): Promise<TerminalCarriedFact[]> {
  const loadCompilation = (id: string) => db.storyCompilation.findFirst({ where: { id, userId: subject.userId, novelId: subject.novelId, status: 'completed', stage: 'commit' },
    include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
  const latest = await db.storyCompilation.findFirst({ where: { userId: subject.userId, novelId: subject.novelId, chapterId: predecessor.id,
    status: 'completed', stage: 'commit' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
  const parsed = z.array(terminalCarriedFactSchema).max(200).safeParse(object(latest?.preparedContext).terminalFactProofs)
  if (!latest?.bridge?.committedAt || latest.bridge.targetRevision !== predecessor.revision || !parsed.success) return []
  type Chapter = Awaited<ReturnType<typeof db.chapter.findFirst>>
  const chapters = new Map<string, Chapter>()
  const compilations = new Map<string, Awaited<ReturnType<typeof loadCompilation>>>([[latest.id, latest]])
  const previousIds = new Map<string, string | null>()
  const chapterFor = async (id: string) => {
    if (!chapters.has(id)) {
      if (chapters.size >= 128) return null
      chapters.set(id, await db.chapter.findFirst({ where: { id, authorId: subject.userId, ...activeChapterScope(subject.novelId) } }))
    }
    return chapters.get(id) ?? null
  }
  const valid: TerminalCarriedFact[] = []
  const { terminalReviewStateHash } = await import('./chapter-review-guard.js')
  // The same authenticated compilation can occur in many independent facts.
  // Rebuild its review/proofs once per invocation, never from a fact's node hash.
  const authenticated = new Map<string, Awaited<ReturnType<typeof authenticate>>>()
  async function authenticate(compilationId: string, chapterId: string) {
    const chapter = await chapterFor(chapterId)
    if (!compilations.has(compilationId)) {
      if (compilations.size >= 128) return null
      compilations.set(compilationId, await loadCompilation(compilationId))
    }
    const compilation = compilations.get(compilationId), context = object(compilation?.preparedContext), proof = object(context.terminalReviewProof)
    const validation = object(compilation?.validation), coverage = object(validation.coverage), audit = object(validation.continuityCriticResponse)
    let evidence = audit.terminalEvidence as TerminalEvidenceContext | undefined
    let deliveryBinding: TerminalDeliveryBinding | undefined
    if (evidence && compilation && (audit.parserVersion === 9 || audit.parserVersion === 10 || evidence.proposalChanges || context.terminalProposalReview)) {
      if (!compilation.runId) return null
      const original = await readOriginalTaskRequest(db, { ...subject, runId: compilation.runId })
      deliveryBinding = { taskId: terminalProposalTaskId(original.spec, original.taskId), preparedContext: compilation.preparedContext }
      const candidate = readTerminalCandidate(validation)
      if (!candidate) return null
      try { evidence = attachTerminalProposalInput(evidence, { taskId: deliveryBinding.taskId,
        preparedContext: compilation.preparedContext, validation, candidate }) }
      catch (error) { if (!(error instanceof DataAccessError)) throw error; return null }
      if (chapter) deliveryBinding = await (await import('./terminal-draft-authority.js')).readTerminalDraftBinding(db,
        { ...subject, runId: compilation.runId, compilationId: compilation.id }, deliveryBinding, chapter, validation, evidence)
    }
    const review = compilation && chapter ? currentTerminalReview(compilation.validation, chapter.content, evidence, deliveryBinding) : null
    if (!chapter || !compilation?.bridge?.committedAt || compilation.chapterId !== chapter.id || compilation.bridge.targetRevision !== chapter.revision
      || coverage.protocolVersion !== 11 || !review?.deliveryEligibility.eligible || validation.checkedChapterId !== chapter.id || validation.checkedRevision !== chapter.revision
      || coverage.contentHash !== review.contentHash || coverage.terminalHash !== review.candidateHash
      || evidence?.protocol !== 2 || evidence.current.id !== chapter.id || evidence.current.revision !== chapter.revision || evidence.current.orderIndex !== chapter.orderIndex
      || context.terminalCandidateHash !== review.candidateHash || context.terminalContentHash !== review.contentHash || proof.version !== 2) return null
    const stateHash = terminalReviewStateHash(compilation.bridge, compilation.sceneTasks)
    if (proof.terminalStateHash !== stateHash) return null
    return { chapter, review, stateHash, validationHash: terminalAssessmentHash(compilation.validation), bodyHash: bodyHash(chapter.content),
      rebuilt: buildTerminalFactProofs({ compilationId: compilation.id, chapter, validation: compilation.validation, stateHash, evidence, review }) }
  }
  for (const fact of parsed.data) {
    if (fact.depth !== fact.nodes.length || fact.nodes[0].compilationId !== latest.id || fact.nodes[0].chapterId !== predecessor.id
      || fact.proofHash !== factHash({ field: fact.field, claim: fact.claim, anchors: fact.anchors, nodes: fact.nodes })
      || new Set(fact.nodes.map(node => node.chapterId)).size !== fact.nodes.length) continue
    let good = true
    for (const anchor of fact.anchors) {
      const chapter = await chapterFor(anchor.chapterId)
      if (!chapter || chapter.revision !== anchor.revision || bodyHash(chapter.content) !== anchor.contentHash
        || anchor.end - anchor.start !== anchor.quote.length || chapter.content.slice(anchor.start, anchor.end) !== anchor.quote) { good = false; break }
    }
    for (const [index, node] of fact.nodes.entries()) {
      if (!good) break
      const key = JSON.stringify([node.compilationId, node.chapterId])
      if (!authenticated.has(key)) authenticated.set(key, await authenticate(node.compilationId, node.chapterId))
      const bound = authenticated.get(key)
      if (!bound || bound.chapter.revision !== node.revision || bound.chapter.orderIndex !== node.orderIndex || bound.bodyHash !== node.bodyHash
        || bound.review.candidateHash !== node.candidateHash || bound.validationHash !== node.validationHash || bound.stateHash !== node.stateHash
        || !terminalClaims(bound.review.candidate).some(claim => claim.path === node.path && claim.path.split('.')[1] === fact.field && claim.claim === fact.claim)) { good = false; break }
      const rebuilt = bound.rebuilt.find(item => item.field === fact.field && item.claim === fact.claim)
      if (!rebuilt || runtimeJson(rebuilt.anchors).hash !== runtimeJson(fact.anchors).hash || runtimeJson(rebuilt.nodes).hash !== runtimeJson(fact.nodes.slice(index)).hash) { good = false; break }
      if (node.previousChapterId) {
        const chapter = bound.chapter
        if (!previousIds.has(chapter.id)) previousIds.set(chapter.id, (await db.chapter.findFirst({ where: { authorId: subject.userId,
          ...activeChapterScope(subject.novelId), orderIndex: { lt: chapter.orderIndex } }, orderBy: [{ orderIndex: 'desc' }, { id: 'asc' }], select: { id: true } }))?.id ?? null)
        if (previousIds.get(chapter.id) !== node.previousChapterId || index + 1 < fact.nodes.length
          && (fact.nodes[index + 1].chapterId !== node.previousChapterId || fact.nodes[index + 1].orderIndex >= node.orderIndex)) { good = false; break }
      } else if (index !== fact.nodes.length - 1) { good = false; break }
    }
    if (good) valid.push({ ...fact, segmentId: `t${valid.length}` })
  }
  return valid
}
