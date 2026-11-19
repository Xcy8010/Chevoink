import { getAgentToolPresentation } from '../../../shared/agent-tool-presentation.js'

/** Supply the opening when the provider starts with tools alone. Subsequent
 * ordinary tool rounds already have their own visible progress and receipts. */
export function toolActivityReport(name: string, title: string | undefined, hasPriorTool: boolean): string {
  const { label } = getAgentToolPresentation(name)
  if (label === '等待作者决定') return '这一步需要和你确认一个问题。'
  if (hasPriorTool) return ''
  const action = title ?? (label.endsWith('复查') ? `复查${label.slice(0, -2)}` : label)
  return `我先${action}。`
}
