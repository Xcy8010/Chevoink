import { createHash } from 'node:crypto'
import { getAgentToolPresentation } from '../../../../shared/agent-tool-presentation.js'
import { AGENT_TOOL_GOVERNANCE } from './governance.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'

type ResultProvenance = {
  source: 'legacy_body_transaction' | 'durable_receipt' | 'confirmed_preexecution_failure'
  taskRootId?: string
  operationId?: string
  receipt?: { id: string; resultHash: string }
}
export type DurableResultProvenance = {
  taskRootId: string
  operationId: string
  /** Actual AgentEffectReceipt primary key (operationId), never a generated ID. */
  receiptId?: string
  resultHash?: string
}
type ResultScope = {
  runId: string
  callId: string
  targetId?: string
  revision?: number
  /** SHA256 of the raw UTF-8 body, not runtimeJson({content})'s envelope hash. */
  contentHash?: string
}

/** Optional internal diagnostics. A body effect, receipt commit, valid report
 * and task delivery are separate facts. This never grants recovery authority. */
export type AgentToolResultSemantics = {
  version: 1
  scope: ResultScope
  provenance: ResultProvenance
} & (
  | { kind: 'applied'; effectDomain: 'chapter_body'; effectState: 'committed'; reasonCode: 'CHAPTER_BODY_APPLIED' }
  | { kind: 'no_change'; effectDomain: 'chapter_body'; effectState: 'known_not_applied'; reasonCode: 'CHAPTER_BODY_UNCHANGED' }
  | { kind: 'failed'; effectDomain: 'tool_execution'; effectState: 'known_not_applied'; reasonCode: string }
)

function resultProvenance(source: ResultProvenance['source'], durable?: DurableResultProvenance): ResultProvenance {
  return durable ? {
    source: 'durable_receipt', taskRootId: durable.taskRootId, operationId: durable.operationId,
    ...(durable.receiptId && durable.resultHash && /^[a-f0-9]{64}$/u.test(durable.resultHash)
      ? { receipt: { id: durable.receiptId, resultHash: durable.resultHash } } : {}),
  } : { source }
}

/** Invoke only after the owned body transaction or existing durable receipt
 * validation. Return a new projection; never persist it into canonical receipts.
 * Outer legacy transactions have not committed, so they supply no effect claim. */
export function projectChapterBodyResult(ctx: Pick<ToolContext, 'runId' | 'callId' | 'transaction'>, result: ToolResult,
  durable?: DurableResultProvenance): ToolResult {
  const projected = { ...result }
  delete projected.resultSemantics
  const display = result.display
  if ((!durable && ctx.transaction) || result.outcome === 'failed' || display?.kind !== 'chapterDiff' || !display.appliedDirectly
    || !display.chapterId || typeof display.revision !== 'number' || !Number.isSafeInteger(display.revision) || display.revision < 1) return projected
  const changed = display.before !== display.after
  projected.resultSemantics = {
    version: 1, scope: { runId: ctx.runId, callId: ctx.callId, targetId: display.chapterId, revision: display.revision,
      contentHash: createHash('sha256').update(display.after).digest('hex') },
    provenance: resultProvenance('legacy_body_transaction', durable),
    ...(changed ? { kind: 'applied', effectDomain: 'chapter_body', effectState: 'committed', reasonCode: 'CHAPTER_BODY_APPLIED' } as const
      : { kind: 'no_change', effectDomain: 'chapter_body', effectState: 'known_not_applied', reasonCode: 'CHAPTER_BODY_UNCHANGED' } as const),
  }
  return projected
}

/** Only a confirmed preexecution refusal or the existing validated
 * outcome=failed/effectApplied=false receipt may call this. Unknown exceptions
 * stay on their existing throw/reconciliation path without diagnostic fiction. */
export function projectConfirmedToolFailure(ctx: Pick<ToolContext, 'runId' | 'callId' | 'transaction'>, result: ToolResult,
  code: string, durable?: DurableResultProvenance): ToolResult {
  const projected = { ...result }
  delete projected.resultSemantics
  if ((!durable && ctx.transaction) || result.outcome !== 'failed' || !code) return projected
  return { ...projected, resultSemantics: {
    version: 1, kind: 'failed', effectDomain: 'tool_execution', effectState: 'known_not_applied', reasonCode: code,
    scope: { runId: ctx.runId, callId: ctx.callId }, provenance: resultProvenance('confirmed_preexecution_failure', durable),
  } }
}

/** Diagnostic requirements, not a second authority/scheduler. Runtime checks and
 * immutable execution snapshots remain the source of admission and effects. */
export type AgentToolContract = {
  version: 1
  author: ReturnType<typeof getAgentToolPresentation>
  category: 'read' | 'write' | 'structure' | 'high_risk' | 'workflow'
  risk: 'low' | 'medium' | 'high'
  effect: 'observation' | 'content' | 'structure' | 'configuration' | 'workflow'
  preconditions: readonly string[]
  postconditions: readonly string[]
  recovery: 'repeat_authorized_read' | 'committed_receipt_only'
  concurrency: 'independent_read' | 'serialize_scope'
  resource: 'account' | 'session' | 'novel'
}

// Deliberately narrow: readOnly also includes paid image reads, exports,
// previews, trace-producing retrieval and bounded waits. They are not pure.
const repeatableReads = new Set([
  'model_list', 'account_credits', 'account_credit_history', 'account_novels',
  'novel_get_context', 'chapter_read', 'chapter_list_summaries', 'memory_search',
  'plan_read', 'volume_list', 'structure_outline', 'directive_list',
  'memory_review_list', 'session_history_search', 'session_message_read',
  'task_context_list', 'task_context_read', 'story_charter_get',
  'chapter_bridge_get', 'quality_report_get', 'character_voice_get',
  'experience_anchor_get', 'style_profile_get', 'retrieval_trace_read',
  'research_report_read', 'goal_read',
])
const currentBodyRequired = new Set(['chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_rename',
  'continuity_validate', 'quality_analyze', 'chapter_bridge_commit'])
const configuration = new Set(['agent_configure', 'model_assign', 'skill_enable', 'skill_install_shared', 'skill_rollback'])
const account = new Set(['model_list', 'account_credits', 'account_credit_history', 'account_novels',
  'novel_create', 'skill_catalog', 'skill_shared_invites', 'skill_install_shared'])
const session = new Set(['agent_configure', 'model_assign', 'session_rename', 'session_history_search',
  'session_message_read', 'task_context_list', 'task_context_read', 'task_spawn', 'task_send', 'task_wait',
  'goal_read', 'goal_enable', 'goal_report', 'plan_exit', 'todo_write', 'ask_user', 'task_respond'])

export function describeAgentToolContract(tool: Pick<AgentTool, 'name' | 'readOnly' | 'alwaysConfirm' | 'dangerous'>): AgentToolContract {
  const governance = AGENT_TOOL_GOVERNANCE[tool.name as keyof typeof AGENT_TOOL_GOVERNANCE]
  if (!governance) throw new Error(`Tool governance missing: ${tool.name}`)
  const pureRead = tool.readOnly && repeatableReads.has(tool.name)
  return {
    version: 1, author: getAgentToolPresentation(tool.name), category: governance.category, risk: governance.risk,
    effect: pureRead ? 'observation' : configuration.has(tool.name) ? 'configuration'
      : governance.category === 'structure' ? 'structure' : governance.category === 'write' ? 'content' : 'workflow',
    preconditions: ['server_identity_and_task_scope', 'frozen_tool_authority', 'complete_schema_valid_input',
      ...(currentBodyRequired.has(tool.name) ? ['current_chapter_observation_and_revision'] : []),
      ...(tool.alwaysConfirm || tool.dangerous ? ['explicit_human_confirmation'] : [])],
    postconditions: governance.postconditions,
    recovery: pureRead ? 'repeat_authorized_read' : 'committed_receipt_only',
    concurrency: pureRead ? 'independent_read' : 'serialize_scope',
    resource: account.has(tool.name) ? 'account' : session.has(tool.name) ? 'session' : 'novel',
  }
}

/** Coarse conservative keys; no caller may use model-provided identity fields.
 * This catalog is informational until the scheduler's equivalent rules pass. */
export function agentToolResourceKey(contract: AgentToolContract, ctx: Pick<ToolContext, 'userId' | 'novelId' | 'sessionId'>): string {
  return JSON.stringify([ctx.userId, contract.resource, contract.resource === 'account' ? ctx.userId
    : contract.resource === 'session' ? ctx.sessionId : ctx.novelId])
}
