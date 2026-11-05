import type { AgentExecutionMode, AgentWorkspaceToolPermission, TaskSpec } from '../../../shared/contracts/index.js'
import type { AgentTool } from './tools/types.js'

/** Server-created admission ceiling, never populated from model arguments or tool output. */
export type ToolAuthority = ReadonlyMap<string, Readonly<{
  permission: AgentWorkspaceToolPermission
  alwaysConfirm: boolean
  dangerous: boolean
}>>

/** Task interpretation is context, not a second permission system. Role,
 * mode, session policy and actual parent grants own the tool ceiling. */
export function restrictToolsToTask(tools: AgentTool[], task: TaskSpec, mode?: AgentExecutionMode): AgentTool[] {
  if (task.scope.agentWritingProtocol !== 1) tools = tools.filter(tool => tool.name !== 'task_scope_bind')
  if (mode) tools = tools.filter(tool => tool.permission[mode] !== 'deny')
  if (task.responseDeliveryProtocol !== 1) tools = tools.filter(tool => tool.name !== 'task_respond')
  if (task.researchNavigation?.version === 1 && task.intent === 'research_analysis') tools = tools.map(tool => tool.researchNavigation
    ? { ...tool, ...tool.researchNavigation } : tool)
  if (task.networkAccess === 'denied') tools = tools.filter(tool => tool.name !== 'web_search' && tool.name !== 'web_read')
  if (task.researchReadAccess === 'denied') tools = tools.filter(tool => tool.name !== 'web_read')
  return tools
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
