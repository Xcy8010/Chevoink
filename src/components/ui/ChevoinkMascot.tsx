import { cn } from '@/lib/utils'

import './mascot.css'

export type ChevoinkMascotPose = 'welcome' | 'privacy' | 'search' | 'connection' | 'reading' | 'message' | 'writing'

export default function ChevoinkMascot({ pose, className, animate = true }: {
  pose: ChevoinkMascotPose
  className?: string
  animate?: boolean
}) {
  return (
    <img
      src={`/chevoink-agent-${pose}.webp`}
      alt=""
      aria-hidden="true"
      width={128}
      height={128}
      draggable={false}
      className={cn('chevoink-mascot size-32 shrink-0', animate && 'chevoink-mascot--animated', className)}
    />
  )
}
