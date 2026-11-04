import { describe, expect, it } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { writingPreparationGuidance } from '../../api/lib/agent/writing-tool-guidance.js'
import { observeSemanticReadProgress, observeWritingWorkflowMilestone } from '../../api/lib/agent/semantic-progress.js'

function fixture() {
  const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', prompt: '写下一章' })
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: null, orderIndex: 3 }],
    repairAuthorized: false, titleAndBodyOnly: false,
    tailVolume: { version: 1, previousChapterId: 'prior', previousRevision: 1, targetOrderIndex: 3 } }
  const seen = new Set<string>()
  return { spec, seen }
}
function read(seen: Set<string>, id = 'prior') {
  observeSemanticReadProgress(seen, 'chapter_read', 'synthetic', { targetId: id, contentHash: 'a'.repeat(64), start: 0, end: 100 })
}
describe('writing preparation convergence', () => {
  it('waits for an actual bound predecessor observation, not unrelated reading', () => {
    const { spec, seen } = fixture()
    expect(writingPreparationGuidance(spec, seen)).toBe('')
    read(seen, 'unrelated')
    expect(writingPreparationGuidance(spec, seen)).toBe('')
    read(seen)
    const before = JSON.stringify(spec), evidence = [...seen]
    const guidance = writingPreparationGuidance(spec, seen)
    expect(guidance).toContain('第3章')
    expect(guidance).toContain('正文片段')
    expect(guidance).toContain('story_compiler_prepare')
    expect(guidance).toContain('真正冲突仍核实')
    expect(guidance).toContain('质量检查')
    expect(JSON.stringify(spec)).toBe(before)
    expect([...seen]).toEqual(evidence)
  })
  it.each(['prepare', 'scenes'] as const)('retires after real same-task %s evidence, including checkpoint restoration', phase => {
    const { spec, seen } = fixture(); read(seen)
    observeWritingWorkflowMilestone(seen, phase === 'prepare' ? 'story_compiler_prepare' : 'scene_task_build',
      { version: 1, userId: 'user', novelId: 'novel', runId: 'run', targetOrderIndex: 3, phase },
      { userId: 'user', novelId: 'novel', runId: 'run', taskSpec: spec })
    expect(writingPreparationGuidance(spec, new Set([...seen]))).toBe('')
  })
  it('does not treat another task preparation or malformed historical key as current preparation', () => {
    const { spec, seen } = fixture(); read(seen)
    seen.add('workflow:broken'); seen.add(`workflow:${JSON.stringify(['user', 'novel', 'other', 3, 'prepare'])}`)
    expect(writingPreparationGuidance(spec, seen)).toContain('story_compiler_prepare')
  })
  it.each(['conversation_only', 'proposal_only'] as const)('does not push %s into writing', pacing => {
    const { spec, seen } = fixture(); read(seen); spec.writingPacing = pacing
    expect(writingPreparationGuidance(spec, seen)).toBe('')
  })
  it('does not change research or existing chapter revision workflows', () => {
    const { spec, seen } = fixture(); read(seen); spec.intent = 'research_analysis'
    expect(writingPreparationGuidance(spec, seen)).toBe('')
    spec.intent = 'write'; if (spec.scope.writing?.kind === 'bounded') spec.scope.writing.targets[0].chapterId = 'existing'
    expect(writingPreparationGuidance(spec, seen)).toBe('')
  })
})
