import { Prisma } from '@prisma/client'
import { DataAccessError, prisma } from '../prisma.js'
import type { AgentCreationState } from '../../../shared/agent-creation-state.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { activeChapterScope } from '../data/internal.js'
import { readWritingScope } from './writing-scope.js'
import { originalTaskRunIds } from './original-request.js'
import { readChapterReviewReadiness } from './chapter-review-guard.js'
import { readExecutionStateInTransaction } from './runtime-state.js'
import { collectDurableToolEvidence } from './runtime-evidence.js'
import { runCheckpointSchema } from './checkpoint.js'
import { runtimeJson } from './runtime-common.js'
import { readRunOutcome } from './run-outcome.js'

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** A rebuildable sidecar for both executors, never a lease/recovery/completion
 * entrypoint. PostgreSQL enforces no writes throughout the existing readers.
 * Field sources: original=admission lineage; targets/reviews=current owned rows;
 * effects=receipts+reduced frames; pending/usage=original-task records;
 * delivery=run status/outcome, expressly not current literary acceptance. */
export async function readAgentCreationState(userId: string, runId: string): Promise<AgentCreationState> {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`
    return collectAgentCreationState(tx, userId, runId)
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
}

/** Caller must supply one consistent, read-only snapshot for the whole chain. */
export async function collectAgentCreationState(tx: Prisma.TransactionClient, userId: string, runId: string): Promise<AgentCreationState> {
  const run = await tx.agentRun.findFirst({ where: { id: runId, userId } })
  if (!run) throw new DataAccessError(404, 'AGENT_RUN_NOT_FOUND', '未找到当前作者的任务。')
  if (![0, 1].includes(run.runtimeProtocolVersion) || run.runtimeProtocolVersion === 1 && !run.taskRootId) {
    throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '执行协议或原任务根无法核实。')
  }
  const subject = { userId, novelId: run.novelId, runId }
  const original = await readWritingScope(tx, subject)
  const parsed = taskSpecSchema.safeParse(original.spec)
  if (parsed.success && parsed.data.scope.novelId !== subject.novelId) {
    throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '原任务作品身份不一致。')
  }
  const spec = parsed.success ? parsed.data : null
  const runIds = await originalTaskRunIds(tx, subject, original)
  const ownedRuns = await tx.agentRun.findMany({ where: { id: { in: runIds }, userId, novelId: run.novelId }, select: { id: true, taskRootId: true } })
  if (ownedRuns.length !== new Set(runIds).size) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '原任务执行链身份不一致。')
  const rootIds = [...new Set(ownedRuns.flatMap(item => item.taskRootId ? [item.taskRootId] : []))]
  const compilations = await tx.storyCompilation.findMany({ where: { userId, novelId: run.novelId, runId: { in: runIds },
    status: { in: ['active', 'completed'] } }, include: { bridge: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const frozenTargets = original.writing?.kind === 'bounded' ? original.writing.targets
    : original.writing?.kind === 'unbounded' ? compilations.map(item => ({ orderIndex: item.targetOrderIndex, chapterId: item.chapterId })) : []
  const targets: AgentCreationState['targets'] = []
  const seen = new Set<number>()
  for (const target of frozenTargets) {
    if (seen.has(target.orderIndex)) continue
    seen.add(target.orderIndex)
    const chapterId = target.chapterId ?? original.bindings?.targets.find(item => item.orderIndex === target.orderIndex)?.chapterId ?? null
    const chapter = chapterId ? await tx.chapter.findFirst({ where: { id: chapterId, authorId: userId, ...activeChapterScope(run.novelId) },
      select: { id: true, revision: true, content: true, orderIndex: true } }) : null
    if (chapter && chapter.orderIndex !== target.orderIndex) throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '当前章节位置与原目标不一致。')
    const compilation = chapter ? compilations.find(item => item.chapterId === chapter.id) : null
    let review: AgentCreationState['targets'][number]['review'] = null
    let unknownReason: AgentCreationState['targets'][number]['unknownReason'] = !chapterId ? 'target_unbound' : !chapter ? 'target_missing' : 'review_unavailable'
    if (chapter && compilation) {
      try {
        const readiness = await readChapterReviewReadiness(tx, subject, compilation.id)
        if (readiness) {
          if (readiness.chapterId !== chapter.id || readiness.revision !== chapter.revision
            || readiness.decisionBinding?.contentHash !== runtimeJson({ content: chapter.content }).hash) {
            throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '检查来源与当前目标版本不一致。')
          }
          review = { source: 'persisted_current_review', continuity: readiness.continuity, quality: readiness.quality,
            requiredChecks: readiness.requiredTools.map(item => item.name), decisionPending: readiness.decisionPending ?? true,
            mustPassPending: readiness.mustPassPending ?? false, requiredDecisions: readiness.requiredDecisions ?? [],
            retainedDecisions: readiness.retainedDecisions ?? [], details: readiness.decisionDetails ?? [], binding: readiness.decisionBinding ?? null }
          unknownReason = null
        }
      } catch (error) {
        if (error instanceof DataAccessError && error.code === 'CONTINUITY_INPUT_STALE') unknownReason = error.code
        else throw error
      }
    }
    targets.push({ orderIndex: target.orderIndex, chapterId, revision: chapter?.revision ?? null,
      contentHash: chapter ? runtimeJson({ content: chapter.content }).hash : null,
      compilation: compilation ? { id: compilation.id, status: compilation.status, stage: compilation.stage,
        committedRevision: compilation.bridge?.targetRevision ?? null } : null, review, unknownReason })
  }
  const checkpoint = runCheckpointSchema.safeParse(run.runtimeProtocolVersion === 0 ? object(run.usage)?.checkpoint : undefined)
  let cursor: AgentCreationState['execution']['cursor'] = checkpoint.success
    ? { kind: 'legacy_checkpoint', version: checkpoint.data.version, hash: runtimeJson(object(run.usage)!.checkpoint).hash } : { kind: 'unknown' }
  const reduced = new Map<string, { resultHash: string; outcome: 'succeeded' | 'failed' }>()
  for (const taskRootId of rootIds) {
    const head = await tx.agentExecutionState.findUnique({ where: { taskRootId } })
    if (!head) continue // Admitted but uninitialized is unknown, not a new start.
    const state = await readExecutionStateInTransaction(tx, taskRootId)
    if (taskRootId === run.taskRootId) cursor = { kind: 'durable_frame', revision: state.frame.revision, hash: state.frame.snapshotHash }
    for (const effect of (await collectDurableToolEvidence(tx, taskRootId, state.frame.revision)).effects) reduced.set(effect.operationId, effect)
  }
  const operations = await tx.agentOperation.findMany({ where: { taskRootId: { in: rootIds } }, include: { effectReceipt: true }, orderBy: { id: 'asc' } })
  const effects: AgentCreationState['effects']['operations'] = operations.filter(item => item.kind === 'tool').map(item => {
    const receipt = item.effectReceipt, observed = reduced.get(item.id)
    if (receipt && runtimeJson(receipt.result).hash !== receipt.resultHash) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '工具回执损坏，不能投影为成功。')
    if (observed && observed.resultHash !== receipt?.resultHash) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '工具观察与回执不一致。')
    return { id: item.id, action: item.action, status: item.status, receiptHash: receipt?.resultHash ?? null,
      receiptState: receipt ? 'hash_verified' : 'missing', observation: observed ? 'reduced_verified' : 'not_verified', outcome: observed?.outcome ?? 'unknown' }
  })
  const usage: AgentCreationState['usage']['observations'] = (await tx.aiUsageLog.findMany({ where: { userId,
    OR: [{ agentRunId: { in: runIds } }, { targetType: 'agentRun', targetId: { in: runIds } }] },
    select: { id: true, billingStatus: true, usageSource: true, requestTokens: true, responseTokens: true }, orderBy: { id: 'asc' } })).map(item => ({
      id: item.id, source: 'legacy_usage', status: item.billingStatus ?? 'unknown', settlementStatus: item.billingStatus,
      usageSource: item.usageSource, tokensKnown: item.usageSource === 'reported' && item.requestTokens !== null && item.responseTokens !== null,
      pendingSettlement: ['observed', 'pending_usage', 'pending_settlement'].includes(item.billingStatus ?? '') }))
  for (const attempt of await tx.agentProviderAttempt.findMany({ where: { operation: { taskRootId: { in: rootIds } } }, include: { usageReceipt: true }, orderBy: { id: 'asc' } })) {
    const receipt = attempt.usageReceipt
    if (receipt && runtimeJson({ source: receipt.source, promptTokens: receipt.promptTokens, completionTokens: receipt.completionTokens,
      cacheHitTokens: receipt.cacheHitTokens, cacheMissTokens: receipt.cacheMissTokens }).hash !== receipt.observationHash) {
      throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '用量回执损坏，不能投影为已知用量。')
    }
    usage.push({ id: attempt.id, source: 'durable_attempt', status: attempt.status, settlementStatus: attempt.usageReceipt?.settlementStatus ?? null,
      usageSource: attempt.usageReceipt?.source ?? null,
      tokensKnown: receipt?.source === 'reported' && receipt.promptTokens != null && receipt.completionTokens != null,
      pendingSettlement: receipt ? receipt.settlementStatus === 'pending' : attempt.dispatchedAt !== null })
  }
  return { version: 1, consistency: 'repeatable_read', observedAt: new Date().toISOString(), subject,
    original: { taskId: original.taskId, sourceRunId: original.sourceRunId, parentRunId: original.parentRunId,
      prompt: original.prompt, contract: spec, projectionHash: runtimeJson({ prompt: original.prompt, spec: original.spec ?? null }).hash },
    execution: { protocol: run.runtimeProtocolVersion === 1 ? 'durable' : 'legacy', status: run.status, cursor }, targets,
    effects: { legacy: ownedRuns.some(item => !item.taskRootId) ? 'unknown' : 'not_applicable', operations: effects },
    pending: { operations: operations.filter(item => ['prepared', 'dispatched', 'unknown'].includes(item.status)).map(({ id, action, status }) => ({ id, action, status })),
      reviews: checkpoint.success ? checkpoint.data.pendingReviews ?? [] : null },
    localRestrictions: { source: checkpoint.success ? 'legacy_checkpoint' : 'unknown', items: checkpoint.success ? checkpoint.data.toolRestrictions ?? [] : null },
    usage: { coverage: 'saved_records_only', observations: usage },
    delivery: { source: 'run_record', status: run.status, limitation: readRunOutcome(run.usage).outcome?.summary ?? null, verified: false },
    obligations: spec ? { source: 'original_contract', verification: 'unverified', goals: spec.goals,
      expectedOutputs: spec.expectedOutputs, postconditions: spec.postconditions, hardConstraints: spec.hardConstraints } : null }
}
