import { z } from 'zod'

export const adminModelDiagnosticRequestSchema = z.object({
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  mode: z.enum(['configuration', 'gateway', 'capability', 'connection']),
  expectedRevision: z.string().min(1).max(96),
  costConfirmed: z.boolean().optional(),
}).strict()
export type AdminModelDiagnosticRequest = z.infer<typeof adminModelDiagnosticRequestSchema>
export type AdminDiagnosticStage = 'configuration' | 'policy' | 'dns' | 'tls' | 'http' | 'authentication' | 'protocol' | 'generation' | 'cancelled' | 'timeout'
export type AdminDiagnosticStatus = 'running' | 'configuration_passed' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'unknown'
export type AdminDiagnosticCheck = { field: 'modelName' | 'baseUrl' | 'apiKey' | 'protocol' | 'capabilities' | 'lifecycle'; passed: boolean; message: string }
export type AdminModelDiagnosticResult = {
  id: string
  requestKey: string
  modelConfigId: string
  configRevision: string
  modelName: string
  provider: string
  modelKind: 'text' | 'vision' | 'image_generation' | 'web_search' | 'web_fetch'
  mode: AdminModelDiagnosticRequest['mode']
  status: AdminDiagnosticStatus
  stale: boolean
  createdAt: string
  finishedAt: string | null
  failure: { stage: AdminDiagnosticStage; code: string; message: string } | null
  upstreamHttpStatus?: number
  checks: AdminDiagnosticCheck[]
  metrics: {
    responseHeadersMs: number | null
    firstEventMs: number | null
    firstThinkingMs: number | null
    firstTextMs: number | null
    totalMs: number | null
    outputTokens: number | null
    tokensPerSecond: number | null
  }
  fee: { identity: string; owner: 'platform'; status: 'not_requested' | 'known' | 'unknown'; currency: 'CNY'; amountMicros: number | null; maximumMicros: number | null }
  livePolicy: { enabled: boolean; maximumCostMicros: number | null; blockedReason: string | null }
}

/** Transport is supplied by the authenticated admin API, never by an upstream URL. */
export type AdminModelDiagnosticsClient = {
  start: (modelConfigId: string, input: AdminModelDiagnosticRequest) => Promise<AdminModelDiagnosticResult>
  get: (modelConfigId: string, requestKey: string) => Promise<AdminModelDiagnosticResult>
  cancel: (modelConfigId: string, requestKey: string) => Promise<AdminModelDiagnosticResult>
}
