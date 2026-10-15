// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BookOpen } from 'lucide-react'
import StudioMobileMenu from '@/features/studio/components/StudioMobileMenu'
import type { Novel } from '../../shared/contracts/index.js'

afterEach(cleanup)
const book = (id: string, title: string) => ({ id, title, displayTitle: null, chapterCount: 7, wordCount: 18000 }) as Novel
const one = book('one', '第一本作品'), two = book('two', '第二本作品')

describe('mobile book folders and categorized existing actions', () => {
  it('expands a different book without switching data until explicit selection', () => {
    const select = vi.fn(), close = vi.fn()
    render(<StudioMobileMenu currentNovel={one} novels={[one, two]} loading={false} busy={false} view="assistant" actions={[]} accountCard={<span>账户</span>} onClose={close} onSelectNovel={select} onCreateNovel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '展开作品：第二本作品' }))
    expect(select).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '进入作品' }))
    expect(select.mock.calls).toEqual([['two']])
    expect(close).toHaveBeenCalledOnce()
  })
  it('keeps current-book toggles local and preserves the create action', () => {
    const select = vi.fn(), create = vi.fn()
    render(<StudioMobileMenu currentNovel={one} novels={[]} loading busy={false} view="assistant" actions={[]} accountCard={null} onClose={vi.fn()} onSelectNovel={select} onCreateNovel={create} />)
    fireEvent.click(screen.getByRole('button', { name: '收起作品：第一本作品' }))
    expect(select).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '展开作品：第一本作品' }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: '新建作品' }))
    expect(create).toHaveBeenCalledOnce()
  })
  it('expands categories and delegates an existing action exactly once, keeping disabled and future actions', () => {
    const action = vi.fn(), unavailable = vi.fn()
    render(<StudioMobileMenu currentNovel={one} novels={[one]} loading={false} busy={false} view="assistant" actions={[
      { key: 'meta', label: '作品设置', icon: BookOpen, action },
      { key: 'delete-novel', label: '删除作品', icon: BookOpen, action: unavailable, disabled: true, danger: true },
      { key: 'future-action', label: '扩展入口', icon: BookOpen, action: vi.fn() },
    ]} accountCard={<span>用量详情</span>} onClose={vi.fn()} onSelectNovel={vi.fn()} onCreateNovel={vi.fn()} />)
    fireEvent.click(screen.getByText('创作资料'))
    fireEvent.click(screen.getByRole('button', { name: '作品设置' }))
    expect(action).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByText('作品操作'))
    expect(screen.getByRole('button', { name: '删除作品' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '删除作品' }))
    expect(unavailable).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('其他操作'))
    expect(screen.getByRole('button', { name: '扩展入口' })).toBeTruthy()
  })
})
