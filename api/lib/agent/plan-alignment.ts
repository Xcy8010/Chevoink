import { z } from 'zod'
import { parseContinuityReportEnvelope } from './continuity-format-recovery.js'
import { locateQualityFindingSpans, type QualityEvidenceSources } from './quality-evidence.js'
import { writingPlanContextHash, type WritingPlanContext } from './writing-plan-context.js'

export const planAlignmentSchema = z.object({ version: z.literal(1), planContextHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['reviewed', 'unknown']), findings: z.array(z.object({
    stage: z.enum(['outline_to_detail', 'detail_to_chapter']),
    kind: z.enum(['contradiction', 'omission']), severity: z.enum(['warning', 'error']), explanation: z.string().min(1).max(2000),
    planEvidence: z.array(z.object({ planId: z.string().min(1), planHash: z.string().min(1), quote: z.string().min(1).max(2000) }).strict()).min(1),
    chapterEvidence: z.array(z.object({ sourceId: z.string().min(1) }).strict()),
  }).strict()),
}).strict()
export type PlanAlignment = z.infer<typeof planAlignmentSchema>
export function readPlanAlignment(raw: string, context: WritingPlanContext,
  sources: Array<{ source: 'current' | 'previous'; content: string; table: QualityEvidenceSources }>): PlanAlignment {
  const unknown: PlanAlignment = { version: 1, planContextHash: writingPlanContextHash(context), status: 'unknown', findings: [] }
  let parsed: ReturnType<typeof planAlignmentSchema.safeParse>
  try { parsed = planAlignmentSchema.safeParse(parseContinuityReportEnvelope(raw).record?.planAlignment) } catch { return unknown }
  if (!parsed.success || parsed.data.planContextHash !== unknown.planContextHash) return unknown
  const alignment = parsed.data
  const plans = [context.outline, context.detail]
  const valid = alignment.findings.every(finding => {
    const referencesValid = finding.planEvidence.every(reference => {
      const plan = plans.find(item => item.id === reference.planId && item.planHash === reference.planHash)
      return !!plan && plan.content.includes(reference.quote)
    })
    const hasOutline = finding.planEvidence.some(reference => reference.planId === context.outline.id)
    const hasDetail = finding.planEvidence.some(reference => reference.planId === context.detail.id)
    const chapterReferencesValid = finding.chapterEvidence.every(reference => sources.some(source => source.source === 'current'
      && locateQualityFindingSpans(source.content, { sourceId: reference.sourceId }, source.table).length === 1))
    const stageEvidenceValid = finding.stage === 'outline_to_detail'
      ? hasOutline && (finding.kind === 'omission' || hasDetail)
      : hasDetail && (finding.kind === 'omission' || finding.chapterEvidence.length > 0)
    return referencesValid && chapterReferencesValid && stageEvidenceValid
  })
  // Preserve all original opinions for inspection even if one reference is bad.
  return valid ? alignment : { ...alignment, status: 'unknown' }
}
export function renderPlanAlignmentInstructions(context: WritingPlanContext) {
  return `同一份回复同时完成 planAlignment：核查父大纲→本章细纲、细纲→本章正文的矛盾和遗漏。只检查明确属于本章或当前阶段的义务，远期事件未出现不是漏写；无法确定落实章节时status=unknown，不猜测。计划是创作意图，不是前文事实，不在连续性findings中冒充previous。stage=outline_to_detail时，遗漏需大纲证据、矛盾需大纲与细纲各自证据，均可不引用正文；stage=detail_to_chapter时，遗漏需细纲证据、矛盾需计划证据与本章真实sourceId；planEvidence逐字引用冻结计划并保留ID/hash。无问题且确已核查才reviewed。planContextHash=${writingPlanContextHash(context)}。planAlignment结构：${JSON.stringify(z.toJSONSchema(planAlignmentSchema, { io: 'input' }))}`
}
