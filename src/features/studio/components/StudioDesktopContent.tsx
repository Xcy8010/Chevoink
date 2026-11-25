import type { ReactNode } from 'react'

export default function StudioDesktopContent({ inactive = false, children }: { inactive?: boolean; children: ReactNode }) {
  return <div ref={element => { if (element) element.inert = inactive }} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
    <div data-studio-content-focus tabIndex={-1} role="region" aria-label="创作内容" className="relative flex min-h-0 min-w-0 flex-1 outline-none">
      {children}
    </div>
  </div>
}
