import type { AdminGatewayModelMapping, AdminGatewayMappingPreview, AdminGatewayScope, AdminGatewaySnapshot, AdminIntegrationExport, AdminIntegrationExportRequest, AdminIntegrationReadRequest, AdminIntegrationResource, AdminIntegrationResourceStatus, AdminIntegrationStatusPayload } from '../../shared/contracts/admin-integrations.js'
import { adminGatewaySnapshotSchema } from '../../shared/contracts/admin-integrations.js'
import { DataAccessError } from './prisma.js'

const RESOURCES: AdminIntegrationResource[] = ['model_metadata', 'usage', 'gateway_charges', 'gateway_health']
type LocalModelIdentity = { id: string; revision: number; displayName: string }
export function previewAdminGatewayMappings(local: readonly LocalModelIdentity[], candidates: AdminGatewaySnapshot['models'] | null, mappings: readonly AdminGatewayModelMapping[], observedGroup: string | null = null): AdminGatewayMappingPreview[] {
  return local.map(model => {
    const history = mappings.filter(binding => binding.localModelConfigId === model.id)
    const current = history.filter(binding => binding.localRevision === model.revision)
    const mapping = current.length === 1 ? current[0] : null
    const candidate = mapping ? candidates?.find(row => row.id === mapping.gatewayModelId) : null
    const state: AdminGatewayMappingPreview['state'] = current.length > 1 ? 'conflict' : !mapping ? history.length ? 'stale' : 'unmapped' : mapping.verification !== 'verified' || !mapping.verifiedAt || candidates === null || mapping.gatewayGroup !== observedGroup ? 'unverified' : !candidate ? 'not_observed' : 'verified'
    return { localModelConfigId: model.id, localRevision: model.revision, localDisplayName: model.displayName, gatewayModelId: mapping?.gatewayModelId ?? null, gatewayGroup: mapping?.gatewayGroup ?? null, suggestedLabel: candidate?.label ?? null, state }
  })
}

/** Future implementations may use approved read-only endpoints only; no model/generation adapter belongs here. */
export type AdminGatewayReadAdapter = { read: (request: AdminIntegrationReadRequest, signal: AbortSignal) => Promise<unknown> }
export type AdminGatewayReadAccess = { readOnlyAuthorized: boolean; resources: readonly AdminIntegrationResource[]; scope: AdminGatewayScope; requestIdentifiersVerified: boolean; reconciliation?: { paginationWatermarkVerified: boolean; retentionVerified: boolean; lateCorrectionsAndRefundsVerified: boolean } }
const CLOSED_ACCESS: AdminGatewayReadAccess = { readOnlyAuthorized: false, resources: [], scope: { kind: 'unknown', sourceIdentity: null, group: null, verifiedAt: null }, requestIdentifiersVerified: false }

export function escapeAdminAggregateCsvCell(value: string | null): string {
  const text = value ?? ''
  let start = 0
  while (start < text.length && (/\s/u.test(text[start]) || text.charCodeAt(start) < 32)) start++
  const safe = /^[=+\-@]/u.test(text.slice(start)) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}
export function createAdminIntegrationService(deps: { adapter?: AdminGatewayReadAdapter; access?: AdminGatewayReadAccess; localModels?: readonly LocalModelIdentity[]; mappings?: readonly AdminGatewayModelMapping[]; now?: () => number } = {}) {
  const now = deps.now ?? Date.now
  const access = deps.access ?? CLOSED_ACCESS
  const mappings = deps.mappings ?? []
  const saved = new Map<AdminIntegrationResource, { snapshot: AdminGatewaySnapshot; lastSuccessAt: string }>()
  const attempts = new Map<AdminIntegrationResource, { at: string; failure: string | null }>()
  const active = new Map<AdminIntegrationResource, Promise<AdminIntegrationResourceStatus>>()
  const blockers = (resource: AdminIntegrationResource) => {
    const reasons: string[] = []
    if (!deps.adapter) reasons.push('未配置云枢只读适配器；没有发起外部请求。')
    if (!access.readOnlyAuthorized || !access.resources.includes(resource)) reasons.push('尚未核实该来源的最小只读权限；生成令牌不能当作管理读取令牌。')
    if (resource === 'usage' || resource === 'gateway_charges') {
      if (access.scope.kind !== 'chevoink_exclusive' || !access.scope.sourceIdentity || !access.scope.verifiedAt) reasons.push('墨域专属调用来源和覆盖范围未确认，不能把全网关数据分给墨域。')
      if (!access.requestIdentifiersVerified) reasons.push('两端请求标识贯通、去重和迟到更正规则尚未确认。')
      if (!access.reconciliation?.paginationWatermarkVerified || !access.reconciliation.retentionVerified || !access.reconciliation.lateCorrectionsAndRefundsVerified) reasons.push('分页水位、保留期及迟到更正 / 退款覆盖尚未核实，不能宣称已完成对账。')
      if (!mappings.some(mapping => mapping.verification === 'verified' && mapping.verifiedAt && mapping.gatewayGroup === access.scope.group && deps.localModels?.some(model => model.id === mapping.localModelConfigId && model.revision === mapping.localRevision))) reasons.push('尚无已确认的本地配置 ID / 版本到云枢模型及分组映射；不能按模型名自动归属。')
    }
    if (resource === 'gateway_health' && access.scope.kind === 'unknown') reasons.push('健康数据的网关范围尚未确认；不能宣称墨域专属健康。')
    return reasons
  }
  const resourceStatus = (resource: AdminIntegrationResource): AdminIntegrationResourceStatus => {
    const previous = saved.get(resource)
    const attempt = attempts.get(resource)
    const reasons = blockers(resource)
    const age = previous ? now() - Date.parse(previous.snapshot.observedAt) : null
    const stale = previous && (Boolean(attempt?.failure) || age! > 600000 || age! < 0)
    return { resource, state: reasons.length ? 'blocked' : previous ? stale ? 'stale' : 'ready' : attempt?.failure ? 'failed' : 'not_loaded', canRead: reasons.length === 0, blockingReasons: reasons, lastAttemptAt: attempt?.at ?? null, lastSuccessAt: previous?.lastSuccessAt ?? null, failureReason: attempt?.failure ?? null, snapshot: previous ? structuredClone(previous.snapshot) : null, retention: 'process_memory' }
  }
  const status = (): AdminIntegrationStatusPayload => ({
    source: 'yunshu_read_only', observedAt: new Date(now()).toISOString(), resources: RESOURCES.map(resourceStatus), mappings: previewAdminGatewayMappings(deps.localModels ?? [], saved.get('model_metadata')?.snapshot.models ?? null, mappings, saved.get('model_metadata')?.snapshot.scope.group ?? null),
    system: { applicationName: '启创墨域', releaseVersion: null, releaseVersionSource: 'not_available', checkedAt: new Date(now()).toISOString(), coverage: ['应用名称来自已知产品身份；当前没有可核公开运行版本来源。', '不读取或展示环境变量、主机、端口、路径、凭据、数据库状态或队列健康。'] },
    deferred: [{ area: 'site_settings', state: 'contract_only', reason: '当前仅有管理员本人安全与 Credits 政策；通用站点设置缺少持久化与权限契约。' }, { area: 'announcements', state: 'contract_only', reason: '未发现后台公告发布与版本存储契约，未增加空入口。' }, { area: 'help', state: 'contract_only', reason: '缺少结构化帮助内容、发布和预览契约，未使用任意 HTML 编辑器。' }, { area: 'admin_notifications', state: 'contract_only', reason: '普通用户互动/未读计数不能替代管理员异常通知；接收人、阈值、去重与权限待明确。' }],
  })
  const read = async (request: AdminIntegrationReadRequest, callerSignal?: AbortSignal): Promise<AdminIntegrationResourceStatus> => {
    if (blockers(request.resource).length) return resourceStatus(request.resource)
    if (active.has(request.resource)) throw new DataAccessError(409, 'INTEGRATION_READ_IN_PROGRESS', '该来源已有只读请求进行中，请等待完成。')
    const requestedAt = new Date(now()).toISOString()
    attempts.set(request.resource, { at: requestedAt, failure: null })
    const timeout = AbortSignal.timeout(8000)
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
    const operation = (async () => {
      try {
        signal.throwIfAborted()
        const interrupted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('INTEGRATION_READ_ABORTED')), { once: true }))
        const snapshot = adminGatewaySnapshotSchema.parse(await Promise.race([deps.adapter!.read(request, signal), interrupted]))
        signal.throwIfAborted()
        const sameWindow = Date.parse(snapshot.window.from) === Date.parse(request.window.from) && Date.parse(snapshot.window.to) === Date.parse(request.window.to)
        const exclusive = snapshot.scope.kind === 'chevoink_exclusive'
        const scopeMatches = (access.scope.group === null || snapshot.scope.group === access.scope.group) && (!exclusive || (access.scope.kind === 'chevoink_exclusive' && Boolean(access.scope.verifiedAt) && Boolean(access.scope.sourceIdentity) && snapshot.scope.sourceIdentity === access.scope.sourceIdentity && snapshot.scope.group === access.scope.group))
        const attributed = request.resource !== 'usage' && request.resource !== 'gateway_charges' || exclusive
        if (snapshot.resource !== request.resource || !sameWindow || !scopeMatches || !attributed) throw new Error('INTEGRATION_SCOPE_INVALID')
        saved.set(request.resource, { snapshot: exclusive ? { ...snapshot, scope: { ...access.scope } } : snapshot, lastSuccessAt: new Date(now()).toISOString() })
      } catch {
        attempts.set(request.resource, { at: requestedAt, failure: signal.aborted ? '读取已取消或超时，未重试；保留上次成功快照。' : '只读返回、来源或期间校验失败；保留上次快照，不清零、不自动重试。' })
      }
      return resourceStatus(request.resource)
    })().finally(() => active.delete(request.resource))
    active.set(request.resource, operation)
    return operation
  }
  const exportAggregates = (request: AdminIntegrationExportRequest): AdminIntegrationExport => {
    const item = resourceStatus(request.resource)
    if (!item.snapshot) throw new DataAccessError(409, 'INTEGRATION_SNAPSHOT_UNAVAILABLE', '尚无可导出的安全聚合快照。')
    const snapshot = item.snapshot
    const rows = snapshot.aggregates.map(row => {
      const values: Record<AdminIntegrationExportRequest['columns'][number], string | null> = { source: 'YunShu gateway snapshot', scope: snapshot.scope.kind, from: snapshot.window.from, to: snapshot.window.to, observedAt: snapshot.observedAt, metric: row.metric, value: row.value ?? '未核定', unit: row.unit }
      return request.columns.map(column => escapeAdminAggregateCsvCell(values[column])).join(',')
    })
    return { fileName: `yunshu-${request.resource}-aggregate.csv`, mimeType: 'text/csv; charset=utf-8', content: '\ufeff' + [request.columns.map(escapeAdminAggregateCsvCell).join(','), ...rows].join('\r\n'), source: 'gateway_snapshot', localLedgerChanged: false }
  }
  return { status, read, exportAggregates }
}
const service = createAdminIntegrationService()
export const getAdminIntegrationStatus = service.status
export const readAdminIntegrationSnapshot = service.read
export const exportAdminIntegrationAggregates = service.exportAggregates
