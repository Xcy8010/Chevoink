import { researchReportSaveTool } from '../../api/lib/agent/tools/search-tools.js'
import { observeSemanticTransition, nextStagnantBatch } from '../../api/lib/agent/semantic-progress.js'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { canonicalResearchUrl, registerResearchSource, resolveResearchSource, saveResearchContent, readResearchContent,
  findResearchSource, getResearchReadFailure, recordResearchReadFailure,
  reserveResearchRequest, settleResearchRequest, recordResearchWindow, recordResearchReadOutcome,
  findResearchSearchOutcome, saveResearchSearchOutcome,
  saveResearchReportSection, readResearchReport, readResearchReportForDelivery, assertResearchUrlProvenance, findSavedResearchContent } from '../../api/lib/agent/research-sources.js'
import { assessReaderText } from '../../api/lib/web-reader-quality.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })

describe.skipIf(!available)('J4 private versioned research sources', () => {
  it('six actual ordered report section writes keep legacy progress alive, while noop and A/B cycles do not', async () => {
    const user = await prisma.user.create({ data: { nickname: 'semantic-report-fixture', passwordHash: 'test-only' } })
    try {
      const novel = await prisma.novel.create({ data: { authorId: user.id, title: '研究报告', slug: randomUUID(), summary: '' } })
      const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '研究' } })
      const runId = randomUUID(), spec = buildTaskSpec({ runId, novelId: novel.id, prompt: '拆解这本小说' })
      expect(spec.intent).toBe('research_analysis')
      await prisma.agentRun.create({ data: { id: runId, userId: user.id, novelId: novel.id, sessionId: session.id, mode: 'act', engine: 'loop',
        action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', taskSpec: JSON.parse(JSON.stringify(spec)) } })
      const ctx = { userId: user.id, novelId: novel.id, sessionId: session.id, runId, chapterId: null, callId: 'report', mode: 'build' as const,
        creativeFreedom: 'balanced' as const, qualityMode: 'balanced' as const, signal: new AbortController().signal, emit: () => {} }
      const seen = new Set<string>()
      let revision = 0, stagnant = 0, target = ''
      const save = async (section: { id: string; order: number; content: string; citations: [] }, progressed: boolean) => {
        const result = await researchReportSaveTool.execute(ctx, { reportId: 'main', title: '原任务报告', expectedRevision: revision, section })
        revision = JSON.parse(result.output).revision
        const transition = result.semanticTransition!
        if (!target) target = transition.targetId
        expect(transition.targetId).toBe(target)
        const actual = observeSemanticTransition(seen, target, transition.beforeHash, transition.afterHash)
        expect(actual).toBe(progressed)
        stagnant = nextStagnantBatch(stagnant, actual)
        return result
      }
      for (let index = 0; index < 6; index++) {
        await save({ id: `section-${index}`, order: index, content: `真实分析成果${index}`, citations: [] }, true)
        expect(stagnant).toBe(0)
      }
      const original = { id: 'section-5', order: 5, content: '真实分析成果5', citations: [] as [] }
      await save(original, false)
      expect(revision).toBe(6)
      await save({ ...original, content: '新事实B' }, true)
      await save(original, false)
      await save({ ...original, content: '新事实B' }, false)
      expect(stagnant).toBe(2)
      const report = await readResearchReport(ctx, {})
      expect(report.sections).toHaveLength(6)
      expect(report.content).toContain('真实分析成果0')
      expect(report.content).toContain('新事实B')
      await expect(saveResearchReportSection(ctx, { reportId: 'main', title: '原任务报告', expectedRevision: 0,
        section: { ...original, content: '旧版本越权覆盖' } })).rejects.toMatchObject({ code: 'RESEARCH_REPORT_CONFLICT' })
      await prisma.agentRun.update({ where: { id: runId }, data: { status: 'cancelled' } })
      await expect(saveResearchReportSection(ctx, { reportId: 'main', title: '原任务报告', expectedRevision: revision,
        section: { ...original, content: '取消后写入' } })).rejects.toMatchObject({ code: 'RESEARCH_RUN_NOT_ACTIVE' })
      expect((await readResearchReport(ctx, {})).content).toBe(report.content)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: user.id } })).toBe(0)
    } finally {
      await prisma.agentArtifact.deleteMany({ where: { run: { userId: user.id } } })
      await prisma.agentRun.deleteMany({ where: { userId: user.id } })
      await prisma.agentSession.deleteMany({ where: { userId: user.id } })
      await prisma.novel.deleteMany({ where: { authorId: user.id } })
      await prisma.user.delete({ where: { id: user.id } })
    }
  })

  it('freezes small research budgets, stops consecutive failures across resume, and isolates the next task', async () => {
    const user = await prisma.user.create({ data: { nickname: 'budget-fixture', passwordHash: 'test-only' } })
    try {
      const novel = await prisma.novel.create({ data: { authorId: user.id, title: '预算', slug: randomUUID(), summary: '' } })
      const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '预算' } })
      const id = randomUUID()
      const spec = buildTaskSpec({ runId: id, novelId: novel.id, prompt: '分析番茄小说上的某本书' })
      expect(spec.researchBudget).toBe('standard')
      const base = { userId: user.id, novelId: novel.id, sessionId: session.id, mode: 'act' as const,
        action: 'workspaceAgent' as const, agentType: 'writingOrchestrator' as const, status: 'running' as const }
      await prisma.agentRun.create({ data: { ...base, id, taskSpec: JSON.parse(JSON.stringify(spec)) } })
      const scope = { ...base, runId: id }
      for (let i = 0; i < 2; i++) {
        const call = { ...scope, callId: randomUUID() }
        expect(await reserveResearchRequest(call, 'search', `query-${i}`)).toBe(true)
        await settleResearchRequest(call, 'consumed')
      }
      expect(await reserveResearchRequest({ ...scope, callId: randomUUID() }, 'search', 'third')).toBe(false)
      for (let i = 0; i < 2; i++) {
        const call = { ...scope, callId: randomUUID() }
        expect(await reserveResearchRequest(call, 'read', `page-${i}`)).toBe(true)
        await settleResearchRequest(call, 'consumed')
        await recordResearchReadOutcome(call, false)
        await recordResearchReadOutcome(call, true) // replay cannot rewrite failure
      }
      const resumedId = randomUUID()
      await prisma.agentRun.create({ data: { ...base, id: resumedId, taskSpec: JSON.parse(JSON.stringify({ ...spec, runId: resumedId })) } })
      await expect(reserveResearchRequest({ ...scope, runId: resumedId, callId: randomUUID() }, 'search', 'new-query'))
        .rejects.toMatchObject({ code: 'RESEARCH_NO_PROGRESS' })
      const nextId = randomUUID()
      await prisma.agentRun.create({ data: { ...base, id: nextId, taskSpec: JSON.parse(JSON.stringify(buildTaskSpec({ runId: nextId, novelId: novel.id, prompt: '深度研究下一本书' }))) } })
      expect(await reserveResearchRequest({ ...scope, runId: nextId, callId: randomUUID() }, 'search', 'new-task')).toBe(true)
    } finally {
      await prisma.agentRun.deleteMany({ where: { userId: user.id } })
      await prisma.agentSession.deleteMany({ where: { userId: user.id } })
      await prisma.novel.deleteMany({ where: { authorId: user.id } })
      await prisma.user.delete({ where: { id: user.id } })
    }
  })
  it('recovers report sections in the same task, rejects stale/foreign writes, and stops without modifying creative content', async () => {
    const user = await prisma.user.create({ data: { nickname: 'report-fixture', passwordHash: 'test-only' } })
    try {
      const novel = await prisma.novel.create({ data: { authorId: user.id, title: '只读研究', slug: randomUUID(), summary: '' } })
      const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '报告' } })
      const runId = randomUUID()
      const spec = buildTaskSpec({ runId, novelId: novel.id, prompt: '拆解这本小说' })
      const base = { userId: user.id, novelId: novel.id, sessionId: session.id, mode: 'act' as const,
        action: 'workspaceAgent' as const, agentType: 'writingOrchestrator' as const, engine: 'loop', status: 'running' as const }
      await prisma.agentRun.create({ data: { ...base, id: runId, taskSpec: JSON.parse(JSON.stringify(spec)) } })
      const scope = { userId: user.id, novelId: novel.id, sessionId: session.id, runId }
      const requests = Array.from({ length: 8 }, () => ({ ...scope, callId: randomUUID() }))
      const admitted = await Promise.all(requests.map(request => reserveResearchRequest(request, 'search', 'a'.repeat(64))))
      expect(admitted.filter(Boolean)).toHaveLength(5)
      const accepted = requests[admitted.indexOf(true)]
      await settleResearchRequest(accepted, 'released')
      const replacement = { ...scope, callId: randomUUID() }
      expect(await reserveResearchRequest(replacement, 'search', 'b'.repeat(64))).toBe(true)
      await settleResearchRequest(replacement, 'consumed')
      await saveResearchSearchOutcome(replacement, { provider: 'bocha', results: [], attempts: [{ providerRequestId: 'not-persisted' }] })
      expect(await findResearchSearchOutcome(scope, 'b'.repeat(64))).toEqual({ provider: 'bocha', results: [] })
      await settleResearchRequest(replacement, 'released')
      expect(await reserveResearchRequest({ ...scope, callId: randomUUID() }, 'search', 'c'.repeat(64))).toBe(false)
      await expect(reserveResearchRequest(replacement, 'search', 'b'.repeat(64))).rejects.toMatchObject({ code: 'RESEARCH_REQUEST_ALREADY_RESERVED' })
      await expect(assertResearchUrlProvenance(scope, 'https://www.xs599.com/novel/12345.html'))
        .rejects.toMatchObject({ code: 'WEB_READ_UNDISCOVERED_URL' })
      await prisma.agentMessage.create({ data: { runId, sessionId: session.id, role: 'user',
        parts: [{ type: 'text', text: '请阅读 https://example.com/authorized 。' }] } })
      await expect(assertResearchUrlProvenance(scope, 'https://example.com/authorized')).resolves.toBeUndefined()
      await registerResearchSource(scope, 'https://example.com/discovered')
      await expect(assertResearchUrlProvenance(scope, 'https://example.com/discovered')).resolves.toBeUndefined()
      const input = { reportId: 'main', title: '研究报告', expectedRevision: 0,
        section: { id: 'structure', order: 0, content: '人物选择推动故事转折。', citations: [] } }
      expect(await readResearchReport(scope, {})).toMatchObject({ revision: 0, sections: [] })
      const saved = await saveResearchReportSection(scope, input)
      expect(saved.revision).toBe(1)
      expect(await saveResearchReportSection(scope, input)).toMatchObject({ revision: 1, replayed: true })
      await expect(saveResearchReportSection(scope, { ...input, section: { ...input.section, content: '过时覆盖。' } }))
        .rejects.toMatchObject({ code: 'RESEARCH_REPORT_CONFLICT' })
      const resumedId = randomUUID()
      await prisma.agentRun.update({ where: { id: runId }, data: { status: 'paused' } })
      await prisma.agentRun.create({ data: { ...base, id: resumedId, taskSpec: JSON.parse(JSON.stringify({ ...spec, runId: resumedId })) } })
      const resumed = { ...scope, runId: resumedId }
      expect(await findResearchSearchOutcome(resumed, 'b'.repeat(64))).toEqual({ provider: 'bocha', results: [] })
      expect(await findResearchSearchOutcome(resumed, 'different-key')).toBeNull()
      expect(await reserveResearchRequest({ ...resumed, callId: randomUUID() }, 'search', 'd'.repeat(64))).toBe(false)
      await expect(reserveResearchRequest({ ...scope, callId: randomUUID() }, 'read', 'e'.repeat(64))).rejects.toMatchObject({ code: 'RESEARCH_RUN_NOT_ACTIVE' })
      // A legacy task may have read many stored windows. Only genuine fetch
      // calls seed the network limit, including across a resumed run.
      await prisma.agentRunEvent.createMany({ data: Array.from({ length: 12 }, (_, index) => ({
        runId, seq: index + 1, type: 'tool.call', payload: { type: 'tool.call', callId: randomUUID(),
          toolName: 'web_read', args: index < 2 ? { url: `https://example.com/old-${index}` }
            : { contentRef: 'saved-version', revision: 'a'.repeat(64), offset: index * 6000 } },
      })) })
      for (let index = 0; index < 6; index += 1) {
        expect(await reserveResearchRequest({ ...resumed, callId: randomUUID() }, 'read', 'e'.repeat(64))).toBe(true)
      }
      expect(await reserveResearchRequest({ ...resumed, callId: randomUUID() }, 'read', 'e'.repeat(64))).toBe(false)
      const source = await registerResearchSource(resumed, 'https://example.com/evidence')
      const text = '人物在村庄修建水渠，合作解决了道路与水流冲突。'.repeat(100)
      const evidence = await saveResearchContent(resumed, source.id, { ...assessReaderText(text, '材料'), finalUrl: source.canonicalUrl,
        provider: 'direct', retryable: false, contentKind: 'article' })
      expect(await findSavedResearchContent(resumed, source.id)).toEqual({ id: evidence.id, revision: evidence.revision })
      expect(evidence.providedRanges).toEqual([])
      await Promise.all([
        recordResearchWindow(resumed, { contentRef: evidence.id, revision: evidence.revision, start: 0, end: 100 }),
        recordResearchWindow(resumed, { contentRef: evidence.id, revision: evidence.revision, start: 50, end: 150 }),
      ])
      expect((await prisma.agentResearchContent.findUniqueOrThrow({ where: { id: evidence.id } })).providedRanges).toEqual([{ start: 0, end: 150 }])
      await expect(recordResearchWindow({ ...resumed, userId: randomUUID() }, { contentRef: evidence.id,
        revision: evidence.revision, start: 150, end: 200 })).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_NOT_FOUND' })
      const citation = { contentRef: evidence.id, revision: evidence.revision, start: 0, end: 20,
        excerptHash: createHash('sha256').update(text.slice(0, 20)).digest('hex') }
      const second = { ...input, expectedRevision: 1, section: { id: 'characters', order: 1, content: '人物关系随冲突逐步变化。', citations: [citation] } }
      await expect(saveResearchReportSection(resumed, { ...second, section: { ...second.section,
        citations: [{ ...citation, excerptHash: '0'.repeat(64) }] } })).rejects.toMatchObject({ code: 'RESEARCH_CITATION_INVALID' })
      await expect(saveResearchReportSection(scope, second)).rejects.toMatchObject({ code: 'RESEARCH_RUN_NOT_ACTIVE' })
      expect(await saveResearchReportSection(resumed, second)).toMatchObject({ artifactId: saved.artifactId, revision: 2 })
      const report = await readResearchReport(resumed, { limit: 5 })
      expect(report).toMatchObject({ revision: 2, nextOffset: 5, content: input.section.content.slice(0, 5) })
      expect(report.sections).toHaveLength(2)
      expect(await readResearchReportForDelivery(resumed)).toMatchObject({
        revision: 2, content: input.section.content + '\n\n' + second.section.content, nextOffset: null,
        evidence: { discoveredPages: 2, readablePages: 1, metadataPages: 0, failedSources: 0, citedVersions: 1, providedCharacters: 150 },
      })
      expect((await readResearchReport(resumed, { offset: 5, expectedRevision: report.revision })).content).toBe((input.section.content + '\n\n' + second.section.content).slice(5))
      await saveResearchReportSection(resumed, { ...second, expectedRevision: 2,
        section: { ...second.section, content: '修订后的角色分析，不应与旧版拼接。' } })
      await expect(readResearchReport(resumed, { offset: 5, expectedRevision: report.revision }))
        .rejects.toMatchObject({ code: 'RESEARCH_REPORT_CONFLICT' })
      expect(await readResearchReport(resumed, { expectedRevision: 3 })).toMatchObject({ revision: 3 })
      const otherId = randomUUID()
      const other = buildTaskSpec({ runId: otherId, novelId: novel.id, prompt: '写下一章' })
      await prisma.agentRun.create({ data: { ...base, id: otherId, taskSpec: JSON.parse(JSON.stringify(other)) } })
      expect(await readResearchReport({ ...scope, runId: otherId }, {})).toMatchObject({ revision: 0 })
      await expect(saveResearchReportSection({ ...scope, runId: otherId }, input)).rejects.toMatchObject({ code: 'RESEARCH_REPORT_NOT_AUTHORIZED' })
      await expect(readResearchReport({ ...scope, userId: randomUUID() }, {})).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_NOT_FOUND' })
      expect(await prisma.chapter.count({ where: { novelId: novel.id } })).toBe(0)
      expect(await prisma.agentArtifact.count({ where: { run: { userId: user.id } } })).toBe(1)
    } finally {
      await prisma.agentArtifact.deleteMany({ where: { run: { userId: user.id } } })
      await prisma.agentRun.deleteMany({ where: { userId: user.id } })
      await prisma.agentSession.deleteMany({ where: { userId: user.id } })
      await prisma.novel.deleteMany({ where: { authorId: user.id } })
      await prisma.user.delete({ where: { id: user.id } })
    }
  })
  it('preserves meaningful query parameters and does not rewrite signed URLs', () => {
    expect(canonicalResearchUrl('https://example.com/chapter?id=19&page=2&utm_source=test')).toBe('https://example.com/chapter?id=19&page=2')
    const signed = 'https://example.com/chapter?id=19&signature=abc%2B123&utm_source=test'
    expect(canonicalResearchUrl(signed)).toBe(signed)
  })
  it('persists full text, resumes exact windows, isolates new tasks, and deletes private evidence with its owner', async () => {
    const user = await prisma.user.create({ data: { nickname: 'research-fixture', passwordHash: 'test-only' } })
    try {
      const novel = await prisma.novel.create({ data: { authorId: user.id, title: '研究测试', slug: randomUUID(), summary: '' } })
      const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '分析' } })
      const runId = randomUUID()
      const spec = buildTaskSpec({ runId, novelId: novel.id, prompt: '分析指定资料' })
      const runData = { userId: user.id, novelId: novel.id, sessionId: session.id, mode: 'act' as const,
        action: 'workspaceAgent' as const, agentType: 'writingOrchestrator' as const, engine: 'loop' }
      await prisma.agentRun.create({ data: { ...runData, id: runId, taskSpec: JSON.parse(JSON.stringify(spec)) } })
      const scope = { userId: user.id, novelId: novel.id, sessionId: session.id, runId }
      expect(await findResearchSource(scope, 'https://example.com/book?id=19')).toBeNull()
      const source = await registerResearchSource(scope, 'https://example.com/book?id=19', '指定资料')
      expect(await prisma.agentResearchContent.count({ where: { sourceId: source.id } })).toBe(0)
      const text = '这份材料描述了村庄兴建水渠的过程，工匠与村民合作解决道路和水流的问题。'.repeat(500)
      const page = { ...assessReaderText(text, '水渠'), finalUrl: source.canonicalUrl, provider: 'direct' as const, retryable: false, contentKind: 'article' as const,
        links: Array.from({ length: 19 }, (_, index) => ({ url: `https://example.com/chapter?id=${20 + index}`, title: `第${20 + index}章` })) }
      const saved = await saveResearchContent(scope, source.id, page)
      expect((await saveResearchContent(scope, source.id, page)).id).toBe(saved.id)
      const first = await readResearchContent(scope, { contentRef: saved.id, revision: saved.revision })
      expect(first).toMatchObject({ text: text.slice(0, 6000), truncated: true, nextCursor: '6000' })
      expect(first.links).toEqual(page.links.slice(0, 8))
      expect(first).toMatchObject({ linksTotal: 19, linksNextOffset: 8 })
      const secondLinks = await readResearchContent(scope, { contentRef: saved.id, revision: saved.revision, linksOffset: 8 })
      const lastLinks = await readResearchContent(scope, { contentRef: saved.id, revision: saved.revision, linksOffset: 16 })
      expect([...first.links, ...secondLinks.links, ...lastLinks.links]).toEqual(page.links)
      expect(lastLinks.linksNextOffset).toBeNull()
      await expect(readResearchContent(scope, { contentRef: saved.id, revision: saved.revision, linksOffset: 20 })).rejects.toMatchObject({ code: 'RESEARCH_RANGE_INVALID' })
      const located = await readResearchContent(scope, { contentRef: saved.id, revision: saved.revision, find: '村庄', offset: 6500, limit: 200 })
      const matchAt = text.indexOf('村庄', 6500)
      expect(located.match).toEqual({ start: matchAt, end: matchAt + 2 })
      expect(located.text).toBe(text.slice(located.returnedRange.start, located.returnedRange.end))
      expect(located.text).toContain('村庄')
      expect(located.text.length).toBeLessThanOrEqual(200)
      expect(located.revision).toBe(saved.revision)
      expect(located.excerptHash).toBe(createHash('sha256').update(located.text).digest('hex'))
      await expect(readResearchContent(scope, { contentRef: saved.id, revision: saved.revision, find: '不存在的证据' })).rejects.toMatchObject({ code: 'RESEARCH_MATCH_NOT_FOUND' })
      await expect(readResearchContent(scope, { contentRef: saved.id, revision: saved.revision, find: '  ' })).rejects.toMatchObject({ code: 'RESEARCH_QUERY_INVALID' })
      const resumedId = randomUUID()
      await prisma.agentRun.create({ data: { ...runData, id: resumedId, taskSpec: JSON.parse(JSON.stringify({ ...spec, runId: resumedId })) } })
      const resumedScope = { ...scope, runId: resumedId }
      expect((await registerResearchSource(resumedScope, source.canonicalUrl)).id).toBe(source.id)
      expect((await findResearchSource(resumedScope, source.canonicalUrl))?.id).toBe(source.id)
      for (const code of ['WEB_READ_NOT_FOUND', 'WEB_READ_BLOCKED', 'WEB_READ_GARBLED', 'WEB_READ_INSUFFICIENT',
        'WEB_READ_TOO_LARGE', 'WEB_READ_UNSAFE_URL', 'WEB_READ_UNSUPPORTED_TYPE', 'WEB_READ_HTTP_ERROR',
        'WEB_READ_SOURCE_ERROR', 'WEB_READ_PROTOCOL_ERROR', 'WEB_READ_PARSE_ERROR',
        'WEB_READ_COMPLEX_DOCUMENT', 'WEB_READ_HOSTED_TARGET_RESTRICTED'] as const) {
        await recordResearchReadFailure(scope, source.id, { ...page, status: 'unreadable', code })
        expect(await getResearchReadFailure(resumedScope, source.id)).toMatchObject({ code })
      }
      for (const code of ['WEB_READ_UNAVAILABLE', 'WEB_READ_HOSTED_UNAVAILABLE'] as const) {
        await prisma.agentResearchSource.update({ where: { id: source.id }, data: { readFailure: { code, retryAt: '2000-01-01T00:00:00.000Z' } } })
        const started = Date.now()
        await recordResearchReadFailure(scope, source.id, { ...page, status: 'transient_error', retryable: true, code })
        const failure = await getResearchReadFailure(resumedScope, source.id)
        expect(failure).toMatchObject({ code })
        expect(Date.parse(failure!.retryAt)).toBeGreaterThanOrEqual(started + 60_000)
        expect(Date.parse(failure!.retryAt)).toBeLessThanOrEqual(Date.now() + 60_000)
      }
      // Retry-After survives restart and is not shortened to the default negative TTL.
      await recordResearchReadFailure(scope, source.id, { ...page, status: 'transient_error', code: 'WEB_READ_RATE_LIMITED', retryAfter: '3600' })
      expect(Date.parse((await getResearchReadFailure(resumedScope, source.id))!.retryAt)).toBeGreaterThan(Date.now() + 3_500_000)
      await recordResearchReadFailure(scope, source.id, { ...page, status: 'transient_error', retryable: true, code: 'WEB_READ_UNAVAILABLE' })
      expect(await getResearchReadFailure(resumedScope, source.id)).toMatchObject({ code: 'WEB_READ_RATE_LIMITED' })
      expect(Date.parse((await getResearchReadFailure(resumedScope, source.id))!.retryAt)).toBeGreaterThan(Date.now() + 3_500_000)
      const retryDate = new Date(Date.now() + 7200_000).toUTCString()
      await recordResearchReadFailure(scope, source.id, { ...page, status: 'transient_error', code: 'WEB_READ_RATE_LIMITED', retryAfter: retryDate })
      expect(Date.parse((await getResearchReadFailure(resumedScope, source.id))!.retryAt)).toBe(Date.parse(retryDate))
      // A stored window remains readable even if a subsequent network fetch was denied.
      expect((await readResearchContent(resumedScope, { contentRef: saved.id, revision: saved.revision })).text).toBe(first.text)
      await prisma.agentResearchSource.update({ where: { id: source.id }, data: { readFailure: { code: 'WEB_READ_BLOCKED', retryAt: '2000-01-01T00:00:00.000Z' } } })
      expect(await getResearchReadFailure(resumedScope, source.id)).toBeNull()
      await recordResearchReadFailure(scope, source.id, { ...page, status: 'blocked', code: 'WEB_READ_BLOCKED' })
      await saveResearchContent(scope, source.id, page)
      expect(await getResearchReadFailure(resumedScope, source.id)).toBeNull()
      let assembled = first.text, offset = 6000
      while (offset < text.length) {
        const window = await readResearchContent(resumedScope, { contentRef: saved.id, revision: saved.revision, offset })
        assembled += window.text
        offset = window.returnedRange.end
      }
      expect(assembled).toBe(text)
      const changedLinks = await saveResearchContent(scope, source.id, { ...page, links: page.links.slice(0, 9) })
      expect(changedLinks.id).not.toBe(saved.id)
      expect(changedLinks.revision).not.toBe(saved.revision)
      expect((await readResearchContent(scope, { contentRef: saved.id, revision: saved.revision })).linksTotal).toBe(19)
      const legacyRevision = createHash('sha256').update(JSON.stringify([saved.contentHash, saved.finalUrl, saved.contentKind])).digest('hex')
      const legacy = await prisma.agentResearchContent.create({ data: { ...saved, id: randomUUID(), revision: legacyRevision,
        quality: { ...page.quality, links: page.links.slice(0, 8) } } })
      expect((await readResearchContent(scope, { contentRef: legacy.id, revision: legacyRevision })).linksTotal).toBe(8)
      await expect(readResearchContent(scope, { contentRef: saved.id, revision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'RESEARCH_REVISION_MISMATCH' })
      await expect(readResearchContent(scope, { contentRef: saved.id, revision: saved.revision, offset: text.length + 1 })).rejects.toMatchObject({ code: 'RESEARCH_RANGE_INVALID' })
      const nextId = randomUUID()
      await prisma.agentRun.create({ data: { ...runData, id: nextId } })
      await expect(resolveResearchSource({ ...scope, runId: nextId }, source.id)).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_NOT_FOUND' })
      expect(await findResearchSource({ ...scope, runId: nextId }, source.canonicalUrl)).toBeNull()
      await expect(recordResearchReadFailure({ ...scope, runId: nextId }, source.id, { ...page, status: 'blocked', code: 'WEB_READ_BLOCKED' })).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_NOT_FOUND' })
      await expect(getResearchReadFailure({ ...scope, runId: nextId }, source.id)).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_NOT_FOUND' })
      await expect(resolveResearchSource({ ...scope, userId: randomUUID() }, source.id)).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_NOT_FOUND' })
      await expect(saveResearchContent(scope, source.id, { ...page, status: 'blocked' })).rejects.toMatchObject({ code: 'RESEARCH_CONTENT_UNREADABLE' })
      await prisma.agentResearchContent.update({ where: { id: saved.id }, data: { text: '被改变的内容' } })
      await expect(readResearchContent(scope, { contentRef: saved.id, revision: saved.revision })).rejects.toMatchObject({ code: 'RESEARCH_REVISION_MISMATCH' })
      await prisma.agentRun.delete({ where: { id: runId } })
      expect(await prisma.agentResearchContent.count({ where: { id: saved.id } })).toBe(0)
      expect(await prisma.chapter.count({ where: { novelId: novel.id } })).toBe(0)
      expect(await prisma.agentArtifact.count({ where: { run: { userId: user.id } } })).toBe(0)
    } finally {
      await prisma.agentRun.deleteMany({ where: { userId: user.id } })
      await prisma.agentSession.deleteMany({ where: { userId: user.id } })
      await prisma.novel.deleteMany({ where: { authorId: user.id } })
      await prisma.user.delete({ where: { id: user.id } })
    }
  })
})
