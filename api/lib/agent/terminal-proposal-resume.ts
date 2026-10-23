import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'
import { originalTaskRunIds, readOriginalTaskRequest } from './original-request.js'
import { readReviewRequestRecovery } from './review-request-recovery.js'
import { applyTerminalCandidatePatch, terminalCandidatePatchSchema, terminalCandidateReplacementIssue } from './terminal-candidate-patch.js'
import { readTerminalCandidate, resolveTerminalCandidate, terminalCandidateSchema } from './terminal-state-review.js'
import { readCompilerContinuitySource } from './compiler-continuity-source.js'
import { terminalEvidenceContext, terminalEvidenceVersion, terminalQuoteAddressVersion } from './terminal-evidence-context.js'
import { terminalCoverageInput, terminalCoverageProofs } from './terminal-fact-coverage.js'
import { prepareCompilerTerminalProposals } from './terminal-proposal-context.js'
import { runtimeJson } from './runtime-common.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const argsSchema = z.union([z.object({ compilationId: z.string(), chapterId: z.string().optional(), focus: z.string().optional(),
  terminalPatch: terminalCandidatePatchSchema, inheritedProofs: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(200).optional() }).strict(),
  z.object({ compilationId: z.string().min(1), terminalState: terminalCandidateSchema }).strict()])

/** Resume one already proposed delta that this legacy producer demonstrably
 * refused locally. This is neither a third main-model proposal nor a new review
 * allowance. The normal tool reservation still owns model/price/unknown gates.
 * Caller persists this claim before the ordinary call journal and execution. */
export async function readCompatibleTerminalProposal(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, target: { compilationId: string; chapterId: string; revision: number },
  executingCallId?: string) {
  const original = await readOriginalTaskRequest(tx, subject)
  if (terminalEvidenceVersion(original.spec) !== 2) return null
  const runIds = await originalTaskRunIds(tx, subject, original)
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  if (!run || run.runtimeProtocolVersion !== 0 || run.taskRootId) return null
  const proofs = (await readReviewRequestRecovery(tx, subject, [])).filter(item => item.notDispatched
    && item.toolName === 'continuity_validate' && item.compilationId === target.compilationId
    && item.chapterId === target.chapterId && item.reconciliation.currentRevision === target.revision)
  if (!proofs.length) return null
  const proof = proofs.at(-1)!
  const calls = await tx.agentRunEvent.findMany({ where: { runId: proof.reconciliation.sourceRunId, type: 'tool.call',
    payload: { path: ['callId'], equals: proof.callId } } })
  if (calls.length !== 1) return null
  const parsed = argsSchema.safeParse(object(calls[0].payload).args)
  if (!parsed.success || parsed.data.compilationId !== target.compilationId
    || 'chapterId' in parsed.data && parsed.data.chapterId !== undefined && parsed.data.chapterId !== target.chapterId) return null
  const compilation = await tx.storyCompilation.findFirst({ where: { id: target.compilationId, userId: subject.userId,
    novelId: subject.novelId, runId: { in: runIds }, chapterId: target.chapterId, status: 'active',
    chapter: { authorId: subject.userId, ...activeChapterScope(subject.novelId) } }, include: { chapter: true, bridge: true } })
  if (!compilation?.chapter || !compilation.bridge || compilation.chapter.revision !== target.revision) return null
  const chapter = compilation.chapter, base = readTerminalCandidate(compilation.validation)
  if (!base) return null
  const source = await readCompilerContinuitySource(tx, subject, chapter, compilation.bridge.fromChapterId, 11)
  if (compilation.bridge.fromChapterId && source?.revision !== compilation.bridge.sourceRevision) return null
  try {
    const patch = 'terminalPatch' in parsed.data ? parsed.data.terminalPatch : undefined
    const candidate = 'terminalState' in parsed.data ? parsed.data.terminalState : applyTerminalCandidatePatch(base, parsed.data.terminalPatch)
    if (patch && !terminalCandidateReplacementIssue(compilation.validation, candidate, chapter.content)) return null
    const selected = resolveTerminalCandidate({ ...candidate, inheritedProofs: 'inheritedProofs' in parsed.data ? parsed.data.inheritedProofs : undefined },
      source && 'terminalInheritance' in source ? source.terminalInheritance : [], 2)
    if (!selected.ok) return null
    const context = terminalEvidenceContext(chapter, source, 2, terminalQuoteAddressVersion(original.spec),
      terminalCoverageInput(original.spec, compilation.preparedContext, chapter, selected.candidate, 2, terminalCoverageProofs(source, 2)), 5, 2)
    const prepared = prepareCompilerTerminalProposals({ spec: original.spec, preparedContext: compilation.preparedContext,
      validation: compilation.validation, chapter, source, candidate: selected.candidate, nextContext: context })
    if (!prepared?.changes) return null
    const key = runtimeJson({ kind: 'terminal-candidate-compatibility', version: 1, taskId: original.taskId, contractHash: runtimeJson({ spec: original.spec }).hash,
      sourceRunId: proof.reconciliation.sourceRunId, sourceResultId: proof.reconciliation.sourceResultId,
      userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id, revision: chapter.revision,
      bodyHash: context.current.contentHash, sourceHash: prepared.changes.sourceHash,
      baseHash: runtimeJson(base).hash, args: parsed.data }).hash
    const callId = `terminal_resume_${key.slice(0, 40)}`
    const journal = await tx.agentRunEvent.findMany({ where: { runId: { in: runIds }, type: { in: ['tool.call', 'tool.result'] },
      payload: { path: ['callId'], equals: callId } } })
    if (journal.length && (executingCallId !== callId || journal.length !== 1 || journal[0].type !== 'tool.call'
      || journal[0].runId !== subject.runId || object(journal[0].payload).toolName !== 'continuity_validate'
      || runtimeJson({ args: object(journal[0].payload).args }).hash !== runtimeJson({ args: parsed.data }).hash)) return null
    if (executingCallId && (!journal.length || executingCallId !== callId)) return null
    return { claim: `terminal-compatibility:${key}`, callId, args: parsed.data }
  } catch (error) { if (error instanceof DataAccessError) return null; throw error }
}
