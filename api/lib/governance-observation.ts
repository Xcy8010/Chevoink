/** A completed paid response remains settled even if writing an observation fails. */
export async function recordRefusalLead(userId: string, source: string, observationId: string, runId?: string) {
  try {
    const { observeSafetySignal } = await import('./governance-safety.js')
    await observeSafetySignal(userId, source, observationId, runId)
  } catch {
    console.warn('[governance] safety observation unavailable', { source, observationId })
  }
}
