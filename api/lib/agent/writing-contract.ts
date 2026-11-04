import type { TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError } from '../prisma.js'
import { runtimeJson } from './runtime-common.js'

/** The compatibility union retains any proven volume fence for the same slot. */
export function writingActionTargets(operations: NonNullable<TaskSpec['scope']['writingActions']>['operations']) {
  const targets = new Map<number, NonNullable<TaskSpec['scope']['writing']>['targets'][number]>()
  for (const target of operations.flatMap(operation => operation.targets)) {
    const previous = targets.get(target.orderIndex)
    if (!previous?.volumeId || target.volumeId) targets.set(target.orderIndex, target)
  }
  return [...targets.values()]
}

/** Detect incomplete or inconsistent projections without parsing author prose
 * again. Frozen root/input ownership remains the authority for this receipt. */
export function frozenWritingScopeHash(scope: TaskSpec['scope']): string {
  const interpretation = scope.writingInterpretation
  return runtimeJson({ writing: scope.writing ?? null, ...(scope.authorEffects ? { authorEffects: scope.authorEffects } : {}), localEditBoundary: scope.localEditBoundary ?? null,
    localEditProtocol: scope.localEditProtocol ?? null, selection: scope.selection ?? null, selectionBoundary: scope.selectionBoundary ?? null,
    requestHash: interpretation?.requestHash ?? null, intent: interpretation?.intent ?? null,
    revisionDenied: interpretation?.revisionDenied ?? null, creationDenied: interpretation?.creationDenied ?? null,
    operations: interpretation?.operations ?? null, excludedChapterIds: interpretation?.excludedChapterIds ?? null,
    ...(scope.writingActions ? { writingActions: scope.writingActions } : {}) }).hash
}

export function assertFrozenWritingContract(spec: TaskSpec): void {
  if (spec.scope.writingTargetProtocol !== 2) return
  if (!spec.scope.writing || !spec.scope.writingInterpretation
    || spec.scope.writingInterpretation.scopeHash !== frozenWritingScopeHash(spec.scope)) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原作者章节与局部范围投影缺失或不一致，不能回退旧解析或补正文权限。')
  }
}
