import type { AgentExecutionMode, AgentSessionToolPolicy, AgentSandboxMode, AgentWorkspaceToolPermission } from '../../../shared/contracts/index.js'
import { env } from '../../config/env.js'
import type { AgentTool } from './tools/types.js'
import { filterGoalToolsForExecution, getToolsForMode } from './tools/registry.js'
import type { Agent2FeatureFlags } from '../../../shared/contracts/index.js'
import { AGENT_TOOL_GOVERNANCE } from './tools/governance.js'

/** Agent 声明式定义（替代 buildExecutionAgent 的硬编码 switch） */
export type AgentDefinition = {
  type: string
  title: string
  model: string
  /** '*' 表示全部注册工具；数组则为白名单 */
  tools: '*' | string[]
  modes: AgentExecutionMode[]
}

/**
 * 主控与四种专业子 Agent。子 Agent 使用显式工具白名单：
 * - 不含 todo_write（持久子 Agent 使用独立 run/执行帧，主 run 待办仍由主控维护）
 * - 不含 subagent_delegate / subagent_run（禁止嵌套递归，只有主控可调子 Agent）
 * - 写工具按需白名单化；派生仍受父任务工具策略与审批限制，不能把 ask/deny 扩大为 allow
 */
export const agentRegistry: AgentDefinition[] = [
  {
    type: 'orchestrator',
    title: '写作主控',
    model: env.agentModel,
    tools: '*',
    modes: ['plan', 'build', 'review'],
  },
  {
    type: 'research',
    title: '调研 Agent',
    model: env.agentModel,
    tools: ['novel_get_context', 'chapter_read', 'chapter_list_summaries', 'memory_search', 'plan_read', 'web_search', 'web_read', 'platform_novel_search', 'platform_novel_read', 'research_dossier_get', 'research_dossier_build', 'craft_search'],
    modes: ['plan', 'review'],
  },
  {
    type: 'continuity',
    title: '一致性 Agent',
    model: env.agentModel,
    tools: ['novel_get_context', 'chapter_read', 'chapter_list_summaries', 'memory_search', 'story_charter_get', 'chapter_bridge_get', 'continuity_validate', 'quality_report_get', 'project_search', 'structure_validate', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'plan_save'],
    modes: ['review'],
  },
  {
    type: 'quality',
    title: '质量 Agent',
    model: env.agentModel,
    tools: ['novel_get_context', 'chapter_read', 'quality_analyze', 'quality_report_get', 'quality_findings_select', 'creative_critique', 'style_profile_get', 'style_leakage_check', 'chapter_edit_range', 'chapter_write', 'chapter_append'],
    modes: ['review'],
  },
  {
    type: 'lore',
    title: '设定 Agent',
    model: env.agentModel,
    tools: ['novel_get_context', 'chapter_read', 'chapter_list_summaries', 'memory_search', 'memory_review_list', 'memory_relation_save', 'memory_event_save', 'memory_save', 'story_charter_get', 'character_voice_get', 'experience_anchor_get'],
    modes: ['plan', 'review'],
  },
]

export function getAgentDefinition(type: string): AgentDefinition {
  return agentRegistry.find((agent) => agent.type === type) ?? agentRegistry[0]
}

/** 按 Agent 白名单 + 模式权限过滤可用工具 */
export function getToolsForAgent(
  agent: AgentDefinition,
  mode: AgentExecutionMode,
  featureFlags?: Agent2FeatureFlags,
  options: { goalOwned?: boolean } = {},
): AgentTool[] {
  let modeTools = getToolsForMode(mode)
  modeTools = filterGoalToolsForExecution(modeTools, options.goalOwned === true)

  if (featureFlags) {
    const disabled = new Set<string>()
    if (!featureFlags.volume) {
      ;['volume_list', 'volume_create', 'volume_update', 'volume_move', 'volume_delete', 'chapter_move', 'chapter_move_to_volume', 'chapter_split', 'chapter_merge', 'structure_outline'].forEach((name) => disabled.add(name))
    }
    if (!featureFlags.changeSet) {
      ;['project_search', 'entity_resolve', 'impact_analyze', 'structure_validate', 'bulk_replace_preview', 'entity_rename_preview', 'changeset_apply', 'changeset_rollback'].forEach((name) => disabled.add(name))
    }
    if (!featureFlags.memory2) {
      ;['memory_review_list', 'memory_relation_save', 'memory_event_save'].forEach((name) => disabled.add(name))
    }
    if (!featureFlags.skill2) {
      ;['skill_catalog', 'skill_load', 'skill_run_explain', 'skill_shared_invites', 'skill_create_draft', 'skill_test', 'skill_enable', 'skill_install_shared', 'skill_rollback', 'skill_publish', 'creative_critique', 'creative_revision_draft'].forEach((name) => disabled.add(name))
    }
    if (!featureFlags.storyCompiler) {
      ;['story_charter_get', 'story_charter_save', 'reader_promise_save', 'reader_promise_update', 'story_compiler_prepare', 'scene_task_build', 'chapter_bridge_get', 'continuity_validate', 'chapter_bridge_commit'].forEach((name) => disabled.add(name))
    }
    if (!featureFlags.humanityQuality) {
      ;['quality_analyze', 'quality_report_get', 'quality_findings_select', 'quality_revision_apply', 'quality_finding_feedback', 'character_voice_get', 'character_voice_save', 'experience_anchor_get', 'experience_anchor_save'].forEach((name) => disabled.add(name))
    }
    if (!featureFlags.craftLibrary) {
      ;['craft_search', 'style_profile_get', 'style_profile_extract', 'retrieval_trace_read', 'style_leakage_check'].forEach((name) => disabled.add(name))
    }
    if (!featureFlags.researchDossier) {
      ;['research_dossier_get', 'research_dossier_build', 'first_three_prototype_get', 'first_three_prototype_build'].forEach((name) => disabled.add(name))
    }
    modeTools = modeTools.filter((tool) => !disabled.has(tool.name))
  }

  if (agent.tools === '*') {
    return modeTools
  }

  const allowed = new Set(agent.tools)
  return modeTools.filter((tool) => allowed.has(tool.name))
}

const DEFAULT_POLICY: AgentSessionToolPolicy = {
  network: 'ask',
  contentWrite: 'allow',
  bulkWrite: 'ask',
  publish: 'ask',
  destructive: 'ask',
}

function governedPolicyKey(tool: AgentTool): keyof AgentSessionToolPolicy | null {
  if (tool.name === 'web_search' || tool.name === 'web_read' || tool.name === 'research_dossier_build') return 'network'
  if (tool.name === 'novel_publish' || tool.name === 'cover_apply') return 'publish'
  if (tool.name === 'changeset_apply' || tool.name === 'changeset_rollback' || tool.name === 'chapter_merge' || tool.name === 'chapter_split') return 'bulkWrite'
  const governance = AGENT_TOOL_GOVERNANCE[tool.name as keyof typeof AGENT_TOOL_GOVERNANCE]
  if (tool.dangerous || governance?.category === 'high_risk' || /(?:delete|archive|rollback)$/.test(tool.name)) return 'destructive'
  if (!tool.readOnly && governance?.category !== 'workflow') return 'contentWrite'
  return null
}

/** 服务端会话级权限闸：客户端隐藏按钮不能绕过此处。 */
export function applySessionToolPolicy(
  tools: AgentTool[],
  mode: AgentExecutionMode,
  rawPolicy: unknown,
  sandboxMode: AgentSandboxMode = 'workspace',
): AgentTool[] {
  const policy = rawPolicy && typeof rawPolicy === 'object' ? { ...DEFAULT_POLICY, ...(rawPolicy as Partial<AgentSessionToolPolicy>) } : DEFAULT_POLICY
  return tools.flatMap((tool) => {
    if (sandboxMode === 'read_only' && !tool.readOnly && tool.name !== 'agent_configure' && tool.name !== 'model_assign') return []
    const key = governedPolicyKey(tool)
    if (!key) return [tool]
    const level = policy[key]
    if (level === 'deny') return []
    if (level === 'allow') return [tool]
    const permission: Record<AgentExecutionMode, AgentWorkspaceToolPermission> = { ...tool.permission, [mode]: 'ask' }
    return [{ ...tool, permission }]
  })
}
