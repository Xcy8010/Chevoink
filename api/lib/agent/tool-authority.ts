import type { AgentExecutionMode, AgentWorkspaceToolPermission, TaskSpec } from '../../../shared/contracts/index.js'
import type { AgentTool } from './tools/types.js'

/** Server-created admission ceiling, never populated from model arguments or tool output. */
export type ToolAuthority = ReadonlyMap<string, Readonly<{
  permission: AgentWorkspaceToolPermission
  alwaysConfirm: boolean
  dangerous: boolean
}>>

/** Narrow both the model's schemas and the executor's admission ceiling. */
export function restrictToolsToTask(tools: AgentTool[], task: TaskSpec): AgentTool[] {
  if (task.writingPacing === 'conversation_only') return tools.filter(tool => tool.readOnly || tool.name === 'ask_user')
  if (task.writingPacing === 'proposal_only') {
    // This ceiling is snapshotted and inherited by children and resume. A model
    // cannot turn its own outline, question or checkpoint into write permission.
    return tools.filter(tool => tool.readOnly || ['ask_user', 'todo_write', 'plan_save'].includes(tool.name))
  }
  if (task.intent !== 'research_analysis') return tools.filter(tool => tool.name !== 'research_report_save' && tool.name !== 'research_report_read')
  return tools.filter(tool => tool.readOnly || tool.name === 'ask_user' || tool.name === 'todo_write' || tool.name === 'research_report_save')
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
