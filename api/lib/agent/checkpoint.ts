import { z } from 'zod'

/**
 * plan/18 P4 检查点式自动续跑：纯函数判定 + 预算 clamp。
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
export const runCheckpointSchema = z.object({
  version: z.literal(1), runStartedAt: z.number().int().positive(),
  resumeCount: z.number().int().min(0).max(CHECKPOINT_MAX_RESUMES),
  compactionCount: z.number().int().min(0).max(CHECKPOINT_MAX_COMPACTIONS),
  maxTurns: z.number().int().positive(), tokenBudget: z.number().int().positive(),
  writeProgress: z.number().int().nonnegative(), writeBaseline: z.number().int().nonnegative(),
  readProgress: z.number().int().nonnegative(), readBaseline: z.number().int().nonnegative(),
  progressSignatures: z.array(z.string()),
  // Usage/currentTurn remain per-run for existing UI and accounting consumers.
  // Only the budget guard includes preceding runs of the same explicit task.
  inheritedTokens: z.number().int().nonnegative().default(0),
  inheritedTurns: z.number().int().nonnegative().default(0),
  inheritedExecutionMs: z.number().int().nonnegative().optional(),
  // 作者显式续跑在自动硬顶之上再授予的预算片次数；老记录缺省 0（无手动续跑）。
  manualResumeCount: z.number().int().min(0).max(CHECKPOINT_MANUAL_RESUME_HARD_MAX).default(0),
}).strict().refine(value => value.writeBaseline <= value.writeProgress && value.readBaseline <= value.readProgress)
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

export function evaluateCheckpoint(input: CheckpointEvaluation): { ok: boolean; reason: string } {
  if (input.usedTokens !== undefined && input.tokenCeiling !== undefined && input.usedTokens >= input.tokenCeiling) return { ok: false, reason: '已达总 token 硬顶' }
  const maxResumes = input.maxResumes ?? CHECKPOINT_MAX_RESUMES
  const maxCompactions = input.maxCompactions ?? CHECKPOINT_MAX_COMPACTIONS
  // 任务完成由执行循环决定；兼容未传 taskPending 的旧调用方。
  if (!(input.taskPending ?? input.todoLeft > 0)) return { ok: false, reason: '任务已结束，无需续跑' }
  // 新读取证据也可推进研究/检查任务，但重复观察、待办改名不能购买预算片。
  if (input.writeProgress <= input.writeBaseline && (input.readProgress ?? 0) <= (input.readBaseline ?? 0)) {
    return { ok: false, reason: '本区间无新的有效进展' }
  }
  // 条件 c：续跑链与 compaction 次数硬上限
  if (input.resumeCount >= maxResumes) return { ok: false, reason: `续跑次数已达上限 ${maxResumes}` }
  if (input.compactionCount >= maxCompactions) return { ok: false, reason: `压缩次数已达上限 ${maxCompactions}` }
  // 条件 d：墙钟总帽（长任务模式）未超
  if (input.elapsedMs > input.longWallClockLimitMs) return { ok: false, reason: '已达长任务墙钟总帽' }
  return { ok: true, reason: '' }
}

/**
 * run 预算解析：默认档不变（env 200 万）；作者显式上调时允许，但服务端 clamp 到硬顶（500 万），
 * 下调不限（最低 500 防空转误杀）。取代原「只能下调」的 min() 语义。
 */
export function resolveRunTokenBudget(paramBudget: number | undefined | null, defaultBudget: number, ceiling: number): number {
  const requested = paramBudget ?? defaultBudget
  return Math.min(ceiling, Math.max(500, requested))
}

/**
 * 手动续跑预算片：自动检查点续跑在总 token 硬顶上严格停下（evaluateCheckpoint），
 * 但「继续执行」是设计中的显式人工入口（plan/18）——命中预算/轮次边界时，
 * 作者显式续跑可在硬顶之上再授予有限数量的预算片，避免任务被硬顶永久死锁
 * （额度耗尽换免费/自定义模型、供应商故障烧穿预算等场景都曾卡死任务）。
 * 片数上限持久化在 checkpoint 里，脚本化连点不能无限放大成本；
 * 未命中边界返回 null（正常续跑，不消耗手动名额）。
 */
export function resolveManualResumeGrant(input: {
  taskTokens: number
  runTokenBudget: number
  turnsUsed: number
  maxTurns: number
  manualResumeCount: number
  maxManualResumes: number
}): { granted: false; reason: string } | { granted: true; tokenBudget: number; maxTurns: number; manualResumeCount: number } | null {
  const atTokenWall = input.taskTokens >= input.runTokenBudget
  const atTurnWall = input.turnsUsed >= input.maxTurns
  if (!atTokenWall && !atTurnWall) return null
  if (input.manualResumeCount >= input.maxManualResumes) {
    return { granted: false, reason: `手动续跑机会已用完（${input.manualResumeCount}/${input.maxManualResumes}）` }
  }
  return {
    granted: true,
    tokenBudget: Math.max(input.runTokenBudget, input.taskTokens + CHECKPOINT_BUDGET_SLICE),
    maxTurns: input.maxTurns + CHECKPOINT_TURN_SLICE,
    manualResumeCount: input.manualResumeCount + 1,
  }
}
