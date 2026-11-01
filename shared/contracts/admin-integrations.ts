import { z } from 'zod'

export const adminIntegrationResourceSchema = z.enum(['model_metadata', 'usage', 'gateway_charges', 'gateway_health'])
export type AdminIntegrationResource = z.infer<typeof adminIntegrationResourceSchema>
const iso = z.string().datetime({ offset: true })
export const adminIntegrationWindowSchema = z.object({ from: iso, to: iso }).strict().refine(value => Date.parse(value.from) < Date.parse(value.to), '开始时间必须早于结束时间。')
export const adminIntegrationReadRequestSchema = z.object({ resource: adminIntegrationResourceSchema, window: adminIntegrationWindowSchema }).strict()
export type AdminIntegrationReadRequest = z.infer<typeof adminIntegrationReadRequestSchema>
export const adminGatewayScopeSchema = z.object({ kind: z.enum(['unknown', 'gateway_wide', 'chevoink_exclusive']), sourceIdentity: z.string().min(1).max(100).nullable(), group: z.string().min(1).max(100).nullable(), verifiedAt: iso.nullable() }).strict()
export type AdminGatewayScope = z.infer<typeof adminGatewayScopeSchema>
const metric = z.enum(['calls', 'prompt_tokens', 'completion_tokens', 'cache_tokens', 'success', 'failure', 'unknown', 'gateway_deduction', 'gateway_refund'])
/** Normalized read-only adapter DTO; not a claim that upstream wire fields are verified. */
export const adminGatewaySnapshotSchema = z.object({
  resource: adminIntegrationResourceSchema,
  observedAt: iso,
  window: adminIntegrationWindowSchema,
  scope: adminGatewayScopeSchema,
  coverage: z.enum(['unknown', 'partial', 'complete']),
  pricingVersion: z.string().max(100).nullable(),
  models: z.array(z.object({ id: z.string().min(1).max(160), label: z.string().max(160).nullable(), capabilities: z.array(z.enum(['text', 'vision', 'image_generation', 'web_search', 'web_fetch'])).max(5) }).strict()).max(500),
  aggregates: z.array(z.object({ metric, value: z.string().regex(/^\d+(?:\.\d+)?$/).max(80).nullable(), unit: z.enum(['count', 'tokens', 'CNY', 'USD']) }).strict()).max(100),
}).strict().superRefine((value, context) => {
  if (value.resource !== 'model_metadata' && value.models.length) context.addIssue({ code: 'custom', path: ['models'], message: '此来源不包含模型资料。' })
  if (value.resource === 'model_metadata' && value.aggregates.length) context.addIssue({ code: 'custom', path: ['aggregates'], message: '模型资料不能冒充用量。' })
  for (const [index, row] of value.aggregates.entries()) {
    const money = row.metric === 'gateway_deduction' || row.metric === 'gateway_refund'
    const tokens = ['prompt_tokens','completion_tokens','cache_tokens'].includes(row.metric)
    if ((money && (value.resource !== 'gateway_charges' || !['CNY','USD'].includes(row.unit))) || (!money && row.unit !== (tokens ? 'tokens' : 'count')) || (!money && row.value !== null && !/^\d+$/.test(row.value))) context.addIssue({ code: 'custom', path: ['aggregates',index], message: '指标类型、单位或来源不匹配。' })
  }
})
export type AdminGatewaySnapshot = z.infer<typeof adminGatewaySnapshotSchema>
export type AdminGatewayModelMapping = { localModelConfigId: string; localRevision: number; gatewayModelId: string; gatewayGroup: string | null; verification: 'unverified' | 'verified'; verifiedAt: string | null }
export type AdminGatewayMappingPreview = { localModelConfigId: string; localRevision: number; localDisplayName: string; gatewayModelId: string | null; gatewayGroup: string | null; suggestedLabel: string | null; state: 'unmapped' | 'unverified' | 'verified' | 'stale' | 'conflict' | 'not_observed' }
export type AdminIntegrationResourceStatus = { resource: AdminIntegrationResource; state: 'blocked' | 'not_loaded' | 'ready' | 'stale' | 'failed'; canRead: boolean; blockingReasons: string[]; lastAttemptAt: string | null; lastSuccessAt: string | null; failureReason: string | null; snapshot: AdminGatewaySnapshot | null; retention: 'process_memory' }
export type AdminReadOnlySystemStatus = { applicationName: string; releaseVersion: string | null; releaseVersionSource: 'not_available'; checkedAt: string; coverage: string[] }
export type AdminIntegrationStatusPayload = { source: 'yunshu_read_only'; observedAt: string; resources: AdminIntegrationResourceStatus[]; mappings: AdminGatewayMappingPreview[]; system: AdminReadOnlySystemStatus; deferred: Array<{ area: 'site_settings' | 'announcements' | 'help' | 'admin_notifications'; state: 'contract_only'; reason: string }> }
export const adminIntegrationExportRequestSchema = z.object({ resource: z.enum(['usage', 'gateway_charges', 'gateway_health']), columns: z.array(z.enum(['source', 'scope', 'from', 'to', 'observedAt', 'metric', 'value', 'unit'])).min(1).max(8).refine(values => new Set(values).size === values.length, '不能重复选择导出列。') }).strict()
export type AdminIntegrationExportRequest = z.infer<typeof adminIntegrationExportRequestSchema>
export type AdminIntegrationExport = { fileName: string; mimeType: 'text/csv; charset=utf-8'; content: string; source: 'gateway_snapshot'; localLedgerChanged: false }
export type AdminIntegrationClient = { status: () => Promise<AdminIntegrationStatusPayload>; read: (request: AdminIntegrationReadRequest) => Promise<AdminIntegrationResourceStatus> }
