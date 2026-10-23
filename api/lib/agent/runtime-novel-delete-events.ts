import type { AgentStreamEvent, AgentStreamEventBody } from '../../../shared/contracts/index.js'
import { runtimeError, type RuntimeTx } from './runtime-common.js'
import { readVerifiedNovelDeletion } from './runtime-novel-delete-read.js'
import { durableMessageId } from './runtime-frame-events.js'

/** The user deleted the manuscript and its chat projection. Replay ONLY its
 * authenticated terminal facts at new, original-run-relative sequence numbers;
 * do not manufacture a replacement history or recreate deleted chat rows. */
export async function readDeletedNovelEvents(tx: RuntimeTx, userId: string, runId: string, sinceSeq: number, limit: number): Promise<AgentStreamEvent[] | null> {
  const proof = await readVerifiedNovelDeletion(tx, userId, runId)
  if (!proof) return null
  const { deletion, run, source } = proof
  const bodies: AgentStreamEventBody[] = runId === deletion.runId ? [
    { type: 'tool.result', messageId: durableMessageId(deletion.taskRootId, source.source.state.turn), callId: deletion.callId,
      toolName: 'novel_delete', ok: true, summary: deletion.summary, durationMs: deletion.durationMs },
    { type: 'message.start', messageId: deletion.messageId, role: 'assistant' },
    { type: 'text.final', messageId: deletion.messageId, text: deletion.output, asReasoning: false },
    { type: 'run.finished', status: 'succeeded', usage: deletion.usage, artifacts: [], outputSummary: deletion.output, deletedNovelId: deletion.novelId },
  ] : [{ type: 'error', code: 'NOVEL_DELETED', message: '该任务所属作品已由作者确认删除，原失败及费用证据保留。', recoverable: false }]
  const last = run.lastSequence + bodies.length
  if (last > 2_147_483_647) return runtimeError('RUNTIME_EVENT_SEQUENCE_EXHAUSTED', '删除终态事件序号超出允许范围。')
  if (sinceSeq > last) return runtimeError('RUNTIME_EVENT_CURSOR_AHEAD', '事件游标超过原删除终态。')
  return bodies.map((body, index) => ({ ...body, runId, seq: run.lastSequence + index + 1, ts: deletion.committedAt }))
    .filter(event => event.seq > sinceSeq).slice(0, limit)
}
