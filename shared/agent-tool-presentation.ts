/** Author activity vocabulary. No model output or tool arguments choose a label.
 * This read-only catalog never grants a capability or certifies an effect. */
export type AgentAuthorPhase = 'read' | 'plan' | 'write' | 'revise' | 'review' | 'save' | 'other'
export type AgentToolPresentation = Readonly<{ label: string; phase: AgentAuthorPhase }>

const groups: Array<[AgentAuthorPhase, string, readonly string[]]> = [
  ['read', '核对前文', ['novel_get_context', 'chapter_read', 'chapter_list_summaries', 'memory_search', 'project_search', 'entity_resolve', 'impact_analyze', 'chapter_bridge_get']],
  ['read', '查看创作设定', ['directive_list', 'memory_review_list', 'story_charter_get', 'character_voice_get', 'experience_anchor_get', 'style_profile_get']],
  ['read', '查看创作资料', ['plan_read', 'research_report_read', 'research_dossier_get', 'first_three_prototype_get', 'craft_search', 'retrieval_trace_read', 'skill_catalog', 'skill_load', 'skill_run_explain', 'skill_shared_invites']],
  ['read', '查看参考资料', ['web_search', 'web_read', 'platform_novel_search', 'platform_novel_read', 'read_file', 'view_image']],
  ['read', '查看任务记录', ['session_history_search', 'session_message_read', 'task_context_list', 'task_context_read', 'task_wait', 'goal_read']],
  ['read', '查看作品结构', ['volume_list', 'structure_outline']],
  ['read', '查看我的作品', ['account_novels']],
  ['read', '查看额度', ['account_credits', 'account_credit_history']],
  ['read', '查看可用模型', ['model_list']],
  ['plan', '准备章节', ['story_compiler_prepare', 'scene_task_build']],
  ['plan', '规划创作', ['todo_write', 'first_three_prototype_build']],
  ['plan', '整理创作资料', ['research_dossier_build', 'research_report_save']],
  ['write', '新建章节', ['chapter_create']],
  ['write', '撰写章节', ['chapter_write', 'chapter_append']],
  ['revise', '修改章节内容', ['chapter_edit_range']],
  ['revise', '整理卷章', ['chapter_rename', 'chapter_move', 'chapter_move_to_volume', 'chapter_split', 'chapter_merge', 'volume_create', 'volume_update', 'volume_move', 'volume_delete']],
  ['revise', '预览作品修改', ['bulk_replace_preview', 'entity_rename_preview']],
  ['revise', '应用作品修改', ['changeset_apply']],
  ['revise', '恢复作品修改', ['changeset_rollback']],
  ['review', '复查章节', ['continuity_validate', 'quality_analyze', 'quality_report_get']],
  ['review', '检查作品结构', ['structure_validate']],
  ['review', '检查创作建议', ['creative_critique', 'creative_revision_draft', 'quality_finding_feedback']],
  ['review', '检查参考引用', ['style_leakage_check']],
  ['save', '保存章节进展', ['chapter_bridge_commit']],
  ['save', '保存创作设定', ['memory_save', 'memory_relation_save', 'memory_event_save', 'directive_save', 'directive_supersede', 'story_charter_save', 'reader_promise_save', 'reader_promise_update', 'character_voice_save', 'experience_anchor_save', 'style_profile_extract']],
  ['save', '保存创作计划', ['plan_save', 'plan_rename', 'plan_delete']],
  ['other', '整理作品信息', ['novel_create', 'novel_rename', 'novel_update_meta']],
  ['other', '制作封面', ['cover_prompt_set', 'cover_generate', 'cover_apply']],
  ['other', '导出作品', ['novel_export']],
  ['other', '导入作品', ['novel_import']],
  ['other', '管理作品', ['novel_publish', 'novel_archive', 'novel_delete']],
  ['other', '管理创作方法', ['skill_create_draft', 'skill_test', 'skill_enable', 'skill_install_shared', 'skill_rollback', 'skill_publish']],
  ['other', '协作创作', ['subagent_delegate', 'subagent_run', 'task_spawn', 'task_send']],
  ['other', '更新任务设置', ['agent_configure', 'model_assign', 'session_rename', 'plan_exit', 'goal_enable', 'goal_report']],
  ['other', '等待作者决定', ['ask_user']],
  ['other', '答复问题', ['task_respond']],
]

const catalog = new Map<string, AgentToolPresentation>()
for (const [phase, label, names] of groups) {
  for (const name of names) {
    if (catalog.has(name)) throw new Error(`Duplicate tool presentation: ${name}`)
    catalog.set(name, Object.freeze({ label, phase }))
  }
}
const fallback = Object.freeze({ label: '推进创作', phase: 'other' as const })
export const hasAgentToolPresentation = (name: string): boolean => catalog.has(name)
export const getAgentToolPresentation = (name: string): AgentToolPresentation => catalog.get(name) ?? fallback
export const registeredAgentToolPresentationNames = (): string[] => [...catalog.keys()]
