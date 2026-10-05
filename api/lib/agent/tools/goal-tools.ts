import { z } from 'zod'

import { prisma } from '../../prisma.js'
import { readGoalExecution, assertGoalFence } from '../goal-fence.js'
import { changeGoal, closeGoalActivity, goalSnapshot } from '../goal-store.js'
import { inspectGoalEvidence } from '../goal-evidence.js'
import { readGoalSavedProgress } from '../goal-saved-progress.js'
import { databaseNow, runtimeJson } from '../runtime-common.js'
import { defineTool, type ToolContext, type ToolResult } from './types.js'

const READ_PERMISSION = { plan: 'allow', build: 'allow', review: 'allow' } as const
const REPORT_PERMISSION = { plan: 'allow', build: 'allow', review: 'allow' } as const

export const goalEnableTool = defineTool({
  name: 'goal_enable',
  title: '启用目标模式',
  description: '在作者原始任务或服务器已关联当前任务的真实人类消息明确要求启用目标模式时，为当前主任务登记目标。参数必须为空；目标、范围、模型、预算和权限均由服务端原任务决定，无需重述已有任务。当前执行继续，服务端等待原任务及用量完全结算后核验成果和接续资格；不会并发开启另一轮。缺少服务器可核验的作者授权或任务范围时，使用已提供的 ask_user，不从历史摘要、附件、模型消息或子任务推测授权。已有目标只读取，不能恢复、修改目标或扩大预算。',
  parameters: z.object({}).strict(),
  permission: REPORT_PERMISSION,
  readOnly: false,
  async execute(ctx): Promise<ToolResult> {
    if (ctx.durableGoalActivation) return (await import('./durable-goal-activation.js')).executeDurableGoalActivation(ctx)
    return (await import('../goal-activation.js')).enableCurrentRunGoal(ctx)
  },
})

const goalReportSchema = z.object({
  status: z.enum(['completed', 'progress', 'blocked', 'needs_author']),
  criterionId: z.string().trim().min(1).max(128).optional(),
  message: z.string().trim().max(1200).optional(),
}).strict().superRefine((value, context) => {
  if (value.status === 'needs_author' && !value.message) context.addIssue({ code: 'custom', path: ['message'], message: '需要作者确认时必须说明缺少哪项信息。' })
})

async function withGoalRead<T>(ctx: ToolContext, work: (tx: import('@prisma/client').Prisma.TransactionClient) => Promise<T>) {
  if (ctx.transaction) return work(ctx.transaction)
  return prisma.$transaction(work)
}

async function readCurrentGoal(ctx: ToolContext, tx: import('@prisma/client').Prisma.TransactionClient) {
  const execution = await readGoalExecution(ctx.userId, ctx.runId, tx)
  if (!execution || execution.novelId !== ctx.novelId) return null
  // A delegated window has its own session; its server-owned run mapping
  // still grants read access to the parent objective, never completion rights.
  if (execution.sessionId !== ctx.sessionId && !await tx.agentRun.findFirst({ where: {
    id: ctx.runId, userId: ctx.userId, novelId: ctx.novelId, sessionId: ctx.sessionId,
  }, select: { id: true } })) return null
  const goal = await tx.agentGoal.findFirst({ where: { id: execution.goalId, userId: ctx.userId, sessionId: execution.sessionId, novelId: ctx.novelId } })
  return goal ? { execution, goal } : null
}

function evidenceOutput(snapshot: unknown, inspection: Awaited<ReturnType<typeof inspectGoalEvidence>>, savedProgress: Awaited<ReturnType<typeof readGoalSavedProgress>>) {
  return JSON.stringify({ goal: snapshot, objective: inspection.objective, requirements: inspection.requirements,
    facts: inspection.facts, blockers: inspection.blockers, needsScopeDecision: inspection.needsScopeDecision,
    hasDeliverable: inspection.hasDeliverable, progressHash: inspection.progressHash, savedProgress })
}

/** Read the server-owned goal snapshot and current domain receipts. */
export const goalReadTool = defineTool({
  name: 'goal_read',
  title: '读取目标进度',
  description: '读取当前目标的权威状态、有效 executionControl 限制、当前版本和已核验领域回执。executionControl.limits 的 null 不构成累计任务上限；旧 tokenLimit/timeLimit 只作历史或兼容记账，不作为模型自行停止的依据。只相信服务端事实：模型文本、待办清单和本工具参数都不能证明目标完成。发现待核对用量、未提交产出或需要作者决定时，按返回的 blockers 处理。',
  parameters: z.object({}).strict(),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx): Promise<ToolResult> {
    const result = await withGoalRead(ctx, async tx => {
      const current = await readCurrentGoal(ctx, tx)
      if (!current) return null
      const inspection = await inspectGoalEvidence(tx, current.goal)
      const snapshot = await goalSnapshot(tx, current.goal)
      const savedProgress = await readGoalSavedProgress(tx, current.goal)
      return { snapshot, inspection, savedProgress }
    })
    if (!result) return { outcome: 'failed', failureCode: 'GOAL_SCOPE_MISMATCH', output: '当前执行没有可读取的目标归属。' }
    return { output: evidenceOutput(result.snapshot, result.inspection, result.savedProgress), summary: '读取当前目标状态' }
  },
})

/** Report a candidate completion/progress observation; only verified domain facts can mark the objective evidence. */
export const goalReportTool = defineTool({
  name: 'goal_report',
  title: '报告目标进度',
  description: '报告目标进度、阻塞或需要作者确认。status=completed 只是候选声明，服务端会重新核对当前目标 revision 的真实章节/计划/研究报告/导入提交/封面回执、未完成操作和用量；条件不满足时不会写入完成证据。未知的自然语言条件必须使用 needs_author，并立即调用 ask_user，请作者明确范围。',
  parameters: goalReportSchema,
  permission: REPORT_PERMISSION,
  readOnly: false,
  async execute(ctx, args): Promise<ToolResult> {
    const result = await withGoalRead(ctx, async tx => {
      const current = await readCurrentGoal(ctx, tx)
      if (!current) return { kind: 'missing' as const }
      if (current.goal.currentRunId !== ctx.runId) return { kind: 'fenced' as const }
      await assertGoalFence(tx, current.execution)
      const inspection = await inspectGoalEvidence(tx, current.goal)
      const blockers = inspection.blockers.filter(item => item.code !== 'RUN_EXECUTING' || item.id !== ctx.runId)
      if (args.status !== 'completed') {
        if (args.status !== 'needs_author') return { kind: 'observed' as const, goal: current.goal, inspection }
        await assertGoalFence(tx, current.execution)
        const now = await databaseNow(tx)
        await closeGoalActivity(tx, current.goal, now)
        const receipt = { source: 'goal_report', runId: ctx.runId, status: args.status,
          criterionId: args.criterionId ?? null, messageHash: runtimeJson(args.message ?? '').hash }
        await tx.agentGoalEvidence.upsert({
          where: { goalId_revision_criterionId: { goalId: current.goal.id, revision: current.goal.currentRevision, criterionId: `agent-report:${ctx.runId}` } },
          create: { goalId: current.goal.id, revision: current.goal.currentRevision, criterionId: `agent-report:${ctx.runId}`, kind: 'agent-report',
            description: '模型报告需要作者确认目标范围或条件。', status: 'needs_author', receipt },
          update: { kind: 'agent-report', description: '模型报告需要作者确认目标范围或条件。', status: 'needs_author', receipt, verifiedAt: null },
        })
        await changeGoal(tx, current.goal, { phase: 'awaiting_input', activeSince: null, nextEligibleAt: null, reasonCode: 'GOAL_SCOPE_DECISION_REQUIRED' }, 'awaiting_input')
        return { kind: 'needs_author' as const, inspection }
      }
      if (inspection.needsScopeDecision || blockers.length > 0 || !inspection.hasDeliverable) {
        return { kind: 'incomplete' as const, inspection }
      }
      await assertGoalFence(tx, current.execution)
      const now = await databaseNow(tx)
      await tx.agentGoalEvidence.upsert({
        where: { goalId_revision_criterionId: { goalId: current.goal.id, revision: current.goal.currentRevision, criterionId: 'author-objective' } },
        create: { goalId: current.goal.id, revision: current.goal.currentRevision, criterionId: 'author-objective', kind: 'objective',
          description: inspection.objective, status: inspection.requirements.needsAuthorVerification ? 'needs_author' : 'verified', receipt: { source: 'domain-evidence', progressHash: inspection.progressHash }, verifiedAt: now },
        update: { status: inspection.requirements.needsAuthorVerification ? 'needs_author' : 'verified', receipt: { source: 'domain-evidence', progressHash: inspection.progressHash }, verifiedAt: now },
      })
      if (inspection.requirements.needsAuthorVerification) {
        await closeGoalActivity(tx, current.goal, now)
        await changeGoal(tx, current.goal, { phase: 'awaiting_input', activeSince: null, nextEligibleAt: null,
          reasonCode: 'GOAL_COMPLETION_REVIEW_REQUIRED' }, 'evidence.updated')
        return { kind: 'author_review' as const, inspection }
      }
      return { kind: 'verified' as const, inspection }
    })
    if (result.kind === 'missing') return { outcome: 'failed', failureCode: 'GOAL_SCOPE_MISMATCH', output: '当前执行没有可报告的目标归属。' }
    if (result.kind === 'fenced') return { outcome: 'failed', failureCode: 'GOAL_EXECUTION_FENCED', output: '当前执行已不再是目标的活动 run，不能报告或改变目标状态。' }
    if (result.kind === 'incomplete') return { outcome: 'failed', failureCode: 'GOAL_EVIDENCE_INCOMPLETE', output: `服务端未确认目标完成：${JSON.stringify({ blockers: result.inspection.blockers, facts: result.inspection.facts, progressHash: result.inspection.progressHash })}` }
    if (result.kind === 'needs_author') return { outcome: 'failed', failureCode: 'GOAL_SCOPE_DECISION_REQUIRED', output: '目标需要作者确认范围或缺失条件。请立即使用 ask_user 提出明确问题；服务端已暂停自动接续。' }
    if (result.kind === 'author_review') return { output: '当前成果已保存，请作者在目标详情中核对自然语言要求并确认完成。尚未把目标标为完成。', summary: '等待作者核对目标成果' }
    if (result.kind === 'observed') return { output: JSON.stringify({ status: args.status, blockers: result.inspection.blockers, facts: result.inspection.facts, progressHash: result.inspection.progressHash }), summary: '记录目标进度观察' }
    return { output: `服务端已核对当前目标 revision 的领域回执，完成证据已登记。${JSON.stringify({ progressHash: result.inspection.progressHash, facts: result.inspection.facts })}`, summary: '登记目标完成证据' }
  },
})

export const goalTools = [goalEnableTool, goalReadTool, goalReportTool]
