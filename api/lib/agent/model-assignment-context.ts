import { AsyncLocalStorage } from 'node:async_hooks'
import type { FrozenModelAssignments, ModelAssignmentTask } from '../../../shared/contracts/agent-model-assignments.js'
import { freezeModelAssignments, resolveAssignedModel } from './model-assignments.js'

type AssignmentContext = { userId: string; novelId: string; frozen?: FrozenModelAssignments }
const contexts = new AsyncLocalStorage<AssignmentContext>()
export function withModelAssignmentContext<T>(context: AssignmentContext, run: () => T): T { return contexts.run(context, run) }
export function updateModelAssignmentContext(userId: string, novelId: string, frozen: FrozenModelAssignments) {
  const context = contexts.getStore()
  if (context?.userId === userId && context.novelId === novelId) context.frozen = frozen
}

/** Only a matching execution context can supply frozen preferences. No credentials enter persistence. */
export async function assignedTaskModel(userId: string, novelId: string | null | undefined, task: ModelAssignmentTask, frozen?: FrozenModelAssignments, frozenExecution = false) {
  const context = contexts.getStore()
  const matching = context?.userId === userId && context.novelId === novelId
  const preferences = frozen ?? (matching ? context.frozen : frozenExecution ? undefined : await freezeModelAssignments(userId, novelId ?? undefined))
  const selection = preferences?.assignments[task]
  return selection ? resolveAssignedModel(userId, selection, task === 'vision') : undefined
}

export const TEXT_ACTION_TASKS: Readonly<Record<string, ModelAssignmentTask>> = {
  generateCoverPrompt: 'cover_prompt', generatePublishAdvice: 'publish_advice',
  agentSessionAutoName: 'session_title', agentMemoryGraphBuild: 'memory_graph', style_learning: 'style_learning',
  agentCreativeCritique: 'creative_critique', agentCreativeRevision: 'creative_revision', agentResearchDossier: 'research_synthesis',
  agent3HumanityRevision: 'quality', agent3HumanityRevisionRetry: 'quality', agent3HumanityEvidenceCorrection: 'quality',
  agent3HumanityQuality: 'quality', agent3ContinuityValidation: 'continuity', agent3ContinuityRepair: 'continuity', agent3ContinuityRepairRetry: 'continuity',
  agent3HumanityCritic: 'quality', agent3RigorousContinuityRepair: 'continuity', agent3RigorousContinuityRepairRetry: 'continuity',
  agent3ContinuityCritic: 'continuity', agent3ContinuityCriticSecondPass: 'continuity',
}

/** Only the known quality chain inherits its assignment during output recovery. */
export function resolveTextActionTask(action: string): ModelAssignmentTask | undefined {
  const direct = Object.prototype.hasOwnProperty.call(TEXT_ACTION_TASKS, action) ? TEXT_ACTION_TASKS[action] : undefined
  if (direct) return direct
  const suffix = 'OutputRecovery'
  return action.endsWith(suffix) && TEXT_ACTION_TASKS[action.slice(0, -suffix.length)] === 'quality'
    ? 'quality' : undefined
}
