import { z } from 'zod'
import type { TaskSpec } from '../../../shared/contracts/index.js'
import type { RunLeaseToken } from './runtime-lease.js'
import type { readExecutionStateInTransaction } from './runtime-state.js'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { intersectToolAuthority, restrictToolsToTask, snapshotToolAuthority } from './tool-authority.js'
import type { AgentTool } from './tools/types.js'

type Configuration = Awaited<ReturnType<typeof readExecutionStateInTransaction>>['configuration']
const grantSchema = z.object({ name: z.string(), permission: z.enum(['allow', 'ask', 'deny']), alwaysConfirm: z.boolean(), dangerous: z.boolean() }).strict()
const definitionSchema = z.object({ type: z.literal('function'), function: z.object({ name: z.string(), strict: z.boolean().optional(),
  description: z.string(), parameters: z.record(z.string(), z.unknown()) }).strict() }).strict()
const admissionSchema = z.object({ version: z.literal(1), grant: grantSchema, definition: definitionSchema }).strict()
export type NativeToolAdmission = z.infer<typeof admissionSchema>

/** Recover the exact permission/schema admitted before restart. The field is
 * server metadata in the existing operation snapshot, never model arguments. */
export function readNativeToolAdmission(operation: { action: string; inputSnapshot: unknown; inputHash: string }): NativeToolAdmission | null {
  const outer = operation.inputSnapshot as { input?: { toolAdmission?: unknown } } | null
  if (!outer?.input?.toolAdmission) return null
  const parsed = admissionSchema.safeParse(outer.input.toolAdmission)
  if (!parsed.success || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash
    || parsed.data.grant.name !== operation.action || parsed.data.definition.function.name !== operation.action)
    return runtimeError('RUNTIME_RECEIPT_INVALID', '原工具准入记录与操作不一致。')
  return parsed.data
}

/** New calls use actual role/session permissions. Original configuration,
 * provider snapshots, prices and Continue identities remain unchanged. */
export async function readEffectiveNativeTooling(tx: RuntimeTx, lease: RunLeaseToken, configuration: Configuration, task: TaskSpec) {
  const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
  let parentTooling: Awaited<ReturnType<typeof readEffectiveNativeTooling>> | undefined
  if (lease.parent) {
    const parent = await (await import('./runtime-state.js')).readExecutionStateInTransaction(tx, lease.parent.taskRootId)
    parentTooling = await readEffectiveNativeTooling(tx, { ...lease, ...lease.parent, parent: undefined }, parent.configuration,
      (await import('../../../shared/contracts/task-spec-contracts.js')).taskSpecSchema.parse(parent.originalSpec))
  }
  // Session updates take FOR UPDATE; hold the same policy through the effect.
  // Parent is locked before child, matching the execution lineage.
  await tx.$queryRaw`SELECT id FROM agent_sessions WHERE id = ${root.sessionId} FOR SHARE`
  const session = await tx.agentSession.findFirst({ where: { id: root.sessionId, userId: lease.userId, novelId: root.novelId } })
  if (!session || root.userId !== lease.userId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '工具会话不属于当前作者和作品。')
  const { agentRegistry, getToolsForAgent, applySessionToolPolicy } = await import('./agents.js')
  const agent = agentRegistry.find(item => item.type === configuration.agentType)
  if (!agent) return runtimeError('RUNTIME_SCOPE_MISMATCH', '原Agent角色不存在，不能替换为其他角色。')
  const { resolveAgent2FeatureFlags } = await import('../agent2-feature-flags.js')
  const { executionContextReadTool } = await import('./tools/task-context-tools.js')
  const { ORCHESTRATION_TOOL_NAMES } = await import('./tools/task-orchestration-tools.js')
  const goal = await tx.agentGoalExecution.findFirst({ where: { runId: lease.runId }, select: { goalId: true } })
  const contextRead: AgentTool = { ...executionContextReadTool,
    execute: (ctx, args) => executionContextReadTool.execute(ctx, executionContextReadTool.parameters.parse(args)) }
  const candidates = [...getToolsForAgent(agent, configuration.mode, resolveAgent2FeatureFlags(lease.userId), { goalOwned: Boolean(goal) }), contextRead]
    .filter(tool => !session.spawnedFromSessionId || !ORCHESTRATION_TOOL_NAMES.has(tool.name))
  let tools = applySessionToolPolicy(restrictToolsToTask(candidates, task, configuration.mode), configuration.mode, session.toolPolicy,
    session.sandboxMode === 'read_only' || session.sandboxMode === 'full_access' ? session.sandboxMode : 'workspace')
  const ceiling = new Map(snapshotToolAuthority(tools, configuration.mode))
  for (const grant of configuration.toolAuthority) ceiling.set(grant.name, grant)
  tools = intersectToolAuthority(tools, configuration.mode, ceiling)
  if (lease.parent) {
    tools = intersectToolAuthority(tools, configuration.mode, new Map(configuration.toolAuthority.map(grant => [grant.name, grant])))
    tools = intersectToolAuthority(tools, configuration.mode, new Map(parentTooling!.toolAuthority.map(grant => [grant.name, grant])))
  }
  if (goal) {
    const source = await tx.agentGoal.findUniqueOrThrow({ where: { id: goal.goalId } })
    const activationCeiling = await (await import('./goal-activation.js')).readGoalActivationToolCeiling(tx, source)
    if (activationCeiling !== null) tools = intersectToolAuthority(tools, configuration.mode, new Map(activationCeiling))
  }
  const { toOpenAITools } = await import('./tools/registry.js')
  const previous = await (await import('./runtime-tool-view.js')).currentNativeToolViews(configuration.tools, task.scope)
  // Existing custom parameter contracts remain significant. Missing tool names
  // may be restored from actual permissions without rewriting old contracts.
  const definitions = toOpenAITools(tools, task.scope).map(definition => previous.find(item => item.function.name === definition.function.name) ?? definition)
  return { tools: definitions, toolAuthority: [...snapshotToolAuthority(tools, configuration.mode)].map(([name, grant]) => ({ name, ...grant })) }
}
