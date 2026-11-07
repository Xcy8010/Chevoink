import { Headphones } from 'lucide-react'

export default function SiteSupportLink({ href, className, onClick }: {
  href: string | null
  className: string
  onClick?: () => void
}) {
  if (!href) return null

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className} onClick={onClick}>
      <Headphones aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
      联系客服
    </a>
  )
}
