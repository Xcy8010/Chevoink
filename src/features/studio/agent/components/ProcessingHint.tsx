import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

/** 等待阶段的轻量动态反馈；支持多次入场，淡出不依赖 animationend 必达。 */
export function ProcessingHint({ visible }: { visible: boolean }) {
  const [retained, setRetained] = useState(visible)

  useEffect(() => {
    if (visible) {
      setRetained(true)
      return
    }
    // 后台标签页/减少动态效果可能不触发动画结束事件，定时兜底防止提示残留。
    const timer = setTimeout(() => setRetained(false), 250)
    return () => clearTimeout(timer)
  }, [visible])

  if (!visible && !retained) {
    return null
  }

  return (
    <p
      role="status"
      aria-hidden={!visible}
      className={cn('px-1 text-xs text-[var(--text-secondary)] motion-reduce:animate-none', visible ? 'animate-fade-in' : 'animate-agent-fade-out')}
      onAnimationEnd={(event) => {
        if (!visible && event.animationName === 'agent-fade-out') {
          setRetained(false)
        }
      }}
    >
      <span className={visible ? 'agent-processing-shimmer' : undefined}>正在处理...</span>
    </p>
  )
}
