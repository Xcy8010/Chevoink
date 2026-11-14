import type { AgentPersonalizationRule } from '../../../shared/contracts/agent-personalization.js'
import type { AgentExecutionMode } from '../../../shared/contracts/index.js'
import { DataAccessError } from '../prisma.js'
import { AGENT_TOOL_GOVERNANCE } from './tools/governance.js'
import type { AgentTool } from './tools/types.js'
import type { Prisma } from '@prisma/client'
import { readPersonalizationRules } from './personalization.js'

export function applyPersonalizationToolRules(tools: AgentTool[], mode: AgentExecutionMode, rules: AgentPersonalizationRule[],
  hasSessionOverride?: (tool: AgentTool) => boolean) {
  const byName = new Map(rules.map(rule => [rule.toolName, rule.permission]))
  return tools.flatMap(tool => {
    const rule = byName.get(tool.name)
    if (tool.permission[mode] === 'deny' || rule === 'deny') return []
    // Allow can skip a discretionary default. This stage cannot add a tool to
    // the mode/role or lift a session override, frozen grant or mandatory ask.
    if (rule === 'allow' && hasSessionOverride && !hasSessionOverride(tool) && !tool.alwaysConfirm && !tool.dangerous
      && AGENT_TOOL_GOVERNANCE[tool.name as keyof typeof AGENT_TOOL_GOVERNANCE]?.category !== 'high_risk')
      return [{ ...tool, permission: { ...tool.permission, [mode]: 'allow' as const } }]
    if (rule !== 'ask') return [tool]
    return [{ ...tool, alwaysConfirm: true, permission: { ...tool.permission, [mode]: 'ask' as const } }]
  })
}

export function hasPersonalizationSessionOverride(policy: unknown, key: string | null) {
  return Boolean(key && policy && typeof policy === 'object' && Object.prototype.hasOwnProperty.call(policy, key))
}

/** A report-only call doesn't carry approval to perform an implicit repair.
 * Keep the report when the author would need to approve a separate action. */
export async function automaticRepairPermitted(userId: string, db: Prisma.TransactionClient, kind: 'quality' | 'continuity', lock = false) {
  const actions = kind === 'quality' ? ['chapter_edit_range', 'quality_revision_apply'] : ['chapter_edit_range']
  return !(await readPersonalizationRules(userId, db, lock ? 'share' : undefined))
    .some(rule => actions.includes(rule.toolName) && rule.permission !== 'allow')
}

export async function listPersonalizationRuleOperations() {
  const { allTools } = await import('./tools/registry.js')
  return allTools.map(tool => ({ toolName: tool.name, title: tool.title }))
    .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
}

export async function assertPersonalizationRuleOperation(toolName: string) {
  const { getToolByName } = await import('./tools/registry.js')
  if (!getToolByName(toolName)) throw new DataAccessError(400, 'PERSONALIZATION_RULE_UNKNOWN_TOOL', '此操作不可用，请从操作列表选择。')
}
