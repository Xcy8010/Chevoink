import { useRef, type ReactNode } from 'react'
import { SiteAnnouncements } from '@/features/site-content/public'

export default function StudioDesktopContent({ inactive = false, children }: { inactive?: boolean; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null)
  return <div ref={element => { if (element) element.inert = inactive }} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
    <SiteAnnouncements scope="studio" focusAfterDismiss={content} />
    <div ref={content} tabIndex={-1} role="region" aria-label="创作内容" className="relative flex min-h-0 min-w-0 flex-1 outline-none">
      {children}
    </div>
  </div>
}
