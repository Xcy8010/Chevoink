import { createHash } from 'node:crypto'

/** Hash complete canonical JSON; different endings and nested/array tails must never be conflated. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]))
  }
  return value
}

export function toolSignature(toolName: string, args: string | null | undefined): string {
  let canonical = args ?? ''
  try { canonical = JSON.stringify(normalize(JSON.parse(canonical))) } catch { /* Hash the entire malformed input too. */ }
  return `${toolName}:${createHash('sha256').update(canonical).digest('hex')}`
}

/** Admission precedes tool.call. Failures are not cached; changed state permits fresh reads/validation. */
export class ToolAdmissionGuard {
  private completed = new Map<string, string>()
  private stateVersion = 0

  key(signature: string, stateSensitive: boolean): string {
    return stateSensitive ? `${signature}@${this.stateVersion}` : signature
  }
  previous(key: string): string | undefined { return this.completed.get(key) }
  /** Reports/candidates can change even when a check fails. Cache freshness is
   * independent of manuscript progress, convergence and paid retry authority. */
  invalidateStateReads(): void { this.stateVersion += 1 }
  record(key: string, observation: string, changed: boolean): void {
    this.completed.set(key, observation.slice(0, 12000))
    if (changed) this.invalidateStateReads()
    if (this.completed.size > 512) this.completed.delete(this.completed.keys().next().value!)
  }
}
