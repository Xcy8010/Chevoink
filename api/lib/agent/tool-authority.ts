import { isElidedVolumeAddition } from './volume-create-intent.js'
import { isNovelDirectionSetup, isExplicitNovelMetadataRequest } from './task-spec.js'
import type { AgentExecutionMode, AgentWorkspaceToolPermission, TaskSpec } from '../../../shared/contracts/index.js'
import type { AgentTool } from './tools/types.js'

/** Server-created admission ceiling, never populated from model arguments or tool output. */
export type ToolAuthority = ReadonlyMap<string, Readonly<{
  permission: AgentWorkspaceToolPermission
  alwaysConfirm: boolean
  dangerous: boolean
}>>

const manuscriptEffects = new Set(['chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_rename',
  'story_compiler_prepare', 'scene_task_build', 'chapter_bridge_commit', 'changeset_apply', 'changeset_rollback', 'quality_revision_apply'])
const structureEffects = new Set(['volume_create', 'volume_move', 'volume_delete',
  'chapter_move', 'chapter_move_to_volume', 'chapter_split', 'chapter_merge'])

/** Narrow both the model's schemas and the executor's admission ceiling. */
export function restrictToolsToTask(tools: AgentTool[], task: TaskSpec, mode?: AgentExecutionMode): AgentTool[] {
  tools = tools.map(tool => {
    const setup = task.scope.novelInitializationProtocol === 1 && (isExplicitNovelMetadataRequest(task.goals.join('\n'))
      || isNovelDirectionSetup(task.goals.join('\n')) && task.scope.novelInitializationTarget !== 'existing')
    const allowed = ['novel_create', 'novel_update_meta'].includes(tool.name) ? setup
      : tool.name === 'volume_create' ? task.scope.volumeCreationProtocol === 1 && (task.scope.authorEffects?.structure === true || Boolean(task.scope.volumeCreateIntent)) : true
    return allowed ? tool : { ...tool, permission: { ...tool.permission, plan: 'deny' as const } }
  })
  if (mode) tools = tools.filter(tool => tool.permission[mode] !== 'deny')
  if (task.scope.novelInitializationTarget === 'existing' && isNovelDirectionSetup(task.goals.join('\n'))) {
    tools = tools.filter(tool => !['novel_create', 'novel_update_meta'].includes(tool.name))
  }
  if (task.scope.novelInitializationProtocol === 1 && (isNovelDirectionSetup(task.goals.join('\n')) || isExplicitNovelMetadataRequest(task.goals.join('\n')) && !/(?:大纲|细纲|计划|规划|outline|plan)/iu.test(task.goals.join('\n')))
    && task.scope.authorEffects?.artifact !== true) tools = tools.filter(tool => !['plan_save', 'plan_rename', 'plan_delete'].includes(tool.name))
  if (task.responseDeliveryProtocol !== 1) tools = tools.filter(tool => tool.name !== 'task_respond')
  if (task.scope.capabilityCatalog) {
    const names = new Set(task.scope.capabilityCatalog.names)
    tools = tools.filter(tool => names.has(tool.name))
  }
  if (task.scope.volumeCreateIntent || task.scope.volumeCreationProtocol === 1 && isElidedVolumeAddition(task.goals.join('\n'))) {
    tools = tools.filter(tool => tool.readOnly || ['ask_user', 'todo_write', 'agent_configure', 'model_assign', 'task_respond'].includes(tool.name)
      || tool.name === 'volume_create' && Boolean(task.scope.volumeCreateIntent))
  }
  if (task.scope.authorEffects) tools = tools.filter(tool =>
    (task.scope.authorEffects!.manuscript || !manuscriptEffects.has(tool.name))
    && (task.scope.authorEffects!.structure || tool.name === 'volume_create' && (task.scope.writing?.tailVolume?.creationProtocol === 2 || Boolean(task.scope.volumeCreateIntent)) || !structureEffects.has(tool.name)))
  if (task.researchNavigation?.version === 1 && task.intent === 'research_analysis') tools = tools.map(tool => tool.researchNavigation
    ? { ...tool, ...tool.researchNavigation } : tool)
  if (task.networkAccess === 'denied') tools = tools.filter(tool => tool.name !== 'web_search' && tool.name !== 'web_read')
  if (task.researchReadAccess === 'denied') tools = tools.filter(tool => tool.name !== 'web_read')
  if (task.writingPacing === 'conversation_only') return tools.filter(tool => tool.readOnly || ['ask_user', 'goal_report', 'goal_enable', 'agent_configure', 'model_assign'].includes(tool.name))
  if (task.writingPacing === 'proposal_only') {
    // This ceiling is snapshotted and inherited by children and resume. A model
    // cannot turn its own outline, question or checkpoint into write permission.
    return tools.filter(tool => tool.readOnly || ['ask_user', 'todo_write', 'plan_save', 'goal_report', 'goal_enable', 'agent_configure', 'model_assign'].includes(tool.name)
      || task.scope.novelInitializationProtocol === 1 && ['novel_create', 'novel_update_meta'].includes(tool.name) && isNovelDirectionSetup(task.goals.join('\n'))
      || task.scope.novelInitializationProtocol === 1 && ['novel_create', 'novel_rename', 'novel_update_meta'].includes(tool.name) && isExplicitNovelMetadataRequest(task.goals.join('\n')))
  }
  if (task.intent !== 'research_analysis') return tools.filter(tool => tool.name !== 'research_report_save' && tool.name !== 'research_report_read')
  return tools.filter(tool => tool.readOnly || ['ask_user', 'todo_write', 'research_report_save', 'goal_report', 'goal_enable'].includes(tool.name))
}

export function snapshotToolAuthority(tools: AgentTool[], mode: AgentExecutionMode): ToolAuthority {
  const authority = new Map<string, { permission: AgentWorkspaceToolPermission; alwaysConfirm: boolean; dangerous: boolean }>()
  for (const tool of tools) {
    if (authority.has(tool.name)) throw new Error(`Duplicate admitted tool: ${tool.name}`)
    authority.set(tool.name, Object.freeze({
      permission: tool.permission[mode],
      alwaysConfirm: tool.alwaysConfirm === true,
      dangerous: tool.dangerous === true,
    }))
  }
  return authority
}

/** Mode changes and refreshed session policies can narrow, never widen, a parent's ceiling. */
export function intersectToolAuthority(tools: AgentTool[], mode: AgentExecutionMode, authority: ToolAuthority): AgentTool[] {
  return tools.flatMap(tool => {
    const grant = authority.get(tool.name)
    const current = tool.permission[mode]
    if (!grant || grant.permission === 'deny' || current === 'deny') return []
    const alwaysConfirm = grant.alwaysConfirm || tool.alwaysConfirm === true
    const permission = alwaysConfirm || grant.permission === 'ask' || current === 'ask' ? 'ask' : 'allow'
    return [{
      ...tool,
      alwaysConfirm,
      dangerous: grant.dangerous || tool.dangerous === true,
      permission: { ...tool.permission, [mode]: permission },
    }]
  })
}
