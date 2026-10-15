// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentEmptyWelcome from '@/features/studio/agent/components/AgentEmptyWelcome'
const { draft } = vi.hoisted(() => ({ draft: vi.fn() }))
vi.mock('@/features/studio/agent/agentStore', () => ({ useAgentStore: (select: (state: { setComposerDraft: typeof draft }) => unknown) => select({ setComposerDraft: draft }) }))
afterEach(() => { cleanup(); draft.mockClear() })
describe('mobile welcome suggestions', () => {
  it.each([false, true])('shows three full-text draft-only suggestions (initializing=%s)', initializing => {
    render(<AgentEmptyWelcome mobile novelName="测试作品" seed="mobile-polish" initializingNovel={initializing} />)
    const cards = screen.getAllByRole('button')
    expect(cards).toHaveLength(3)
    for (const card of cards) expect(card.textContent!.length).toBeGreaterThan(8)
    fireEvent.click(cards[0])
    expect(draft.mock.calls).toEqual([[cards[0].textContent]])
  })
  it('preserves four suggestions on desktop', () => {
    render(<AgentEmptyWelcome novelName="测试作品" seed="mobile-polish" />)
    expect(screen.getAllByRole('button')).toHaveLength(4)
  })
  it('retains the existing suggestion-disabled state', () => {
    render(<AgentEmptyWelcome mobile novelName="测试作品" seed="mobile-polish" showSuggestions={false} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText(/在下方输入任务/)).toBeTruthy()
  })
})
