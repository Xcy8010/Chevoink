import { describe, expect, it } from 'vitest'
import type { TaskSpec } from '../../shared/contracts/index.js'
import { singleDeliverableTodoGuidance } from '../../api/lib/agent/tools/todo-tools.js'

const scope = (count: number): TaskSpec['scope'] => ({ novelId: 'novel',
  authorEffects: { version: 1, requestHash: 'a'.repeat(64), manuscript: true, structure: false, artifact: false }, writing: {
  version: 1, kind: 'bounded', targets: Array.from({ length: count }, (_, i) => ({ chapterId: `chapter-${i}`, orderIndex: i + 1 })),
  repairAuthorized: true, titleAndBodyOnly: false,
} })
describe('todo uses author deliverables rather than internal tool steps', () => {
  it('does not create a plan for one chapter or a local edit', () => {
    expect(singleDeliverableTodoGuidance([], scope(1))).toContain('无需创建待办')
    expect(singleDeliverableTodoGuidance([], scope(1))).toContain('不代表正文已经完成')
  })
  it('keeps existing plans updateable and permits multi-chapter work', () => {
    expect(singleDeliverableTodoGuidance([{ id: 'a', content: '修订', status: 'in_progress' }], scope(1))).toBeNull()
    expect(singleDeliverableTodoGuidance([], scope(2))).toBeNull()
    expect(singleDeliverableTodoGuidance([], undefined)).toBeNull()
    expect(singleDeliverableTodoGuidance([], { ...scope(1), authorEffects: undefined })).toBeNull()
    expect(singleDeliverableTodoGuidance([], { ...scope(1), authorEffects: { ...scope(1).authorEffects!, artifact: true } })).toBeNull()
  })
})
