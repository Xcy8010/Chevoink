import { describe, expect, it } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { taskSpecSchema } from '../../shared/contracts/task-spec-contracts.js'
import { coordinatedWritingInputSchema, coordinatedWritingManifest } from '../../api/lib/agent/coordinated-writing-input.js'

const original = (prompt = '完整改写本章，并完成连续性与质量检查。') => {
  const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt })
  spec.writingPacing = 'explicit_writing'
  spec.scope.writingCoordinationProtocol = 1
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'chapter', orderIndex: 1 }], titleAndBodyOnly: false, repairAuthorized: true }
  return { spec, prompt }
}
const completed = { draftComplete: true, actualOutcomes: { exitState: { location: '第一道门内侧' }, lastUnfinishedAction: '尚未执行归档' },
  chapterSummary: '只归纳已发生事件', hookDecision: '', delayedHookReason: '作者要求停在此处', openingStructure: '接续动作', endingStructure: '停在核实之前' }

describe('original writer decisions and service manifest', () => {
  it('keeps a saved draft distinct from a requested completion', () => {
    expect(coordinatedWritingManifest(original(), 'chapter_write', 'chapter', { draftComplete: false })).toMatchObject({ steps: [{ step: 'body' }] })
    expect(coordinatedWritingManifest(original(), 'chapter_write', 'chapter', completed)).toMatchObject({ steps: [
      { step: 'body' }, { step: 'continuity' }, { step: 'quality' }, { step: 'commit' },
    ] })
  })
  it('does not infer actual end facts from planned scene exit states', () => {
    const planned = { purpose: '计划归档', goal: '核实归档', obstacle: '尚无证据', choice: '先等', cost: '保持未知', turn: '尚未完成', exitState: { objects: ['已归档'] } }
    expect(coordinatedWritingInputSchema.safeParse({ ...completed, actualOutcomes: undefined, scenes: [planned] }).success).toBe(false)
    const payload = coordinatedWritingInputSchema.parse({ ...completed, scenes: [planned] })
    expect(payload.actualOutcomes?.exitState.location).toBe('第一道门内侧')
    expect(payload.actualOutcomes?.lastUnfinishedAction).toBe('尚未执行归档')
    expect(payload.actualOutcomes?.exitState.objects).toEqual([])
    expect(payload.scenes?.[0].exitState.objects).toEqual(['已归档'])
  })
  it.each(['actualOutcomes', 'chapterSummary', 'hookDecision', 'delayedHookReason', 'openingStructure', 'endingStructure'])('requires the writer’s explicit %s before finalization', field => {
    expect(coordinatedWritingInputSchema.safeParse(Object.fromEntries(Object.entries(completed).filter(([key]) => key !== field))).success).toBe(false)
  })
  it('retains explicit empty hook decisions and rejects internal proof or commit fields', () => {
    expect(coordinatedWritingInputSchema.parse(completed).hookDecision).toBe('')
    expect(coordinatedWritingInputSchema.safeParse({ ...completed, compilationId: 'invented' }).success).toBe(false)
    expect(coordinatedWritingInputSchema.safeParse({ ...completed, actualOutcomes: { ...completed.actualOutcomes, inheritedProofs: ['a'.repeat(64)] } }).success).toBe(false)
  })
  it('rejects another chapter even when the writer could actually read it', () => {
    expect(() => coordinatedWritingManifest(original(), 'chapter_write', 'different-chapter', completed)).toThrow()
  })
  it.each(['legacy', 'proposal', 'conversation', 'selection', 'read-only', 'unbounded'] as const)('cannot opt %s into internal writing effects', kind => {
    const value = original()
    if (kind === 'legacy') delete value.spec.scope.writingCoordinationProtocol
    if (kind === 'proposal') value.spec.writingPacing = 'proposal_only'
    if (kind === 'conversation') value.spec.writingPacing = 'conversation_only'
    if (kind === 'selection') value.spec.scope.selection = { chapterId: 'chapter', start: 0, end: 3 }
    if (kind === 'read-only') value.spec.scope.authorEffects = { version: 1, requestHash: 'a'.repeat(64), manuscript: false, structure: false }
    if (kind === 'unbounded') value.spec.scope.writing!.kind = 'unbounded'
    expect(() => coordinatedWritingManifest(value, 'chapter_write', 'chapter', completed)).toThrow()
    if (kind !== 'legacy') expect(taskSpecSchema.safeParse(value.spec).success).toBe(false)
  })
  it('uses the original task’s quality waiver and never a model-supplied review switch', () => {
    expect(coordinatedWritingManifest(original('完整改写本章，跳过质量检查。'), 'chapter_write', 'chapter', completed)).toMatchObject({ steps: [
      { step: 'body' }, { step: 'continuity' }, { step: 'commit' },
    ] })
    expect(coordinatedWritingInputSchema.safeParse({ ...completed, skipQuality: true }).success).toBe(false)
  })
})
