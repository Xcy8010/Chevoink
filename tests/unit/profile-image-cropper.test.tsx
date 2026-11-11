// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ImageCropperDialog from '../../src/components/ui/ImageCropperDialog.js'

const dialogPrototype = HTMLDialogElement.prototype
const originalShow = Object.getOwnPropertyDescriptor(dialogPrototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(dialogPrototype, 'close')

beforeEach(() => {
  Object.defineProperty(dialogPrototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(dialogPrototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } })
})

afterEach(() => {
  if (originalShow) Object.defineProperty(dialogPrototype, 'showModal', originalShow)
  else Reflect.deleteProperty(dialogPrototype, 'showModal')
  if (originalClose) Object.defineProperty(dialogPrototype, 'close', originalClose)
  else Reflect.deleteProperty(dialogPrototype, 'close')
})

it('can save an already decoded cover and waits for a replacement that is still loading', () => {
  const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
  const width = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(300)
  const height = vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(100)
  const common = { open: true, onCancel: vi.fn(), onConfirm: vi.fn() }
  const view = render(<ImageCropperDialog {...common} imageDataUrl="data:image/png;base64,first" />)

  try {
    const dialog = screen.getByRole('dialog', { name: '调整封面' })
    expect(dialog.hasAttribute('open')).toBe(true)
    const save = within(dialog).getByRole('button', { name: '保存封面' })
    expect(save).toHaveProperty('disabled', false)

    complete.mockReturnValue(false)
    view.rerender(<ImageCropperDialog {...common} imageDataUrl="data:image/png;base64,second" />)
    expect(save).toHaveProperty('disabled', true)

    fireEvent.load(screen.getByRole('img', { name: '封面裁剪预览' }))
    expect(save).toHaveProperty('disabled', false)
  } finally {
    view.unmount()
    complete.mockRestore()
    width.mockRestore()
    height.mockRestore()
  }
})
