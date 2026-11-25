// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import ChapterSettingsPanel from '../../src/features/studio/components/ChapterSettingsPanel'
import ConfirmDialog from '../../src/features/studio/components/ConfirmDialog'
import type { ChapterDraftState } from '../../src/features/studio/types'

afterEach(cleanup)

const chapter: ChapterDraftState = {
  id: 'chapter-1', title: '第一章 雾起时', summary: '初稿', content: '', status: 'draft',
  visibility: 'public', orderIndex: 1, revision: 1, localOnly: false,
}

it('names the active chapter once and sends text edits to its draft owner', () => {
  const onChange = vi.fn()
  render(<ChapterSettingsPanel chapterDraft={chapter} onChange={onChange} onRequestStatusAction={vi.fn()}
    onRequestVisibilityAction={vi.fn()} onRequestDelete={vi.fn()} onClose={vi.fn()} />)
  expect(screen.getByRole('dialog', { name: '章节设置 · 第 1 章 · 雾起时' })).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: '章节摘要' }), { target: { value: '新的摘要' } })
  expect(onChange).toHaveBeenLastCalledWith({ ...chapter, summary: '新的摘要' })
})

it('opens the visibility confirmation before applying it and leaves settings open on Escape', async () => {
  const onClose = vi.fn(), onChange = vi.fn(), onStatus = vi.fn(), onDelete = vi.fn()
  function Example() {
    const [pending, setPending] = useState<ChapterDraftState['visibility'] | null>(null)
    return <>
      <ChapterSettingsPanel chapterDraft={chapter} onChange={onChange} onRequestStatusAction={onStatus}
        onRequestVisibilityAction={setPending} onRequestDelete={onDelete} onClose={onClose} />
      <ConfirmDialog open={pending !== null} title="确认更改可见范围" description="" onCancel={() => setPending(null)}
        onConfirm={() => { onChange(pending); setPending(null) }} />
    </>
  }
  render(<Example />)
  const visibility = screen.getByRole<HTMLSelectElement>('combobox', { name: '可见范围' })
  await userEvent.selectOptions(visibility, 'followers')
  expect(screen.getByRole('dialog', { name: '确认更改可见范围' })).toBeTruthy()
  expect(onChange).not.toHaveBeenCalled()
  await userEvent.keyboard('{Escape}')
  expect(visibility.value).toBe('public')
  expect(document.activeElement).toBe(visibility)
  expect(onClose).not.toHaveBeenCalled()
  await userEvent.selectOptions(visibility, 'private')
  await userEvent.click(screen.getByRole('button', { name: '确定' }))
  expect(onChange).toHaveBeenCalledWith('private')
  await userEvent.click(screen.getByRole('button', { name: '定时' }))
  expect(onStatus).toHaveBeenCalledWith('scheduled')
  await userEvent.click(screen.getByRole('button', { name: '删除章节' }))
  expect(onDelete).toHaveBeenCalledOnce()
})
