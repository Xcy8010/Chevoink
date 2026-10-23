import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { runtimeError, runtimeJson, runtimeJsonHash, type RuntimeTx } from './runtime-common.js'
import { getStructureReportObservation } from '../data/volume.js'

const baselineSchema = z.object({
  version: z.literal(1), inputHash: z.string(), taskRootId: z.string(),
  chapters: z.array(z.object({ id: z.string(), revision: z.number().int(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
}).strict()
const envelopeSchema = z.object({ snapshot: baselineSchema, snapshotHash: z.string() }).strict()
const bodyHash = (body: string) => createHash('sha256').update(body).digest('hex')

/** Only called in the NEW root's creation transaction. Resume never re-baselines. */
export async function recordTaskContentBaseline(tx: RuntimeTx, root: { id: string; novelId: string; inputHash: string }, runId: string) {
  const chapters: z.infer<typeof baselineSchema>['chapters'] = []
  let cursor: string | undefined
  for (;;) {
    const page = await tx.chapter.findMany({ where: { novelId: root.novelId }, orderBy: { id: 'asc' }, take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, revision: true, content: true } })
    chapters.push(...page.map(chapter => ({ id: chapter.id, revision: chapter.revision, contentHash: bodyHash(chapter.content) })))
    if (page.length < 100) break
    cursor = page.at(-1)!.id
  }
  const snapshot = runtimeJson({ version: 1, taskRootId: root.id, inputHash: root.inputHash, chapters })
  await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: root.id, runId,
    eventKey: `baseline:${root.id}`, type: 'task.baseline.recorded', payload: { snapshot: snapshot.value, snapshotHash: snapshot.hash } } })
}

/** Deterministic checks only; passing these does not certify the user's whole goal. */
export async function evaluateTaskPostconditions(tx: RuntimeTx, root: { id: string; novelId: string; userId: string; inputHash: string; specSnapshot: unknown }) {
  const spec = taskSpecSchema.parse(root.specSnapshot)
  const results: { code: string; severity: string; status: 'passed' | 'failed' | 'unverified'; evidence: unknown }[] = []
  for (const condition of spec.postconditions) {
    if (condition.code === 'EARLIER_CONTENT_UNCHANGED') {
      const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `baseline:${root.id}` } })
      if (!event) {
        results.push({ ...condition, status: 'unverified', evidence: { reason: 'original_baseline_missing' } })
        continue
      }
      const parsed = envelopeSchema.safeParse(event.payload)
      if (!parsed.success || event.taskRootId !== root.id || event.type !== 'task.baseline.recorded'
        || parsed.data.snapshot.taskRootId !== root.id || parsed.data.snapshot.inputHash !== root.inputHash
        || runtimeJsonHash(parsed.data.snapshot) !== parsed.data.snapshotHash
        || new Set(parsed.data.snapshot.chapters.map(item => item.id)).size !== parsed.data.snapshot.chapters.length) {
        return runtimeError('RUNTIME_RECEIPT_INVALID', '原任务正文基线损坏，不能宣称保护约束已满足。')
      }
      const checked = []
      for (let offset = 0; offset < parsed.data.snapshot.chapters.length; offset += 100) {
        const page = parsed.data.snapshot.chapters.slice(offset, offset + 100)
        const current = await tx.chapter.findMany({ where: { novelId: root.novelId, id: { in: page.map(item => item.id) } }, select: { id: true, revision: true, content: true } })
        const byId = new Map(current.map(item => [item.id, item]))
        for (const original of page) {
          const chapter = byId.get(original.id)
          checked.push({ id: original.id, originalHash: original.contentHash, currentHash: chapter ? bodyHash(chapter.content) : null,
            currentRevision: chapter?.revision ?? null, unchanged: !!chapter && bodyHash(chapter.content) === original.contentHash })
        }
      }
      results.push({ ...condition, status: checked.every(item => item.unchanged) ? 'passed' : 'failed', evidence: { baselineHash: parsed.data.snapshotHash, checked } })
    } else if (condition.code === 'STRUCTURE_VALIDATED') {
      const observation = await getStructureReportObservation(root.userId, root.novelId, tx)
      results.push({ ...condition, status: observation.report.valid ? 'passed' : 'failed', evidence: observation })
    } else {
      results.push({ ...condition, status: 'unverified', evidence: { reason: 'domain_verifier_required' } })
    }
  }
  return results
}
