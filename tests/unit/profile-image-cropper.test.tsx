// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import ImageCropperDialog from '../../src/components/ui/ImageCropperDialog.js'

it('can save an already decoded cover and waits for a replacement that is still loading', () => {
  const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
  const width = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(300)
  const height = vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(100)
  const common = { open: true, onCancel: vi.fn(), onConfirm: vi.fn() }
  const view = render(<ImageCropperDialog {...common} imageDataUrl="data:image/png;base64,first" />)

  try {
    expect(screen.getByRole('button', { name: '保存封面' })).toHaveProperty('disabled', false)

    complete.mockReturnValue(false)
    view.rerender(<ImageCropperDialog {...common} imageDataUrl="data:image/png;base64,second" />)
    expect(screen.getByRole('button', { name: '保存封面' })).toHaveProperty('disabled', true)

    fireEvent.load(screen.getByRole('img', { name: '封面裁剪预览' }))
    expect(screen.getByRole('button', { name: '保存封面' })).toHaveProperty('disabled', false)
  } finally {
    view.unmount()
    complete.mockRestore()
    width.mockRestore()
    height.mockRestore()
  }
})
