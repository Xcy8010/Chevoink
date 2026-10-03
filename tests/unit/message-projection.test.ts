import { describe, expect, it } from 'vitest'
import type { AgentUIMessage } from '../../shared/contracts/index.js'
import { projectMessages, shouldRenderAuthorMessage } from '../../src/features/studio/agent/lib/message-projection.js'

const message = (id: string, role: AgentUIMessage['role'], parts: AgentUIMessage['parts'] = []): AgentUIMessage => ({
  id, role, parts, runId: 'run', createdAt: '2026-09-08T00:00:00Z',
})

describe('message presentation projection', () => {
  it('handles empty conversations without inventing a last assistant', () => {
    expect(projectMessages([])).toEqual({ blockInfoById: new Map(), recentConversationText: '', lastAssistantId: undefined })
  })

  it('preserves consecutive assistant blocks and excludes text from operation counts', () => {
    const messages = [
      message('u1', 'user'),
      message('a1', 'assistant', [{ type: 'reasoning', text: 'thinking' }]),
      message('a2', 'assistant', [{ type: 'text', text: 'answer' }]),
      message('u2', 'user'),
      message('a3', 'assistant'),
    ]
    const before = structuredClone(messages)
    const result = projectMessages(messages)
    expect([...result.blockInfoById]).toEqual([
      ['a1', { firstId: 'a1', lastId: 'a2', ops: 1 }],
      ['a2', { firstId: 'a1', lastId: 'a2', ops: 1 }],
      ['a3', { firstId: 'a3', lastId: 'a3', ops: 0 }],
    ])
    expect(result.lastAssistantId).toBe('a3')
    expect(messages).toEqual(before)
  })

  it('uses the latest nonempty visible text, not reasoning, with bounded preview', () => {
    const result = projectMessages([
      message('a', 'assistant', [{ type: 'text', text: 'old' }]),
      message('u', 'user', [{ type: 'text', text: `  new\n ${'字'.repeat(1100)}` }]),
      message('r', 'assistant', [{ type: 'reasoning', text: 'private' }]),
    ])
    expect(result.recentConversationText).toBe(`new ${'字'.repeat(996)}`)
    expect(result.lastAssistantId).toBe('r')
  })

  it('groups resumed runs of the same goal while keeping internal continuation records outside author presentation', () => {
    const messages = [
      { ...message('u1', 'user'), goalId: 'goal' },
      { ...message('a1', 'assistant', [{ type: 'reasoning', text: 'before pause' }]), goalId: 'goal', runId: 'r1' },
      { ...message('resume', 'user', [{ type: 'text', text: 'system resume' }]), goalId: 'goal', goalContinuation: true, runId: 'r2' },
      { ...message('a2', 'assistant', [{ type: 'text', text: 'final' }]), goalId: 'goal', runId: 'r2' },
    ]
    const result = projectMessages(messages)
    const block = { firstId: 'a1', lastId: 'a2', ops: 1, goalId: 'goal' }
    expect([...result.blockInfoById]).toEqual([['a1', block], ['resume', block], ['a2', block]])
    expect(result.recentConversationText).toBe('final')
    expect(projectMessages(messages.slice(0, 3)).recentConversationText).not.toBe('system resume')
    expect(messages.filter(shouldRenderAuthorMessage).map(item => item.id)).toEqual(['u1'])
  })

  it('preserves real author and steering messages while suppressing tagged internal context without mutating history', () => {
    const messages = [
      { ...message('original', 'user'), goalId: 'goal', goalContinuation: false },
      { ...message('internal', 'user'), goalId: 'goal', goalContinuation: true },
      { ...message('legacy-internal', 'user'), goalContinuation: true },
      { ...message('steering', 'user'), goalId: 'goal', goalContinuation: false },
      message('ordinary', 'user'),
      { ...message('progress', 'assistant'), goalId: 'goal' },
    ]
    const before = structuredClone(messages)
    expect(messages.filter(shouldRenderAuthorMessage).map(item => item.id)).toEqual(['original', 'steering', 'ordinary'])
    expect(messages).toEqual(before)
  })

  it('preserves natural author boundaries and separates goals from ordinary assistant work', () => {
    const result = projectMessages([
      { ...message('a1', 'assistant'), goalId: 'g1' },
      { ...message('natural', 'user'), goalId: 'g1', goalContinuation: false },
      { ...message('a2', 'assistant'), goalId: 'g1' },
      { ...message('a3', 'assistant'), goalId: 'g2' },
      message('ordinary', 'assistant'),
    ])
    expect(result.blockInfoById.has('natural')).toBe(false)
    expect([...result.blockInfoById.values()].map(block => block.firstId)).toEqual(['a1', 'a2', 'a3', 'ordinary'])
  })
})
