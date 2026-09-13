export type ImportAgentAttachment = { url: string; runId: string; callId?: string }

export function readImportJobId(params: URLSearchParams): string | null {
  const jobId = params.get('importJobId')
  return jobId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId) ? jobId : null
}

/** Parse a hint only: never fetch URLs from navigation, and never infer submit authority. */
export function readImportHandoff(params: URLSearchParams): ImportAgentAttachment | null {
  const url = params.get('importAttachmentUrl')
  const runId = params.get('importRunId')
  const callId = params.get('importCallId')
  if (!url || !runId || runId.length > 64 || url.length > 1024) return null
  if (callId !== null && (!callId.trim() || callId.length > 255 || [...callId].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) return null
  // Accept only root-relative server attachment references, never network or local filesystem paths.
  const relative = url.slice('/api/uploads/agent-attachments/'.length)
  if (!url.startsWith('/api/uploads/agent-attachments/') || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(relative) || relative.split('/').some(part => part === '.' || part === '..')) return null
  return { url, runId, ...(callId ? { callId } : {}) }
}

export function clearImportHandoff(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete('importAttachmentUrl')
  next.delete('importRunId')
  next.delete('importCallId')
  next.delete('importJobId')
  return next
}
