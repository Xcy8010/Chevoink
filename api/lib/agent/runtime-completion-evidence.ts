import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { countReportChineseCharacters } from '../../../shared/agent-output.js'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionStateInTransaction } from './runtime-state.js'
import { readTaskBudgetInTransaction } from './runtime-budget.js'
import { collectDurableToolEvidence } from './runtime-evidence.js'
import { readDurableTodoItems } from './tools/durable-todo.js'
import { evaluateTaskPostconditions } from './runtime-postconditions.js'
import { collectDurableDeliverables } from './runtime-deliverables.js'
import { collectDurableMemoryWork } from './runtime-memory.js'

/** Review input, NOT a completion certificate. The goal/output/postcondition
 * obligations remain explicit and unverified until their domain checks run.
 * Same-book legacy tasks never enter this root's completion obligations. */
export async function collectDurableCompletionEvidence(token: RunLeaseToken, cursor: { expectedRevision: number; expectedHash: string }) {
  const lease = { ...token }, expected = { ...cursor }
  return withRunLease(lease, tx => collectCompletionEvidenceInTransaction(tx, lease, expected))
}

/** Caller owns the current lease transaction; unresolved operations are never
 * excluded to make a completion check pass. */
export async function collectCompletionEvidenceInTransaction(tx: RuntimeTx, lease: RunLeaseToken,
  expected: { expectedRevision: number; expectedHash: string }) {
    const state = await readExecutionStateInTransaction(tx, lease.taskRootId)
    const frame = state.frame, last = frame.state.messages.at(-1)
    if (frame.revision !== expected.expectedRevision || frame.snapshotHash !== expected.expectedHash || frame.state.phase !== 'idle'
      || last?.role !== 'assistant' || last.toolCalls?.length) return runtimeError('RUNTIME_STATE_CONFLICT', '完成审查必须绑定当前已保存的候选答复。')
    const spec = taskSpecSchema.parse(state.originalSpec)
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    const evidence = await collectDurableToolEvidence(tx, root.id, frame.revision)
    const deliverables = await collectDurableDeliverables(tx, root, evidence.effects)
    const memoryWork = await collectDurableMemoryWork(tx, root, evidence.effects)
    const postconditionChecks = await evaluateTaskPostconditions(tx, root)
    const todos = await readDurableTodoItems(tx, root.id, frame.revision)
    const budget = await readTaskBudgetInTransaction(tx, root.id)
    const compilations = await tx.storyCompilation.findMany({ where: { userId: lease.userId, novelId: root.novelId, run: { taskRootId: root.id } },
      select: { id: true, chapterId: true, status: true, stage: true, bridge: { select: { targetRevision: true, committedAt: true } }, chapter: { select: { revision: true } } }, orderBy: { id: 'asc' } })
    const pendingOperations = await tx.agentOperation.findMany({ where: { taskRootId: root.id, status: { in: ['prepared', 'dispatched', 'unknown'] } }, select: { id: true, action: true, status: true }, orderBy: { id: 'asc' } })
    const failedOperations = await tx.agentOperation.findMany({ where: { taskRootId: root.id, status: 'failed' }, select: { id: true, action: true }, orderBy: { id: 'asc' } })
    const subtasks = await tx.agentSubtaskRun.findMany({ where: { userId: lease.userId, novelId: root.novelId, parentRun: { taskRootId: root.id } }, select: { id: true, status: true }, orderBy: { id: 'asc' } })
    const reportLengthChecks = spec.expectedOutputs.filter(output => output.required && output.minimumChineseCharacters !== undefined)
      .map(output => ({ description: output.description, required: output.minimumChineseCharacters!,
        actual: output.kind === 'text' || output.kind === 'validation_report' ? countReportChineseCharacters(last.content ?? '') : null }))
    const blockers = [
      ...reportLengthChecks.filter(check => check.actual === null || check.actual < check.required)
        .map(check => ({ code: 'report_length_unmet', reference: check.description })),
      ...memoryWork.filter(item => !item.completed).map(item => ({ code: 'unresolved_memory_job', reference: item.job.id })),
      ...deliverables.filter(item => item.status === 'missing' || item.status === 'changed').map(item => ({ code: `deliverable_${item.status}`, reference: item.id })),
      ...postconditionChecks.filter(item => item.severity === 'error' && item.status !== 'passed').map(item => ({ code: `postcondition_${item.status}`, reference: item.code })),
      ...todos.filter(item => item.status === 'pending' || item.status === 'in_progress').map(item => ({ code: 'unfinished_todo', reference: runtimeJson({ content: item.content }).hash })),
      ...compilations.filter(item => item.status === 'active' || item.status === 'completed' && (!item.bridge?.committedAt || item.chapter?.revision !== item.bridge.targetRevision)).map(item => ({ code: 'uncommitted_compilation', reference: item.id })),
      ...pendingOperations.map(item => ({ code: 'unresolved_operation', reference: item.id })),
      ...subtasks.filter(item => !['completed', 'cancelled'].includes(item.status)).map(item => ({ code: 'unresolved_subtask', reference: item.id })),
      ...(budget.unresolvedAttempts > 0n ? [{ code: 'unresolved_usage', reference: root.id }] : []),
    ]
    const snapshot = runtimeJson({ version: 1, taskRootId: root.id, inputHash: root.inputHash, sourceRevision: frame.revision, sourceHash: frame.snapshotHash,
      candidateHash: runtimeJson({ content: last.content, reasoning: last.reasoning ?? null }).hash,
      originalRequest: root.requestSnapshot,
      obligations: { goals: spec.goals, expectedOutputs: spec.expectedOutputs, postconditions: spec.postconditions, hardConstraints: spec.hardConstraints },
      verification: 'required', postconditionChecks, reportLengthChecks, deliverables, blockers, effects: evidence.effects, failedOperations, todos,
      memoryJobs: memoryWork.map(item => ({ id: item.job.id, sourceOperationId: item.source.operationId, chapterId: item.job.chapterId,
        chapterRevision: item.job.chapterRevision, verified: item.completed })),
      compilations: compilations.map(item => ({ id: item.id, chapterId: item.chapterId, status: item.status, stage: item.stage, currentRevision: item.chapter?.revision ?? null, committedRevision: item.bridge?.targetRevision ?? null })),
      budget: { usedTokens: String(budget.usedTokens), unresolvedAttempts: String(budget.unresolvedAttempts), deadlineExceeded: budget.deadlineExceeded } })
    return { snapshot: snapshot.value, snapshotHash: snapshot.hash }
}
