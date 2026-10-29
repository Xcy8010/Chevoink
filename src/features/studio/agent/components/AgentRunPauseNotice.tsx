import type { AgentRunPhase } from '../agentStore'

/** A receipt wait is visible after the brief resume request has completed. */
export function AgentRunPauseNotice({ phase, summary }: { phase: AgentRunPhase; summary: string }) {
  if (phase !== 'paused' || !summary.startsWith('检查正在等待原请求')) return null
  return <p role="status" className="mx-4 mb-2 rounded-[14px] border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">
    上次检查尚未完成，正文和进度已保留。
  </p>
}
