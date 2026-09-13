// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import StudioCommandBar from '../../src/features/studio/components/StudioCommandBar'
import StudioToolbar from '../../src/features/studio/components/StudioToolbar'
import { useImportCapabilities } from '../../src/features/studio/components/use-import-capabilities'
import { novelImportApi } from '../../src/features/studio/import-api'

vi.mock('../../src/features/feedback/components/FeedbackDialog', () => ({ default: () => null }))
vi.mock('../../src/features/studio/components/StudioMoreMenu', () => ({ default: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const commandProps: ComponentProps<typeof StudioCommandBar> = {
  perspective: 'work', perspectiveSwitchEnabled: false, onPerspectiveChange: vi.fn(), currentNovelId: 'a', novelTitle: '作品', novelOptions: [],
  onSelectNovel: vi.fn(), onCreateNovel: vi.fn(), onPublish: vi.fn(), onOpenCover: vi.fn(), onOpenMeta: vi.fn(), onExport: vi.fn(), onDeleteNovel: vi.fn(),
}

it.each(['work', 'ide'] as const)('places import immediately above export in the %s work menu only when enabled', perspective => {
  const onImport = vi.fn()
  const view = render(<MemoryRouter><StudioCommandBar {...commandProps} perspective={perspective} /></MemoryRouter>)
  fireEvent.click(screen.getByRole('button', { name: '作品' }))
  expect(screen.queryByRole('button', { name: '一键导入' })).toBeNull()
  view.rerender(<MemoryRouter><StudioCommandBar {...commandProps} perspective={perspective} onImport={onImport} /></MemoryRouter>)
  const upload = screen.getByRole('button', { name: '一键导入' })
  expect(upload.nextElementSibling).toBe(screen.getByRole('button', { name: '一键导出' }))
  fireEvent.click(upload)
  expect(onImport).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '作品' }))
})

it('toolbar import is optional, above export, and returns focus to a persistent trigger', () => {
  const onImport = vi.fn()
  const props: ComponentProps<typeof StudioToolbar> = { currentNovelId: 'a', novelTitle: '作品', novelOptions: [], chapterTitle: '章', chapterStatusLabel: '草稿', wordCountLabel: '0字', saveState: 'idle', saveMessage: '', onOpenMeta: vi.fn(), onOpenAssistant: vi.fn(), onOpenCover: vi.fn(), onEnterImmersive: vi.fn(), onSaveNovel: vi.fn(), onPublishNovel: vi.fn(), onDeleteNovel: vi.fn(), onExport: vi.fn(), onSelectNovel: vi.fn(), onCreateNovel: vi.fn(), perspective: 'ide', onPerspectiveChange: vi.fn() }
  const view = render(<MemoryRouter><StudioToolbar {...props} /></MemoryRouter>)
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
  expect(screen.queryByRole('button', { name: '一键导入' })).toBeNull()
  view.rerender(<MemoryRouter><StudioToolbar {...props} onImport={onImport} /></MemoryRouter>)
  const upload = screen.getByRole('button', { name: '一键导入' })
  expect(upload.nextElementSibling).toBe(screen.getByRole('button', { name: '一键导出' }))
  fireEvent.click(upload)
  expect(onImport).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '更多操作' }))
})

it('capability hook fails closed after refetch error and isolates novel/user query keys', async () => {
  const capability = vi.spyOn(novelImportApi, 'capabilities').mockResolvedValue({ enabled: true, overwriteEnabled: false, overwriteVerified: false, restoreEnabled: false, retainsEmptyVolumes: true, aiEnabled: false, sourceBytes: 1000, formats: [], limitations: [] })
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={query}>{children}</QueryClientProvider>
  const hook = renderHook(({ novelId, userId }) => useImportCapabilities(novelId, userId), { wrapper, initialProps: { novelId: 'a', userId: 'u' } })
  await waitFor(() => expect(hook.result.current.data?.enabled).toBe(true))
  capability.mockRejectedValue(new Error('offline'))
  await act(async () => { await hook.result.current.refetch() })
  await waitFor(() => expect(hook.result.current.data).toBeUndefined())
  hook.rerender({ novelId: 'b', userId: '' })
  expect(hook.result.current.data).toBeUndefined()
  expect(capability.mock.calls.every(([novel]) => novel === 'a')).toBe(true)
  hook.unmount(); query.clear()
})

it('keeps the read-only history entry independently available when a new import callback is absent', () => {
  const onImportHistory = vi.fn()
  render(<MemoryRouter><StudioCommandBar {...commandProps} onImportHistory={onImportHistory} /></MemoryRouter>)
  fireEvent.click(screen.getByRole('button', { name: '作品' }))
  expect(screen.queryByRole('button', { name: '一键导入' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '导入记录与恢复' }))
  expect(onImportHistory).toHaveBeenCalledTimes(1)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '作品' }))
})
