import { Prisma } from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { prisma, DataAccessError } from '../prisma.js'
import { evaluateResearchSearchCandidates, evaluateResearchNavigationCandidates } from '../research-search-quality.js'
import { readResearchReportForDelivery, saveResearchReportSection } from './research-sources.js'

type Scope = { userId: string; novelId: string; sessionId: string; runId: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const markerScope = { version: z.literal(1), scopeKey: z.string().regex(/^[a-f0-9]{64}$/u), taskKey: z.string().min(1) }
const markerSchema = z.discriminatedUnion('kind', [
  z.object({ ...markerScope, kind: z.literal('researchReadHandoff'), status: z.enum(['pending', 'consumed']), sourceId: z.string().min(1), searchId: z.string().min(1), purpose: z.literal('navigation').optional() }).strict(),
  z.object({ ...markerScope, kind: z.literal('researchLimitationDelivery'), status: z.literal('consumed'), sectionId: z.string().regex(/^system-limitation-[a-f0-9-]{36}$/u) }).strict(),
])

/** Execution checkpoints are separate from the request budget ledger. Their
 * existing artifact type needs no schema change and cannot grant request units. */
async function readMarker(tx: Prisma.TransactionClient, scope: Scope, id: string, scopeKey: string, taskKey: string) {
  const record = await tx.agentArtifact.findUnique({ where: { id }, include: { run: { select: { userId: true, novelId: true, sessionId: true } } } })
  if (!record) return null
  const state = markerSchema.safeParse(record.metadata)
  if (record.artifactType !== 'contextCheckpoint' || record.content !== '' || record.run.userId !== scope.userId
    || record.run.novelId !== scope.novelId || record.run.sessionId !== scope.sessionId || !state.success
    || state.data.scopeKey !== scopeKey || state.data.taskKey !== taskKey) {
    throw new DataAccessError(409, 'RESEARCH_CHECKPOINT_INVALID', '研究执行检查点归属或版本待核对，未派发请求或覆盖报告。')
  }
  return { record, state: state.data }
}
async function context(tx: Prisma.TransactionClient, scope: Scope) {
  const run = await tx.agentRun.findFirst({ where: { id: scope.runId, userId: scope.userId, sessionId: scope.sessionId,
    novelId: scope.novelId, novel: { authorId: scope.userId } } })
  if (!run) throw new DataAccessError(404, 'RESEARCH_SOURCE_NOT_FOUND', '研究任务不存在。')
  const parsed = taskSpecSchema.safeParse(run.taskSpec)
  const spec = parsed.success ? parsed.data : undefined
  const taskKey = run.taskRootId ?? spec?.id ?? run.id
  return { run, spec, taskKey, scopeKey: hash([scope.userId, scope.sessionId, scope.novelId, taskKey]) }
}

async function readAvailable(tx: Prisma.TransactionClient, scope: Scope, taskKey: string, scopeKey: string, extended: boolean) {
  const requests = await tx.agentResearchRequest.findMany({ where: { scopeKey, kind: 'read' } })
  if (requests.some(item => item.status === 'reserved' || item.status === 'consumed' && (item.savedOutcome === null
    || typeof item.savedOutcome === 'object' && !Array.isArray(item.savedOutcome) && item.savedOutcome.state === 'reserved'))) return false
  const recent = requests.filter(item => item.status === 'consumed').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 2)
  if (recent.length === 2 && recent.every(item => item.savedOutcome && typeof item.savedOutcome === 'object'
    && !Array.isArray(item.savedOutcome) && item.savedOutcome.ok === false)) return false
  const baseline = requests.find(item => item.status === 'baseline')
  let used = requests.filter(item => item.status !== 'released').reduce((sum, item) => sum + item.units, 0)
  if (!baseline) {
    const legacy = await tx.$queryRaw<Array<{ units: bigint }>>`
      SELECT count(*) AS units FROM agent_run_events e JOIN agent_runs r ON r.id=e.run_id
      WHERE r.user_id=${scope.userId} AND r.session_id=${scope.sessionId} AND r.novel_id=${scope.novelId}
        AND (r.id=${scope.runId} OR r.task_root_id=${taskKey} OR (r.task_root_id IS NULL AND r.task_spec->>'id'=${taskKey}))
        AND e.type='tool.call' AND e.payload->>'toolName'='web_read'
        AND e.payload->'args' IS NOT NULL AND e.payload->'args'<>'null'::jsonb
        AND e.payload->'args'->>'contentRef' IS NULL`
    used += Number(legacy[0].units)
  }
  if (used >= (baseline?.requestLimit ?? (extended ? 8 : 2))) return false
  return !await tx.webToolCall.findFirst({ where: { status: 'dispatched', run: {
    userId: scope.userId, sessionId: scope.sessionId, novelId: scope.novelId,
    OR: [{ id: scope.runId }, { taskRootId: taskKey }, { taskSpec: { path: ['id'], equals: taskKey } }],
  } } })
}

/** Only a pending handoff may be claimed. A crash after this claim must not
 * redispatch a possibly paid request, even if its tool receipt is absent. */
export async function takeResearchReadHandoff(scope: Scope): Promise<{ sourceId: string; receiptId: string; purpose?: 'navigation' } | null> {
  return prisma.$transaction(async tx => {
    const { run, spec, scopeKey, taskKey } = await context(tx, scope)
    const target = spec?.researchTarget ?? (spec?.researchNavigation?.sourceHosts ? { title: '', sourceHosts: spec.researchNavigation.sourceHosts } : undefined)
    if (run.status !== 'running' || spec?.researchDiscoveryProtocol !== 1 || spec.intent !== 'research_analysis'
      || spec.networkAccess === 'denied' || spec.researchReadAccess === 'denied' || !target || 'textAnalysisRequired' in target && target.textAnalysisRequired === false
      || !target.sourceHosts?.length) return null
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))::text`
    const id = hash([scopeKey, 'research-read-handoff-v1'])
    const pending = await readMarker(tx, scope, id, scopeKey, taskKey)
    if (pending?.state.kind !== 'researchReadHandoff' || pending.state.status !== 'pending') return null
    if (!await readAvailable(tx, scope, taskKey, scopeKey, spec.researchBudget === 'extended')) return null
    const source = await tx.agentResearchSource.findFirst({ where: { id: pending.state.sourceId, taskKey,
      ownerRun: { userId: scope.userId, sessionId: scope.sessionId, novelId: scope.novelId },
      versions: { none: {} }, readFailure: { equals: Prisma.DbNull } } })
    if (!source) return null
    await tx.agentArtifact.update({ where: { id }, data: { metadata: { ...pending.state, status: 'consumed' } } })
    return { sourceId: source.id, receiptId: id, ...(pending.state.purpose ? { purpose: pending.state.purpose } : {}) }
  })
}

/** One task-owned handoff, persisted before dispatch. A search result is not
 * progress: only the ordinary admitted web_read may subsequently obtain it. */
export async function claimResearchReadHandoff(scope: Scope, searchCallIds: readonly string[]): Promise<{ sourceId: string; receiptId: string; purpose?: 'navigation' } | null> {
  return prisma.$transaction(async tx => {
    const { run, spec, taskKey, scopeKey } = await context(tx, scope)
    const target = spec?.researchTarget ?? (spec?.researchNavigation?.sourceHosts ? { title: '', sourceHosts: spec.researchNavigation.sourceHosts } : undefined)
    if (!searchCallIds.length && !spec?.researchNavigation) return null
    if (run.status !== 'running' || spec?.researchDiscoveryProtocol !== 1 || spec.intent !== 'research_analysis'
      || spec.networkAccess === 'denied' || spec.researchReadAccess === 'denied' || !target || 'textAnalysisRequired' in target && target.textAnalysisRequired === false
      || !target.sourceHosts?.length) return null
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))::text`
    const id = hash([scopeKey, 'research-read-handoff-v1'])
    if (await readMarker(tx, scope, id, scopeKey, taskKey)) return null
    if (!await readAvailable(tx, scope, taskKey, scopeKey, spec.researchBudget === 'extended')) return null
    const searches = await tx.agentResearchRequest.findMany({ where: { scopeKey, kind: 'search', status: 'consumed',
      ...(!spec.researchNavigation ? { id: { in: searchCallIds.map(callId => hash([scopeKey, scope.runId, callId])) } } : {}),
      savedOutcome: { not: Prisma.DbNull } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5 })
    for (const search of searches) {
      const saved = search.savedOutcome
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) || typeof saved.query !== 'string' || !Array.isArray(saved.results)) continue
      const entries = saved.results.flatMap(entry => entry && typeof entry === 'object' && !Array.isArray(entry)
        && typeof entry.url === 'string' && typeof entry.title === 'string' && typeof entry.snippet === 'string' && typeof entry.source === 'string'
        ? [{ url: entry.url, title: entry.title, snippet: entry.snippet, source: entry.source }] : [])
      const extra = saved.navigation && typeof saved.navigation === 'object' && !Array.isArray(saved.navigation) && Array.isArray(saved.navigation.results)
        ? saved.navigation.results.flatMap(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.url === 'string'
          && typeof entry.title === 'string' && typeof entry.snippet === 'string' && typeof entry.source === 'string' ? [{ url: entry.url, title: entry.title, snippet: entry.snippet, source: entry.source }] : []) : []
      const evaluation = evaluateResearchSearchCandidates(saved.query, entries, target)
      const eligible = evaluation.eligibleResults.filter(item => !spec.researchNavigation || evaluation.candidates[entries.indexOf(item)].pageType === 'book'
        || evaluation.candidates[entries.indexOf(item)].pageType === 'chapter').map(item => ({ ...item,
        purpose: spec.researchNavigation && evaluation.candidates[entries.indexOf(item)].pageType === 'book' ? 'navigation' as const : undefined }))
      const navigation = spec.researchNavigation ? evaluateResearchNavigationCandidates([...entries, ...extra], target, spec.researchNavigation.sourceSites) : []
      for (const candidate of [...eligible, ...navigation]) {
        const source = await tx.agentResearchSource.findFirst({ where: { taskKey, canonicalUrl: candidate.url,
          title: candidate.title.slice(0, 300), ownerRun: { userId: scope.userId, sessionId: scope.sessionId, novelId: scope.novelId },
          versions: { none: {} }, readFailure: { equals: Prisma.DbNull } } })
        if (!source) continue
        await tx.agentArtifact.create({ data: { id, runId: scope.runId, artifactType: 'contextCheckpoint', title: '研究来源交接检查点', content: '',
          metadata: { version: 1, kind: 'researchReadHandoff', scopeKey, taskKey, status: 'pending', sourceId: source.id, searchId: search.id,
            ...(candidate.purpose ? { purpose: candidate.purpose } : {}) } } })
        return { sourceId: source.id, receiptId: id, ...(candidate.purpose ? { purpose: candidate.purpose } : {}) }
      }
    }
    return null
  })
}

/** A truthful, deterministic partial report requires no paid model wrap-up.
 * It preserves author sections and never certifies missing original text. */
export async function saveResearchLimitationDelivery(scope: Scope, reason: string): Promise<string | null> {
  const facts = await prisma.$transaction(async tx => {
    const { spec, run, taskKey, scopeKey } = await context(tx, scope)
    if (run.status !== 'running' || spec?.researchDiscoveryProtocol !== 1 || spec.intent !== 'research_analysis') return null
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))::text`
    const deliveryId = hash([scopeKey, 'research-limitation-delivery-v1'])
    let delivery = await readMarker(tx, scope, deliveryId, scopeKey, taskKey)
    if (!delivery) {
      await tx.agentArtifact.create({ data: { id: deliveryId, runId: scope.runId, artifactType: 'contextCheckpoint', title: '研究限制交付检查点', content: '',
        metadata: { version: 1, kind: 'researchLimitationDelivery', scopeKey, taskKey, status: 'consumed', sectionId: `system-limitation-${randomUUID()}` } } })
      delivery = await readMarker(tx, scope, deliveryId, scopeKey, taskKey)
    }
    if (delivery?.state.kind !== 'researchLimitationDelivery') throw new DataAccessError(409, 'RESEARCH_REPORT_INVALID', '限制说明的归属回执待核对，原报告未修改。')
    const owned = { taskKey, ownerRun: { userId: scope.userId, sessionId: scope.sessionId, novelId: scope.novelId } }
    const sourceCount = await tx.agentResearchSource.count({ where: owned })
    const failures = await tx.agentResearchSource.count({ where: { ...owned, readFailure: { not: Prisma.DbNull } } })
    const requests = await tx.agentResearchRequest.findMany({ where: { scopeKey, kind: { in: ['search', 'read'] } },
      select: { kind: true, status: true, units: true, savedOutcome: true } })
    const savedVersions = await tx.agentResearchContent.count({ where: { source: owned } })
    const metadataVersions = await tx.agentResearchContent.count({ where: { source: owned, contentKind: 'metadata' } })
    const reads = await tx.agentResearchContent.count({ where: { source: owned, contentKind: 'article', AND: [
      { quality: { path: ['evidence', 'identity', 'status'], equals: 'verified' } },
      { quality: { path: ['evidence', 'identity', 'pageType'], equals: 'chapter' } },
      { quality: { path: ['evidence', 'integrity', 'status'], equals: 'source_compared' } },
    ] } })
    const used = (kind: string) => requests.filter(item => item.kind === kind && item.status !== 'released').reduce((sum, item) => sum + item.units, 0)
    const emptySearches = requests.filter(item => { const saved = item.savedOutcome
      return item.kind === 'search' && item.status === 'consumed' && saved && typeof saved === 'object'
        && !Array.isArray(saved) && Array.isArray(saved.results) && saved.results.length === 0 }).length
    const handoff = await readMarker(tx, scope, hash([scopeKey, 'research-read-handoff-v1']), scopeKey, taskKey)
    return { title: spec.researchTarget?.title, usedSearch: used('search'), usedRead: used('read'), reads, failures, savedVersions, metadataVersions,
      sectionId: delivery.state.sectionId,
      emptySearches, handoff: handoff?.state.status, sourceCount, targetHosts: spec.researchTarget?.sourceHosts ?? [],
      reasonKind: reads > 0 ? 'partial_evidence' : failures > 0 ? 'source_unavailable' : 'no_relevant_evidence' }
  })
  if (!facts) return null
  const content = `## 研究尚未完成\n\n${facts.title ? `目标：《${facts.title}》。\n\n` : ''}${reason}\n\n证据状态：${facts.reasonKind}。\n\n`
    + `已保存 ${facts.sourceCount} 个候选来源、页面版本 ${facts.savedVersions} 个，元数据版本 ${facts.metadataVersions}，已核验章节版本 ${facts.reads}。页面请求占用 ${facts.usedRead} 次，读取失败来源 ${facts.failures} 个；搜索请求占用 ${facts.usedSearch} 次，其中已保存的空结果 ${facts.emptySearches} 次。空结果不等于网络故障，非空结果也不等于目标正文可用。结果数量、摘要及目录均不能代替目标原作正文。\n\n`
    + (facts.handoff ? `一次性来源交接状态：${facts.handoff}；已派发或结果未知的交接不会自动重发。\n\n` : '')
    + `当前缺失：${facts.reads > 0 ? '仍需核实目标身份、正文实际覆盖及分析证据是否完整' : '尚无可供写法分析的已核验原作正文'}。${facts.targetHosts.length ? `来源范围：${facts.targetHosts.join('、')}。` : ''}\n\n`
    + '已保存已有成果并暂停，未标记完成。可提供满足目标的真实官方作品/章节链接，或有权使用的材料后继续核验；继续不会重置联网额度，不会自动重复搜索、重放未知请求或改写小说。'
  const report = await readResearchReportForDelivery(scope)
  const sectionId = facts.sectionId
  const existing = report.sections.find(section => section.id === sectionId)
  const usedOrders = new Set(report.sections.filter(section => section.id !== sectionId).map(section => section.order))
  const order = existing?.order ?? Array.from({ length: 101 }, (_, index) => 100 - index).find(value => !usedOrders.has(value))
  if (order === undefined || !existing && report.sections.length >= 100) return content
  try {
    await saveResearchReportSection(scope, { reportId: 'main', title: ('title' in report ? report.title : '') || '研究证据与未完成项', expectedRevision: report.revision,
      section: { id: sectionId, order, content, evidenceKind: 'limitation', citations: [] } })
  } catch (error) {
    if (error instanceof DataAccessError && ['RESEARCH_REPORT_CONFLICT', 'RESEARCH_REPORT_TOO_LARGE'].includes(error.code)) {
      return `${content}\n\n限制说明本次仅在对话交付：报告版本已变化或已达保存上限，原报告保留，未覆盖或重试。`
    }
    throw error
  }
  return (await readResearchReportForDelivery(scope)).content
}
