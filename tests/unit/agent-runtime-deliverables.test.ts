import { describe, expect, it, vi } from 'vitest'
import { collectDurableDeliverables } from '../../api/lib/agent/runtime-deliverables.js'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'

type Effect = Parameters<typeof collectDurableDeliverables>[2][number]
const root = { id: 'root', userId: 'owner', novelId: 'novel' }
const marker = { version: 1, userId: root.userId, novelId: root.novelId, chapterId: 'chapter', revision: 4 }
const reused = (wordCount = 8) => ({ output: '复用，本次未创建', summary: '复用', chapterCreateReuse: marker,
  observedState: { kind: 'chapter', id: 'chapter', revision: 4 }, display: { kind: 'chapterRef', chapterId: 'chapter', title: '标题', wordCount } })
function evidence(operationId: string, action: string, toolResult: object, envelope: object = {}) {
  const result = runtimeJson({ toolResult, ...envelope })
  const receipt = { operationId, result: result.value, resultHash: result.hash }
  const effect: Effect = { operationId, action, resultHash: result.hash, sequence: '1', sourceRevision: 0, outcome: 'succeeded', summary: '合成回执' }
  return { receipt, effect }
}
function database(receipts: ReturnType<typeof evidence>['receipt'][], chapters: object[] = []) {
  const db = { agentEffectReceipt: { findMany: vi.fn(async () => receipts) },
    chapter: { findMany: vi.fn(async () => chapters) }, agentArtifact: { findMany: vi.fn(async () => []) } }
  return { db, tx: db as unknown as RuntimeTx }
}
const written = () => evidence('written', 'chapter_write', { output: '已保存', summary: '写入',
  display: { kind: 'chapterDiff', chapterId: 'chapter', chapterTitle: '标题', after: '原写入正文', revision: 3 } })

describe('durable deliverable creation reuse evidence', () => {
  it.each([0, 8])('a verified reuse with %i characters is a noop, not an authored delivery', async count => {
    const item = evidence('reuse', 'chapter_create', reused(count))
    const { db, tx } = database([item.receipt])
    expect(await collectDurableDeliverables(tx, root, [item.effect])).toEqual([])
    expect(db.chapter.findMany).not.toHaveBeenCalled()
    expect(db.agentArtifact.findMany).not.toHaveBeenCalled()
  })

  it.each(['current', 'changed', 'missing'] as const)('reuse preserves the original authored body/hash/revision and its %s storage status', async status => {
    const write = written(), noop = evidence('reuse', 'chapter_create', reused())
    const { tx } = database([write.receipt, noop.receipt], status === 'missing' ? [] : [{ id: 'chapter', title: '标题',
      content: status === 'changed' ? '外部修改正文' : '原写入正文', revision: 8 }])
    const originalReceipt = structuredClone(write.receipt)
    const result = await collectDurableDeliverables(tx, root, [write.effect, noop.effect])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ sourceOperationId: 'written', expectedRevision: 3,
      expectedHash: runtimeJson({ title: '标题', content: '原写入正文' }).hash, status })
    expect(write.receipt).toEqual(originalReceipt)
  })

  it.each([
    ['wrong-owner', { ...marker, userId: 'another' }],
    ['wrong-novel', { ...marker, novelId: 'another' }],
    ['wrong-id', { ...marker, chapterId: 'another' }],
    ['wrong-revision', { ...marker, revision: 5 }],
    ['unsupported-version', { ...marker, version: 2 }],
    ['extra-marker-field', { ...marker, content: '不能当正文' }],
    ['null-marker', null],
  ])('rejects %s even when the altered result has a matching hash', async (_scenario, invalidMarker) => {
    const item = evidence('invalid', 'chapter_create', { ...reused(), chapterCreateReuse: invalidMarker })
    const { tx } = database([item.receipt])
    await expect(collectDurableDeliverables(tx, root, [item.effect])).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  })

  it.each(['write-action', 'snapshot', 'transition', 'progress', 'required-result', 'diff', 'ref-body', 'observed-id'] as const)(
    'rejects contradictory %s rather than using a marker to suppress a write', async scenario => {
      const toolResult = { ...reused(),
        ...(scenario === 'snapshot' ? { snapshot: { target: 'chapter', targetId: 'chapter', field: 'content', previousValue: '' } } : {}),
        ...(scenario === 'transition' ? { semanticTransition: { targetId: root.novelId, beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64) } } : {}),
        ...(scenario === 'required-result' ? { requiredResult: { targetId: 'chapter', contentHash: 'a'.repeat(64) } } : {}),
        ...(scenario === 'diff' ? { display: { kind: 'chapterDiff', chapterId: 'chapter', chapterTitle: '标题', after: '正文', revision: 4 } } : {}),
        ...(scenario === 'ref-body' ? { display: { ...reused().display, after: '正文' } } : {}),
        ...(scenario === 'observed-id' ? { observedState: { kind: 'chapter', id: 'another', revision: 4 } } : {}),
      }
      const item = evidence('invalid', scenario === 'write-action' ? 'chapter_write' : 'chapter_create', toolResult,
        scenario === 'progress' ? { progress: { kind: 'content_revision', targetId: 'chapter', beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64) } } : {})
      const { tx } = database([item.receipt])
      await expect(collectDurableDeliverables(tx, root, [item.effect])).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    })

  it('still rejects an unmarked nonempty reference, prose claims and incomplete true creation evidence', async () => {
    for (const display of [{ ...reused().display }, { kind: 'chapterDiff', chapterId: 'chapter', chapterTitle: '标题', revision: 4 }]) {
      const item = evidence('invalid', 'chapter_create', { output: '服务端已复用，未写入', summary: '复用', display })
      const { tx } = database([item.receipt])
      await expect(collectDurableDeliverables(tx, root, [item.effect])).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    }
  })

  it('keeps unmarked original body and empty creation receipts compatible', async () => {
    for (const content of ['', '原写入正文']) {
      const display = content ? { kind: 'chapterDiff', chapterId: 'chapter', chapterTitle: '标题', after: content, revision: 3 }
        : { kind: 'chapterRef', chapterId: 'chapter', title: '标题', wordCount: 0 }
      const item = evidence('create', 'chapter_create', { output: '创建成功', display })
      const { tx } = database([item.receipt], [{ id: 'chapter', title: '标题', content, revision: 3 }])
      expect(await collectDurableDeliverables(tx, root, [item.effect])).toEqual([expect.objectContaining({ sourceOperationId: 'create', status: 'current', characters: content.length })])
    }
  })

  it('rejects missing receipts and hash mismatches before reading the marker', async () => {
    const item = evidence('reuse', 'chapter_create', reused())
    const { tx } = database([])
    await expect(collectDurableDeliverables(tx, root, [item.effect])).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    const altered = database([{ ...item.receipt, result: runtimeJson({ toolResult: reused(0) }).value }])
    await expect(collectDurableDeliverables(altered.tx, root, [item.effect])).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  })
})
