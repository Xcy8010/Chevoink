import type { AgentModelSelection, FrozenModelAssignments } from '../../../shared/contracts/agent-model-assignments.js'
import type { StartAgentLoopRunRequest } from '../../../shared/contracts/agent-events.js'

/** Undefined deliberately preserves the old input/default encoder and hash. */
export function admissionModelOverride(input: Pick<StartAgentLoopRunRequest, 'modelTier' | 'customModelId' | 'reasoningEffort' | 'modelSelectionExplicit'>,
  frozen: FrozenModelAssignments | undefined, writingPurpose: boolean): AgentModelSelection | undefined {
  if (input.modelSelectionExplicit && input.modelTier && input.modelTier !== 'basic') return { modelTier: input.modelTier,
    ...(input.modelTier === 'custom' && input.customModelId ? { customModelId: input.customModelId } : {}), reasoningEffort: input.reasoningEffort }
  return (writingPurpose ? frozen?.assignments.chapter_writing : undefined) ?? frozen?.assignments.main
}
