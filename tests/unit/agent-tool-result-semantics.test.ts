import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { projectChapterBodyResult, projectConfirmedToolFailure } from '../../api/lib/agent/tools/contract.js'
import type { ToolContext, ToolResult } from '../../api/lib/agent/tools/types.js'

const ctx = { runId: 'run', callId: 'call' }
const result = (before: string, after: string): ToolResult => ({ output: 'unchanged compatible observation',
  display: { kind: 'chapterDiff', chapterId: 'chapter', chapterTitle: '章', before, after, appliedDirectly: true, revision: 4 },
  snapshot: { target: 'chapter', targetId: 'chapter', field: 'content', previousValue: before } })
const durable = { taskRootId: 'root', operationId: 'operation', receiptId: 'operation', resultHash: 'a'.repeat(64) }

describe('optional tool result diagnostics', () => {
  it.each(['legacy', 'durable'] as const)('describes body effects separately from compatible result fields for %s', executor => {
    for (const after of ['原文', '改稿']) {
      const original = result('原文', after)
      const saved = structuredClone(original)
      const projected = projectChapterBodyResult(ctx, original, executor === 'durable' ? durable : undefined)
      expect(projected.resultSemantics).toMatchObject({ version: 1,
        kind: after === '原文' ? 'no_change' : 'applied', effectDomain: 'chapter_body',
        effectState: after === '原文' ? 'known_not_applied' : 'committed',
        reasonCode: after === '原文' ? 'CHAPTER_BODY_UNCHANGED' : 'CHAPTER_BODY_APPLIED',
        scope: { ...ctx, targetId: 'chapter', revision: 4, contentHash: createHash('sha256').update(after).digest('hex') },
        provenance: { source: executor === 'durable' ? 'durable_receipt' : 'legacy_body_transaction' },
      })
      if (executor === 'durable') expect(projected.resultSemantics?.provenance).toMatchObject({ taskRootId: 'root', operationId: 'operation',
        receipt: { id: 'operation', resultHash: 'a'.repeat(64) } })
      const canonical = { ...projected }
      delete canonical.resultSemantics
      expect(canonical).toEqual(saved)
      expect(original).toEqual(saved)
      expect(JSON.stringify(projected.resultSemantics)).not.toContain(after)
    }
  })

  it('does not mistake uncommitted legacy outer transactions for final effect evidence', () => {
    const outer = { ...ctx, transaction: {} as NonNullable<ToolContext['transaction']> }
    expect(projectChapterBodyResult(outer, result('原文', '改稿')).resultSemantics).toBeUndefined()
    expect(projectChapterBodyResult(outer, result('原文', '原文')).resultSemantics).toBeUndefined()
    expect(projectConfirmedToolFailure(outer, { outcome: 'failed', output: '拒绝' }, 'CHAPTER_ANCHOR_CONFLICT').resultSemantics).toBeUndefined()
  })

  it.each([
    { output: '已完成' },
    { output: '待核', outcome: 'failed', display: result('原文', '改稿').display },
    { ...result('原文', '改稿'), display: { ...result('原文', '改稿').display, appliedDirectly: false } },
    ...[undefined, 0, -1, 1.1, NaN].map(revision => ({ ...result('原文', '改稿'), display: { ...result('原文', '改稿').display, revision } })),
  ] as ToolResult[])('omits unproven effects for %j instead of inferring success from text', value => {
    expect(projectChapterBodyResult(ctx, value).resultSemantics).toBeUndefined()
  })

  it('preserves existing outcome/failureCode and diagnoses only the caller-proved exact failure code', () => {
    const original: ToolResult = { outcome: 'failed', output: '原错误', summary: '原摘要' }
    const saved = structuredClone(original)
    const projected = projectConfirmedToolFailure(ctx, original, 'TOOL_APPROVAL_EXPIRED', durable)
    expect(projected.outcome).toBe('failed')
    expect(projected.failureCode).toBeUndefined()
    expect(projected.resultSemantics).toMatchObject({ kind: 'failed', effectDomain: 'tool_execution', effectState: 'known_not_applied', reasonCode: 'TOOL_APPROVAL_EXPIRED' })
    expect(original).toEqual(saved)
    expect(projectConfirmedToolFailure(ctx, original, '').resultSemantics).toBeUndefined()
    expect(projectConfirmedToolFailure(ctx, { output: '结果未确认' }, 'RUNTIME_RECONCILIATION_REQUIRED').resultSemantics).toBeUndefined()
  })

  it('does not copy fabricated prior diagnostics or reconstruct missing receipt references', () => {
    const original = { ...result('原文', '原文'), resultSemantics: { kind: 'applied' } as ToolResult['resultSemantics'] }
    expect(projectChapterBodyResult(ctx, original, { taskRootId: 'root', operationId: 'operation' }).resultSemantics)
      .toMatchObject({ kind: 'no_change', provenance: { source: 'durable_receipt' } })
    expect(projectChapterBodyResult(ctx, original, { ...durable, resultHash: 'invalid' }).resultSemantics?.provenance.receipt).toBeUndefined()
    expect(projectChapterBodyResult(ctx, { ...original, display: undefined }).resultSemantics).toBeUndefined()
    expect(original.resultSemantics).toEqual({ kind: 'applied' })
  })
})
