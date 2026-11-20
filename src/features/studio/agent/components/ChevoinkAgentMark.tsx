import { agentMarkUrl } from '@/lib/brand-assets'
import { cn } from '@/lib/utils'

/** Chevoink Agent 2.0 标识：墨滴、笔尖与机器人面屏融为一体。 */
export default function ChevoinkAgentMark({ className }: { className?: string }) {
  return (
    <img
      src={agentMarkUrl}
      alt=""
      aria-hidden="true"
      className={cn('h-5 w-5 object-contain drop-shadow-[0_0_1px_rgba(255,255,255,0.72)]', className)}
    />
  )
}
