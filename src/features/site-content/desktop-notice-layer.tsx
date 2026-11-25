import { useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

// A modal in the browser top layer makes the app's own title bar inert.
// Keep Windows notices within the client area so the actual window buttons stay available.
export function useDesktopNoticeLayer() {
  const [desktop] = useState(() => typeof document !== 'undefined' && Boolean(document.documentElement.dataset.desktopFrame)
    && !document.querySelector('dialog:modal'))
  function layer(content: ReactElement, close: () => void) {
    if (!desktop) return content
    return createPortal(
      <div className="desktop-notice-layer" onClick={event => {
        if (event.target === event.currentTarget) close()
      }}>{content}</div>, document.fullscreenElement ?? document.body,
    )
  }
  return { desktop, layer }
}
