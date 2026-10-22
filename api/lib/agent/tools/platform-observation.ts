import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import type { ToolContext, ToolResult } from './types.js'

const savedObservation = z.object({ toolResult: z.object({ output: z.string(), platformBudget: z.object({
  version: z.literal(1), requestHash: z.string().regex(/^[a-f0-9]{64}$/), charged: z.boolean(),
}).strict() }).passthrough() })
const savedInput = z.object({ kind: z.literal('tool'), action: z.string(), input: z.object({ args: z.record(z.string(), z.unknown()) }) })
function requestHashFor(action: 'platform_novel_search' | 'platform_novel_read', args: unknown) {
  const raw = z.record(z.string(), z.unknown()).parse(args)
  return runtimeJson({ action, args: action === 'platform_novel_read'
    ? { novelId: raw.novelId, chapterId: raw.chapterId ?? null, offset: raw.offset ?? 0, limit: raw.limit ?? 6000 } : raw }).hash
}

/** DB-only observations reuse the original root's receipts, including after
 * worker/run replacement. A process-local cache must not reset its allowance. */
export async function observePlatformNovel(ctx: ToolContext, action: 'platform_novel_search' | 'platform_novel_read',
  args: unknown, read: () => Promise<ToolResult>, tx: Prisma.TransactionClient): Promise<ToolResult> {
  const run = await tx.agentRun.findFirst({ where: { id: ctx.runId, userId: ctx.userId, novelId: ctx.novelId,
    sessionId: ctx.sessionId, runtimeProtocolVersion: 1, novel: { authorId: ctx.userId } }, select: { taskRootId: true } })
  if (!run?.taskRootId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '站内读取没有原持久任务身份。')
  const requestHash = requestHashFor(action, args)
  const history = await tx.agentOperation.findMany({ where: { taskRootId: run.taskRootId, kind: 'tool', action, status: 'succeeded' },
    include: { effectReceipt: true, events: { where: { type: 'effect.committed' }, take: 2 } }, orderBy: { createdAt: 'asc' } })
  let used = 0, cached: ToolResult | undefined
  for (const operation of history) {
    const receipt = operation.effectReceipt, event = operation.events[0]
    const result = savedObservation.safeParse(receipt?.result)
    const input = savedInput.safeParse(operation.inputSnapshot)
    if (!receipt || !result.success || !input.success || input.data.action !== action
      || result.data.toolResult.platformBudget.requestHash !== requestHashFor(action, input.data.input.args)
      || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash
      || runtimeJson(receipt.result).hash !== receipt.resultHash || operation.events.length !== 1
      || event.eventKey !== `effect:${operation.id}` || event.taskRootId !== run.taskRootId
      || runtimeJson(event.payload).hash !== runtimeJson({ operationId: operation.id, resultHash: receipt.resultHash }).hash) {
      return runtimeError('RUNTIME_RECEIPT_INVALID', '站内读取回执不完整，不能清零预算或重读代替。')
    }
    if (result.data.toolResult.platformBudget.charged) used++
    if (result.data.toolResult.platformBudget.charged && result.data.toolResult.platformBudget.requestHash === requestHash) cached = result.data.toolResult as ToolResult
  }
  const platformBudget = { version: 1 as const, requestHash, charged: false }
  if (cached) return { ...cached, output: `复用本任务已保存的站内阅读结果：\n${cached.output}`, platformBudget }
  const maximum = action === 'platform_novel_search' ? 5 : 8
  if (used >= maximum) return { platformBudget,
    output: `本次任务的站内作品${action === 'platform_novel_search' ? '搜索' : '读取'}次数已用完（最多 ${maximum} 次）。请基于已获取的内容完成任务。`,
    summary: action === 'platform_novel_search' ? '站内搜索预算已用尽' : '站内深读预算已用尽' }
  ctx.signal.throwIfAborted()
  const result = await read()
  ctx.signal.throwIfAborted()
  return { ...result, platformBudget: { ...platformBudget, charged: true } }
}
