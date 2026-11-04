type MessageRecord = { id: string; role: string; run: { userId: string; startRequest: unknown; messages: Array<{ id: string }> } }
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** Read-only correlation from an already-owned, persisted admission. No request authority is inferred. */
export function historyClientRequest(record: MessageRecord, userId: string): { clientRequestId?: string } {
  if (record.role !== 'user' || record.run.userId !== userId) return {}
  const saved = object(record.run.startRequest)
  if (!saved) return {}
  const steering = object(saved.authorSteering)
  const source = steering?.sourceMessageId === record.id ? object(steering.admission)
    : record.run.messages[0]?.id === record.id ? saved : null
  return typeof source?.clientRequestId === 'string' ? { clientRequestId: source.clientRequestId } : {}
}
