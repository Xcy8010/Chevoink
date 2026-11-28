import { useCallback, useEffect, useMemo, useState } from 'react'
import { projectAgentAuthorParts } from '../../../../../shared/agent-author-view.js'
import type { AgentUIMessage } from '../../../../../shared/contracts/index.js'
import { activityReportVisibility, projectActivityGroups } from './activity-groups'

/** Group only the receipts the reader has reached. A later tool may already
 * have finished on the server while its preceding report is still painting. */
export function useActivityPresentation<T extends AgentUIMessage>(messages: T[], targets: Readonly<Record<string, string>> | undefined,
  activeRunId?: string | null, approvalId?: string) {
  const complete = useMemo(() => projectActivityGroups(messages), [messages])
  const [settled, setSettled] = useState<Record<string, string>>({})
  const onVisibleTextSettled = useCallback((id: string, text: string) => {
    setSettled(previous => previous[id] === text ? previous : { ...previous, [id]: text })
  }, [])
  useEffect(() => {
    setSettled(previous => Object.keys(previous).some(id => !targets || !(id in targets))
      ? Object.fromEntries(Object.entries(previous).filter(([id]) => targets && id in targets)) : previous)
  }, [targets])
  const shown = useMemo(() => {
    if (!targets || !Object.keys(targets).length) return messages
    const blocked = new Set<string>()
    return messages.flatMap(message => {
      if (message.role !== 'assistant') return [message]
      const run = message.runTiming?.sourceRunId ?? message.runId
      if (blocked.has(run)) return []
      if (!(message.id in targets)) return [message]
      const visibility = activityReportVisibility(complete.reportsByMessage.get(message.id), run === activeRunId, approvalId)
      let ordinal = 0
      let visible = ''
      for (const [index, part] of message.parts.entries()) {
        if (part.type !== 'text') continue
        const [projected] = projectAgentAuthorParts([part])
        if (projected?.type !== 'text' || visibility?.hidden.has(ordinal++)) continue
        visible += projected.text
        if (settled[message.id]?.startsWith(visible)) continue
        blocked.add(run)
        return index === message.parts.length - 1 ? [message] : [{ ...message, parts: message.parts.slice(0, index + 1) }]
      }
      return [message]
    })
  }, [messages, targets, complete, activeRunId, approvalId, settled])
  const groups = useMemo(() => shown.length === messages.length && shown.every((msg, i) => msg === messages[i])
    ? complete : projectActivityGroups(shown), [complete, shown, messages])
  return { messages: shown, groups, reports: complete.reportsByMessage, onVisibleTextSettled }
}
