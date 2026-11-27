import { getAgentToolPresentation } from '../../../shared/agent-tool-presentation.js'
import { z } from 'zod'
import type { ToolCallRequest } from '../ai-service.js'
import type { RuntimeTx } from './runtime-common.js'

/** Supply the opening when the provider starts with tools alone. Subsequent
 * ordinary tool rounds already have their own visible progress and receipts. */
export function toolActivityReport(name: string, title: string | undefined, hasPriorTool: boolean): string {
  const { label } = getAgentToolPresentation(name)
  if (label === '等待作者决定') return '这一步需要和你确认一个问题。'
  if (hasPriorTool) return ''
  const action = title ?? (label.endsWith('复查') ? `复查${label.slice(0, -2)}` : label)
  return `我先${action}。`
}

const singleReviewTypes = new Map([['continuity_validate', 'continuity'], ['quality_analyze', 'quality'], ['creative_critique', 'custom']])
const reviewArgs = z.object({ chapterId: z.string().optional(), chapterIds: z.array(z.string()).optional(),
  reviewType: z.string().optional(), skillIds: z.array(z.string()).optional() })
const reviewReceipt = z.object({ ok: z.boolean(), failureCode: z.string().optional(), reviewOutcome: z.string().optional(),
  display: z.object({ kind: z.literal('reviewBatch'), chapters: z.array(z.object({ chapterId: z.string(), status: z.string() })) }).optional() })
function reviewTarget(call: ToolCallRequest) {
  if (call.incomplete) return
  try { return reviewArgs.safeParse(JSON.parse(call.arguments)).data } catch { return }
}

/** The model may stay silent when it changes review method. Announce the
 * change once, using the original task's actual result as the witness. */
export async function readReviewTransitionReport(db: RuntimeTx, runId: string,
  history: readonly { role: string; toolCalls?: readonly ToolCallRequest[] }[], next: readonly ToolCallRequest[]): Promise<string> {
  const singles = next.filter(call => singleReviewTypes.has(call.name))
  if (!singles.length) return ''
  const previousSingles: ToolCallRequest[] = []
  for (let index = history.length - 1; index >= 0; index--) {
    const calls = history[index].toolCalls
    if (history[index].role !== 'assistant' || !calls?.length) continue
    const batches = calls.filter(call => call.name === 'chapter_review_batch')
    if (!batches.length) {
      previousSingles.push(...calls.filter(call => singleReviewTypes.has(call.name)))
      continue
    }
    for (const batch of batches) {
      const args = reviewTarget(batch)
      if (!args?.chapterIds) continue
      const matchingChapter = (call: ToolCallRequest) => {
        if (singleReviewTypes.get(call.name) !== args.reviewType) return
        const target = reviewTarget(call)
        if (target?.chapterId && args.chapterIds?.includes(target.chapterId)
          && (args.reviewType !== 'custom' || JSON.stringify(target.skillIds) === JSON.stringify(args.skillIds))) return target.chapterId
      }
      const targets = singles.map(matchingChapter).filter(Boolean)
      if (!targets.length || previousSingles.some(matchingChapter)) continue
      const event = await db.agentRunEvent.findFirst({ where: { runId, type: 'tool.result',
        AND: [{ payload: { path: ['callId'], equals: batch.id } }, { payload: { path: ['toolName'], equals: batch.name } }] },
        select: { payload: true } })
      const receipt = reviewReceipt.safeParse(event?.payload).data
      if (receipt?.reviewOutcome === 'provider_unresolved' || receipt?.failureCode === 'AI_PROVIDER_BILLING_UNCONFIRMED'
        || receipt?.failureCode === 'RUNTIME_RECONCILIATION_REQUIRED') return '批量复查的原请求仍待核对。'
      if (receipt && (receipt.display ? receipt.display.chapters.some(row => row.status !== 'complete' && targets.includes(row.chapterId))
        : !receipt.ok)) return '批量复查还有未完成的部分，我准备按章核对。'
    }
    return ''
  }
  return ''
}
