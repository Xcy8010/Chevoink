import { z } from 'zod'
import { startAgentLoopRunSchema } from './schemas.js'

export const GOAL_OBJECTIVE_MAX_CHARS = 12_000
export const agentGoalObjectiveSchema = z.string().trim().min(1, '请输入目标。')
  .refine(value => Array.from(value).length <= GOAL_OBJECTIVE_MAX_CHARS, '目标不能超过12,000字。')
export const agentGoalStatusSchema = z.enum(['active', 'updating', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'completed', 'cancelled'])
export const agentGoalPhaseSchema = z.enum(['idle', 'queued', 'executing', 'awaiting_input', 'awaiting_approval', 'awaiting_provider', 'reconciling', 'reviewing'])
export type AgentGoalStatus = z.infer<typeof agentGoalStatusSchema>
export type AgentGoalPhase = z.infer<typeof agentGoalPhaseSchema>
export const goalIsTerminal = (status: AgentGoalStatus): boolean => status === 'completed' || status === 'cancelled'

const requestId = z.string().uuid()
const version = z.number().int().positive().max(2_147_483_647)
const positiveLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const agentGoalLimitsSchema = z.object({
  tokenLimit: positiveLimit.optional(),
  activeTimeLimitMs: positiveLimit.optional(),
}).strict()
export const agentGoalExecutionOptionsSchema = startAgentLoopRunSchema.omit({ sessionId: true, novelId: true, prompt: true })
export const createAgentGoalSchema = z.object({
  requestId, objective: agentGoalObjectiveSchema, options: agentGoalExecutionOptionsSchema,
  limits: agentGoalLimitsSchema.optional(),
}).strict()
export const updateAgentGoalSchema = z.object({
  requestId, expectedStateVersion: version, expectedRevision: version, objective: agentGoalObjectiveSchema,
}).strict()
export const actOnAgentGoalSchema = z.object({
  requestId, expectedStateVersion: version, action: z.enum(['pause', 'resume', 'cancel', 'confirm_completion']),
  budgetChange: agentGoalLimitsSchema.optional(),
  completion: z.object({ progressHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  model: startAgentLoopRunSchema.pick({ modelTier: true, customModelId: true, reasoningEffort: true }).optional(),
}).strict().refine(value => value.action === 'resume' || (!value.budgetChange && !value.model), '仅继续目标时可以调整限制或模型。')
  .refine(value => value.action === 'confirm_completion' ? Boolean(value.completion) : !value.completion, '确认完成必须绑定当前成果。')
export type CreateAgentGoalRequest = z.infer<typeof createAgentGoalSchema>
export type UpdateAgentGoalRequest = z.infer<typeof updateAgentGoalSchema>
export type ActOnAgentGoalRequest = z.infer<typeof actOnAgentGoalSchema>

// BigInt accounting crosses JSON as decimal strings; never round budget values.
export interface AgentGoalSnapshot {
  id: string; sessionId: string; novelId: string
  objective: string; revision: number; pendingRevision: number | null
  status: AgentGoalStatus; phase: AgentGoalPhase; stateVersion: number
  currentRunId: string | null; reasonCode: string | null
  tokenLimit: string; tokensUsed: string; tokensReserved: string; creditsUsedMicros: string
  activeTimeMs: string; activeTimeLimitMs: string; activeSince: string | null
  serverTime: string; createdAt: string; updatedAt: string; finishedAt: string | null
}
export interface AgentGoalEventPayload {
  sequence: number; goalId: string; sessionId: string; stateVersion: number; goalRevision: number
  type: string; snapshot: AgentGoalSnapshot
}
export interface AgentGoalRevisionView { revision: number; objective: string; createdAt: string }
export interface AgentGoalEvidenceView {
  criterionId: string; description: string; kind: string; targetId: string | null
  status: string; receipt: unknown; verifiedAt: string | null
}
export interface AgentGoalDetail {
  goal: AgentGoalSnapshot; revisions: AgentGoalRevisionView[]; evidence: AgentGoalEvidenceView[]
  nextRevisionCursor: number | null; nextEvidenceCursor: string | null
  completion: { progressHash: string; canConfirm: boolean; needsAuthorVerification: boolean; blockers: Array<{ code: string; id: string }> }
}

/** One projection for every surface. An idle/waiting goal is not a live model request. */
export function agentGoalPresentation(goal: Pick<AgentGoalSnapshot, 'status' | 'phase'>) {
  const labels: Record<AgentGoalStatus, string> = { active: '进行中的目标', updating: '正在更新目标', paused: '已暂停的目标',
    blocked: '需要处理', usage_limited: '额度受限', budget_limited: '预算已用完', completed: '目标已完成', cancelled: '目标已取消' }
  const waiting: Partial<Record<AgentGoalPhase, string>> = { awaiting_input: '等待你的回复', awaiting_approval: '等待确认',
    awaiting_provider: '等待服务恢复', reconciling: '正在核对执行结果' }
  return { label: goal.status === 'active' ? (waiting[goal.phase] ?? labels.active) : labels[goal.status],
    running: goal.status === 'active' && ['executing', 'reviewing'].includes(goal.phase),
    canResume: ['paused', 'blocked', 'usage_limited', 'budget_limited'].includes(goal.status),
    canPause: ['active', 'updating'].includes(goal.status), visible: goal.status !== 'cancelled' }
}
