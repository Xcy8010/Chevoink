import type { AgentUIMessage } from '../../../../../shared/contracts/index.js'
import { getAgentAuthorMessageText } from '../../../../../shared/agent-author-view.js'

/**
 * AgentPanel 的模块级纯声明（自 AgentPanel.tsx 抽取，逐字保留）：
 * 阶段文案映射、消息纯文本提取、会话时间格式化与助手输出判定。
 * 组件类声明（ProcessingHint）单独成文件，保持 react-refresh 快刷兼容。
 */

export const phaseLabel: Record<string, string> = {
  starting: '启动中',
  running: '运行中',
  awaiting_approval: '等待确认',
  awaiting_input: '等待回答',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '已失败',
  cancelled: '已取消',
}

/** 技能阶段文案：与技能区、输入框「+」菜单保持同一套中文名 */
export const skillPhaseLabel: Record<string, string> = {
  research: '调研',
  plan: '规划',
  scene: '场景',
  draft: '正文',
  critique: '审阅',
  revision: '修订',
  commit: '落库',
}

/** 提取消息纯文本（复制用） */
export function getMessageText(parts: AgentUIMessage['parts'], role: 'user' | 'assistant' = 'assistant'): string {
  if (role === 'assistant') return getAgentAuthorMessageText(parts)
  return parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

export function formatSessionTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** 运行中没有其他动态反馈时显示等待提示；生成参数不等于工具已执行。 */
export function shouldShowProcessingHint(
  messages: AgentUIMessage[],
  runId: string | null,
  phase: string,
  waitingForUser = false,
): boolean {
  if (!runId || waitingForUser || (phase !== 'starting' && phase !== 'running')) return false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant' && message.runId === runId) {
      // 真正执行中的工具已有进度动画，不叠加一行通用提示。
      if (message.parts.some(part => part.type === 'tool-call' && !part.subagentCallId && part.status === 'running')) return false
    }
  }
  // 未定稿的思考不代表画面仍在更新：供应商可能正静默生成工具参数。
  // 不依赖思考结束标记或后续 SSE 到达，持续提示直至工具动画接管。
  return true
}

/** 首次发送时空历史请求可能晚于本地 beginRun 返回；此时旧响应不得覆盖正在直播的消息。 */
export function shouldKeepLiveSessionMessages(
  runId: string | null,
  phase: string,
  activeSessionId: string | null,
  requestedSessionId: string,
): boolean {
  return Boolean(
    runId &&
      ['starting', 'running', 'awaiting_approval', 'awaiting_input'].includes(phase) &&
      activeSessionId === requestedSessionId,
  )
}
