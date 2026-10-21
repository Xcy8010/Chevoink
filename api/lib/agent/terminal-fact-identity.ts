import type { TerminalCandidate } from './terminal-state-review.js'
import { runtimeJson } from './runtime-common.js'

/** Stable identity includes the exact field and complete claim. It is an
 * address into an explicit candidate, never proof or an alias matcher. */
export const terminalFactId = (field: string, claim: string) => runtimeJson({ field, claim }).hash
export function terminalCandidateFacts(candidate: TerminalCandidate) {
  return Object.entries(candidate.exitState).flatMap(([field, value]) => Array.isArray(value)
    ? value.map((claim, index) => ({ id: terminalFactId(field, claim), field, claim, path: `exitState.${field}.${index}` }))
    : value?.trim() ? [{ id: terminalFactId(field, value), field, claim: value, path: `exitState.${field}` }] : [])
    .concat(candidate.lastUnfinishedAction.trim() ? [{ id: terminalFactId('lastUnfinishedAction', candidate.lastUnfinishedAction),
      field: 'lastUnfinishedAction', claim: candidate.lastUnfinishedAction, path: 'lastUnfinishedAction' }] : [])
}
