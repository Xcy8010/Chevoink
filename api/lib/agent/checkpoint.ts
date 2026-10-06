import { COMPATIBILITY_TOKEN_LIMIT } from './execution-control.js'
import { z } from 'zod'

/**
 * 历史检查点证据兼容。新任务按完成条件执行。
 *
 * 预算/轮次耗尽不直接终止，而是做「检查点评估」；全部用确定性信号判定，
 * 满足则同 run 内压缩上下文 + 刷新预算片/轮次片继续跑；不满足走既有 wrap-up 收尾。
 * 29 R08：待办不是完成真源；相邻检查点须有真实写入或去重后的读取证据，否则禁止续跑。
 */

export interface CheckpointEvaluation {
  /** 当前未完成的待办数；没有清单不构成任务已完成的证据。 */
  todoLeft: number
  /** 执行循环尚未接受最终交付。显式 false 优先于遗留待办。 */
  taskPending?: boolean
  /** 本次运行已去重的有效只读观察数，不含失败/重复调用或模型叙述。 */
  readProgress?: number
  readBaseline?: number
  /** 本 checkpoint 区间内成功的写类工具次数（chapter_write/append/edit_range、plan_save、memory_save 等） */
  writeProgress: number
  /** 上一个检查点时的写类进展基线（区间增量 = writeProgress - writeBaseline） */
  writeBaseline: number
  /** 已自动续跑次数 */
  resumeCount: number
  /** 已执行 compaction 次数 */
  compactionCount: number
  /** run 已运行的墙钟毫秒数 */
  elapsedMs: number
  /** 长任务墙钟帽毫秒数（默认 180 分钟） */
  longWallClockLimitMs: number
  maxResumes?: number
  maxCompactions?: number
  usedTokens?: number
  tokenCeiling?: number
}

export const CHECKPOINT_MAX_RESUMES = 4
export const CHECKPOINT_MAX_COMPACTIONS = 6
/** 每次续跑增加 200 万 token；总预算仍受服务端硬顶约束（默认 500 万）。 */
export const CHECKPOINT_BUDGET_SLICE = 2_000_000
/** 每次续跑刷新的轮次片 */
export const CHECKPOINT_TURN_SLICE = 50
/**
 * 手动续跑（作者显式点击「继续」）在自动硬顶之上可再授予的预算片次数上限：
 * 这是持久化计数的 schema 硬上限，实际额度由 env.AGENT_RUN_MANUAL_RESUME_MAX 决定（默认 2）。
 */
export const CHECKPOINT_MANUAL_RESUME_HARD_MAX = 10

/** Internal metadata inside the existing run usage JSON, not a new UI/API field. */
const runCheckpointFields = {
  runStartedAt: z.number().int().positive(),
  resumeCount: z.number().int().nonnegative(),
  compactionCount: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive(), tokenBudget: z.number().int().positive(),
  writeProgress: z.number().int().nonnegative(), writeBaseline: z.number().int().nonnegative(),
  readProgress: z.number().int().nonnegative(), readBaseline: z.number().int().nonnegative(),
  progressSignatures: z.array(z.string()),
  // A review denial hands control back for bounded safe wrap-up attempts (the
  // loop guides at most 3 times, then ends the task with an explicit exit for
  // the author). Resuming never restores this budget or manuscript authority.
  reviewHandoffCount: z.number().int().min(0).max(4).optional(),
  // Usage/currentTurn remain per-run for existing UI and accounting consumers.
  // Only the budget guard includes preceding runs of the same explicit task.
  inheritedTokens: z.number().int().nonnegative().default(0),
  inheritedTurns: z.number().int().nonnegative().default(0),
  inheritedExecutionMs: z.number().int().nonnegative().optional(),
  // 作者显式续跑在自动硬顶之上再授予的预算片次数；老记录缺省 0（无手动续跑）。
  manualResumeCount: z.number().int().min(0).max(CHECKPOINT_MANUAL_RESUME_HARD_MAX).default(0),
}
export const runCheckpointSchema = z.discriminatedUnion('version', [
  z.object({ ...runCheckpointFields, version: z.literal(1),
    resumeCount: z.number().int().min(0).max(CHECKPOINT_MAX_RESUMES),
    compactionCount: z.number().int().min(0).max(CHECKPOINT_MAX_COMPACTIONS) }).strict(),
  z.object({ ...runCheckpointFields, version: z.literal(2), controlPolicy: z.literal('until_completion'),
    origin: z.enum(['system_default', 'unknown_legacy']), activeExecutionMs: z.number().int().nonnegative(), stagnantBatches: z.number().int().nonnegative().default(0) }).strict(),
]).refine(value => value.writeBaseline <= value.writeProgress && value.readBaseline <= value.readProgress)
export type RunCheckpointState = z.infer<typeof runCheckpointSchema>

/** Count execution intervals, not the gaps between terminal and restart events.
 * Missing terminal events remain charged conservatively until the next known
 * stop; nested starts never reset the clock. This does not alter token usage. */
export function recoverRunElapsedMs(startedAt: number, stoppedAt: number,
  events: Array<{ type: string; at: number }>): number | null {
  if (![startedAt, stoppedAt].every(Number.isSafeInteger) || startedAt < 0 || stoppedAt < startedAt) return null
  let activeSince: number | null = startedAt, previous = startedAt, elapsed = 0
  for (const event of events) {
    if (!Number.isSafeInteger(event.at) || event.at < previous || event.at > stoppedAt) return null
    previous = event.at
    if (event.type === 'run.started') activeSince ??= event.at
    else if (event.type === 'run.paused' || event.type === 'run.finished') {
      if (activeSince !== null) elapsed += event.at - activeSince
      activeSince = null
    }
  }
  if (activeSince !== null) elapsed += stoppedAt - activeSince
  return Number.isSafeInteger(elapsed) ? elapsed : null
}

export const savedRunUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(), completionTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative(),
  checkpoint: runCheckpointSchema.optional(),
}).refine(value => value.totalTokens >= value.promptTokens + value.completionTokens)

/** Pre-checkpoint releases left usage NULL. Recover only complete, run-owned receipts;
 * this is budget accounting, never a new charge or a zero-budget reset. */
export function recoverLegacyRunUsage(currentTurn: number, receipts: Array<{
  turn: number | null; requestTokens: number | null; responseTokens: number | null
}>) {
  if (!Number.isSafeInteger(currentTurn) || currentTurn < 0) return null
  const turns = new Set<number>()
  let promptTokens = 0, completionTokens = 0
  for (const receipt of receipts) {
    if (!Number.isSafeInteger(receipt.requestTokens) || !Number.isSafeInteger(receipt.responseTokens)
      || receipt.requestTokens === null || receipt.responseTokens === null
      || receipt.requestTokens < 0 || receipt.responseTokens < 0) return null
    promptTokens += receipt.requestTokens
    completionTokens += receipt.responseTokens
    if (receipt.turn !== null) turns.add(receipt.turn)
  }
  for (let turn = 1; turn <= currentTurn; turn++) if (!turns.has(turn)) return null
  const totalTokens = promptTokens + completionTokens
  if (!Number.isSafeInteger(totalTokens)) return null
  return { promptTokens, completionTokens, totalTokens }
}

/** Historical callers may assess progress, but saved caps are not effective policy. */
export function evaluateCheckpoint(input: CheckpointEvaluation): { ok: boolean; reason: string } {
  if (!(input.taskPending ?? input.todoLeft > 0)) return { ok: false, reason: '任务已结束，无需续跑' }
  if (input.writeProgress <= input.writeBaseline && (input.readProgress ?? 0) <= (input.readBaseline ?? 0)) return { ok: false, reason: '本区间无新的有效进展' }
  return { ok: true, reason: '' }
}

/** Storage compatibility only. Internal inputs cannot establish human stoploss. */
export function resolveRunTokenBudget(_paramBudget: number | undefined | null, _defaultBudget: number, _ceiling: number): number {
  return COMPATIBILITY_TOKEN_LIMIT
}

/** Manual resume neither resets usage nor grants a new cumulative allowance. */
export function resolveManualResumeGrant(_input: {
  taskTokens: number; runTokenBudget: number; turnsUsed: number; maxTurns: number; manualResumeCount: number; maxManualResumes: number
}): { granted: false; reason: string } | { granted: true; tokenBudget: number; maxTurns: number; manualResumeCount: number } | null {
  return null
}
