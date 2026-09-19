// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExportDialog from '../../src/features/studio/components/ExportDialog'

const mocks = vi.hoisted(() => ({ download: vi.fn(), link: vi.fn(), open: vi.fn(), native: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ success: mocks.success, error: mocks.error }) }))
vi.mock('../../src/lib/native-app', () => ({ isNativeApp: mocks.native }))
vi.mock('../../src/features/studio/lib/export-download', () => ({ downloadNovelExportZip: mocks.download, requestNovelExportLink: mocks.link, openExportDownloadInBrowser: mocks.open }))

afterEach(cleanup)
beforeEach(() => { vi.clearAllMocks(); mocks.native.mockReturnValue(false); mocks.download.mockResolvedValue(false); mocks.link.mockResolvedValue({ downloadUrl: '/download' }) })
const props = { open: true, novelId: 'n', novelTitle: '作品', chapters: [], onClose: vi.fn() }

describe('export memory selection', () => {
  it('defaults to including memories and forwards deselection to web download', async () => {
    render(<ExportDialog {...props} />)
    const memory = screen.getByRole('checkbox', { name: /创作记忆/ })
    expect(memory.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(memory)
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }))
    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith('n', expect.objectContaining({ includeMemories: false })))
  })
  it('allows memories alone without chapters and forwards selection to native download', async () => {
    mocks.native.mockReturnValue(true)
    render(<ExportDialog {...props} />)
    for (const checkbox of screen.getAllByRole('checkbox')) {
      if (!checkbox.textContent?.includes('创作记忆')) fireEvent.click(checkbox)
    }
    const button = screen.getByRole('button', { name: '开始导出' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(mocks.link).toHaveBeenCalledWith('n', { includeMemories: true, includePlans: false, includeCatalog: false, includeInfo: false, includeChapters: false, chapterIds: undefined }))
    expect(mocks.open).toHaveBeenCalledWith('/download')
  })
  it('disables empty selection and resets memories on reopening', () => {
    const view = render(<ExportDialog {...props} />)
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox)
    expect((screen.getByRole('button', { name: '开始导出' }) as HTMLButtonElement).disabled).toBe(true)
    view.rerender(<ExportDialog {...props} open={false} />)
    view.rerender(<ExportDialog {...props} />)
    expect(screen.getByRole('checkbox', { name: /创作记忆/ }).getAttribute('aria-checked')).toBe('true')
  })
})
