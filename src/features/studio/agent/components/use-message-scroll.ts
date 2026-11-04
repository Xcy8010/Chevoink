import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { AgentUIMessage } from '../../../../../shared/contracts/index.js'
import { useKeyboardPushScroll } from '@/hooks/useKeyboardPushScroll'

/** Owns only viewport following/navigation; history and request ownership stay outside. */
export function useMessageScroll({
  messages, pendingApproval, pendingQuestion, conversationLoading, collapsed, scopeKey,
}: {
  scopeKey?: string
  messages: readonly AgentUIMessage[]
  pendingApproval: unknown
  pendingQuestion: unknown
  conversationLoading: boolean
  collapsed: boolean
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // 自动跟随开关：用户上滑离开底部后暂停自动滚底（避免运行中回看历史被强制弹回），滚回底部附近自动恢复
  const pinnedToBottomRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const scopeOwner = useRef({ key: scopeKey })
  if (scopeOwner.current.key !== scopeKey) scopeOwner.current = { key: scopeKey }
  useLayoutEffect(() => { pinnedToBottomRef.current = true; lastScrollTopRef.current = 0 }, [scopeKey])

  // 消息更新自动滚动到底部（仅当用户本就贴底时）。
  // 消息流用 content-visibility 虚拟化，scrollHeight 起初只是估算值：面板新挂载（如进入沉浸层）时
  // 单次滚底只能跳到「估算底部」，随后底部消息真实布局、高度膨胀，位置会停在半山腰；
  // 改为逐帧追底直到连续多帧稳定贴底才收敛
  useEffect(() => {
    if (conversationLoading || collapsed) {
      return
    }
    const node = scrollRef.current
    if (!node) {
      return
    }
    if (!pinnedToBottomRef.current) {
      return
    }
    const owner = scopeOwner.current
    let attempts = 0
    let stableTicks = 0
    let frame = requestAnimationFrame(function step() {
      // 用户中途上滑脱离贴底：立刻停止追底，不和手势抢滚动
      if (scopeOwner.current !== owner || scrollRef.current !== node || !pinnedToBottomRef.current) {
        return
      }
      if (node.scrollHeight - node.scrollTop - node.clientHeight > 1) {
        node.scrollTop = node.scrollHeight
        lastScrollTopRef.current = node.scrollTop
        stableTicks = 0
      } else {
        stableTicks += 1
      }
      attempts += 1
      // 连续 3 帧稳定贴底视为布局收敛；上限 30 帧防止极端情况下空转
      if (attempts < 30 && stableTicks < 3) {
        frame = requestAnimationFrame(step)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [messages, pendingApproval, pendingQuestion, conversationLoading, collapsed, scopeKey])

  // 跟踪用户是否贴底。只要出现一次「向上滚动」就立刻脱离贴底：
  // 流式输出时每个增量都会触发自动滚底，若只用「距底 80px」判定，用户手指刚上滑十几像素
  // 就会被下一个增量拽回底部、并把贴底标记重新置回 true，表现为整个对话根本滑不动。
  const handleMessagesScroll = useCallback(() => {
    const node = scrollRef.current
    if (!node || node.clientHeight === 0) {
      return
    }
    const previousTop = lastScrollTopRef.current
    lastScrollTopRef.current = node.scrollTop
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    // scrollTop 变小但人仍在底部 → 是内容高度变化（content-visibility 估算修正/清空重建）
    // 引发的浏览器钳制，不是用户上滑，不能据此关闭贴底跟随
    if (node.scrollTop < previousTop - 2 && distanceToBottom > 1) {
      pinnedToBottomRef.current = false
      return
    }
    // 只在回到底部附近时恢复贴底；不在中途向下滚时置 false——自动滚底后底部内容真实布局撑高会让
    // 距底距离瞬间超阈值，若据此关贴底会把追底收敛循环自己打断
    if (distanceToBottom < 80) {
      pinnedToBottomRef.current = true
    }
  }, [])

  // 聊天轨道的导航必须滚动本面板的消息容器，而不是交给浏览器猜测最近的滚动祖先。
  // 同时关闭贴底跟随，避免运行中的自动滚动把用户刚选择的历史轮次又拉回最新消息。
  // 页面同时存在多个 AgentPanel 实例（如 IDE 侧栏常驻隐藏），消息 id 会跨实例撞车：
  // getElementById 可能命中隐藏实例的元素，导致可见实例 contains 检查失败、导航静默失效。
  // 因此必须在自己实例的容器内定位目标，且零高度容器（不可见实例）直接忽略。
  useEffect(() => {
    const handleConversationNavigate = (event: Event) => {
      const messageId = (event as CustomEvent<{ messageId?: string }>).detail?.messageId
      if (!messageId) return
      const container = scrollRef.current
      if (!container || container.clientHeight === 0) return
      const target = container.querySelector<HTMLElement>(`[id="agent-message-${messageId}"]`)
      if (!target) return
      pinnedToBottomRef.current = false
      const containerRect = container.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const top = container.scrollTop + targetRect.top - containerRect.top - (container.clientHeight - targetRect.height) / 2
      container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      // 导航落点高亮：让“点击轨道 → 定位到这一轮”有可见反馈
      target.classList.remove('agent-msg-flash')
      // 强制重启动画：连续点击同一轨道也能再次闪烁
      void target.offsetWidth
      target.classList.add('agent-msg-flash')
      window.setTimeout(() => target.classList.remove('agent-msg-flash'), 1500)
    }
    window.addEventListener('chevoink:agent-conversation-navigate', handleConversationNavigate)
    return () => window.removeEventListener('chevoink:agent-conversation-navigate', handleConversationNavigate)
  }, [])

  // 键盘弹起 / 底部导航隐藏使消息容器变矮时，像微信/QQ 一样把对话顶上去
  useKeyboardPushScroll(scrollRef)

  return { scrollRef, pinnedToBottomRef, lastScrollTopRef, handleMessagesScroll }
}
