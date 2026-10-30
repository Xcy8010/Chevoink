import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { taskSpecSchema, type TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError, prisma } from '../prisma.js'
import { parsePublicHttpUrl } from '../public-http.js'
import { assessReaderText, type ReaderTarget } from '../web-reader-quality.js'
import type { WebReadResult } from '../web-reader-service.js'
import { countReportChineseCharacters } from '../../../shared/agent-output.js'
import { researchChapterTitle, researchSourceHosts } from './research-navigation-policy.js'
import { mergeResearchRanges } from './research-ranges.js'
import { evaluateResearchNavigationCandidates, evaluateResearchSearchCandidates } from '../research-search-quality.js'
import { runtimeJson } from './runtime-common.js'
import { durableTaskSpecIdentity } from './runtime-identity.js'
import type { ToolContext } from './tools/types.js'

type Scope = Pick<ToolContext, 'userId' | 'sessionId' | 'novelId' | 'runId' | 'transaction' | 'webAdmission'>

/** A durable projection uses the same operation/lease boundary as its receipt.
 * Legacy callers keep their existing transaction behavior. Never wraps HTTP. */
function researchTransaction<T>(scope: Scope, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  const admitted = (tx: Prisma.TransactionClient) => scope.webAdmission ? scope.webAdmission(tx, () => work(tx)) : work(tx)
  return scope.transaction ? admitted(scope.transaction) : prisma.$transaction(admitted)
}

const savedLinksSchema = z.array(z.object({ url: z.string().min(1).max(8192), title: z.string().min(1).max(160) }).strict()).max(4096)
function checkedSavedLinks(value: unknown, finalUrl: string) {
  const origin = new URL(finalUrl).origin
  return savedLinksSchema.parse(value ?? []).map(link => {
    const url = canonicalResearchUrl(link.url)
    if (new URL(url).origin !== origin) throw new DataAccessError(422, 'RESEARCH_LINK_INVALID', '保存链接不是来源页面的同源链接。')
    return { ...link, url }
  })
}

const reportCitationSchema = z.object({ contentRef: z.string().min(1).max(64), revision: z.string().regex(/^[a-f0-9]{64}$/),
  start: z.number().int().nonnegative(), end: z.number().int().positive(), excerptHash: z.string().regex(/^[a-f0-9]{64}$/),
  purpose: z.enum(['target_text', 'source_identity', 'limitation']).optional() }).strict()
const readerEvidenceSchema = z.object({ version: z.literal(1),
  identity: z.object({ status: z.enum(['verified', 'mismatch', 'unknown']), title: z.string().max(300).optional(), author: z.string().max(300).optional(), chapterTitle: z.string().max(300).optional(), chapterId: z.string().max(300).optional(),
    pageType: z.enum(['chapter', 'book', 'unknown']), basis: z.enum(['structured_metadata', 'page_title', 'none']) }).strict(),
  integrity: z.object({ status: z.enum(['source_compared', 'unverified', 'damaged']), code: z.string().max(64),
    extractedHash: z.string().regex(/^[a-f0-9]{64}$/), referenceHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
}).strict()
/** A readable, source-proven subset remains partial; it is not chapter completeness. */
export function isResearchPreviewEvidence(evidence: Pick<z.infer<typeof readerEvidenceSchema>, 'integrity'> | undefined) {
  return evidence?.integrity.status === 'unverified' && evidence.integrity.code === 'SOURCE_PREVIEW_ONLY' && Boolean(evidence.integrity.referenceHash)
}

const reportSectionSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), order: z.number().int().min(0).max(100),
  content: z.string().min(1).max(60_000), evidenceKind: z.enum(['analysis', 'source_identity', 'limitation']).optional(),
  citations: z.array(reportCitationSchema).max(100) }).strict()
const reportStateSchema = z.object({ kind: z.literal('researchReport'), taskKey: z.string(), revision: z.number().int().positive(),
  sections: z.array(reportSectionSchema).max(100) }).strict()
export const researchReportSaveParameters = z.object({ reportId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default('main'),
  title: z.string().trim().min(1).max(160).optional().describe('报告标题；更新区块时省略沿用已保存标题，首次省略使用区块标题。'),
  expectedRevision: z.number().int().nonnegative(), section: reportSectionSchema }).strict()

/** Save only the addressed section. A replay cannot append it twice, and a
 * stale revision cannot overwrite a newer report. No chapter/plan writes. */
export async function saveResearchReportSection(scope: Scope, input: {
  reportId: string; title?: string; expectedRevision: number; section: z.infer<typeof reportSectionSchema>;
}, transaction?: Prisma.TransactionClient) {
  const parsed = researchReportSaveParameters.parse(input)
  const save = async (tx: Prisma.TransactionClient) => {
    // Share the legacy run's row lock with pause/stop. A committed stop cannot
    // be followed by a late report write from that execution.
    await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${scope.runId} AND user_id = ${scope.userId} FOR UPDATE`
    const { taskKey, run } = await ownedTask(tx, scope)
    const spec = taskSpecSchema.parse(run.taskSpec)
    const durableRoot = transaction && run.runtimeProtocolVersion === 1 && run.taskRootId
      ? await tx.agentTaskRoot.findFirst({ where: { id: run.taskRootId, userId: scope.userId, novelId: scope.novelId, sessionId: scope.sessionId } }) : null
    // Root admission already excludes runId and omits schema-produced undefined
    // values. Reuse that exact identity instead of hashing a reparsed snapshot.
    const durable = durableRoot && !spec.authorization && spec.runId === scope.runId
      && runtimeJson(durableRoot.specSnapshot).hash === durableTaskSpecIdentity(run.taskSpec).frozen.hash
    if (spec.intent !== 'research_analysis' || spec.authorization || (run.runtimeProtocolVersion !== 0 && !durable)) {
      throw new DataAccessError(403, 'RESEARCH_REPORT_NOT_AUTHORIZED', '当前执行入口没有研究报告保存权限。')
    }
    if (run.status !== 'running') throw new DataAccessError(409, 'RESEARCH_RUN_NOT_ACTIVE', '任务已停止，报告未被修改。')
    const id = hash(JSON.stringify(['research-report', scope.userId, scope.sessionId, taskKey, parsed.reportId]))
    const previous = await tx.agentArtifact.findUnique({ where: { id } })
    const state = previous ? reportStateSchema.parse(previous.metadata) : null
    if (previous && (previous.artifactType !== 'researchReport' || state?.taskKey !== taskKey
      || !(await tx.agentRun.findFirst({ where: { id: previous.runId, userId: scope.userId, sessionId: scope.sessionId, novelId: scope.novelId } })))) return denied()
    if (previous && state!.sections.map(section => section.content).join('\n\n') !== previous.content) {
      throw new DataAccessError(409, 'RESEARCH_REPORT_INVALID', '报告内容与区块版本不一致，未覆盖原报告。')
    }
    // Only the actual ordered report and its cited source material count.
    // Artifact IDs/revision counters are retained for audit/CAS, not progress.
    const reportHash = async (title: string, sections: z.infer<typeof reportSectionSchema>[]) => hash(JSON.stringify({ title,
      sections: await Promise.all(sections.map(async section => ({ order: section.order, content: section.content,
        citations: await Promise.all(section.citations.map(async citation => {
          const saved = await tx.agentResearchContent.findUnique({ where: { id: citation.contentRef }, include: { source: true } })
          if (!saved) return denied()
          return { url: saved.source.canonicalUrl, revision: citation.revision, start: citation.start, end: citation.end, excerptHash: citation.excerptHash }
        })) }))) }))
    const beforeHash = await reportHash(previous?.title ?? '', state?.sections ?? [])
    const inferredTitle = parsed.section.content.match(/^#{1,6}[\t ]+([^\r\n]+)/mu)?.[1].trim().slice(0, 160) || '研究报告'
    const title = parsed.title ?? previous?.title ?? inferredTitle
    const targetId = `research-report:${scope.userId}:${scope.sessionId}:${taskKey}:${parsed.reportId}`
    const priorSection = state?.sections.find(section => section.id === parsed.section.id)
    if (previous && previous.title === title && JSON.stringify(priorSection) === JSON.stringify(parsed.section)) {
      return { artifactId: id, revision: state!.revision, chineseCharacters: countReportChineseCharacters(previous.content), replayed: true,
        semanticTransition: { targetId, beforeHash, afterHash: beforeHash } }
    }
    if ((state?.revision ?? 0) !== parsed.expectedRevision) throw new DataAccessError(409, 'RESEARCH_REPORT_CONFLICT', '报告已更新，请读取当前版本后仅修订目标区块。')
    if ((spec.researchTarget || spec.researchNavigation) && (parsed.section.evidenceKind ?? 'analysis') === 'analysis'
      && !parsed.section.citations.some(citation => (citation.purpose ?? 'target_text') === 'target_text')) {
      throw new DataAccessError(422, 'RESEARCH_TARGET_EVIDENCE_REQUIRED', '指定原作的分析区块必须引用已核验目标正文；仅核对书目或说明材料缺失时明确evidenceKind，不能标为已完成正文分析。')
    }
    for (const citation of parsed.section.citations) {
      const content = await tx.agentResearchContent.findUnique({ where: { id: citation.contentRef } })
      if (!content) return denied()
      await ownedSource(tx, scope, content.sourceId)
      if (content.revision !== citation.revision || hash(content.text) !== content.contentHash || citation.end <= citation.start
        || citation.end > content.text.length || citation.end - citation.start > 6000
        || hash(content.text.slice(citation.start, citation.end)) !== citation.excerptHash) {
        throw new DataAccessError(409, 'RESEARCH_CITATION_INVALID', '引用与保存的原文版本或范围不一致。')
      }
      if ((spec.researchTarget || spec.researchNavigation) && (citation.purpose ?? 'target_text') === 'target_text') {
        const metadata = content.quality && typeof content.quality === 'object' && !Array.isArray(content.quality) ? content.quality : null
        const evidence = readerEvidenceSchema.safeParse(metadata?.evidence)
        if (content.contentKind !== 'article' || !evidence.success || evidence.data.identity.status !== 'verified' || evidence.data.identity.pageType !== 'chapter'
          || evidence.data.integrity.status !== 'source_compared' && !isResearchPreviewEvidence(evidence.data)) {
          throw new DataAccessError(422, 'RESEARCH_TARGET_EVIDENCE_REQUIRED', '目标正文引用尚未核对原作书名、作者及同源正文完整性；不得把错书、简介或未核验提取当作原作证据。仅用于身份核验或说明缺失的引用须明确purpose。')
        }
        if (isResearchPreviewEvidence(evidence.data) && !mergeResearchRanges(content.providedRanges, content.text.length)
          .some(range => range.start <= citation.start && range.end >= citation.end)) {
          throw new DataAccessError(409, 'RESEARCH_CITATION_INVALID', '部分正文引用必须位于本任务实际已读取的保存范围内，不能把预览当作完整章节。')
        }
        if (spec.researchNavigation) {
          const sealed = checkedResearchMetadata(content)
          const selected = await readResearchSelection(tx, scope, taskKey)
          if (!selected || sealed.binding?.purpose !== 'body' || sealed.binding.identityHash !== selected.identityHash
            || evidence.data.identity.title !== selected.target.title || evidence.data.identity.author !== selected.target.author) {
            throw new DataAccessError(422, 'RESEARCH_TARGET_EVIDENCE_REQUIRED', '正文引用没有绑定本任务核验的同一作品身份，不能用导航或另一目标的缓存代替。')
          }
          await assertChosenResearchLineage(tx, scope, selected, content.sourceId, sealed.binding.parent)
        }
      }
    }
    const sections = [...(state?.sections.filter(section => section.id !== parsed.section.id) ?? []), parsed.section]
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    if (sections.length > 100 || new Set(sections.map(section => section.order)).size !== sections.length) {
      throw new DataAccessError(400, 'RESEARCH_REPORT_SECTION_INVALID', '报告区块顺序重复或区块数量超限。')
    }
    const content = sections.map(section => section.content).join('\n\n')
    if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw new DataAccessError(413, 'RESEARCH_REPORT_TOO_LARGE', '报告超过保存上限。')
    const revision = (state?.revision ?? 0) + 1
    const metadata = { kind: 'researchReport', taskKey, revision, sections }
    if (previous) await tx.agentArtifact.update({ where: { id }, data: { title, content, metadata } })
    else await tx.agentArtifact.create({ data: { id, runId: scope.runId, artifactType: 'researchReport', title, content, metadata } })
    return { artifactId: id, revision, chineseCharacters: countReportChineseCharacters(content), replayed: false,
      semanticTransition: { targetId, beforeHash, afterHash: await reportHash(title, sections) } }
  }
  return transaction ? save(transaction) : prisma.$transaction(save, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

type ReportReadInput = { reportId?: string; offset?: number; limit?: number; expectedRevision?: number }

export function readResearchReport(scope: Scope, input: ReportReadInput, transaction?: Prisma.TransactionClient) {
  return loadResearchReport(scope, input, false, transaction)
}

/** Server-only final delivery: one owned, consistent snapshot, not hundreds of
 * model reads or a second paid generation. The saved report already has a 2MiB cap. */
export function readResearchReportForDelivery(scope: Scope) {
  return loadResearchReport(scope, {}, true)
}

async function loadResearchReport(scope: Scope, input: ReportReadInput, complete: boolean, transaction?: Prisma.TransactionClient) {
  const parsed = z.object({ reportId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default('main'),
    offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(6000).default(6000),
    expectedRevision: z.number().int().nonnegative().optional() }).parse(input)
  const read = async (tx: Prisma.TransactionClient) => {
    const { taskKey, run } = await ownedTask(tx, scope)
    const spec = taskSpecSchema.safeParse(run.taskSpec)
    const id = hash(JSON.stringify(['research-report', scope.userId, scope.sessionId, taskKey, parsed.reportId]))
    const report = await tx.agentArtifact.findFirst({ where: { id, artifactType: 'researchReport',
      run: { userId: scope.userId, sessionId: scope.sessionId, novelId: scope.novelId } } })
    if (!report) {
      if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== 0) {
        throw new DataAccessError(409, 'RESEARCH_REPORT_CONFLICT', '报告版本已失效，请重新读取区块清单。')
      }
      return { reportId: parsed.reportId, revision: 0, sections: [], content: '', chineseCharacters: 0, nextOffset: null }
    }
    const state = reportStateSchema.parse(report.metadata)
    if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== state.revision) {
      throw new DataAccessError(409, 'RESEARCH_REPORT_CONFLICT', '报告已更新，请从当前版本重新读取，不能拼接不同版本的正文。')
    }
    if (state.taskKey !== taskKey || state.sections.map(section => section.content).join('\n\n') !== report.content) {
      throw new DataAccessError(409, 'RESEARCH_REPORT_INVALID', '报告内容与区块版本不一致。')
    }
    if (parsed.offset > report.content.length) throw new DataAccessError(400, 'RESEARCH_REPORT_OFFSET_INVALID', '报告读取位置超出正文范围。')
    const end = complete ? report.content.length : Math.min(report.content.length, parsed.offset + parsed.limit)
    const sourceScope = { taskKey, ownerRun: { userId: scope.userId, sessionId: scope.sessionId, novelId: scope.novelId } }
    const evidence = complete ? await Promise.all([
      tx.agentResearchSource.count({ where: sourceScope }),
      tx.agentResearchSource.count({ where: { ...sourceScope, versions: { some: { contentKind: 'article' } } } }),
      tx.agentResearchSource.count({ where: { ...sourceScope, versions: { some: { contentKind: 'metadata' } } } }),
      tx.agentResearchSource.count({ where: { ...sourceScope, readFailure: { not: Prisma.DbNull } } }),
      tx.agentResearchContent.findMany({ where: { source: sourceScope }, select: { providedRanges: true } }),
    ]).then(async ([discoveredPages, readablePages, metadataPages, failedSources, windows]) => ({ discoveredPages, readablePages, metadataPages, failedSources,
      providedCharacters: windows.reduce((sum, window) => sum + mergeResearchRanges(window.providedRanges, Number.MAX_SAFE_INTEGER)
        .reduce((count, range) => count + range.end - range.start, 0), 0),
      citedVersions: new Set(state.sections.flatMap(section => section.citations.map(citation => `${citation.contentRef}:${citation.revision}`))).size,
      ...(spec.success && (spec.data.researchTarget || spec.data.researchNavigation) ? { targetAnalysisSupported: spec.data.researchNavigation
        ? await currentResearchTargetAnalysis(tx, scope, taskKey, state.sections)
        : state.sections.some(section => (section.evidenceKind ?? 'analysis') === 'analysis'
          && section.citations.some(citation => (citation.purpose ?? 'target_text') === 'target_text')) } : {}) })) : undefined
    return { reportId: parsed.reportId, artifactId: report.id, title: report.title, revision: state.revision,
      sections: state.sections.map(section => ({ id: section.id, order: section.order })),
      content: report.content.slice(parsed.offset, end), offset: parsed.offset, totalChars: report.content.length,
      chineseCharacters: countReportChineseCharacters(report.content), nextOffset: end < report.content.length ? end : null, evidence }
  }
  return transaction ? read(transaction) : prisma.$transaction(read, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const denied = (): never => { throw new DataAccessError(404, 'RESEARCH_SOURCE_NOT_FOUND', '来源不存在或不属于当前任务。') }

/** Never merge chapter/page/signature parameters or expose credential hashes. */
export function canonicalResearchUrl(value: string): string {
  let url: URL
  try { url = parsePublicHttpUrl(value, true) }
  catch { throw new DataAccessError(422, 'WEB_READ_UNSAFE_URL', '来源地址未通过公开网页校验。') }
  const signed = [...url.searchParams.keys()].some(key => /token|signature|credential|authorization|^sig$|^x-amz-/i.test(key))
  if (!signed) for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_source|utm_medium|utm_campaign|utm_term|utm_content|gclid|fbclid)$/i.test(key)) url.searchParams.delete(key)
  }
  return url.href
}

async function ownedTask(tx: Prisma.TransactionClient, scope: Scope) {
  const run = await tx.agentRun.findFirst({ where: { id: scope.runId, userId: scope.userId,
    sessionId: scope.sessionId, novelId: scope.novelId, novel: { authorId: scope.userId } } })
  if (!run) return denied()
  const spec = run.taskSpec == null ? null : taskSpecSchema.safeParse(run.taskSpec)
  if (spec && (!spec.success || spec.data.scope.novelId !== scope.novelId)) return denied()
  return { taskKey: run.taskRootId ?? (spec?.success ? spec.data.id : run.id), run, spec: spec?.success ? spec.data : null }
}

async function ownedSource(tx: Prisma.TransactionClient, scope: Scope, sourceId: string) {
  const { taskKey } = await ownedTask(tx, scope)
  const source = await tx.agentResearchSource.findFirst({ where: { id: sourceId, taskKey,
    ownerRun: { userId: scope.userId, sessionId: scope.sessionId, novelId: scope.novelId } } })
  if (!source || hash(source.canonicalUrl) !== source.urlHash) return denied()
  return source
}

export type ResearchSearchBudgetContext = { query: string; extension?: {
  gap: 'missing_target_text' | 'source_unavailable'; direction: 'open_web' | 'site' | 'chapter' | 'catalogue'; host?: string
} }

/** Cache identity ignores presentation and word order, never task ownership. */
export function normalizeResearchSearchQuery(query: string): string {
  return [...new Set(query.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}:./_-]+/gu, ' ').trim().split(/\s+/u))].sort().join(' ')
}

function searchDirection(query: string) {
  query = query.normalize('NFKC').replace(/[^\p{L}\p{N}:./_-]+/gu, ' ')
  const hosts = [...new Set([...query.matchAll(/(?<![-\w])site:((?:[a-z0-9-]+\.)+[a-z]{2,63})(?=[/\s]|$)/giu)].map(match => match[1].toLowerCase()))].sort()
  const purpose = /目录|章节列表|目次|catalog(?:ue)?|table of contents|site:[^\s]+\/page(?:[\s/]|$)/iu.test(query) ? 'catalogue'
    : /正文|原文|章节|全文|阅读|chapter|full text|site:[^\s]+\/reader(?:[\s/]|$)/iu.test(query) ? 'chapter' : 'general'
  return { hosts, purpose }
}

function newSearchDirection(query: string, previous: readonly string[]) {
  const current = searchDirection(query), prior = previous.map(searchDirection)
  if (!normalizeResearchSearchQuery(query) || previous.some(old => normalizeResearchSearchQuery(old) === normalizeResearchSearchQuery(query))
    || prior.some(old => old.hosts.join(' ') === current.hosts.join(' ') && old.purpose === current.purpose)) return false
  return current.hosts.some(host => !prior.some(old => old.hosts.includes(host)))
    || !current.hosts.length && prior.some(old => old.hosts.length)
    || current.purpose !== 'general'
}

async function legacyResearchRequestUnits(tx: Prisma.TransactionClient, scope: Scope, taskKey: string, kind: 'search' | 'read', callId = '') {
  const counts = await tx.$queryRaw<Array<{ units: bigint }>>`
    SELECT count(*) AS units FROM agent_run_events e JOIN agent_runs r ON r.id=e.run_id
    WHERE r.user_id=${scope.userId} AND r.session_id=${scope.sessionId} AND r.novel_id=${scope.novelId}
      AND (r.id=${scope.runId} OR r.task_root_id=${taskKey} OR (r.task_root_id IS NULL AND r.task_spec->>'id'=${taskKey}))
      AND e.type='tool.call' AND e.payload->>'toolName'=${kind === 'search' ? 'web_search' : 'web_read'}
      AND e.payload->'args' IS NOT NULL AND e.payload->'args'<>'null'::jsonb
      AND (${kind}='search' OR e.payload->'args'->>'contentRef' IS NULL)
      AND (${callId}='' OR NOT (e.run_id=${scope.runId} AND e.payload->>'callId'=${callId}))`
  return Number(counts[0].units)
}

async function researchRequestBudget(tx: Prisma.TransactionClient, scope: Scope, task: Awaited<ReturnType<typeof ownedTask>>,
  kind: 'search' | 'read', search?: ResearchSearchBudgetContext, requestKey?: string) {
  const scopeKey = hash(JSON.stringify([scope.userId, scope.sessionId, scope.novelId, task.taskKey]))
  const requests = await tx.agentResearchRequest.findMany({ where: { scopeKey, status: { not: 'released' } } })
  const matching = requests.filter(item => item.kind === kind)
  const used = matching.reduce((sum, item) => sum + item.units, 0)
    + (matching.some(item => item.status === 'baseline') ? 0 : await legacyResearchRequestUnits(tx, scope, task.taskKey, kind))
  const searches = requests.filter(item => item.kind === 'search' && item.status === 'consumed').flatMap(item => {
    const parsed = searchOutcomeSchema.safeParse(item.savedOutcome)
    const failed = parsed.success ? null : searchFailureSchema.safeParse(item.savedOutcome)
    return parsed.success && parsed.data.query ? [parsed.data.query] : failed?.success ? [failed.data.query] : []
  })
  const repeated = kind === 'search' && (matching.some(item => item.status !== 'baseline' && item.requestKey === requestKey)
    || !!search?.query && searches.some(query => normalizeResearchSearchQuery(query) === normalizeResearchSearchQuery(search.query)))
  let limit = kind === 'read' ? 8 : 5
  if (kind === 'search' && used >= 5 && used < 10 && search?.query && !repeated && newSearchDirection(search.query, searches)) {
    const spec = task.spec
    const qualified = await tx.agentResearchContent.findFirst({ where: { source: { taskKey: task.taskKey, ownerRun: sourceOwner(scope) }, contentKind: 'article',
      ...(spec && (spec.researchTarget || spec.researchNavigation) ? { AND: [
        { quality: { path: ['evidence', 'identity', 'status'], equals: 'verified' } },
        { quality: { path: ['evidence', 'identity', 'pageType'], equals: 'chapter' } },
        { quality: { path: ['evidence', 'integrity', 'status'], equals: 'source_compared' } },
      ] } : {}) }, select: { id: true } })
    const failedRead = requests.some(item => item.kind === 'read' && item.status === 'consumed' && item.savedOutcome
      && typeof item.savedOutcome === 'object' && !Array.isArray(item.savedOutcome) && item.savedOutcome.ok === false)
    // Actual missing text or a failed source supplies the gap; model callers
    // need no extra wire parameter to pursue a demonstrably new direction.
    if (!qualified && searches.length > 0 || failedRead) limit = 10
  }
  return { used, limit, remaining: repeated ? 0 : Math.max(0, limit - used) }
}

/** Read-only availability for the same task ledger used by every tool path.
 * Historical baseline rows are evidence, not mutable current policy settings. */
export async function readResearchRequestBudget(scope: Scope, kind: 'search' | 'read', transaction?: Prisma.TransactionClient,
  search?: ResearchSearchBudgetContext) {
  const read = async (tx: Prisma.TransactionClient) => researchRequestBudget(tx, scope, await ownedTask(tx, scope), kind, search)
  return transaction ? read(transaction) : researchTransaction(scope, read)
}

/** Durable task-scoped safety attempts. Saved content/cache hits never call this.
 * Historical calls seed a conservative baseline; a restart cannot reset it. */
export async function reserveResearchRequest(scope: Scope & Pick<ToolContext, 'callId' | 'webAdmission'>, kind: 'search' | 'read', requestKey: string, purpose?: 'navigation', transaction?: Prisma.TransactionClient, search?: ResearchSearchBudgetContext) {
  const reserve = async (tx: Prisma.TransactionClient) => {
    const task = await ownedTask(tx, scope)
    const { taskKey, run, spec: frozen } = task
    if (run.status !== 'running' && !scope.webAdmission) throw new DataAccessError(409, 'RESEARCH_RUN_NOT_ACTIVE', '任务已停止，未发起联网请求。')
    if (frozen?.networkAccess === 'denied') {
      throw new DataAccessError(403, 'RESEARCH_NETWORK_DENIED', '原始请求明确禁止联网，本次未预约、未请求供应商、未收工具费。')
    }
    const scopeKey = hash(JSON.stringify([scope.userId, scope.sessionId, scope.novelId, taskKey]))
    if (kind === 'read' && frozen?.researchReadAccess === 'denied') {
      throw new DataAccessError(403, 'RESEARCH_READ_DENIED', '原始请求只允许搜索，未预约、未读取网页、未收读取费。')
    }
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))::text`
    if (purpose) {
      if (kind !== 'read' || !frozen || frozen.researchNavigation?.version !== 1) {
        throw new DataAccessError(403, 'RESEARCH_NAVIGATION_DENIED', '本任务未冻结目录导航权限，未预约或发起请求。')
      }

    }
    if (frozen?.researchNavigation?.version === 1 && await tx.agentResearchRequest.findFirst({
      where: { scopeKey, kind: 'read', OR: [{ status: 'reserved' }, { status: 'consumed', savedOutcome: { equals: Prisma.DbNull } },
        { status: 'consumed', savedOutcome: { path: ['state'], equals: 'reserved' } }] },
    })) throw new DataAccessError(409, 'RESEARCH_REQUEST_UNCERTAIN', '已有页面请求结果待核对，未派发新的联网请求。')
    if (frozen?.researchNavigation?.version === 1 && await tx.webToolCall.findFirst({ where: { status: 'dispatched', run: {
      ...sourceOwner(scope), OR: [{ id: scope.runId }, { taskRootId: taskKey }, { taskSpec: { path: ['id'], equals: taskKey } }],
    } } })) throw new DataAccessError(409, 'RESEARCH_REQUEST_UNCERTAIN', '已有供应商请求结果未知，未派发新联网请求。')
    const id = hash(JSON.stringify([scopeKey, scope.runId, scope.callId]))
    const previous = await tx.agentResearchRequest.findUnique({ where: { id } })
    if (previous) throw new DataAccessError(409, 'RESEARCH_REQUEST_ALREADY_RESERVED',
      '此联网调用已有执行记录，未重复请求。请使用已保存的来源或核对原调用结果。')
    const baselineId = hash(JSON.stringify([scopeKey, kind, 'baseline']))
    let baseline = await tx.agentResearchRequest.findUnique({ where: { id: baselineId } })
    if (!baseline) {
      const units = await legacyResearchRequestUnits(tx, scope, taskKey, kind, scope.callId)
      baseline = await tx.agentResearchRequest.create({ data: { id: baselineId, ownerRunId: scope.runId, scopeKey, kind,
        units, requestKey: hash('legacy-baseline'), requestLimit: kind === 'search' ? 5 : 8, status: 'baseline' } })
    }
    const budget = await researchRequestBudget(tx, scope, task, kind, search, requestKey)
    if (!budget.remaining) return false
    await tx.agentResearchRequest.create({ data: { id, ownerRunId: scope.runId, scopeKey, kind, requestKey, requestLimit: budget.limit,
      ...(purpose ? { savedOutcome: { purpose, state: 'reserved' } } : {}) } })
    return true
  }
  const admitted = (tx: Prisma.TransactionClient) => scope.webAdmission ? scope.webAdmission(tx, () => reserve(tx)) : reserve(tx)
  return transaction ? admitted(transaction) : prisma.$transaction(admitted)
}

export async function settleResearchRequest(scope: Scope & { callId: string }, status: 'consumed' | 'released', transaction?: Prisma.TransactionClient) {
  const settle = async (tx: Prisma.TransactionClient) => {
    const { taskKey } = await ownedTask(tx, scope)
    const scopeKey = hash(JSON.stringify([scope.userId, scope.sessionId, scope.novelId, taskKey]))
    const id = hash(JSON.stringify([scopeKey, scope.runId, scope.callId]))
    await tx.agentResearchRequest.updateMany({ where: { id, ownerRunId: scope.runId, scopeKey, status: 'reserved' }, data: { status } })
  }
  return transaction ? settle(transaction) : prisma.$transaction(settle)
}

/** Persist each real transport outcome; failed URLs do not stop other sources. */
export async function recordResearchReadOutcome(scope: Scope & { callId: string }, ok: boolean) {
  return researchTransaction(scope, async tx => {
    const { taskKey } = await ownedTask(tx, scope)
    const scopeKey = hash(JSON.stringify([scope.userId, scope.sessionId, scope.novelId, taskKey]))
    const id = hash(JSON.stringify([scopeKey, scope.runId, scope.callId]))
    const request = await tx.agentResearchRequest.findUnique({ where: { id } })
    const navigation = request?.savedOutcome && typeof request.savedOutcome === 'object' && !Array.isArray(request.savedOutcome)
      && request.savedOutcome.purpose === 'navigation' && request.savedOutcome.ok === undefined
    await tx.agentResearchRequest.updateMany({ where: { id, scopeKey, kind: 'read', status: 'consumed',
      savedOutcome: navigation ? { equals: request!.savedOutcome as Prisma.InputJsonValue } : { equals: Prisma.DbNull } },
      data: { savedOutcome: { ...(navigation ? { purpose: 'navigation' } : {}), ok } } })
  })
}

const searchOutcomeSchema = z.object({ provider: z.enum(['bocha', 'deepseek', 'sogou', 'bing']),
  query: z.string().max(120).optional(),
  results: z.array(z.object({ title: z.string(), url: z.string().max(8192), snippet: z.string(), source: z.string() })).max(8),
  navigation: z.object({ provider: z.enum(['bocha', 'deepseek', 'sogou', 'bing']),
    results: z.array(z.object({ title: z.string(), url: z.string().max(8192), snippet: z.string(), source: z.string() })).max(2) }).optional() })

const searchFailureSchema = z.object({ kind: z.literal('known_http_failure'), query: z.string().max(120),
  failures: z.array(z.object({ provider: z.string(), httpStatus: z.number().int().min(400).max(599) })) })

/** Only a confirmed original non-billable failure can resolve this same request.
 * A refund alone never upgrades an unknown supplier response to a known one. */
export async function recordResearchSearchFailure(scope: Scope & { callId: string }, request: { query: string; count: number },
  failures: Array<{ provider: string; httpStatus: number }>) {
  return researchTransaction(scope, async tx => {
    const { taskKey } = await ownedTask(tx, scope)
    const receiptId = hash(JSON.stringify([scope.userId, scope.runId, scope.callId, 'search']))
    const receipt = await tx.webToolCall.findUnique({ where: { id: receiptId } })
    if (!receipt || receipt.runId !== scope.runId || receipt.kind !== 'search' || receipt.status !== 'failed'
      || receipt.requestHash !== hash(JSON.stringify(request))) return false
    if (receipt.amountMilli > 0 && !await tx.creditRefundIntent.findFirst({ where: {
      originalEntry: { userId: scope.userId, idempotencyKey: `web-search:${scope.runId}:${scope.callId}` },
      reason: 'web_tool_no_billable_result', AND: [
        { evidence: { path: ['callId'], equals: receipt.id } }, { evidence: { path: ['outcome'], equals: 'failed' } },
      ],
    } })) return false
    const scopeKey = hash(JSON.stringify([scope.userId, scope.sessionId, scope.novelId, taskKey]))
    const id = hash(JSON.stringify([scopeKey, scope.runId, scope.callId]))
    const savedOutcome = { kind: 'known_http_failure', query: request.query, failures }
    await tx.agentResearchRequest.updateMany({ where: { id, ownerRunId: scope.runId, scopeKey, kind: 'search', status: 'consumed', savedOutcome: { equals: Prisma.DbNull } },
      data: { savedOutcome } })
    return true
  })
}

/** Persist only bounded public results, not provider credentials or trace IDs. */
export async function saveResearchSearchOutcome(scope: Scope & { callId: string }, outcome: unknown, query?: string) {
  const parsed = searchOutcomeSchema.parse(outcome)
  const savedOutcome = { provider: parsed.provider, ...(query ? { query: query.slice(0, 120) } : {}), results: parsed.results.map(result => ({
    title: result.title.slice(0, 300), url: canonicalResearchUrl(result.url), snippet: result.snippet.slice(0, 300), source: result.source.slice(0, 300),
  })), ...(parsed.navigation ? { navigation: { provider: parsed.navigation.provider, results: parsed.navigation.results.map(result => ({
    title: result.title.slice(0, 300), url: canonicalResearchUrl(result.url), snippet: result.snippet.slice(0, 300), source: result.source.slice(0, 300),
  })) } } : {}) }
  return researchTransaction(scope, async tx => {
    const { taskKey } = await ownedTask(tx, scope)
    const scopeKey = hash(JSON.stringify([scope.userId, scope.sessionId, scope.novelId, taskKey]))
    const id = hash(JSON.stringify([scopeKey, scope.runId, scope.callId]))
    await tx.agentResearchRequest.updateMany({ where: { id, scopeKey, kind: 'search', status: 'consumed', savedOutcome: { equals: Prisma.DbNull } },
      data: { savedOutcome } })
  })
}

export async function findResearchSearchOutcome(scope: Scope, requestKey: string, query?: string) {
  return researchTransaction(scope, async tx => {
    const { taskKey } = await ownedTask(tx, scope)
    const scopeKey = hash(JSON.stringify([scope.userId, scope.sessionId, scope.novelId, taskKey]))
    const saved = await tx.agentResearchRequest.findFirst({ where: { scopeKey, kind: 'search', requestKey,
      status: 'consumed', savedOutcome: { not: Prisma.DbNull } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { savedOutcome: true } })
    if (saved) {
      if (searchFailureSchema.safeParse(saved.savedOutcome).success) return null
      return searchOutcomeSchema.parse(saved.savedOutcome)
    }
    if (!query) return null
    const previous = await tx.agentResearchRequest.findMany({ where: { scopeKey, kind: 'search', status: 'consumed', savedOutcome: { not: Prisma.DbNull } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { savedOutcome: true } })
    for (const entry of previous) {
      const parsed = searchOutcomeSchema.safeParse(entry.savedOutcome)
      if (parsed.success && parsed.data.query && normalizeResearchSearchQuery(parsed.data.query) === normalizeResearchSearchQuery(query)) return parsed.data
    }
    return null
  })
}

/** Web reads may follow discovered links or a URL explicitly supplied by the
 * author, never invent a chapter ID. This is provenance, not proof of content. */
export async function assertResearchUrlProvenance(scope: Scope, value: string) {
  const url = canonicalResearchUrl(value)
  return researchTransaction(scope, async tx => {
    const { taskKey, run } = await ownedTask(tx, scope)
    const spec = taskSpecSchema.safeParse(run.taskSpec)
    const source = await tx.agentResearchSource.findFirst({ where: { taskKey, canonicalUrl: url,
      ownerRun: { userId: scope.userId, sessionId: scope.sessionId, novelId: scope.novelId } } })
    if (source) return
    const messages = await tx.agentMessage.findMany({ where: { sessionId: scope.sessionId, role: 'user',
      run: { userId: scope.userId, novelId: scope.novelId, ...(spec.success
        ? { taskSpec: { path: ['id'], equals: spec.data.id } } : { id: scope.runId }) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 32, select: { parts: true } })
    for (const message of messages) for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (!part || typeof part !== 'object' || Array.isArray(part) || part.type !== 'text' || typeof part.text !== 'string') continue
      for (const match of part.text.matchAll(/https?:\/\/[^\s<>"'）】。，；！]+/gu)) {
        for (const candidate of [match[0], match[0].replace(/[)\],.!?]+$/u, '')]) {
          try { if (canonicalResearchUrl(candidate) === url) return } catch { /* Not an eligible public URL. */ }
        }
      }
    }
    throw new DataAccessError(422, 'WEB_READ_UNDISCOVERED_URL', '该地址不在本任务的搜索结果、已读取页面链接或用户提供的链接中。本次未联网；请搜索真实链接，不要猜测书籍或章节编号。')
  })
}

/** URL registration is discovery only, not a claim that its body was fetched. */
export async function registerResearchSource(scope: Scope, url: string, title = '') {
  return (await registerResearchSources(scope, [{ url, title }]))[0]
}

/** A bounded discovery batch shares one ownership check and transaction. */
export async function registerResearchSources(scope: Scope, entries: ReadonlyArray<{ url: string; title: string }>) {
  if (entries.length < 1 || entries.length > 8) throw new DataAccessError(400, 'RESEARCH_SOURCE_BATCH_INVALID', '来源批次必须为1至8项。')
  const sources = entries.map(entry => ({ canonicalUrl: canonicalResearchUrl(entry.url), title: entry.title.slice(0, 300) }))
  return researchTransaction(scope, async tx => {
    const { taskKey } = await ownedTask(tx, scope)
    return Promise.all(sources.map(({ canonicalUrl, title }) => {
      const urlHash = hash(canonicalUrl)
      const id = hash(JSON.stringify([scope.userId, scope.sessionId, scope.novelId, taskKey, urlHash]))
      return tx.agentResearchSource.upsert({ where: { id }, update: {}, create: {
        id, ownerRunId: scope.runId, taskKey, urlHash, canonicalUrl, title,
      } })
    }))
  })
}

export async function resolveResearchSource(scope: Scope, sourceId: string) {
  return researchTransaction(scope, tx => ownedSource(tx, scope, sourceId))
}

/** The model cannot replace the original task's named work or author. */
export async function getResearchReadTarget(scope: Scope): Promise<(ReaderTarget & { textAnalysisRequired?: boolean }) | undefined> {
  return researchTransaction(scope, async tx => {
    const { spec, taskKey } = await ownedTask(tx, scope)
    if (spec?.researchNavigation) {
      const sourceHosts = await originalResearchSourceHosts(tx, scope, spec)
      const chapterTitle = researchChapterTitle(await originalResearchPrompt(tx, scope, spec) ?? '')
      const selected = await readResearchSelection(tx, scope, taskKey)
      const target = selected?.target ?? spec.researchTarget ?? { title: '' }
      return { ...target, sourceHosts, ...(chapterTitle ? { chapterTitle } : {}) }
    }
    return spec?.researchTarget
  })
}

/** Shared original source host/path policy, independent from query hints. */
export function researchSourceWithinScope(url: string, target?: { sourceHosts?: readonly string[] }, sourceSites: readonly string[] = []) {
  return evaluateResearchSearchCandidates(sourceSites.join(' '), [{ url, title: '', snippet: '', source: '' }], { title: '', sourceHosts: target?.sourceHosts }).eligibleCount > 0
}

export async function getResearchNavigationPolicy(scope: Scope) {
  return researchTransaction(scope, async tx => {
    const { spec, taskKey } = await ownedTask(tx, scope)
    if (!spec) return undefined
    const alternativeChosen = spec.researchNavigation ? await tx.agentArtifact.findUnique({ where: {
      id: hash(JSON.stringify(['research-alternative-identity-v1', scope.userId, scope.sessionId, taskKey])),
    }, select: { id: true } }) : null
    return spec.intent === 'research_analysis' && spec.researchNavigation ? { ...spec.researchNavigation,
      sourceHosts: await originalResearchSourceHosts(tx, scope, spec),
      alternativeAvailable: !alternativeChosen && spec.researchNavigation.alternativeSelection === 'after_preferred_unavailable'
        && await preferredResearchUnavailable(tx, scope, taskKey) } : undefined
  })
}

/** Old selections may include an inferred first-site host. Only the actual
 * original author's source restriction controls future reads; saved hashes stay. */
async function originalResearchPrompt(tx: Prisma.TransactionClient, scope: Scope, spec: TaskSpec) {
  const requestHash = spec.researchNavigation?.requestHash
  if (!requestHash) return null
  const goal = spec.goals.find(text => hash(text) === requestHash)
  if (goal) return goal
  const messages = await tx.agentMessage.findMany({ where: { sessionId: scope.sessionId, role: 'user',
    run: { ...sourceOwner(scope), taskSpec: { path: ['id'], equals: spec.id } } }, take: 32, select: { parts: true } })
  for (const message of messages) for (const part of Array.isArray(message.parts) ? message.parts : []) {
    if (part && typeof part === 'object' && !Array.isArray(part) && part.type === 'text' && typeof part.text === 'string'
      && hash(part.text) === requestHash) return part.text
  }
  return null
}
async function originalResearchSourceHosts(tx: Prisma.TransactionClient, scope: Scope, spec: TaskSpec) {
  const frozen = spec.researchTarget?.sourceHosts ?? spec.researchNavigation?.sourceHosts ?? []
  if (!frozen.length) return frozen
  const prompt = await originalResearchPrompt(tx, scope, spec)
  return prompt === null ? frozen : researchSourceHosts(prompt)
}

async function researchSearchDiscoveries(tx: Prisma.TransactionClient, scope: Scope, taskKey: string) {
  const searches = await tx.agentResearchRequest.findMany({ where: { ownerRun: { ...sourceOwner(scope),
    OR: [{ id: scope.runId }, { taskRootId: taskKey }, { taskSpec: { path: ['id'], equals: taskKey } }] },
    kind: 'search', status: 'consumed', savedOutcome: { not: Prisma.DbNull } }, orderBy: { createdAt: 'desc' } })
  return searches.flatMap(search => { const saved = searchOutcomeSchema.safeParse(search.savedOutcome); return saved.success ? [saved.data] : [] })
}

async function directlyDiscoveredResearchUrl(tx: Prisma.TransactionClient, scope: Scope, taskKey: string, spec: TaskSpec, url: string) {
  for (const saved of await researchSearchDiscoveries(tx, scope, taskKey)) {
    if ([...saved.results, ...(saved.navigation?.results ?? [])].some(result => result.url === url)) return true
  }
  const prompt = await originalResearchPrompt(tx, scope, spec)
  for (const match of (prompt ?? '').matchAll(/https?:\/\/[^\s<>"'）】。，；！]+/gu)) {
    try { if (canonicalResearchUrl(match[0].replace(/[)\],.!?]+$/u, '')) === url) return true } catch { /* Not an original public URL. */ }
  }
  return false
}

const selectionSchema = z.object({ version: z.literal(1), kind: z.literal('researchSelectedIdentity'), taskKey: z.string(),
  sourceId: z.string(), contentRef: z.string(), revision: z.string(), identityHash: z.string(),
  target: z.object({ title: z.string(), author: z.string(), sourceHosts: z.array(z.string()) }).strict() }).strict()
const identityHash = (target: { title: string; author?: string; sourceHosts?: readonly string[] }) => hash(JSON.stringify({
  title: target.title.normalize('NFC').trim(), author: target.author?.normalize('NFC').trim(), sourceHosts: target.sourceHosts,
}))
const bindingSchema = z.object({ purpose: z.enum(['navigation', 'body']), identityHash: z.string().optional(),
  parent: z.object({ contentRef: z.string(), revision: z.string() }).strict().optional() }).strict()
function checkedResearchMetadata(content: { contentHash: string; finalUrl: string; contentKind: string; text: string; revision: string; quality: Prisma.JsonValue }) {
  const metadata = content.quality && typeof content.quality === 'object' && !Array.isArray(content.quality) ? content.quality : null
  const links = checkedSavedLinks(metadata?.links, content.finalUrl)
  const evidence = metadata?.revisionVersion === 3 || metadata?.revisionVersion === 4 && metadata.evidence != null ? readerEvidenceSchema.parse(metadata.evidence) : undefined
  const binding = metadata?.revisionVersion === 4 ? bindingSchema.parse(metadata.binding) : undefined
  const parts = [content.contentHash, content.finalUrl, content.contentKind]
  const sealed = metadata?.revisionVersion === 4 ? [...parts, links, evidence ?? null, binding] : metadata?.revisionVersion === 3
    ? [...parts, links, evidence] : metadata?.revisionVersion === 2 ? [...parts, links] : parts
  if (hash(content.text) !== content.contentHash || hash(JSON.stringify(sealed)) !== content.revision) {
    throw new DataAccessError(409, 'RESEARCH_REVISION_MISMATCH', '正文版本或来源关系不一致，不能用于引用。')
  }
  return { links, evidence, binding }
}
const sourceOwner = (scope: Scope) => ({ userId: scope.userId, sessionId: scope.sessionId, novelId: scope.novelId })
async function readResearchSelection(tx: Prisma.TransactionClient, scope: Scope, taskKey: string) {
  const preferredId = hash(JSON.stringify(['research-selected-identity-v1', scope.userId, scope.sessionId, taskKey]))
  const alternativeId = hash(JSON.stringify(['research-alternative-identity-v1', scope.userId, scope.sessionId, taskKey]))
  const record = await tx.agentArtifact.findUnique({ where: { id: alternativeId }, include: { run: true } })
    ?? await tx.agentArtifact.findUnique({ where: { id: preferredId }, include: { run: true } })
  if (!record) return null
  const parsed = selectionSchema.safeParse(record.metadata)
  if (record.artifactType !== 'contextCheckpoint' || record.content !== '' || !parsed.success || parsed.data.taskKey !== taskKey
    || record.run.userId !== scope.userId || record.run.sessionId !== scope.sessionId || record.run.novelId !== scope.novelId) return denied()
  const selected = parsed.data
  const content = await tx.agentResearchContent.findUnique({ where: { id: selected.contentRef } })
  if (!content || content.sourceId !== selected.sourceId || content.revision !== selected.revision) return denied()
  await ownedSource(tx, scope, content.sourceId)
  const metadata = checkedResearchMetadata(content)
  const actual = metadata.evidence?.identity
  if (!actual || actual.title !== selected.target.title || actual.author !== selected.target.author
    || identityHash(selected.target) !== selected.identityHash) return denied()
  return selected
}

/** Empty searches, PUA, timeouts and model assertions cannot unlock a switch.
 * A previously verified preferred book/chapter version must subsequently have
 * an owned direct access/not-found receipt. First-read identity remains unknown. */
async function preferredResearchUnavailable(tx: Prisma.TransactionClient, scope: Scope, taskKey: string) {
  const id = hash(JSON.stringify(['research-selected-identity-v1', scope.userId, scope.sessionId, taskKey]))
  const record = await tx.agentArtifact.findUnique({ where: { id } })
  if (!record) return false
  const selected = selectionSchema.parse(record.metadata)
  const preferred = await tx.agentResearchContent.findUnique({ where: { id: selected.contentRef } })
  if (!preferred || preferred.revision !== selected.revision) return false
  await ownedSource(tx, scope, preferred.sourceId)
  const metadata = checkedResearchMetadata(preferred)
  const versions = await tx.agentResearchContent.findMany({ where: { source: { taskKey, ownerRun: sourceOwner(scope) } },
    include: { source: true }, take: 8, orderBy: { createdAt: 'desc' } })
  for (const page of versions) {
    const proof = checkedResearchMetadata(page), actual = proof.evidence?.identity
    const failure = failureSchema.safeParse(page.source.readFailure)
    if (actual?.status !== 'verified' || actual.title !== selected.target.title || actual.author !== selected.target.author
      || !['book', 'chapter'].includes(actual.pageType) || !failure.success || !failure.data.directFinalUrl || !failure.data.directReceiptId
      || failure.data.directFinalUrl !== page.finalUrl || !['WEB_READ_NOT_FOUND', 'WEB_READ_BLOCKED'].includes(failure.data.code)) continue
    const receipt = await tx.webToolCall.findFirst({ where: { id: failure.data.directReceiptId, kind: 'fetch', status: 'completed', run: sourceOwner(scope) } })
    const outcome = receipt?.outcome
    if (outcome && typeof outcome === 'object' && !Array.isArray(outcome) && outcome.provider === 'direct'
      && outcome.code === failure.data.code && outcome.finalUrl === failure.data.directFinalUrl
      && (page.sourceId === preferred.sourceId || metadata.links.some(link => link.url === page.source.canonicalUrl))) return true
  }
  return false
}

export async function assertResearchAlternativeAllowed(scope: Scope) {
  return researchTransaction(scope, async tx => {
    const { run, taskKey } = await ownedTask(tx, scope)
    const spec = taskSpecSchema.parse(run.taskSpec)
    if (spec.researchNavigation?.alternativeSelection !== 'after_preferred_unavailable'
      || !await preferredResearchUnavailable(tx, scope, taskKey)
      || await tx.agentArtifact.findUnique({ where: { id: hash(JSON.stringify(['research-alternative-identity-v1', scope.userId, scope.sessionId, taskKey])) } })) {
      throw new DataAccessError(403, 'RESEARCH_ALTERNATIVE_DENIED', '没有满足原始授权的首选公开来源不可用证据，或已选定替代作品；未换书、未联网。')
    }
  })
}

/** Only discovered public metadata gets this lane, never an inferred URL. */
export async function authorizeResearchNavigation(scope: Scope, sourceId: string, alternative = false) {
  if (alternative) await assertResearchAlternativeAllowed(scope)
  return researchTransaction(scope, async tx => {
    const { spec, taskKey } = await ownedTask(tx, scope)
    const source = await ownedSource(tx, scope, sourceId)
    if (!spec?.researchNavigation || spec.intent !== 'research_analysis' || spec.networkAccess === 'denied' || spec.researchReadAccess === 'denied') {
      throw new DataAccessError(403, 'RESEARCH_NAVIGATION_DENIED', '本任务没有获准的导航用途，未发起请求。')
    }
    const sourceHosts = await originalResearchSourceHosts(tx, scope, spec)
    const target = { ...((await readResearchSelection(tx, scope, taskKey))?.target ?? spec.researchTarget ?? { title: '' }), sourceHosts }
    if (!researchSourceWithinScope(source.canonicalUrl, target, spec.researchNavigation.sourceSites)) {
      throw new DataAccessError(403, 'RESEARCH_NAVIGATION_DENIED', '导航地址超出原始来源范围，未发起请求。')
    }
    if (await findNavigationParent(tx, scope, taskKey, source.canonicalUrl)) return
    for (const saved of await researchSearchDiscoveries(tx, scope, taskKey)) {
      const results = [...saved.results, ...(saved.navigation?.results ?? [])]
      if (evaluateResearchNavigationCandidates(results, target, spec.researchNavigation.sourceSites, alternative).some(item => canonicalResearchUrl(item.url) === source.canonicalUrl)) return
    }
    const prompt = await originalResearchPrompt(tx, scope, spec)
    for (const match of (prompt ?? '').matchAll(/https?:\/\/[^\s<>"'）】。，；！]+/gu)) {
      try { if (canonicalResearchUrl(match[0].replace(/[)\],.!?]+$/u, '')) === source.canonicalUrl) return } catch { /* Not an original public URL. */ }
    }
    throw new DataAccessError(403, 'RESEARCH_NAVIGATION_UNRELATED', '未发现与目标有关的真实导航线索，未发起请求。')
  })
}

async function findNavigationParent(tx: Prisma.TransactionClient, scope: Scope, taskKey: string, url: string) {
  const pages = await tx.agentResearchContent.findMany({ where: { finalUrl: { not: url }, source: { taskKey, canonicalUrl: { not: url }, ownerRun: sourceOwner(scope) } },
    take: 8, orderBy: { createdAt: 'desc' } })
  for (const page of pages) {
    const metadata = checkedResearchMetadata(page)
    if (metadata.links.some(link => link.url === url)) return { contentRef: page.id, revision: page.revision }
  }
  return null
}

async function assertChosenResearchLineage(tx: Prisma.TransactionClient, scope: Scope, selected: z.infer<typeof selectionSchema>, sourceId: string,
  parent?: { contentRef: string; revision: string }) {
  if (sourceId === selected.sourceId) return
  let source = await ownedSource(tx, scope, sourceId)
  const { spec } = await ownedTask(tx, scope)
  let link = parent
  for (let hop = 0; link && hop < 3; hop++) {
    const page = await tx.agentResearchContent.findUnique({ where: { id: link.contentRef } })
    if (!page || page.revision !== link.revision) break
    const metadata = checkedResearchMetadata(page)
    if (!metadata.links.some(item => item.url === source.canonicalUrl)) break
    source = await ownedSource(tx, scope, page.sourceId)
    if (page.id === selected.contentRef && page.revision === selected.revision) return
    const actual = metadata.evidence?.identity
    if (spec && actual?.status === 'verified' && actual.pageType === 'book' && actual.title === selected.target.title
      && actual.author === selected.target.author && await directlyDiscoveredResearchUrl(tx, scope, selected.taskKey, spec, source.canonicalUrl)) return
    link = metadata.binding?.parent
  }
  // Callers already checked actual chapter title/author and source-compared
  // text. A real search URL supplies provenance only, never that identity proof.
  const original = await ownedSource(tx, scope, sourceId)
  if (spec && await directlyDiscoveredResearchUrl(tx, scope, selected.taskKey, spec, original.canonicalUrl)) return
  throw new DataAccessError(422, 'RESEARCH_SOURCE_LINEAGE_REQUIRED', '章节没有连接到已核验同书的真实目录、搜索发现或原作者提供的地址；不能用任意页面链接冒充同书正文。')
}

async function currentResearchTargetAnalysis(tx: Prisma.TransactionClient, scope: Scope, taskKey: string, sections: z.infer<typeof reportSectionSchema>[]) {
  const selected = await readResearchSelection(tx, scope, taskKey)
  if (!selected) return false
  const analysis = sections.filter(section => (section.evidenceKind ?? 'analysis') === 'analysis')
  if (!analysis.length) return false
  for (const section of analysis) {
    const citations = section.citations.filter(citation => (citation.purpose ?? 'target_text') === 'target_text')
    if (!citations.length) return false
    for (const citation of citations) {
      const page = await tx.agentResearchContent.findUnique({ where: { id: citation.contentRef } })
      if (!page || page.revision !== citation.revision || page.contentKind !== 'article' || citation.end > page.text.length
        || hash(page.text.slice(citation.start, citation.end)) !== citation.excerptHash) return false
      await ownedSource(tx, scope, page.sourceId)
      const metadata = checkedResearchMetadata(page), actual = metadata.evidence?.identity
      if (metadata.binding?.purpose !== 'body' || metadata.binding.identityHash !== selected.identityHash || actual?.status !== 'verified'
        || actual.pageType !== 'chapter' || actual.title !== selected.target.title || actual.author !== selected.target.author
        || metadata.evidence?.integrity.status !== 'source_compared') return false
      try { await assertChosenResearchLineage(tx, scope, selected, page.sourceId, metadata.binding.parent) } catch { return false }
    }
  }
  return true
}

/** A continuation reads its saved snapshot unless an explicit refresh is
 * requested. No network request, quota reset, or cross-task content cache. */
export async function findSavedResearchContent(scope: Scope, sourceId: string, purpose?: 'navigation') {
  return researchTransaction(scope, async tx => {
    await ownedSource(tx, scope, sourceId)
    const { run } = await ownedTask(tx, scope)
    const fresh = taskSpecSchema.safeParse(run.taskSpec)
    const selected = fresh.success && fresh.data.researchNavigation ? await readResearchSelection(tx, scope, (await ownedTask(tx, scope)).taskKey) : null
    return tx.agentResearchContent.findFirst({ where: { sourceId, ...(fresh.success && fresh.data.researchNavigation
      ? { AND: [{ quality: { path: ['binding', 'purpose'], equals: purpose ?? 'body' } },
        ...(!purpose && selected ? [{ quality: { path: ['binding', 'identityHash'], equals: selected.identityHash } }] : [])] } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, revision: true } })
  })
}

/** Look up before reserving a new fetch: an existing negative cache is not a request. */
export async function findResearchSource(scope: Scope, value: string) {
  const canonicalUrl = canonicalResearchUrl(value)
  return researchTransaction(scope, async tx => {
    const { taskKey } = await ownedTask(tx, scope)
    const id = hash(JSON.stringify([scope.userId, scope.sessionId, scope.novelId, taskKey, hash(canonicalUrl)]))
    const source = await tx.agentResearchSource.findUnique({ where: { id } })
    return source ? ownedSource(tx, scope, id) : null
  })
}

const failureSchema = z.object({
  code: z.enum(['WEB_READ_NOT_FOUND', 'WEB_READ_BLOCKED', 'WEB_READ_GARBLED', 'WEB_READ_RATE_LIMITED',
    'WEB_READ_INSUFFICIENT', 'WEB_READ_INCOMPLETE', 'WEB_READ_UNAVAILABLE', 'WEB_READ_HOSTED_UNAVAILABLE',
    'WEB_READ_TOO_LARGE', 'WEB_READ_UNSAFE_URL', 'WEB_READ_UNSUPPORTED_TYPE', 'WEB_READ_HTTP_ERROR',
    'WEB_READ_SOURCE_ERROR', 'WEB_READ_PROTOCOL_ERROR', 'WEB_READ_PARSE_ERROR',
    'WEB_READ_COMPLEX_DOCUMENT', 'WEB_READ_HOSTED_TARGET_RESTRICTED',
    'WEB_READ_PROVIDER_PROTOCOL_ERROR', 'WEB_READ_HOSTED_NO_CONTENT', 'WEB_READ_PROVIDER_400', 'WEB_READ_PROVIDER_401', 'WEB_READ_PROVIDER_402',
    'TOOL_CONFIG_INCOMPLETE', 'TOOL_CONFIG_UNAVAILABLE', 'WEB_TOOL_PROVIDER_UNSUPPORTED', 'WEB_TOOL_ENDPOINT_INVALID']),
  retryAt: z.string().datetime(),
  directFinalUrl: z.string().max(8192).optional(),
  directReceiptId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict()

export async function getResearchReadFailure(scope: Scope, sourceId: string) {
  return researchTransaction(scope, async tx => {
    const source = await ownedSource(tx, scope, sourceId)
    const { run, taskKey } = await ownedTask(tx, scope)
    const spec = taskSpecSchema.safeParse(run.taskSpec)
    const sameFinal = source.readFailure === null && spec.success && spec.data.researchNavigation ? await tx.agentResearchSource.findFirst({
      where: { taskKey, ownerRun: sourceOwner(scope), readFailure: { path: ['directFinalUrl'], equals: source.canonicalUrl } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { readFailure: true },
    }) : null
    const failure = source.readFailure ?? sameFinal?.readFailure
    if (failure == null) return null
    const parsed = failureSchema.safeParse(failure)
    if (!parsed.success) throw new DataAccessError(409, 'RESEARCH_SOURCE_STATE_INVALID', '来源读取状态异常，未重新访问网站。')
    return Date.parse(parsed.data.retryAt) > Date.now() ? parsed.data : null
  })
}

/** Preserve access denials across resume without storing raw provider responses.
 * 429 Retry-After is a lower bound, not a delay the model may choose to ignore. */
export async function recordResearchReadFailure(scope: Scope & { callId?: string }, sourceId: string, result: WebReadResult, request?: unknown) {
  if (result.status === 'ok' || !failureSchema.shape.code.safeParse(result.code).success) return
  const now = Date.now()
  let retryAt = now + (result.retryable ? 60_000 : 5 * 60_000)
  if (result.code === 'WEB_READ_RATE_LIMITED') {
    const header = result.retryAfter?.trim() ?? ''
    const seconds = /^\d+$/.test(header) ? Number(header) : NaN
    const requested = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(header)
    retryAt = Number.isFinite(requested) && requested > now && requested <= 8.64e15 ? requested : now + 60_000
  }
  await researchTransaction(scope, async tx => {
    await ownedSource(tx, scope, sourceId)
    await tx.$queryRaw`SELECT id FROM agent_research_sources WHERE id = ${sourceId} FOR UPDATE`
    const source = await ownedSource(tx, scope, sourceId)
    const previous = failureSchema.safeParse(source.readFailure)
    const { run } = await ownedTask(tx, scope)
    const spec = taskSpecSchema.safeParse(run.taskSpec)
    let directReceiptId: string | undefined
    if (spec.success && spec.data.researchNavigation && result.provider === 'direct' && scope.callId && request) {
      const id = hash(JSON.stringify([scope.userId, scope.runId, scope.callId, 'fetch']))
      const receipt = await tx.webToolCall.findUnique({ where: { id } })
      const outcome = receipt?.outcome
      if (receipt?.runId === scope.runId && receipt.kind === 'fetch' && receipt.status === 'completed' && receipt.requestHash === hash(JSON.stringify(request))
        && outcome && typeof outcome === 'object' && !Array.isArray(outcome) && outcome.provider === 'direct'
        && outcome.code === result.code && outcome.finalUrl === result.finalUrl) directReceiptId = id
    }
    // A late timeout must not shorten a Retry-After already received by another attempt.
    if (previous.success && Date.parse(previous.data.retryAt) > retryAt) return
    await tx.agentResearchSource.update({ where: { id: sourceId }, data: { readFailure: { code: result.code, retryAt: new Date(retryAt).toISOString(),
      ...(directReceiptId ? { directFinalUrl: canonicalResearchUrl(result.finalUrl), directReceiptId } : {}) } } })
  })
}

/** Immutable successful extraction, not an analysis/coverage receipt. Failed,
 * restricted or garbled pages cannot enter the readable content store. */
export async function saveResearchContent(scope: Scope, sourceId: string, result: WebReadResult, alternative = false, sourceScopeAdmitted = false) {
  const checked = assessReaderText(result.text, result.title)
  const navigation = result.purpose === 'navigation'
  const evidence = result.evidence ? readerEvidenceSchema.parse(result.evidence) : undefined
  const provenShortPreview = isResearchPreviewEvidence(evidence) && evidence?.identity.status === 'verified' && evidence.identity.pageType === 'chapter'
    && checked.code === 'WEB_READ_INSUFFICIENT' && Boolean(result.text.trim())
  if (result.status !== 'ok' || !result.quality.readable || (checked.status !== 'ok' && !(navigation && result.text.trim()
    && !/[\p{Co}\uFFFD]/u.test(result.text)) && !provenShortPreview)
    || !['article', 'metadata'].includes(result.contentKind)) {
    throw new DataAccessError(422, 'RESEARCH_CONTENT_UNREADABLE', '未取得合格正文，不能保存为已获取内容。')
  }
  if (Buffer.byteLength(result.text, 'utf8') > 2 * 1024 * 1024) throw new DataAccessError(413, 'RESEARCH_CONTENT_TOO_LARGE', '提取内容超过保存上限。')
  const finalUrl = canonicalResearchUrl(result.finalUrl)
  const links = checkedSavedLinks(result.links, finalUrl)
  if (evidence && (evidence.integrity.status === 'damaged' || evidence.integrity.extractedHash !== hash(result.text))) {
    throw new DataAccessError(422, 'RESEARCH_CONTENT_UNREADABLE', '正文完整性证据与提取内容不一致，未保存为已获取内容。')
  }
  const contentHash = hash(result.text)
  return researchTransaction(scope, async tx => {
    const source = await ownedSource(tx, scope, sourceId)
    const { spec: originalSpec, taskKey } = await ownedTask(tx, scope)
    const spec = originalSpec ?? { researchNavigation: undefined, researchTarget: undefined }
    const fresh = Boolean(spec.researchNavigation)
    const scopeKey = hash(JSON.stringify([scope.userId, scope.sessionId, scope.novelId, taskKey]))
    if (fresh) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))::text`
    const frozenHosts = originalSpec?.researchNavigation ? await originalResearchSourceHosts(tx, scope, originalSpec) : spec.researchTarget?.sourceHosts
    if (fresh && (!sourceScopeAdmitted || finalUrl !== source.canonicalUrl) && !researchSourceWithinScope(finalUrl, { sourceHosts: frozenHosts }, spec.researchNavigation?.sourceSites)) {
      throw new DataAccessError(403, 'RESEARCH_SOURCE_SCOPE_MISMATCH', '页面最终地址超出原始来源范围，未保存为目标证据。')
    }
    if (navigation && (!fresh || result.contentKind !== 'metadata' || !evidence || evidence.integrity.status !== 'unverified'
      || evidence.integrity.code !== 'METADATA_ONLY')) throw new DataAccessError(422, 'RESEARCH_NAVIGATION_INVALID', '导航只能保存独立可读元数据，不能升级为正文。')
    const selected = fresh ? await readResearchSelection(tx, scope, taskKey) : null
    if (alternative && (!navigation || spec.researchNavigation?.alternativeSelection !== 'after_preferred_unavailable'
      || !await preferredResearchUnavailable(tx, scope, taskKey))) throw new DataAccessError(403, 'RESEARCH_ALTERNATIVE_DENIED', '没有获准换书的真实来源回执，未替换身份。')
    const target = alternative ? undefined : selected?.target ?? spec.researchTarget
    const actual = evidence?.identity
    const verified = Boolean(actual && actual.status !== 'mismatch' && actual.title && actual.author && (target
      ? actual.status === 'verified' && actual.title === target.title && (!target.author || actual.author === target.author)
      : fresh && actual.pageType === 'book' && actual.basis === 'structured_metadata'))
    const actualTarget = verified ? { title: actual!.title!, author: actual!.author!, sourceHosts: frozenHosts ?? [] } : undefined
    const parent = fresh ? await findNavigationParent(tx, scope, taskKey, source.canonicalUrl) : null
    const binding = fresh ? { purpose: navigation ? 'navigation' as const : 'body' as const,
      ...(actualTarget ? { identityHash: selected && !alternative ? selected.identityHash : identityHash(actualTarget) } : {}), ...(parent ? { parent } : {}) } : undefined
    if (fresh && selected && actualTarget && !navigation && result.contentKind === 'article') {
      await assertChosenResearchLineage(tx, scope, selected, sourceId, parent ?? undefined)
    }
    if (selected && actualTarget && !alternative && identityHash({ ...actualTarget, sourceHosts: selected.target.sourceHosts }) !== selected.identityHash) {
      throw new DataAccessError(422, 'RESEARCH_IDENTITY_CONFLICT', '页面身份与本任务已经核验的作品不一致，未替换目标。')
    }
    const revision = hash(JSON.stringify(binding ? [contentHash, finalUrl, result.contentKind, links, evidence ?? null, binding]
      : [contentHash, finalUrl, result.contentKind, links, ...(evidence ? [evidence] : [])]))
    // Navigation never erases an earlier body/access failure. Stops are shared
    // across purposes, including an attempt to refresh the same source.
    if (!navigation) await tx.agentResearchSource.update({ where: { id: sourceId }, data: { readFailure: Prisma.DbNull } })
    const saved = await tx.agentResearchContent.upsert({ where: { sourceId_revision: { sourceId, revision } }, update: {}, create: {
      id: randomUUID(), sourceId, revision, contentHash, finalUrl, provider: result.provider,
      contentKind: result.contentKind, text: result.text, quality: { ...(navigation || provenShortPreview ? result.quality : checked.quality), links, ...(evidence ? { evidence } : {}),
        ...(binding ? { binding } : {}), revisionVersion: binding ? 4 : evidence ? 3 : 2 },
    } })
    if (fresh && (!selected || alternative) && actualTarget && (actual!.pageType === 'book' || actual!.pageType === 'chapter' && (evidence!.integrity.status === 'source_compared' || isResearchPreviewEvidence(evidence)))) {
      const id = hash(JSON.stringify([alternative ? 'research-alternative-identity-v1' : 'research-selected-identity-v1', scope.userId, scope.sessionId, taskKey]))
      const previous = await tx.agentArtifact.findUnique({ where: { id } })
      if (previous) {
        const prior = selectionSchema.parse(previous.metadata)
        if (previous.artifactType !== 'contextCheckpoint' || previous.content !== '' || prior.taskKey !== taskKey || prior.sourceId !== sourceId
          || prior.contentRef !== saved.id || prior.revision !== saved.revision || prior.identityHash !== identityHash(actualTarget)) {
          throw new DataAccessError(409, 'RESEARCH_IDENTITY_CONFLICT', '替代作品身份已经冻结，未覆盖既有选择。')
        }
      } else await tx.agentArtifact.create({ data: { id, runId: scope.runId, artifactType: 'contextCheckpoint', title: '已核验研究作品身份', content: '',
        metadata: { version: 1, kind: 'researchSelectedIdentity', taskKey, sourceId, contentRef: saved.id, revision: saved.revision,
          target: actualTarget, identityHash: identityHash(actualTarget) } } })
    }
    return saved
  })
}

/** Saved windows make no network calls and consume no document-fetch quota.
 * Offsets use JS UTF-16 indices consistently with the existing attachment tools. */
export async function readResearchContent(scope: Scope, input: { contentRef: string; revision: string; offset?: number; limit?: number; find?: string; linksOffset?: number }) {
  const offset = input.offset ?? 0, limit = input.limit ?? 6000
  const linksOffset = input.linksOffset ?? 0
  if (!Number.isSafeInteger(linksOffset) || linksOffset < 0) throw new DataAccessError(400, 'RESEARCH_RANGE_INVALID', '链接分页位置无效。')
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 6000) {
    throw new DataAccessError(400, 'RESEARCH_RANGE_INVALID', '正文窗口位置或大小无效。')
  }
  if (input.find !== undefined && (typeof input.find !== 'string' || !input.find.trim() || input.find.length > 200 || input.find.length > limit)) {
    throw new DataAccessError(400, 'RESEARCH_QUERY_INVALID', '检索词应为1–200字符的非空文本。')
  }
  return researchTransaction(scope, async tx => {
    const content = await tx.agentResearchContent.findUnique({ where: { id: input.contentRef } })
    if (!content) return denied()
    const source = await ownedSource(tx, scope, content.sourceId)
    const quality = content.quality
    const metadata = quality && typeof quality === 'object' && !Array.isArray(quality) ? quality : null
    const links = checkedSavedLinks(metadata?.links, content.finalUrl)
    const evidence = metadata?.revisionVersion === 3 || metadata?.revisionVersion === 4 && metadata.evidence != null ? readerEvidenceSchema.parse(metadata.evidence) : undefined
    const revisionParts = [content.contentHash, content.finalUrl, content.contentKind]
    if (input.revision !== content.revision || hash(content.text) !== content.contentHash
      || hash(JSON.stringify(metadata?.revisionVersion === 4 ? [...revisionParts, links, evidence ?? null, bindingSchema.parse(metadata.binding)]
        : metadata?.revisionVersion === 3 ? [...revisionParts, links, evidence] : metadata?.revisionVersion === 2 ? [...revisionParts, links] : revisionParts)) !== content.revision) {
      throw new DataAccessError(409, 'RESEARCH_REVISION_MISMATCH', '正文版本不一致，不能用其他版本替换引用。')
    }
    if (offset > content.text.length) throw new DataAccessError(400, 'RESEARCH_RANGE_INVALID', '正文窗口超出保存范围。')
    const matchAt = input.find === undefined ? null : content.text.indexOf(input.find, offset)
    if (matchAt === -1) throw new DataAccessError(404, 'RESEARCH_MATCH_NOT_FOUND', '当前保存版本的指定位置之后没有匹配文本；未联网，也不代表其他版本或来源没有该信息。')
    const start = matchAt === null ? offset : Math.max(offset, matchAt - Math.min(200, Math.floor(limit / 4), limit - input.find!.length))
    const end = Math.min(content.text.length, start + limit)
    if (linksOffset > links.length) throw new DataAccessError(400, 'RESEARCH_RANGE_INVALID', '链接分页超出保存范围。')
    return { sourceId: source.id, contentRef: content.id, revision: content.revision, contentHash: content.contentHash,
      links: links.slice(linksOffset, linksOffset + 8), linksTotal: links.length,
      linksNextOffset: linksOffset + 8 < links.length ? linksOffset + 8 : null,
      excerptHash: hash(content.text.slice(start, end)),
      finalUrl: content.finalUrl, contentKind: content.contentKind, provider: content.provider,
      evidence,
      ...(metadata?.revisionVersion === 4 ? { purpose: bindingSchema.parse(metadata.binding).purpose } : {}),
      text: content.text.slice(start, end), returnedRange: { start, end, total: content.text.length },
      match: matchAt === null ? null : { start: matchAt, end: matchAt + input.find!.length },
      rangeUnit: 'utf16' as const, truncated: end < content.text.length, nextCursor: end < content.text.length ? String(end) : null }
  })
}

/** Records a prepared body observation, not a claim that the model analysed it.
 * Link-only calls must not call this. The source/version and owner remain fixed. */
export async function recordResearchWindow(scope: Scope, input: { contentRef: string; revision: string; start: number; end: number }) {
  return researchTransaction(scope, async tx => {
    const content = await tx.agentResearchContent.findUnique({ where: { id: input.contentRef } })
    if (!content) return denied()
    await ownedSource(tx, scope, content.sourceId)
    await tx.$queryRaw`SELECT id FROM agent_research_contents WHERE id=${content.id} FOR UPDATE`
    const current = await tx.agentResearchContent.findUniqueOrThrow({ where: { id: content.id } })
    if (current.revision !== input.revision || hash(current.text) !== current.contentHash) {
      throw new DataAccessError(409, 'RESEARCH_REVISION_MISMATCH', '正文版本不一致，未记录阅读范围。')
    }
    const prior = mergeResearchRanges(current.providedRanges, current.text.length)
    const providedRanges = mergeResearchRanges([...prior, { start: input.start, end: input.end }], current.text.length)
    if (JSON.stringify(prior) !== JSON.stringify(providedRanges)) {
      await tx.agentResearchContent.update({ where: { id: content.id }, data: { providedRanges } })
    }
  })
}
