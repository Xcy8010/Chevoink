import { useLayoutEffect, useRef, type RefObject } from 'react'

const modalStack: HTMLElement[] = []
let originalOverflow = ''

type DialogFocusTrapOptions = {
  panel: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
}

export function isTopDialog(panel: HTMLElement | null): boolean {
  return panel !== null && modalStack.at(-1) === panel
}

/** Keeps keyboard focus inside an open dialog and restores the trigger on close. */
export function useDialogFocusTrap({ panel, open, onClose }: DialogFocusTrapOptions) {
  const close = useRef(onClose)
  close.current = onClose

  useLayoutEffect(() => {
    if (!open || !panel.current) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const currentPanel = panel.current
    if (modalStack.length === 0) originalOverflow = document.body.style.overflow
    const underlying = modalStack.at(-1)
    underlying?.setAttribute('aria-hidden', 'true')
    modalStack.push(currentPanel)
    document.body.style.overflow = 'hidden'

    const focusable = () => Array.from(currentPanel.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
    )).filter((element) => {
      if (element.closest('[hidden]') || element.matches(':disabled')) return false
      for (let ancestor: HTMLElement | null = element; ancestor && ancestor !== currentPanel; ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLDetailsElement && !ancestor.open && !ancestor.querySelector(':scope > summary')?.contains(element)) return false
        if (getComputedStyle(ancestor).display === 'none' || getComputedStyle(ancestor).visibility === 'hidden') return false
      }
      return true
    })
    const focus = () => {
      const elements = focusable()
      ;(elements[0] ?? currentPanel).focus({ preventScroll: true })
    }
    focus()

    const keydown = (event: KeyboardEvent) => {
      if (!isTopDialog(currentPanel)) return
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
      if (event.key !== 'Tab') return
      const elements = focusable()
      const first = elements[0], last = elements.at(-1)
      if (!first) { event.preventDefault(); currentPanel.focus({ preventScroll: true }); return }
      if (event.shiftKey && (document.activeElement === first || !currentPanel.contains(document.activeElement))) {
        event.preventDefault(); last?.focus({ preventScroll: true })
      } else if (!event.shiftKey && (document.activeElement === last || !currentPanel.contains(document.activeElement))) {
        event.preventDefault(); first.focus({ preventScroll: true })
      }
    }
    const focusin = (event: FocusEvent) => {
      if (isTopDialog(currentPanel) && !currentPanel.contains(event.target as Node)) focus()
    }
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focusin)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('focusin', focusin)
      const index = modalStack.indexOf(currentPanel)
      if (index >= 0) modalStack.splice(index, 1)
      modalStack.at(-1)?.removeAttribute('aria-hidden')
      if (modalStack.length === 0) document.body.style.overflow = originalOverflow
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [open, panel])
}
