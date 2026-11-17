// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentMemoryCards from '../../src/features/studio/agent/components/AgentMemoryCards'
import { fetchStoryMemories, fetchStoryMemorySets, updateStoryMemory } from '../../src/features/studio/agent/agentApi'
import type { StoryMemoryCard } from '../../shared/contracts'

const store = vi.hoisted(() => ({ addComposerReference: vi.fn(), composerDraft: '', memorySpotlight: null as null | { nonce: number; memoryType: string; title: string } }))
vi.mock('../../src/features/studio/agent/agentStore', () => ({ useAgentStore: (select: (s: unknown) => unknown) => select(store) }))
vi.mock('../../src/store/useShellStore', () => ({ useShellStore: (select: (s: unknown) => unknown) => select({ sessionUser: { id: 'u' } }) }))
vi.mock('../../src/features/studio/agent/agentApi', () => ({ fetchStoryMemories: vi.fn(), fetchStoryMemorySets: vi.fn(), deleteStoryMemory: vi.fn(), updateStoryMemory: vi.fn() }))
const firstCard: StoryMemoryCard = { id: 'card', title: '真正的卡片', content: '内容', memoryType: 'worldbuilding', layer: 'L1', importance: 50, status: 'inferred', reviewStatus: 'pending', version: 1, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' }
beforeEach(() => {
  vi.clearAllMocks(); store.memorySpotlight = null
  vi.mocked(fetchStoryMemorySets).mockResolvedValue({ sets: [{ memoryType: 'worldbuilding', count: 1, latestUpdatedAt: '2026-09-12T00:00:00Z', previews: ['真正的卡片'] }] })
  vi.mocked(fetchStoryMemories).mockResolvedValue({ total: 1, typeCounts: { worldbuilding: 1 }, items: [firstCard] })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })
it('only explicit view button flips the card; body clicks/scroll cannot flip it back', async () => {
  render(<AgentMemoryCards novelId="n" />)
  fireEvent.click(await screen.findByRole('button', { name: '世界观卡片集 1 张，点击摊开手牌' }))
  await screen.findByRole('button', { name: '查看全文' })
  const actions = screen.getByRole('group', { name: '卡片操作' })
  expect(actions.parentElement?.className).toContain('right-3 top-4')
  for (const label of ['编辑卡片', '删除卡片']) {
    const button = screen.getByRole('button', { name: label })
    expect(button.textContent).toBe('')
    expect(button.getAttribute('title')).toBe(label)
    expect(button.querySelector('svg')).toBeTruthy()
    expect(button.className).toContain('h-11 w-11')
  }
  fireEvent.click(await screen.findByRole('button', { name: '查看全文' }))
  const back = document.querySelector('.fan-back')!
  fireEvent.click(back.querySelector('p.whitespace-pre-wrap')!)
  fireEvent.scroll(back.querySelector('.overflow-y-auto')!)
  expect(document.querySelector('.fan-flipped')).toBeTruthy()
  expect(screen.getByRole('group', { name: '卡片操作' })).toBe(actions)
  expect(screen.getByRole('button', { name: '删除卡片' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '返回摘要' }))
  expect(document.querySelector('.fan-flipped')).toBeNull()
})
it('edits and restores the selected card while paging in both directions', async () => {
  // jsdom does not implement the native dialog top layer.
  const show = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
  const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open') } })
  const secondCard = { ...firstCard, id: 'second', title: '第二张卡片', content: '另一段正文', version: 2 }
  vi.mocked(fetchStoryMemories).mockResolvedValueOnce({ total: 2, typeCounts: { worldbuilding: 2 }, items: [firstCard, secondCard] })
  vi.mocked(updateStoryMemory).mockResolvedValueOnce({ memory: { ...secondCard, title: '修订第二张', version: 3 } })
  try {
    render(<AgentMemoryCards novelId="n" />)
    const cover = await screen.findByRole('button', { name: /世界观卡片集.+点击摊开手牌/ })
    fireEvent.click(cover)
    const previous = await screen.findByRole('button', { name: '上一张' })
    expect((previous as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '下一张' }))
    await screen.findByRole('heading', { name: '第二张卡片' })
    fireEvent.click(screen.getByRole('button', { name: '查看全文' }))
    fireEvent.click(screen.getByRole('button', { name: '编辑卡片' }))
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('第二张卡片')
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '修订第二张' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修订' }))
    await screen.findByRole('heading', { name: '修订第二张' })
    expect(updateStoryMemory).toHaveBeenCalledExactlyOnceWith('second', expect.objectContaining({ title: '修订第二张', expectedVersion: 2 }))
    expect(screen.getByRole('button', { name: '返回摘要' })).toBeTruthy()
    fireEvent.click(previous)
    expect(screen.getByRole('heading', { name: firstCard.title })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '返回摘要' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '收叠手牌' }))
    expect(document.activeElement).toBe(cover)
  } finally {
    cleanup()
    if (show) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', show); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
    if (close) Object.defineProperty(HTMLDialogElement.prototype, 'close', close); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
  }
})

it('keeps the loaded cards navigable when fetching the next page fails and can retry', async () => {
  const cards = [firstCard, { ...firstCard, id: 'two', title: '第二张' }, { ...firstCard, id: 'three', title: '第三张' }]
  vi.mocked(fetchStoryMemories)
    .mockResolvedValueOnce({ total: 4, typeCounts: { worldbuilding: 4 }, items: cards })
    .mockRejectedValueOnce(new Error('下一页读取失败'))
    .mockResolvedValueOnce({ total: 4, typeCounts: { worldbuilding: 4 }, items: [{ ...firstCard, id: 'four', title: '第四张' }] })
  render(<AgentMemoryCards novelId="n" />)
  fireEvent.click(await screen.findByRole('button', { name: /世界观卡片集.+点击摊开手牌/ }))
  const next = await screen.findByRole('button', { name: '下一张' })
  fireEvent.click(next)
  await screen.findByRole('alert')
  expect(screen.getByRole('heading', { name: '第二张' })).toBeTruthy()
  fireEvent.click(next)
  expect(screen.getByRole('heading', { name: '第三张' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(next)
  expect(screen.getByRole('heading', { name: '第四张' })).toBeTruthy()
})
it('missing spotlight does not silently navigate to the newest unrelated card', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(() => document.body)
  store.memorySpotlight = { nonce: Date.now(), memoryType: 'worldbuilding', title: '并不存在的目标卡' }
  vi.mocked(fetchStoryMemories).mockResolvedValue({ total: 0, items: [], typeCounts: {} })
  render(<AgentMemoryCards novelId="n" />)
  await screen.findByText(/未能唯一定位该记忆/)
  await waitFor(() => expect(screen.queryByRole('button', { name: '收叠手牌' })).toBeNull())
  expect(fetchStoryMemories).toHaveBeenCalledWith('n', expect.objectContaining({ title: '并不存在的目标卡' }))
})
