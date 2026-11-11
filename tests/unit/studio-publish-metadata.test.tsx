// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import PublishMetadataDialog from '@/features/studio/components/PublishMetadataDialog'
import { BOOTSTRAP_NOVEL_SUMMARY, getMissingNovelPublishFields } from '../../shared/contracts/novel-publish.js'
import { mockNativeDialog } from '../helpers/test-native-dialog'

afterEach(cleanup)

const complete = { coverAssetId: 'cover', summary: '作品简介', tags: ['科幻'] }

it.each([
  [{ coverAssetId: null }, ['cover']],
  [{ summary: '  ' }, ['summary']],
  [{ summary: BOOTSTRAP_NOVEL_SUMMARY }, ['summary']],
  [{ tags: [] }, ['tags']],
  [{ coverAssetId: null, summary: '', tags: ['  '] }, ['cover', 'summary', 'tags']],
  [{}, []],
])('checks actual metadata %#', (overrides, missing) => {
  expect(getMissingNovelPublishFields({ ...complete, ...overrides })).toEqual(missing)
})

it('lists only the missing fields and lets the author copy a prompt or open its settings', async () => {
  const openPanel = vi.fn()
  const writeText = vi.fn().mockResolvedValue(undefined)
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const restoreDialog = mockNativeDialog()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  try {
    render(<PublishMetadataDialog missing={['cover', 'tags']} onClose={vi.fn()} onOpenPanel={openPanel} />)
    expect(screen.getByRole('dialog', { name: '还不能发布这部作品' }).textContent).toContain('封面、标签')
    fireEvent.click(screen.getByRole('button', { name: '如何设置？' }))
    const help = within(screen.getByRole('dialog', { name: '如何设置作品信息' }))
    expect(help.getByText('作品设置 → 标签 → 保存作品设置')).toBeTruthy()
    expect(help.queryByRole('heading', { name: '简介' })).toBeNull()
    fireEvent.click(help.getByRole('button', { name: '复制封面提示词' }))
    await waitFor(() => expect(help.getByRole('status').textContent).toBe('已复制封面提示词'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('生成一张封面候选图'))
    fireEvent.click(help.getByRole('button', { name: '打开作品设置' }))
    expect(openPanel).toHaveBeenCalledWith('meta')
  } finally {
    cleanup()
    restoreDialog()
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})
