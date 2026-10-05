import { z } from 'zod'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import type { collectDurableToolEvidence } from './runtime-evidence.js'
import { STRUCTURE_MUTATIONS } from './runtime-common.js'

type Effect = Awaited<ReturnType<typeof collectDurableToolEvidence>>['effects'][number]
type Expected = { kind: 'chapter' | 'plan'; id: string; title: string; hash: string | null; revision: number | null; operationId: string; removed: boolean }
const chapterDiff = z.object({ kind: z.literal('chapterDiff'), chapterId: z.string(), chapterTitle: z.string(), after: z.string(), revision: z.number().int().positive() })
const chapterCreateReuse = z.object({ version: z.literal(1), userId: z.string().min(1), novelId: z.string().min(1), chapterId: z.string().min(1), revision: z.number().int().positive() }).strict()
const reusedChapterRef = z.object({ kind: z.literal('chapterRef'), chapterId: z.string().min(1), title: z.string(), wordCount: z.number().int().nonnegative() }).strict()
const reusedChapterObservation = z.object({ kind: z.literal('chapter'), id: z.string().min(1), revision: z.number().int().positive() }).strict()
const planDisplay = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('planFile'), artifactId: z.string(), title: z.string(), content: z.string() }),
  z.object({ kind: z.literal('planDiff'), artifactId: z.string(), title: z.string(), after: z.string() }),
])
const structureBodies = z.object({ contentBefore: z.array(z.object({ id: z.string(), title: z.string(), content: z.string(), revision: z.number().int() })),
  contentAfter: z.array(z.object({ id: z.string(), title: z.string(), content: z.string(), revision: z.number().int() })) })
const chapterActions = new Set(['chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_rename', 'continuity_validate', 'quality_analyze'])
const documentHash = (title: string, content: string) => runtimeJson({ title, content }).hash

/** Consumes already journal/reducer-verified effects in sequence order, inside
 * the SAME transaction. Current documents are facts, not a semantic completion
 * certificate. A read or failed call cannot become an authored deliverable. */
export async function collectDurableDeliverables(tx: RuntimeTx, root: { id: string; userId: string; novelId: string }, effects: Effect[]) {
  const expected = new Map<string, Expected>()
  const put = (kind: Expected['kind'], id: string, title: string, content: string, revision: number | null, operationId: string) => {
    expected.set(`${kind}:${id}`, { kind, id, title, hash: documentHash(title, content), revision, operationId, removed: false })
  }
  const relevant = effects.filter(effect => effect.outcome === 'succeeded' && (chapterActions.has(effect.action) || ['plan_save', 'plan_rename', 'plan_delete'].includes(effect.action) || STRUCTURE_MUTATIONS.some(action => action === effect.action)))
  for (let offset = 0; offset < relevant.length; offset += 100) {
    const page = relevant.slice(offset, offset + 100)
    const receipts = await tx.agentEffectReceipt.findMany({ where: { operationId: { in: page.map(item => item.operationId) }, operation: { taskRootId: root.id } } })
    const byId = new Map(receipts.map(item => [item.operationId, item]))
    for (const effect of page) {
      const receipt = byId.get(effect.operationId)
      if (!receipt || receipt.resultHash !== effect.resultHash || runtimeJson(receipt.result).hash !== effect.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '交付物来源与已核验效果不一致。')
      const envelope = z.object({ toolResult: z.object({ display: z.unknown().optional(), observedState: z.unknown().optional(),
        chapterCreateReuse: z.unknown().optional(), snapshot: z.unknown().optional(), semanticTransition: z.unknown().optional(), requiredResult: z.unknown().optional() }),
        progress: z.unknown().optional() }).parse(receipt.result)
      if (envelope.toolResult.chapterCreateReuse !== undefined) {
        const reuse = chapterCreateReuse.safeParse(envelope.toolResult.chapterCreateReuse)
        const ref = reusedChapterRef.safeParse(envelope.toolResult.display)
        const observed = reusedChapterObservation.safeParse(envelope.toolResult.observedState)
        if (effect.action !== 'chapter_create' || !reuse.success || !ref.success || !observed.success
          || reuse.data.userId !== root.userId || reuse.data.novelId !== root.novelId || reuse.data.chapterId !== ref.data.chapterId
          || reuse.data.chapterId !== observed.data.id || reuse.data.revision !== observed.data.revision
          || envelope.progress !== undefined || envelope.toolResult.snapshot !== undefined || envelope.toolResult.semanticTransition !== undefined
          || envelope.toolResult.requiredResult !== undefined) return runtimeError('RUNTIME_RECEIPT_INVALID', '章节复用证据与原主体、观察或无写入状态不一致。')
        // A verified successful noop preserves prior authored evidence, including
        // its body/hash/revision. A historical bound chapter adds no delivery.
        continue
      }
      if (effect.action === 'chapter_rename') {
        const { renamedChapter: item } = z.object({ renamedChapter: z.object({ id: z.string(), title: z.string(), content: z.string(), revision: z.number().int().positive() }) }).parse(receipt.result)
        put('chapter', item.id, item.title, item.content, item.revision, effect.operationId)
      } else if (effect.action === 'plan_rename' || effect.action === 'plan_delete') {
        const { planAfter: item } = z.object({ planAfter: z.object({ id: z.string(), title: z.string(), content: z.string(), removed: z.boolean() }) }).parse(receipt.result)
        if (item.removed !== (effect.action === 'plan_delete')) return runtimeError('RUNTIME_RECEIPT_INVALID', '计划移除状态与原操作不一致。')
        if (item.removed) expected.set(`plan:${item.id}`, { kind: 'plan', id: item.id, title: item.title, hash: null, revision: null, operationId: effect.operationId, removed: true })
        else put('plan', item.id, item.title, item.content, null, effect.operationId)
      } else if (effect.action === 'plan_save') {
        const display = planDisplay.safeParse(envelope.toolResult.display)
        if (!display.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '计划交付缺少原始正文。')
        put('plan', display.data.artifactId, display.data.title, display.data.kind === 'planFile' ? display.data.content : display.data.after, null, effect.operationId)
      } else if (STRUCTURE_MUTATIONS.some(action => action === effect.action)) {
        const parsed = structureBodies.safeParse(receipt.result)
        if (!parsed.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '结构交付缺少原始正文映射。')
        for (const chapter of parsed.data.contentAfter) put('chapter', chapter.id, chapter.title, chapter.content, chapter.revision, effect.operationId)
        for (const chapter of parsed.data.contentBefore) {
          if (!parsed.data.contentAfter.some(item => item.id === chapter.id)) expected.set(`chapter:${chapter.id}`, {
            kind: 'chapter', id: chapter.id, title: chapter.title, hash: null, revision: null, operationId: effect.operationId, removed: true })
        }
      } else {
        const display = chapterDiff.safeParse(envelope.toolResult.display)
        if (display.success) {
          // Creation retries reuse their original receipt; never overwrite a
          // later write's expected body with the old creation observation.
          if (effect.action === 'chapter_create' && expected.has(`chapter:${display.data.chapterId}`)) continue
          put('chapter', display.data.chapterId, display.data.chapterTitle, display.data.after, display.data.revision, effect.operationId)
        } else if (effect.action === 'chapter_create') {
          const empty = z.object({ kind: z.literal('chapterRef'), chapterId: z.string(), title: z.string(), wordCount: z.literal(0) }).safeParse(envelope.toolResult.display)
          if (!empty.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '创建交付缺少原始正文或空章证据。')
          if (!expected.has(`chapter:${empty.data.chapterId}`)) put('chapter', empty.data.chapterId, empty.data.title, '', null, effect.operationId)
        } else if (!['quality_analyze', 'continuity_validate'].includes(effect.action)) return runtimeError('RUNTIME_RECEIPT_INVALID', '正文交付缺少原始写入内容。')
        // Successful check-only reports are not authored content.
      }
    }
  }
  const result = []
  const entries = [...expected.values()]
  for (let offset = 0; offset < entries.length; offset += 100) {
    const page = entries.slice(offset, offset + 100)
    const chapters = await tx.chapter.findMany({ where: { id: { in: page.filter(item => item.kind === 'chapter').map(item => item.id) }, novelId: root.novelId, authorId: root.userId }, select: { id: true, title: true, content: true, revision: true } })
    const plans = await tx.agentArtifact.findMany({ where: { id: { in: page.filter(item => item.kind === 'plan').map(item => item.id) }, artifactType: 'chapterPlan', run: { userId: root.userId, novelId: root.novelId } }, select: { id: true, title: true, content: true, metadata: true } })
    for (const item of page) {
      const current = item.kind === 'chapter' ? chapters.find(chapter => chapter.id === item.id) : plans.find(plan => plan.id === item.id
        && !(plan.metadata && typeof plan.metadata === 'object' && !Array.isArray(plan.metadata) && plan.metadata.savedAsPlan === false))
      const currentHash = current ? documentHash(current.title, current.content) : null
      result.push({ kind: item.kind, id: item.id, title: current?.title ?? item.title, sourceOperationId: item.operationId,
        expectedHash: item.hash, currentHash, expectedRevision: item.revision, currentRevision: current && 'revision' in current ? current.revision : null,
        characters: current?.content.length ?? 0,
        status: item.removed ? current ? 'changed' : 'removed' : !current ? 'missing' : currentHash === item.hash ? 'current' : 'changed' })
    }
  }
  return result
}
