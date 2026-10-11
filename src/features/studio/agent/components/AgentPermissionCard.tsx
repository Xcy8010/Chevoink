import { useState } from 'react'
import { getAgentToolPresentation } from '../../../../../shared/agent-tool-presentation.js'
import { ShieldAlert, TriangleAlert } from 'lucide-react'

import Button from '@/components/ui/Button'
import type { PendingApproval } from '../agentStore'

/**
 * 审批卡（plan/13 §4.7）：写操作/高危操作暂停等待用户裁决。
 * - 高危操作（allowAlways=false）隐藏"总是允许"，并以警示色强调
 */

type AgentPermissionCardProps = {
  approval: PendingApproval
  onResolve: (approved: boolean, alwaysAllow: boolean) => Promise<void> | void
}

export function AgentPermissionCard({ approval, onResolve }: AgentPermissionCardProps) {
  const [submitting, setSubmitting] = useState(false)
  const dangerous = !approval.allowAlways

  const handleResolve = async (approved: boolean, alwaysAllow = false) => {
    if (submitting) {
      return
    }
    setSubmitting(true)
    try {
      await onResolve(approved, alwaysAllow)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className={
        dangerous
          ? 'rounded-[18px] border border-amber-300 bg-amber-50 px-4 py-3'
          : 'rounded-[18px] border border-[var(--border-strong)] bg-[var(--surface-default)] px-4 py-3'
      }
    >
      <div className="flex items-center gap-2">
        {dangerous ? (
          <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600" />
        ) : (
          <ShieldAlert className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
        )}
        <p className="text-xs font-medium tracking-[0.08em] text-[var(--text-secondary)]">
          {dangerous ? '高危操作需要确认' : '等待你的确认'}
        </p>
      </div>
      <p className="mt-2 text-sm leading-6 text-[var(--text-primary)]">
        Agent 请求执行：<span className="font-medium">{getAgentToolPresentation(approval.toolName).label}</span>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={submitting}
          onClick={() => void handleResolve(true)}
        >
          允许
        </Button>
        <Button size="sm" variant="secondary" disabled={submitting} onClick={() => void handleResolve(false)}>
          拒绝
        </Button>
        {approval.allowAlways ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={submitting}
            onClick={() => void handleResolve(true, true)}
          >
            本次会话总是允许
          </Button>
        ) : null}
      </div>
    </div>
  )
}
