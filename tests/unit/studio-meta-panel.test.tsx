// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import MetaPanel from '@/features/studio/components/MetaPanel'
import type { NovelFormState } from '@/features/studio/types'

afterEach(cleanup)

const form: NovelFormState = {
  title: '合成作品',
  summary: '作品简介。',
  displayTitle: '',
  tagsText: '都市、现实、正剧、慢热、家长里短',
  visibility: 'private',
  status: 'draft',
}

const actions = {
  onSave: vi.fn(),
  onClose: vi.fn(),
  onChange: vi.fn(),
  onRequestVisibilityAction: vi.fn(),
  onRequestStatusAction: vi.fn(),
}

it('shows the applied cover and hands a replacement file to the existing crop flow', () => {
  const onCoverFile = vi.fn()
  const onOpenCover = vi.fn()
  const { container, rerender } = render(
    <MetaPanel {...actions} novelForm={form} coverUrl="/synthetic-cover.jpg" message="" saving={false} onCoverFile={onCoverFile} onOpenCover={onOpenCover} />,
  )
  expect(screen.getByRole('img', { name: '当前作品封面' }).getAttribute('src')).toBe('/synthetic-cover.jpg')
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!
  const openFile = vi.spyOn(fileInput, 'click')
  fireEvent.click(screen.getByRole('button', { name: '更换封面' }))
  expect(openFile).toHaveBeenCalledOnce()
  const file = new File(['synthetic'], 'replacement.webp', { type: 'image/webp' })
  fireEvent.change(fileInput, { target: { files: [file] } })
  expect(onCoverFile).toHaveBeenCalledWith(file)
  fireEvent.click(screen.getByRole('button', { name: '封面工坊' }))
  expect(onOpenCover).toHaveBeenCalledOnce()

  rerender(<MetaPanel {...actions} mobile novelForm={form} message="" saving={false} onCoverFile={onCoverFile} />)
  expect(screen.queryByRole('heading', { name: '作品设置' })).toBeNull()
  expect(screen.queryByRole('img', { name: '当前作品封面' })).toBeNull()
  expect(screen.getByRole('button', { name: '上传封面' })).toBeTruthy()
})

it('keeps the tag library collapsed until requested and enforces the six-tag limit', () => {
  function Settings() {
    const [current, setCurrent] = useState(form)
    return <MetaPanel {...actions} novelForm={current} message="" saving={false} onChange={setCurrent} />
  }

  render(<Settings />)
  expect(screen.queryByRole('textbox', { name: '搜索标签' })).toBeNull()
  expect(screen.getByRole('button', { name: '移除标签 都市' }).closest('[title]')?.getAttribute('title')).toBe('主分类')
  fireEvent.click(screen.getByRole('button', { name: '添加标签' }))
  const search = screen.getByRole('textbox', { name: '搜索标签' })
  fireEvent.change(search, { target: { value: '科幻' } })
  fireEvent.click(screen.getByRole('button', { name: '科幻' }))
  fireEvent.change(search, { target: { value: '玄幻' } })
  expect((screen.getByRole('button', { name: '玄幻' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '移除标签 都市' }))
  expect((screen.getByRole('button', { name: '玄幻' }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.getByRole('button', { name: '移除标签 现实' }).closest('[title]')?.getAttribute('title')).toBe('主分类')
})

it('sends publishing choices to confirmation and keeps manual save available', () => {
  render(<MetaPanel {...actions} novelForm={form} message="已保存" saving={false} />)
  fireEvent.change(screen.getByRole('combobox', { name: '可见范围' }), { target: { value: 'followers' } })
  fireEvent.change(screen.getByRole('combobox', { name: '发布状态' }), { target: { value: 'published' } })
  expect(actions.onRequestVisibilityAction).toHaveBeenCalledWith('followers')
  expect(actions.onRequestStatusAction).toHaveBeenCalledWith('published')
  expect(actions.onChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '保存作品设置' }))
  expect(actions.onSave).toHaveBeenCalledOnce()
  expect(screen.getByRole('status').textContent).toBe('已保存')
})
