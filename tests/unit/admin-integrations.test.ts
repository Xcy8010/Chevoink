import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdminIntegrationService, escapeAdminAggregateCsvCell, previewAdminGatewayMappings, type AdminGatewayReadAccess } from '../../api/lib/admin-integrations.js'
import { adminGatewaySnapshotSchema, adminIntegrationExportRequestSchema, type AdminGatewaySnapshot, type AdminIntegrationResource } from '../../shared/contracts/admin-integrations.js'

afterEach(() => vi.restoreAllMocks())
const window = { from: '2026-10-31T16:00:00Z', to: '2026-11-01T16:00:00Z' }
const observedAt = '2026-11-01T01:00:00Z'
const localModels = [{ id: 'local-a', revision: 1, displayName: '墨域自定显示名' }, { id: 'local-b', revision: 1, displayName: '另一写作档位' }]
const mappings = localModels.map(model => ({ localModelConfigId: model.id, localRevision: 1, gatewayModelId: 'shared-upstream', gatewayGroup: null, verification: 'verified' as const, verifiedAt: observedAt }))
const access: AdminGatewayReadAccess = { readOnlyAuthorized: true, resources: ['model_metadata','usage','gateway_charges','gateway_health'], scope: { kind: 'chevoink_exclusive', sourceIdentity: 'synthetic-chevoink-source', group: null, verifiedAt: observedAt }, requestIdentifiersVerified: true, reconciliation: { paginationWatermarkVerified: true, retentionVerified: true, lateCorrectionsAndRefundsVerified: true } }
function snapshot(resource: AdminIntegrationResource = 'gateway_charges'): AdminGatewaySnapshot {
  return { resource, window, observedAt, scope: { ...access.scope }, coverage: 'partial', pricingVersion: null, models: resource === 'model_metadata' ? [{ id: 'shared-upstream', label: '网关建议名称', capabilities: ['text'] }] : [], aggregates: resource === 'model_metadata' ? [] : resource === 'gateway_charges' ? [{ metric: 'gateway_deduction', value: '1.25', unit: 'CNY' }, { metric: 'gateway_refund', value: null, unit: 'CNY' }] : [{ metric: 'calls', value: null, unit: 'count' }] }
}

describe('closed read-only integration boundary', () => {
  it('keeps every external read closed by default, with safe public status and no outgoing request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const service = createAdminIntegrationService()
    const status = service.status()
    expect(status.resources).toHaveLength(4)
    expect(status.resources.every(item => !item.canRead && item.state === 'blocked' && item.snapshot === null)).toBe(true)
    expect(await service.read({ resource: 'gateway_charges', window })).toMatchObject({ state: 'blocked', lastAttemptAt: null, snapshot: null })
    expect(fetch).not.toHaveBeenCalled()
    expect(status.system.releaseVersion).toBeNull()
    expect(JSON.stringify(status.system)).not.toMatch(/appEnv|DATABASE_URL|hostname|apiKey/)
    expect(status.deferred.every(item => item.state === 'contract_only')).toBe(true)
  })
  it('does not treat a configured adapter, matching model name or generation permission as read/reconciliation authority', async () => {
    const read = vi.fn(async () => snapshot())
    const service = createAdminIntegrationService({ adapter: { read }, localModels, mappings, access: { ...access, readOnlyAuthorized: false, requestIdentifiersVerified: false, reconciliation: undefined } })
    expect((await service.read({ resource: 'gateway_charges', window })).blockingReasons.join('')).toContain('最小只读权限')
    expect(read).not.toHaveBeenCalled()
    const unknown = createAdminIntegrationService({ adapter: { read }, localModels, access: { ...access, scope: { kind: 'gateway_wide', sourceIdentity: null, group: null, verifiedAt: null } } })
    expect((await unknown.read({ resource: 'usage', window })).blockingReasons.join('')).toContain('专属调用来源')
    expect(read).not.toHaveBeenCalled()
  })
  it('keeps explicit local ID/version mappings and local labels, including two tiers sharing one gateway model', () => {
    const models = snapshot('model_metadata').models
    expect(previewAdminGatewayMappings(localModels, models, []).every(row => row.state === 'unmapped')).toBe(true)
    const preview = previewAdminGatewayMappings(localModels, models, mappings)
    expect(preview.map(row => row.state)).toEqual(['verified','verified'])
    expect(preview[0]).toMatchObject({ localDisplayName: '墨域自定显示名', suggestedLabel: '网关建议名称', gatewayModelId: 'shared-upstream' })
    expect(previewAdminGatewayMappings([{ ...localModels[0], revision: 2 }], models, mappings)[0].state).toBe('stale')
    expect(previewAdminGatewayMappings(localModels, [], mappings)[0].state).toBe('not_observed')
    expect(previewAdminGatewayMappings(localModels, models, [...mappings, mappings[0]])[0].state).toBe('conflict')
    expect(previewAdminGatewayMappings(localModels, models, [{ ...mappings[0], gatewayGroup: 'another-group' }])[0].state).toBe('unverified')
  })
  it('preserves unknown amounts, currency and source scope without adding to a local ledger', async () => {
    const read = vi.fn(async () => snapshot())
    const service = createAdminIntegrationService({ adapter: { read }, access, localModels, mappings, now: () => Date.parse(observedAt) })
    const result = await service.read({ resource: 'gateway_charges', window })
    expect(result).toMatchObject({ state: 'ready', retention: 'process_memory', snapshot: { coverage: 'partial', aggregates: [{ metric: 'gateway_deduction', value: '1.25', unit: 'CNY' }, { metric: 'gateway_refund', value: null, unit: 'CNY' }] } })
    expect(read).toHaveBeenCalledTimes(1)
    const exported = service.exportAggregates(adminIntegrationExportRequestSchema.parse({ resource: 'gateway_charges', columns: ['metric','value','unit'] }))
    expect(exported).toMatchObject({ source: 'gateway_snapshot', localLedgerChanged: false })
    expect(exported.content).toContain('"gateway_refund","未核定","CNY"')
    expect(exported.content).not.toMatch(/user|body|prompt|apiKey|localModelConfigId/)
  })
  it('retains last success and marks stale on malformed or failed reads without exposing upstream errors', async () => {
    const read = vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(new Error('synthetic-secret-from-upstream')).mockResolvedValueOnce({ ...snapshot(), apiKey: 'synthetic-secret-field' })
    let now = Date.parse(observedAt)
    const service = createAdminIntegrationService({ adapter: { read }, access, localModels, mappings, now: () => now })
    const first = await service.read({ resource: 'gateway_charges', window })
    now += 1000
    const failed = await service.read({ resource: 'gateway_charges', window })
    expect(failed).toMatchObject({ state: 'stale', lastSuccessAt: first.lastSuccessAt, snapshot: first.snapshot })
    const malformed = await service.read({ resource: 'gateway_charges', window })
    expect(malformed.snapshot).toEqual(first.snapshot)
    expect(JSON.stringify(malformed)).not.toContain('synthetic-secret')
    expect(read).toHaveBeenCalledTimes(3)
  })
  it('does not promote gateway-wide health to app-exclusive scope and rejects a forged exclusive claim', async () => {
    const read = vi.fn().mockResolvedValueOnce({ ...snapshot('gateway_health'), scope: { kind: 'gateway_wide', sourceIdentity: null, group: null, verifiedAt: null } }).mockResolvedValueOnce(snapshot('gateway_health'))
    const service = createAdminIntegrationService({ adapter: { read }, access: { ...access, scope: { kind: 'gateway_wide', sourceIdentity: null, group: null, verifiedAt: null } }, now: () => Date.parse(observedAt) })
    expect((await service.read({ resource: 'gateway_health', window })).snapshot?.scope.kind).toBe('gateway_wide')
    const forged = await service.read({ resource: 'gateway_health', window })
    expect(forged).toMatchObject({ state: 'stale', snapshot: { scope: { kind: 'gateway_wide' } } })
  })
  it('cancels an injected read without retry or accepting its late response', async () => {
    let resolve!: (value: unknown) => void
    const read = vi.fn(() => new Promise<unknown>(accept => { resolve = accept }))
    const service = createAdminIntegrationService({ adapter: { read }, access, localModels, mappings, now: () => Date.parse(observedAt) })
    const controller = new AbortController()
    const pending = service.read({ resource: 'gateway_charges', window }, controller.signal)
    controller.abort()
    expect(await pending).toMatchObject({ state: 'failed', snapshot: null })
    resolve(snapshot()); await Promise.resolve()
    expect(service.status().resources.find(item => item.resource === 'gateway_charges')?.snapshot).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('rejects invalid units, unsafe extra fields and metadata exports; guards formula-starting CSV text', () => {
    expect(adminGatewaySnapshotSchema.safeParse({ ...snapshot('usage'), aggregates: [{ metric: 'prompt_tokens', value: '1.5', unit: 'CNY' }] }).success).toBe(false)
    expect(adminGatewaySnapshotSchema.safeParse({ ...snapshot(), privateUsers: [] }).success).toBe(false)
    expect(adminIntegrationExportRequestSchema.safeParse({ resource: 'model_metadata', columns: ['value'] }).success).toBe(false)
    expect(adminIntegrationExportRequestSchema.safeParse({ resource: 'usage', columns: ['provider','modelName','baseUrl'] }).success).toBe(false)
    expect(adminIntegrationExportRequestSchema.safeParse({ resource: 'usage', columns: ['value','value'] }).success).toBe(false)
    for (const input of ['=1+1','+SUM(A1:A2)','-1+2','@SUM(A1)','\t=HYPERLINK("synthetic")','\n =1','\r=1',' \r\n\t@synthetic-model']) expect(escapeAdminAggregateCsvCell(input)).toBe('"\'' + input.replace(/"/g,'""') + '"')
    expect(escapeAdminAggregateCsvCell('plain,"label"')).toBe('"plain,""label"""')
  })
})
