import { createHash } from 'node:crypto'
import type { StartAgentLoopRunRequest, TaskSpec } from '../../../shared/contracts/index.js'

// Relevance groups are descriptive only; they never restrict ordinary tools.

const common = new Set(['novel_get_context', 'chapter_read', 'chapter_list_summaries', 'memory_search', 'project_search',
  'plan_read', 'volume_list', 'structure_outline', 'directive_list', 'story_charter_get', 'chapter_bridge_get',
  'session_history_search', 'session_message_read', 'task_context_list', 'task_context_read', 'execution_context_read',
  'task_respond', 'ask_user', 'goal_enable', 'goal_read', 'goal_report', 'agent_configure', 'model_assign', 'model_list'])
const writing = new Set(['chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_rename',
  'story_compiler_prepare', 'scene_task_build', 'continuity_validate', 'quality_analyze', 'chapter_bridge_commit',
  'quality_report_get', 'quality_finding_feedback', 'character_voice_get', 'experience_anchor_get', 'craft_search',
  'style_profile_get', 'retrieval_trace_read', 'style_leakage_check', 'memory_review_list', 'reader_promise_save', 'reader_promise_update',
  'creative_critique', 'creative_revision_draft', 'skill_catalog', 'skill_load', 'skill_run_explain', 'todo_write'])
const research = new Set(['web_search', 'web_read', 'platform_novel_search', 'platform_novel_read',
  'research_report_save', 'research_report_read', 'read_file', 'view_image', 'todo_write'])
export function taskToolRelevance(name: string): 'common' | 'writing' | 'research' | 'extension' {
  return common.has(name) ? 'common' : writing.has(name) ? 'writing' : research.has(name) ? 'research' : 'extension'
}

/** Record the effective registered catalog; language classification is advisory.
 * Role, mode, session policy and parent grants are applied by the caller. */
export function freezeTaskCapabilities(spec: TaskSpec, input: Pick<StartAgentLoopRunRequest,
  'prompt' | 'attachments' | 'pinnedSkillIds' | 'pinnedSubagentId' | 'selection'>, registeredNames: readonly string[]): TaskSpec {
  if (spec.scope.capabilityCatalog || !spec.scope.authorEffects) return spec
  if (spec.scope.authorEffects.requestHash !== createHash('sha256').update(input.prompt).digest('hex')) throw new Error('Original request does not match the task catalog')
  return { ...spec, scope: { ...spec.scope, capabilityCatalog: { version: 1,
    requestHash: createHash('sha256').update(input.prompt).digest('hex'), kind: 'full',
    names: [...new Set([...registeredNames, 'execution_context_read'])] } } }
}
