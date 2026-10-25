import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { taskSpecSchema } from '../../shared/contracts/task-spec-contracts.js'
import { coordinatedWritingInputSchema, coordinatedWritingManifest, issueWritingCoordination, isDeferredWritingRequest } from '../../api/lib/agent/coordinated-writing-input.js'
import { frozenWritingScopeHash } from '../../api/lib/agent/writing-contract.js'

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
  it('issues only a fresh complete capability closure without widening a denied/internal action', () => {
    const value = original()
    delete value.spec.scope.writingCoordinationProtocol
    value.spec.scope.authorEffects = { version: 1, requestHash: 'a'.repeat(64), manuscript: true, structure: false }
    const names = new Set(['chapter_read', 'chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range',
      'story_compiler_prepare', 'scene_task_build', 'continuity_validate', 'quality_analyze', 'chapter_bridge_commit'])
    expect(issueWritingCoordination(value.spec, 'build', names, value.prompt).scope.writingCoordinationProtocol).toBe(1)
    expect(value.spec.scope.writingCoordinationProtocol).toBeUndefined()
    for (const action of names) {
      if (action === 'chapter_create') continue // this original target already exists
      expect(issueWritingCoordination(value.spec, 'build', new Set([...names].filter(name => name !== action)), value.prompt)).toBe(value.spec)
    }
    for (const mode of ['plan', 'review']) expect(issueWritingCoordination(value.spec, mode, names, value.prompt)).toBe(value.spec)
    expect(issueWritingCoordination({ ...value.spec, writingPacing: undefined }, 'build', names, value.prompt).scope.writingCoordinationProtocol).toBeUndefined()
    expect(issueWritingCoordination({ ...value.spec, scope: { ...value.spec.scope, selection: { chapterId: 'chapter', start: 0, end: 2 } } }, 'build', names, value.prompt).scope.writingCoordinationProtocol).toBeUndefined()
  })
  it('fills a legacy pacing-classifier omission only from the fresh integrity-checked bounded interpretation', () => {
    const prompt = '修改第一章正文。', value = original(prompt)
    delete value.spec.scope.writingCoordinationProtocol
    delete value.spec.writingPacing
    const hash = createHash('sha256').update(prompt).digest('hex')
    value.spec.scope.authorEffects = { version: 1, requestHash: hash, manuscript: true, structure: false }
    value.spec.scope.writingTargetProtocol = 2
    value.spec.scope.writingInterpretation = { version: 2, requestHash: hash, scopeHash: '', intent: 'revise', reasons: [],
      revisionDenied: false, creationDenied: false, operations: [{ start: 0, end: 2, kind: 'revise', polarity: 'affirmative' }], excludedChapterIds: [] }
    value.spec.scope.writingInterpretation.scopeHash = frozenWritingScopeHash(value.spec.scope)
    const names = new Set(['chapter_read', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'story_compiler_prepare',
      'scene_task_build', 'chapter_bridge_commit', 'continuity_validate', 'quality_analyze'])
    expect(issueWritingCoordination(value.spec, 'build', names, prompt)).toMatchObject({ writingPacing: 'explicit_writing', scope: { writingCoordinationProtocol: 1 } })
    expect(value.spec.writingPacing).toBeUndefined()
    expect(issueWritingCoordination(value.spec, 'build', names, '模型生成的新请求')).toBe(value.spec)
    const legacy = { ...value.spec, scope: { ...value.spec.scope, writingTargetProtocol: 1 as const } }
    expect(issueWritingCoordination(legacy, 'build', names, prompt)).toBe(legacy)
    expect(legacy.writingPacing).toBeUndefined()
    expect(() => issueWritingCoordination({ ...value.spec, scope: { ...value.spec.scope, writingInterpretation: { ...value.spec.scope.writingInterpretation!, scopeHash: '0'.repeat(64) } } }, 'build', names, prompt)).toThrow()
  })
  it.each(['等我确认后再修改第四章正文', '先给我修改方案，等我同意再写第四章', '修改第四章正文前，先给我方案。', 'Only after I approve, write chapter 4'])(
    'does not issue immediate writing coordination from a conditional author instruction: %s', prompt => {
      expect(isDeferredWritingRequest(prompt)).toBe(true)
      const value = original(prompt)
      delete value.spec.scope.writingCoordinationProtocol
      delete value.spec.writingPacing
      const hash = createHash('sha256').update(prompt).digest('hex')
      value.spec.scope.authorEffects = { version: 1, requestHash: hash, manuscript: true, structure: false }
      value.spec.scope.writingTargetProtocol = 2
      value.spec.scope.writingInterpretation = { version: 2, requestHash: hash, scopeHash: '', intent: 'revise', reasons: [], revisionDenied: false, creationDenied: false,
        operations: [{ start: 0, end: 2, kind: 'revise', polarity: 'affirmative' }], excludedChapterIds: [] }
      value.spec.scope.writingInterpretation.scopeHash = frozenWritingScopeHash(value.spec.scope)
      const names = new Set(['chapter_read', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'story_compiler_prepare',
        'scene_task_build', 'chapter_bridge_commit', 'continuity_validate', 'quality_analyze'])
      expect(issueWritingCoordination(value.spec, 'build', names, prompt)).toBe(value.spec)
    })
  it('does not promote conditional instructions quoted in source text into author control', () => {
    expect(isDeferredWritingRequest('修改第四章正文，保留原句“等我确认后再写”。')).toBe(false)
  })
  it('keeps a saved draft distinct from a requested completion', () => {
    expect(coordinatedWritingManifest(original(), 'chapter_write', 'chapter', { draftComplete: false })).toMatchObject({ steps: [{ step: 'body' }] })
    expect(coordinatedWritingManifest(original(), 'chapter_write', 'chapter', completed)).toMatchObject({ steps: [
      { step: 'body' }, { step: 'continuity' }, { step: 'quality' }, { step: 'commit' },
    ] })
  })
  it('issues the bounded revision chain only with the genuine fresh continuity marker', () => {
    const value = original(), old = structuredClone(value)
    value.spec.scope.writingCoordinationProtocol = 2
    expect(() => coordinatedWritingManifest(value, 'chapter_write', 'chapter', completed)).toThrow()
    value.spec.scope.continuityReportProtocol = 5
    expect(coordinatedWritingManifest(value, 'chapter_write', 'chapter', completed)).toMatchObject({ version: 2, steps: [
      { step: 'body' }, { step: 'continuity' }, { step: 'quality' }, { step: 'prose_revision' },
      { step: 'continuity_verify' }, { step: 'quality_verify' }, { step: 'commit' }] })
    expect(coordinatedWritingManifest(value, 'chapter_write', 'chapter', { draftComplete: false })).toMatchObject({ version: 2, steps: [{ step: 'body' }] })
    expect(coordinatedWritingManifest(old, 'chapter_write', 'chapter', completed)).toMatchObject({ version: 1, steps: [
      { step: 'body' }, { step: 'continuity' }, { step: 'quality' }, { step: 'commit' }] })
    const missingMarker = { ...value.spec, scope: { ...value.spec.scope, continuityReportProtocol: undefined } }
    expect(taskSpecSchema.safeParse(missingMarker).success).toBe(false)
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
