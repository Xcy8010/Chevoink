import type { LucideProps } from 'lucide-react'

export default function StudioPersonalizationIcon({ size = 24, strokeWidth = 1.6, ...props }: LucideProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="m11 7.5-2.5 5h3M12.5 16a5 5 0 0 0 4-3" />
  </svg>
}
