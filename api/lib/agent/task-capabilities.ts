import { createHash } from 'node:crypto'
import type { StartAgentLoopRunRequest, TaskSpec } from '../../../shared/contracts/index.js'
import { parseAuthorWritingRequest } from './author-writing-request.js'

// Relevance groups, not grants. Unmapped extensions remain available at fresh
// admission; the frozen names prevent later registry additions widening a run.
const common = new Set(['novel_get_context', 'chapter_read', 'chapter_list_summaries', 'memory_search', 'project_search',
  'plan_read', 'volume_list', 'structure_outline', 'directive_list', 'story_charter_get', 'chapter_bridge_get',
  'session_history_search', 'session_message_read', 'task_context_list', 'task_context_read', 'execution_context_read',
  'ask_user', 'goal_enable', 'goal_read', 'goal_report', 'agent_configure', 'model_assign', 'model_list'])
const writing = new Set(['chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_rename',
  'story_compiler_prepare', 'scene_task_build', 'continuity_validate', 'quality_analyze', 'chapter_bridge_commit',
  'quality_report_get', 'quality_finding_feedback', 'character_voice_get', 'experience_anchor_get', 'craft_search',
  'style_profile_get', 'retrieval_trace_read', 'style_leakage_check', 'memory_review_list', 'reader_promise_save', 'reader_promise_update',
  'creative_critique', 'creative_revision_draft', 'skill_catalog', 'skill_load', 'skill_run_explain', 'todo_write'])
const research = new Set(['web_search', 'web_read', 'platform_novel_search', 'platform_novel_read',
  'research_report_save', 'research_report_read', 'read_file', 'view_image', 'todo_write'])
const extensions = new Set(['novel_export', 'novel_import', 'account_credits', 'account_credit_history', 'account_novels',
  'session_rename', 'novel_create', 'novel_rename', 'novel_update_meta', 'novel_publish', 'novel_archive', 'novel_delete',
  'cover_prompt_set', 'cover_generate', 'cover_apply', 'volume_create', 'volume_update', 'volume_move', 'volume_delete',
  'chapter_move', 'chapter_move_to_volume', 'chapter_split', 'chapter_merge', 'bulk_replace_preview', 'entity_rename_preview',
  'changeset_apply', 'changeset_rollback', 'entity_resolve', 'impact_analyze', 'structure_validate',
  'plan_save', 'plan_rename', 'plan_delete', 'plan_exit', 'memory_save', 'directive_save', 'directive_supersede',
  'memory_relation_save', 'memory_event_save', 'character_voice_save', 'experience_anchor_save', 'style_profile_extract',
  'research_dossier_get', 'research_dossier_build', 'first_three_prototype_get', 'first_three_prototype_build',
  'skill_shared_invites', 'skill_create_draft', 'skill_test', 'skill_enable', 'skill_install_shared', 'skill_rollback', 'skill_publish',
  'subagent_run', 'subagent_delegate', 'task_spawn', 'task_send', 'task_wait'])

export function taskToolRelevance(name: string): 'common' | 'writing' | 'research' | 'extension' {
  return common.has(name) ? 'common' : writing.has(name) ? 'writing' : research.has(name) ? 'research' : 'extension'
}

/** Called only by fresh authenticated admission, never by Continue/bootstrap.
 * Unknown, mixed and extension requests retain the full effective catalog. */
export function freezeTaskCapabilities(spec: TaskSpec, input: Pick<StartAgentLoopRunRequest,
  'prompt' | 'attachments' | 'pinnedSkillIds' | 'pinnedSubagentId' | 'selection'>, registeredNames: readonly string[]): TaskSpec {
  if (spec.scope.capabilityCatalog || !spec.scope.authorEffects) return spec
  const requestHash = createHash('sha256').update(input.prompt).digest('hex')
  if (requestHash !== spec.scope.authorEffects.requestHash) throw new Error('Original request does not match the task catalog')
  const parsed = parseAuthorWritingRequest(input.prompt)
  const extensionRequest = input.attachments?.length || input.pinnedSkillIds?.length || input.pinnedSubagentId || input.selection
    || /导出|导入|封面|技能|模型|额度|余额|账单|发布|归档|删除作品|删除小说|重命名|改名|计划|大纲|设定|宪章|记忆|子\s*agent|并行|派生|标签|简介|export|import|cover|skill|model|credits|publish|archive|rename|outline|subagent/iu.test(input.prompt)
    || /https?:\/\/|www\./iu.test(input.prompt)
    || spec.scope.authorEffects.manuscript && /联网|上网|搜索|检索|查阅|查找|抓取|网址|网页|来源|search|browse|fetch|look\s+up|web\s+read/iu.test(input.prompt)
    || parsed.evidence.quoted.some(item => !item.closed)
    || parsed.evidence.operations.some(item => item.accepted && item.polarity === 'affirmative'
      && (item.kind === 'artifact' || item.kind === 'structure' || item.targetIndices.some(index => ['artifact', 'metadata', 'structure'].includes(parsed.evidence.targets[index]?.kind))))
  let kind: NonNullable<TaskSpec['scope']['capabilityCatalog']>['kind'] = 'full'
  if (!extensionRequest) {
    if (spec.intent === 'research_analysis' && !spec.scope.authorEffects.manuscript) kind = 'research'
    else if (['write', 'revise'].includes(spec.intent) && !['conversation_only', 'proposal_only'].includes(spec.writingPacing ?? '')
      && spec.scope.writing?.kind === 'bounded' && !spec.scope.localEditBoundary && !parsed.ambiguous
      && parsed.evidence.operations.filter(item => item.accepted && item.polarity === 'affirmative')
        .every(item => ['write', 'revise', 'review', 'read', 'placement'].includes(item.kind))) kind = 'writing'
    else if (spec.writingPacing === 'conversation_only'
      && /^(?:你好|您好|早上好|晚上好|谢谢|hello|hi|thanks)[！!。.\s]*$/iu.test(input.prompt.trim())) kind = 'conversation'
  }
  const names = [...new Set([...registeredNames, 'execution_context_read'])].filter(name => {
    if (kind === 'full') return true
    const group = taskToolRelevance(name)
    // Preserve newly introduced/unmapped capabilities conservatively. Existing
    // extension intents above select full, so mapped irrelevant tools can go.
    return group === 'common' || group === kind || group === 'extension' && !extensions.has(name)
  })
  return { ...spec, scope: { ...spec.scope, capabilityCatalog: { version: 1, requestHash, kind, names } } }
}
