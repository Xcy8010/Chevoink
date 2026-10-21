import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../api/config/env.js'
import { prisma } from '../../api/lib/prisma.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { restrictToolsToTask } from '../../api/lib/agent/tool-authority.js'
import { webReadTool, webSearchTool } from '../../api/lib/agent/tools/search-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { assertResearchAlternativeAllowed, assertResearchUrlProvenance, authorizeResearchNavigation, findResearchSource,
  findSavedResearchContent, getResearchReadFailure, getResearchReadTarget, getResearchNavigationPolicy, readResearchContent, readResearchReportForDelivery,
  recordResearchReadFailure, recordResearchReadOutcome, registerResearchSource, reserveResearchRequest,
  saveResearchContent, saveResearchReportSection, saveResearchSearchOutcome, settleResearchRequest } from '../../api/lib/agent/research-sources.js'
import { claimResearchReadHandoff, saveResearchLimitationDelivery, takeResearchReadHandoff } from '../../api/lib/agent/research-recovery.js'
import { assessReaderEvidence, assessReaderText, extractReaderNavigationHtml } from '../../api/lib/web-reader-quality.js'
import type { WebReadResult } from '../../api/lib/web-reader-service.js'
import type { WebSearchResult } from '../../api/lib/web-search-service.js'
import type { TaskSpec } from '../../shared/contracts/index.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

// Only external responses/configuration are replaced. Provenance, permits,
// immutable versions, report citations and free logical receipts use real PG.
const supplier = vi.hoisted(() => ({ search: vi.fn(), navigation: vi.fn(), body: vi.fn(), runtime: vi.fn() }))
vi.mock('../../api/lib/web-search-service.js', async original => ({ ...await original<object>(), searchWeb: supplier.search }))
vi.mock('../../api/lib/web-reader-service.js', async original => ({ ...await original<object>(), readPublicWebNavigation: supplier.navigation, readPublicWebPage: supplier.body }))
vi.mock('../../api/lib/tool-model-config.js', async original => ({ ...await original<object>(), getToolModelRuntime: supplier.runtime }))

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })
const originalProvider = env.webSearchProvider
beforeEach(() => { Object.values(supplier).forEach(mock => mock.mockReset()); supplier.runtime.mockResolvedValue(null); env.webSearchProvider = 'sogou' })
afterEach(() => { env.webSearchProvider = originalProvider; vi.restoreAllMocks() })
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hashText = (text: string) => createHash('sha256').update(text).digest('hex')
const target = { title: '霜河档案', author: '周禾', sourceHosts: ['fiction.example.com'], textAnalysisRequired: true }
const prompt = '只读联网研究《霜河档案》，作者：周禾。\nsite:fiction.example.com 读取公开章节，取样分析写法。不得另选作品。'
const commentUrl = 'https://fiction.example.com/reviews/river', bookUrl = 'https://fiction.example.com/books/river', chapterUrl = 'https://fiction.example.com/chapters/ice'
const comment: WebSearchResult = { title: '《霜河档案》读者评论', url: commentUrl, snippet: '作品相关讨论，作者：周禾', source: 'fiction.example.com' }
const unrelated: WebSearchResult = { title: '公开网站使用说明', url: 'https://fiction.example.com/help/one', snippet: '不相关页面', source: 'fiction.example.com' }
const bodyText = '清晨村民沿河查看旧冰的边缘，逐一记录木桩上留下的水线，再带着不同的观察返回仓房核对记录。'.repeat(10)
type Scope = Pick<ToolContext, 'userId' | 'novelId' | 'sessionId' | 'runId'>
type Fixture = { scope: Scope; spec: TaskSpec; scopeKey: string }
const call = (scope: Scope): ToolContext => ({ ...scope, callId: randomUUID(), chapterId: null, mode: 'build', creativeFreedom: 'balanced',
  qualityMode: 'premium', signal: new AbortController().signal, emit: vi.fn() })

async function fixture(work: (value: Fixture) => Promise<void>, options: { legacy?: boolean; prompt?: string } = {}) {
  const user = await prisma.user.create({ data: { nickname: 'navigation-fixture', passwordHash: 'test-only' } })
  try {
    const novel = await prisma.novel.create({ data: { authorId: user.id, title: '公开导航测试', slug: randomUUID(), summary: '' } })
    const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '只读研究' } })
    const runId = randomUUID(), spec = buildTaskSpec({ runId, novelId: novel.id, prompt: options.prompt ?? prompt, researchAdmission: 1,
      ...(options.legacy ? {} : { researchNavigationAdmission: 1 }) })
    const scope = { userId: user.id, novelId: novel.id, sessionId: session.id, runId }
    await prisma.agentRun.create({ data: { id: runId, userId: user.id, novelId: novel.id, sessionId: session.id, mode: 'act', engine: 'loop', action: 'workspaceAgent',
      agentType: 'writingOrchestrator', status: 'running', taskSpec: JSON.parse(JSON.stringify(spec)) } })
    const window = getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: user.id, dailyAllowanceMilli: 0, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    await work({ scope, spec, scopeKey: digest([user.id, session.id, novel.id, spec.id]) })
    expect(await prisma.chapter.count({ where: { novelId: novel.id } })).toBe(0)
    expect(await prisma.aiUsageLog.count({ where: { userId: user.id } })).toBe(0)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: user.id, deltaMilli: { not: 0 } } })).toBe(0)
    expect(await prisma.webToolCall.count({ where: { runId, amountMilli: { not: 0 } } })).toBe(0)
  } finally {
    await prisma.agentArtifact.deleteMany({ where: { run: { userId: user.id } } })
    await prisma.agentRun.deleteMany({ where: { userId: user.id } })
    await prisma.agentSession.deleteMany({ where: { userId: user.id } })
    await prisma.novel.deleteMany({ where: { authorId: user.id } })
    await prisma.user.delete({ where: { id: user.id } })
  }
}

function navigation(url: string, links: Array<{ url: string; title: string }> = [], identity?: { title: string; author: string }, expected: typeof target | null = target): WebReadResult {
  const source = `<html><head><title>${identity?.title ?? '霜河档案读者讨论'}</title>${identity ? `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Book', name: identity.title, author: identity.author,
  })}</script>` : ''}</head><body><main>${links.map(link => `<a href="${link.url}">${link.title}</a>`).join('')}</main></body></html>`
  return { ...extractReaderNavigationHtml(source, url, expected ?? undefined), finalUrl: url, provider: 'direct', retryable: false, contentKind: 'metadata', purpose: 'navigation' }
}
function body(url = chapterUrl, title = target.title, author = target.author): WebReadResult {
  const source = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Chapter', articleBody: bodyText,
    isPartOf: { '@type': 'Book', name: title, author } })}</script>`
  return { ...assessReaderText(bodyText, `${title}第1章 冰河`), finalUrl: url, provider: 'direct', retryable: false, contentKind: 'article',
    evidence: assessReaderEvidence(bodyText, `${title}第1章 冰河`, target, source, url) }
}
const citation = (saved: { id: string; revision: string; text: string }) => ({ contentRef: saved.id, revision: saved.revision,
  start: 0, end: Math.min(60, saved.text.length), excerptHash: hashText(saved.text.slice(0, 60)) })
async function seedSearch(scope: Scope, results: WebSearchResult[] = [comment], extra?: WebSearchResult[]) {
  const ctx = call(scope)
  expect(await reserveResearchRequest(ctx, 'search', digest(['search', ctx.callId]))).toBe(true)
  await settleResearchRequest(ctx, 'consumed')
  await saveResearchSearchOutcome(ctx, { provider: 'sogou', results, ...(extra ? { navigation: { provider: 'bing', results: extra } } : {}) }, 'site:fiction.example.com 霜河档案 周禾')
  const sources = []
  for (const result of [...results, ...extra ?? []]) sources.push(await registerResearchSource(scope, result.url, result.title))
  return { ctx, sources }
}
async function consumed(scope: Scope, purpose?: 'navigation') {
  const ctx = call(scope)
  expect(await reserveResearchRequest(ctx, 'read', digest(['read', ctx.callId]), purpose)).toBe(true)
  await settleResearchRequest(ctx, 'consumed'); await recordResearchReadOutcome(ctx, true)
  return ctx
}
async function saveBook(scope: Scope) {
  const source = await registerResearchSource(scope, bookUrl, '霜河档案作品目录')
  const saved = await saveResearchContent(scope, source.id, navigation(bookUrl, [{ url: chapterUrl, title: '第1章 冰河' }], target))
  return { source, saved }
}

describe.skipIf(!available)('fresh research navigation with isolated PostgreSQL and offline responses', () => {
  it('freezes the fresh author policy, source host and tool presentation without widening the old schema', async () => {
    await fixture(async ({ scope, spec }) => {
      expect(spec).toMatchObject({ intent: 'research_analysis', researchBudget: 'extended', researchDiscoveryProtocol: 1,
        researchTarget: target, researchNavigation: { version: 1, requestHash: hashText(prompt), alternativeSelection: 'denied' } })
      const tool = restrictToolsToTask([webReadTool], spec).find(item => item.name === 'web_read')!
      expect(tool.parameters.parse({ sourceId: 'real-source', purpose: 'navigation' })).toMatchObject({ purpose: 'navigation' })
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: scope.runId } })).taskSpec).toEqual(JSON.parse(JSON.stringify(spec)))
    })
  })

  it('follows search → related comment → actual book href → actual chapter → cited analysis through real tools', async () => {
    await fixture(async ({ scope, scopeKey }) => {
      supplier.search.mockResolvedValueOnce({ provider: 'sogou', results: [comment] })
      const searched = await webSearchTool.execute(call(scope), { query: 'site:fiction.example.com 霜河档案 周禾', maxResults: 3 })
      expect(searched.output).toContain('purpose="navigation"')
      const commentSource = (await findResearchSource(scope, commentUrl))!
      supplier.navigation.mockResolvedValueOnce(navigation(commentUrl, [{ url: bookUrl, title: '霜河档案作品目录' }]))
      await webReadTool.execute(call(scope), { sourceId: commentSource.id, purpose: 'navigation' })
      const bookSource = (await findResearchSource(scope, bookUrl))!
      expect(bookSource).toBeTruthy()
      supplier.navigation.mockResolvedValueOnce(navigation(bookUrl, [{ url: chapterUrl, title: '第1章 冰河' }], target))
      await webReadTool.execute(call(scope), { sourceId: bookSource.id, purpose: 'navigation' })
      const chapter = (await findResearchSource(scope, chapterUrl))!
      expect(chapter).toBeTruthy()
      supplier.body.mockResolvedValueOnce(body())
      await webReadTool.execute(call(scope), { sourceId: chapter.id })
      const saved = await prisma.agentResearchContent.findFirstOrThrow({ where: { sourceId: chapter.id } })
      const window = await readResearchContent(scope, { contentRef: saved.id, revision: saved.revision })
      expect(window.text).toBe(bodyText); expect(window.contentHash).toBe(hashText(bodyText))
      const parent = await findSavedResearchContent(scope, bookSource.id, 'navigation')
      expect(saved.quality).toMatchObject({ revisionVersion: 4, binding: { purpose: 'body', parent: { contentRef: parent!.id, revision: parent!.revision } },
        evidence: { identity: { status: 'verified', pageType: 'chapter', title: target.title, author: target.author }, integrity: { status: 'source_compared' } } })
      await saveResearchReportSection(scope, { reportId: 'main', title: '取样分析', expectedRevision: 0, section: {
        id: 'opening', order: 0, content: '本段分析仅依据已取得的第一章片段，不声称已读全书。', citations: [citation(saved)] } })
      expect(await readResearchReportForDelivery(scope)).toMatchObject({ evidence: { targetAnalysisSupported: true, readablePages: 1, metadataPages: 2 } })
      expect(supplier.navigation).toHaveBeenCalledTimes(2); expect(supplier.body).toHaveBeenCalledTimes(1)
      expect(await prisma.agentResearchRequest.count({ where: { scopeKey, kind: 'read', status: 'consumed' } })).toBe(3)
      expect(await prisma.webToolCall.count({ where: { runId: scope.runId, status: 'completed', amountMilli: 0 } })).toBe(4)
    })
  })

  it('does not synthesize a book/chapter source when the related comment contains no href', async () => {
    await fixture(async ({ scope }) => {
      const { sources } = await seedSearch(scope)
      supplier.navigation.mockResolvedValueOnce(navigation(commentUrl))
      await webReadTool.execute(call(scope), { sourceId: sources[0].id, purpose: 'navigation' })
      expect(await prisma.agentResearchSource.count({ where: { ownerRunId: scope.runId } })).toBe(1)
      expect(await findResearchSource(scope, bookUrl)).toBeNull()
      await expect(assertResearchUrlProvenance(scope, chapterUrl)).rejects.toMatchObject({ code: 'WEB_READ_UNDISCOVERED_URL' })
      expect(supplier.body).not.toHaveBeenCalled()
    })
  })

  it.each(['wrong author', 'derivative title'] as const)('does not freeze %s as the target or allow its body to support analysis', async scenario => {
    await fixture(async ({ scope }) => {
      const actual = scenario === 'wrong author' ? { ...target, author: '陈舟' } : { ...target, title: '霜河档案：番外' }
      const source = await registerResearchSource(scope, bookUrl, actual.title), saved = await saveResearchContent(scope, source.id, navigation(bookUrl, [], actual))
      expect(saved.quality).toMatchObject({ evidence: { identity: { status: 'mismatch' } } })
      expect(await getResearchReadTarget(scope)).toEqual(target)
      expect(await prisma.agentArtifact.count({ where: { runId: scope.runId, metadata: { path: ['kind'], equals: 'researchSelectedIdentity' } } })).toBe(0)
      await expect(saveResearchReportSection(scope, { reportId: 'main', title: '错误身份', expectedRevision: 0, section: {
        id: 'unsafe', order: 0, content: '不能将错作者或衍生作品当原作。', citations: [citation(saved)] } })).rejects.toMatchObject({ code: 'RESEARCH_TARGET_EVIDENCE_REQUIRED' })
    })
  })

  it('never permits navigation metadata as target_text while allowing a clearly labelled identity citation', async () => {
    await fixture(async ({ scope }) => {
      const { saved } = await saveBook(scope)
      await expect(saveResearchReportSection(scope, { reportId: 'main', title: '报告', expectedRevision: 0, section: {
        id: 'analysis', order: 0, content: '目录不构成正文手法证据。', citations: [{ ...citation(saved), purpose: 'target_text' }] } }))
        .rejects.toMatchObject({ code: 'RESEARCH_TARGET_EVIDENCE_REQUIRED' })
      await saveResearchReportSection(scope, { reportId: 'main', title: '报告', expectedRevision: 0, section: {
        id: 'identity', order: 0, evidenceKind: 'source_identity', content: '仅核对来源声明的书名与作者。', citations: [{ ...citation(saved), purpose: 'source_identity' }] } })
      expect(await readResearchReportForDelivery(scope)).toMatchObject({ evidence: { targetAnalysisSupported: false, readablePages: 0, metadataPages: 1 } })
    })
  })

  it('partitions navigation and body caches and reuses each purpose without another request', async () => {
    await fixture(async ({ scope, scopeKey }) => {
      const { sources } = await seedSearch(scope)
      const source = sources[0]
      supplier.navigation.mockResolvedValueOnce(navigation(commentUrl, [], target))
      await webReadTool.execute(call(scope), { sourceId: source.id, purpose: 'navigation' })
      const nav = await findSavedResearchContent(scope, source.id, 'navigation')
      expect(nav).not.toBeNull(); expect(await findSavedResearchContent(scope, source.id)).toBeNull()
      supplier.body.mockResolvedValueOnce(body(commentUrl))
      await webReadTool.execute(call(scope), { sourceId: source.id })
      const actual = await findSavedResearchContent(scope, source.id)
      expect(actual).not.toBeNull(); expect(actual!.id).not.toBe(nav!.id)
      expect(await findSavedResearchContent(scope, source.id, 'navigation')).toEqual(nav)
      await webReadTool.execute(call(scope), { sourceId: source.id })
      await webReadTool.execute(call(scope), { sourceId: source.id, purpose: 'navigation' })
      expect(supplier.body).toHaveBeenCalledTimes(1); expect(supplier.navigation).toHaveBeenCalledTimes(1)
      expect(await prisma.agentResearchRequest.count({ where: { scopeKey, kind: 'read', status: 'consumed' } })).toBe(2)
      expect(await prisma.agentResearchContent.count({ where: { sourceId: source.id } })).toBe(2)
    })
  })

  it('atomically gives the last navigation slot to one contender without increasing the total limit', async () => {
    await fixture(async ({ scope, scopeKey }) => {
      await consumed(scope, 'navigation')
      const attempts = [call(scope), call(scope)]
      const results = await Promise.allSettled(attempts.map(ctx => reserveResearchRequest(ctx, 'read', digest(ctx.callId), 'navigation')))
      expect(results.filter(result => result.status === 'fulfilled' && result.value === true)).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected').map(result => result.reason)).toMatchObject([{ code: 'RESEARCH_NAVIGATION_BUDGET' }])
      expect(await prisma.agentResearchRequest.count({ where: { scopeKey, kind: 'read', status: { not: 'baseline' } } })).toBe(2)
      expect(await prisma.agentResearchRequest.findFirstOrThrow({ where: { scopeKey, kind: 'read', status: 'baseline' } })).toMatchObject({ requestLimit: 8, units: 0 })
    })
  })

  it.each(['reserved', 'consumed unknown'] as const)('counts the second navigation %s and blocks a cross-purpose new request', async state => {
    await fixture(async ({ scope, scopeKey }) => {
      await consumed(scope, 'navigation')
      const pending = call(scope)
      expect(await reserveResearchRequest(pending, 'read', digest(pending.callId), 'navigation')).toBe(true)
      if (state === 'consumed unknown') await settleResearchRequest(pending, 'consumed')
      await expect(reserveResearchRequest(call(scope), 'read', digest('third nav'), 'navigation')).rejects.toMatchObject({ code: 'RESEARCH_NAVIGATION_BUDGET' })
      await expect(reserveResearchRequest(call(scope), 'read', digest('new body'))).rejects.toMatchObject({ code: 'RESEARCH_REQUEST_UNCERTAIN' })
      expect(await prisma.agentResearchRequest.count({ where: { scopeKey, kind: 'read', status: { not: 'baseline' } } })).toBe(2)
      expect(supplier.navigation).not.toHaveBeenCalled(); expect(supplier.body).not.toHaveBeenCalled()
    })
  })

  it('releases a genuinely undispatched navigation reservation without erasing a consumed slot', async () => {
    await fixture(async ({ scope, scopeKey }) => {
      await consumed(scope, 'navigation')
      const released = call(scope)
      expect(await reserveResearchRequest(released, 'read', digest(released.callId), 'navigation')).toBe(true)
      await settleResearchRequest(released, 'released')
      await consumed(scope, 'navigation')
      await expect(reserveResearchRequest(call(scope), 'read', digest('over two'), 'navigation')).rejects.toMatchObject({ code: 'RESEARCH_NAVIGATION_BUDGET' })
      expect(await prisma.agentResearchRequest.count({ where: { scopeKey, status: 'released' } })).toBe(1)
      expect(await prisma.agentResearchRequest.aggregate({ where: { scopeKey, kind: 'read', status: { not: 'released' } }, _sum: { units: true } })).toMatchObject({ _sum: { units: 2 } })
    })
  })

  it('combines the historical two-fetch baseline, two navigation reads and four body reads in the original eight', async () => {
    await fixture(async ({ scope, scopeKey }) => {
      await prisma.agentRunEvent.createMany({ data: Array.from({ length: 2 }, (_, index) => ({ runId: scope.runId, seq: index + 1, type: 'tool.call',
        payload: { type: 'tool.call', callId: randomUUID(), toolName: 'web_read', args: { url: `https://fiction.example.com/legacy/${index}` } } })) })
      await consumed(scope, 'navigation'); await consumed(scope, 'navigation')
      for (let index = 0; index < 4; index++) await consumed(scope)
      expect(await reserveResearchRequest(call(scope), 'read', digest('ninth read'))).toBe(false)
      expect(await prisma.agentResearchRequest.findFirstOrThrow({ where: { scopeKey, kind: 'read', status: 'baseline' } })).toMatchObject({ requestLimit: 8, units: 2 })
      expect(await prisma.agentResearchRequest.aggregate({ where: { scopeKey, kind: 'read', status: { not: 'released' } }, _sum: { units: true } })).toMatchObject({ _sum: { units: 8 } })
    })
  })

  it.each(['body to navigation', 'navigation to body'] as const)('shares access failures across %s without dispatch or a new reservation', async direction => {
    await fixture(async ({ scope, scopeKey }) => {
      const { sources } = await seedSearch(scope), source = sources[0]
      const failure: WebReadResult = { ...assessReaderText(''), status: 'blocked', code: 'WEB_READ_BLOCKED', finalUrl: commentUrl,
        provider: 'direct', retryable: false, contentKind: direction === 'body to navigation' ? 'article' : 'metadata',
        ...(direction === 'navigation to body' ? { purpose: 'navigation' } : {}) }
      await recordResearchReadFailure(scope, source.id, failure)
      const before = await getResearchReadFailure(scope, source.id)
      await expect(webReadTool.execute(call(scope), { sourceId: source.id, refresh: true,
        ...(direction === 'body to navigation' ? { purpose: 'navigation' as const } : {}) })).rejects.toMatchObject({ code: 'WEB_READ_BLOCKED' })
      expect(await getResearchReadFailure(scope, source.id)).toEqual(before)
      await saveResearchContent(scope, source.id, navigation(commentUrl))
      expect(await getResearchReadFailure(scope, source.id)).toEqual(before)
      expect(await prisma.agentResearchRequest.count({ where: { scopeKey, kind: 'read' } })).toBe(0)
      expect(supplier.navigation).not.toHaveBeenCalled(); expect(supplier.body).not.toHaveBeenCalled()
    })
  })

  it('blocks new body and navigation dispatch while a provider receipt remains unknown', async () => {
    await fixture(async ({ scope, scopeKey }) => {
      const { sources } = await seedSearch(scope)
      await prisma.webToolCall.create({ data: { id: digest('unknown source dispatch'), runId: scope.runId, requestHash: digest(commentUrl), kind: 'fetch',
        amountMilli: 0, multiplierBps: 10000, status: 'dispatched' } })
      for (const purpose of [undefined, 'navigation'] as const) await expect(webReadTool.execute(call(scope), { sourceId: sources[0].id, ...(purpose ? { purpose } : {}) }))
        .rejects.toMatchObject({ code: 'RESEARCH_REQUEST_UNCERTAIN' })
      expect(await prisma.agentResearchRequest.count({ where: { scopeKey, kind: 'read' } })).toBe(0)
      expect(await claimResearchReadHandoff(scope, [])).toBeNull()
      expect(supplier.navigation).not.toHaveBeenCalled(); expect(supplier.body).not.toHaveBeenCalled()
    })
  })

  it('recovers an earlier related hint after a later empty search exactly once without resetting quota', async () => {
    await fixture(async ({ scope, scopeKey }) => {
      const early = await seedSearch(scope, [unrelated], [comment])
      const last = await seedSearch(scope, [])
      const before = await prisma.agentResearchRequest.count({ where: { scopeKey } })
      const claimed = await claimResearchReadHandoff(scope, [last.ctx.callId])
      expect(claimed).toEqual({ sourceId: early.sources[1].id, receiptId: digest([scopeKey, 'research-read-handoff-v1']), purpose: 'navigation' })
      expect(await takeResearchReadHandoff(scope)).toEqual(claimed)
      expect(await takeResearchReadHandoff(scope)).toBeNull(); expect(await claimResearchReadHandoff(scope, [])).toBeNull()
      expect(await prisma.agentResearchRequest.count({ where: { scopeKey } })).toBe(before)
      expect(await prisma.agentResearchRequest.count({ where: { scopeKey, kind: 'read' } })).toBe(0)
    })
  })

  it('retains the old contract and does not expose or accept the new navigation purpose', async () => {
    await fixture(async ({ scope, spec }) => {
      const snapshot = JSON.parse(JSON.stringify(spec)), source = await registerResearchSource(scope, bookUrl, target.title)
      expect(spec).not.toHaveProperty('researchNavigation')
      const tool = restrictToolsToTask([webReadTool], spec).find(item => item.name === 'web_read')!
      expect(tool.parameters.parse({ sourceId: source.id, purpose: 'navigation' })).not.toHaveProperty('purpose')
      await expect(authorizeResearchNavigation(scope, source.id)).rejects.toMatchObject({ code: 'RESEARCH_NAVIGATION_DENIED' })
      await expect(reserveResearchRequest(call(scope), 'read', digest('legacy nav'), 'navigation')).rejects.toMatchObject({ code: 'RESEARCH_NAVIGATION_DENIED' })
      await expect(saveResearchContent(scope, source.id, navigation(bookUrl, [], target))).rejects.toMatchObject({ code: 'RESEARCH_NAVIGATION_INVALID' })
      const saved = await saveResearchContent(scope, source.id, body(bookUrl))
      expect(saved.quality).toMatchObject({ revisionVersion: 3 }); expect(saved.quality).not.toHaveProperty('binding')
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: scope.runId } })).taskSpec).toEqual(snapshot)
    }, { legacy: true })
  })

  it('preserves a truthful no-body limitation report and the existing identity section', async () => {
    await fixture(async ({ scope }) => {
      const { saved } = await saveBook(scope)
      await saveResearchReportSection(scope, { reportId: 'main', title: '来源与限制', expectedRevision: 0, section: {
        id: 'identity', order: 0, evidenceKind: 'source_identity', content: '已核对作品页声明的作者，正文尚未取得。', citations: [{ ...citation(saved), purpose: 'source_identity' }] } })
      const result = await saveResearchLimitationDelivery(scope, '只有公开目录，尚无可用于分析的章节正文。')
      expect(result).toContain('研究尚未完成'); expect(result).toContain('正文尚未取得'); expect(result).toContain('已核验章节版本 0')
      const report = await readResearchReportForDelivery(scope)
      expect(report).toMatchObject({ evidence: { targetAnalysisSupported: false, readablePages: 0, metadataPages: 1 } })
      expect(report.sections).toHaveLength(2)
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: scope.runId } })).status).toBe('running')
    })
  })

  it('enforces the frozen host and original site path without making any off-scope request', async () => {
    await fixture(async ({ scope }) => {
      for (const url of ['https://other.example/books/river', 'https://fiction.example.com/reviews/river']) {
        const source = await registerResearchSource(scope, url, target.title)
        await expect(authorizeResearchNavigation(scope, source.id)).rejects.toMatchObject({ code: 'RESEARCH_NAVIGATION_DENIED' })
      }
      expect(supplier.navigation).not.toHaveBeenCalled()
    }, { prompt: prompt.replace('site:fiction.example.com ', '仅在site:fiction.example.com/books ') })
  })

  it.each(['empty search', 'garbled chapter'] as const)('does not unlock an authorized alternative after only %s', async condition => {
    await fixture(async ({ scope, spec }) => {
      expect(spec.researchNavigation?.alternativeSelection).toBe('after_preferred_unavailable')
      if (condition === 'empty search') await seedSearch(scope, [])
      else {
        await saveBook(scope)
        const source = await registerResearchSource(scope, chapterUrl, '第1章 冰河')
        await recordResearchReadFailure(scope, source.id, { ...assessReaderText(''), status: 'unreadable', code: 'WEB_READ_GARBLED',
          finalUrl: chapterUrl, provider: 'direct', retryable: false, contentKind: 'article' })
      }
      await expect(assertResearchAlternativeAllowed(scope)).rejects.toMatchObject({ code: 'RESEARCH_ALTERNATIVE_DENIED' })
      expect(await getResearchReadTarget(scope)).toMatchObject({ title: target.title, author: target.author, sourceHosts: target.sourceHosts })
      expect(supplier.navigation).not.toHaveBeenCalled(); expect(supplier.body).not.toHaveBeenCalled()
    }, { prompt: prompt.replace('不得另选作品。', '找不到或无法读取时可以另选作品。') })
  })

  it.each(['unrelated href', 'provider 403'] as const)('does not treat %s as unavailable preferred original text', async scenario => {
    await fixture(async ({ scope }) => {
      const loginUrl = 'https://fiction.example.com/account/login'
      const book = await registerResearchSource(scope, bookUrl, target.title)
      await saveResearchContent(scope, book.id, navigation(bookUrl, [{ url: loginUrl, title: '登录账户' }], target))
      const source = scenario === 'provider 403' ? book : await registerResearchSource(scope, loginUrl, '登录账户')
      supplier.body.mockResolvedValueOnce({ ...assessReaderText(''), status: 'blocked', code: 'WEB_READ_BLOCKED',
        provider: scenario === 'provider 403' ? 'deepseek' : 'direct', finalUrl: source.canonicalUrl, retryable: false, contentKind: 'article' })
      await expect(webReadTool.execute(call(scope), { sourceId: source.id, refresh: true })).rejects.toMatchObject({ code: 'WEB_READ_BLOCKED' })
      await expect(assertResearchAlternativeAllowed(scope)).rejects.toMatchObject({ code: 'RESEARCH_ALTERNATIVE_DENIED' })
      expect(await getResearchReadTarget(scope)).toMatchObject({ title: target.title, author: target.author })
    }, { prompt: prompt.replace('不得另选作品。', '如果首选不可读，可以另选作品。') })
  })

  it('selects one alternative only from an owned direct failure after a verified version, and replays it idempotently', async () => {
    await fixture(async ({ scope, scopeKey }) => {
      await saveBook(scope)
      const chapter = await registerResearchSource(scope, chapterUrl, '第1章 冰河')
      supplier.body.mockResolvedValueOnce(body())
      await webReadTool.execute(call(scope), { sourceId: chapter.id })
      const prior = await prisma.agentResearchContent.findFirstOrThrow({ where: { sourceId: chapter.id } })
      await saveResearchReportSection(scope, { reportId: 'main', title: '首选片段', expectedRevision: 0, section: {
        id: 'opening', order: 0, content: '这里只分析首选的已有片段。', citations: [citation(prior)] } })
      supplier.body.mockResolvedValueOnce({ ...assessReaderText(''), status: 'blocked', code: 'WEB_READ_BLOCKED', provider: 'direct',
        finalUrl: chapterUrl, retryable: false, contentKind: 'article' })
      await expect(webReadTool.execute(call(scope), { sourceId: chapter.id, refresh: true })).rejects.toMatchObject({ code: 'WEB_READ_BLOCKED' })
      await assertResearchAlternativeAllowed(scope)
      const other = { title: '渡口札记', author: '沈舟' }, url = 'https://fiction.example.com/books/ferry'
      await seedSearch(scope, [{ title: other.title, url, snippet: `作者：${other.author}`, source: 'fiction.example.com' }])
      const source = (await findResearchSource(scope, url))!, ctx = call(scope)
      const args = { sourceId: source.id, purpose: 'navigation' as const, selectAlternative: true }
      supplier.navigation.mockResolvedValueOnce(navigation(url, [], other, null))
      await webReadTool.execute(ctx, args)
      const before = await prisma.agentResearchRequest.count({ where: { scopeKey } })
      await webReadTool.execute(ctx, args)
      expect(await prisma.agentResearchRequest.count({ where: { scopeKey } })).toBe(before)
      expect(supplier.navigation).toHaveBeenCalledTimes(1)
      expect(await getResearchReadTarget(scope)).toMatchObject(other)
      expect(await findSavedResearchContent(scope, chapter.id)).toBeNull()
      expect(await readResearchReportForDelivery(scope)).toMatchObject({ evidence: { targetAnalysisSupported: false } })
      await expect(assertResearchAlternativeAllowed(scope)).rejects.toMatchObject({ code: 'RESEARCH_ALTERNATIVE_DENIED' })
      expect(await prisma.agentArtifact.count({ where: { runId: scope.runId, metadata: { path: ['kind'], equals: 'researchSelectedIdentity' } } })).toBe(2)
    }, { prompt: prompt.replace('不得另选作品。', '如果首选不可读，可以另选作品。') })
  })

  it('rejects missing or unrelated directory lineage despite a matching reader identity', async () => {
    await fixture(async ({ scope }) => {
      await saveBook(scope)
      const rogueUrl = 'https://fiction.example.com/chapters/unrelated-link'
      const rogue = await registerResearchSource(scope, rogueUrl, '第1章 无所属目录')
      await expect(saveResearchContent(scope, rogue.id, body(rogueUrl))).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_LINEAGE_REQUIRED' })
      const unrelatedPage = await registerResearchSource(scope, 'https://fiction.example.com/books/other', '别的作品')
      await saveResearchContent(scope, unrelatedPage.id, navigation(unrelatedPage.canonicalUrl, [{ url: rogueUrl, title: '第1章 无所属目录' }], { title: '别的作品', author: '另一人' }))
      await expect(saveResearchContent(scope, rogue.id, body(rogueUrl))).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_LINEAGE_REQUIRED' })
      expect(await prisma.agentResearchContent.count({ where: { sourceId: rogue.id } })).toBe(0)
    })
  })

  it('reports missing target text for a fresh generic task instead of treating metadata as analysis', async () => {
    await fixture(async ({ scope, spec }) => {
      expect(spec.researchTarget).toBeUndefined()
      const { saved } = await saveBook(scope)
      await saveResearchReportSection(scope, { reportId: 'main', title: '来源身份', expectedRevision: 0, section: {
        id: 'identity', order: 0, evidenceKind: 'source_identity', content: '仅核对作品目录，尚无正文样本。', citations: [{ ...citation(saved), purpose: 'source_identity' }] } })
      expect(await readResearchReportForDelivery(scope)).toMatchObject({ evidence: { targetAnalysisSupported: false } })
      await expect(saveResearchReportSection(scope, { reportId: 'main', title: '来源身份', expectedRevision: 1, section: {
        id: 'analysis', order: 1, content: '目录不足以分析正文。', citations: [] } })).rejects.toMatchObject({ code: 'RESEARCH_TARGET_EVIDENCE_REQUIRED' })
    }, { prompt: '联网搜索一本 site:fiction.example.com 的小说，读取公开章节并分析写作手法。' })
  })

  it('keeps a null legacy contract readable without inventing a new protocol', async () => {
    await fixture(async ({ scope }) => {
      await prisma.agentRun.update({ where: { id: scope.runId }, data: { taskSpec: Prisma.DbNull } })
      const source = await registerResearchSource(scope, chapterUrl, target.title)
      const saved = await saveResearchContent(scope, source.id, body())
      expect(saved.quality).toMatchObject({ revisionVersion: 3 })
      expect(await getResearchNavigationPolicy(scope)).toBeUndefined()
      expect(await readResearchContent(scope, { contentRef: saved.id, revision: saved.revision })).toMatchObject({ text: bodyText })
    }, { legacy: true })
  })

  it('hands a fresh official book candidate to metadata navigation before any body reader', async () => {
    await fixture(async ({ scope }) => {
      const result = await seedSearch(scope, [{ title: '霜河档案最新章节', url: bookUrl, snippet: '作者：周禾', source: 'fiction.example.com' }])
      const handoff = await claimResearchReadHandoff(scope, [result.ctx.callId])
      expect(handoff).toMatchObject({ sourceId: result.sources[0].id, purpose: 'navigation' })
      expect(await takeResearchReadHandoff(scope)).toEqual(handoff)
      expect(supplier.body).not.toHaveBeenCalled()
    })
  })
  it('admits the original author supplied chapter URL as an explicit lineage exception', async () => {
    const url = 'https://fiction.example.com/chapters/direct'
    const original = `${prompt} 作者直接提供的公开章节：${url}。`
    await fixture(async ({ scope }) => {
      await prisma.agentMessage.create({ data: { sessionId: scope.sessionId, runId: scope.runId, role: 'user', parts: [{ type: 'text', text: original }] } })
      await saveBook(scope)
      await assertResearchUrlProvenance(scope, url)
      const source = await registerResearchSource(scope, url, '原始请求提供的章节')
      const saved = await saveResearchContent(scope, source.id, body(url))
      await saveResearchReportSection(scope, { reportId: 'main', title: '直供样本', expectedRevision: 0, section: {
        id: 'opening', order: 0, content: '仅分析原始作者提供并实际核验的章节片段。', citations: [citation(saved)] } })
      expect(await readResearchReportForDelivery(scope)).toMatchObject({ evidence: { targetAnalysisSupported: true } })
    }, { prompt: original })
  })
})
