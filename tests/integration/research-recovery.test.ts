import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { TaskSpec } from '../../shared/contracts/index.js'
import type { WebSearchResult } from '../../api/lib/web-search-service.js'
import { prisma } from '../../api/lib/prisma.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { claimResearchReadHandoff, takeResearchReadHandoff, saveResearchLimitationDelivery } from '../../api/lib/agent/research-recovery.js'
import { registerResearchSource, reserveResearchRequest, settleResearchRequest, saveResearchSearchOutcome,
  recordResearchReadOutcome, saveResearchContent, saveResearchReportSection, readResearchReportForDelivery } from '../../api/lib/agent/research-sources.js'
import { assessReaderText, assessReaderEvidence } from '../../api/lib/web-reader-quality.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const target = { title: '河谷纪事', author: '林青', sourceHosts: ['fiction.example.com'], textAnalysisRequired: true }
type Scope = { userId: string; novelId: string; sessionId: string; runId: string }
type Fixture = { scope: Scope; spec: TaskSpec; scopeKey: string }
const runFields = { mode: 'act' as const, engine: 'loop', action: 'workspaceAgent' as const, agentType: 'writingOrchestrator' as const, status: 'running' as const }
const official: WebSearchResult = { title: '河谷纪事最新章节在线阅读_林青', url: 'https://fiction.example.com/page/123', snippet: '作者：林青，公开作品目录。', source: 'fiction.example.com' }
const unrelated: WebSearchResult = { title: '河（汉字）', url: 'https://dictionary.example.com/item/he', snippet: '汉字释义。', source: 'dictionary.example.com' }
const query = 'site:fiction.example.com 河谷纪事 林青'
const handoffCount = (scopeKey: string) => prisma.agentArtifact.count({ where: {
  id: hash([scopeKey, 'research-read-handoff-v1']), artifactType: 'contextCheckpoint',
} })

async function fixture(work: (fixture: Fixture) => Promise<void>, overrides: Partial<TaskSpec> = {}) {
  const user = await prisma.user.create({ data: { nickname: 'research-recovery-fixture', passwordHash: 'test-only' } })
  try {
    const novel = await prisma.novel.create({ data: { authorId: user.id, title: '研究恢复测试', slug: randomUUID(), summary: '' } })
    const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '研究' } })
    const runId = randomUUID()
    const spec: TaskSpec = { ...buildTaskSpec({ runId, novelId: novel.id, prompt: '只读联网研究《河谷纪事》，读取公开章节分析写法', researchAdmission: 1 }),
      intent: 'research_analysis', researchBudget: 'extended', researchDiscoveryProtocol: 1, researchTarget: target, ...overrides }
    const scope = { userId: user.id, novelId: novel.id, sessionId: session.id, runId }
    await prisma.agentRun.create({ data: { id: runId, userId: user.id, novelId: novel.id, sessionId: session.id,
      ...runFields, taskSpec: JSON.parse(JSON.stringify(spec)) } })
    await work({ scope, spec, scopeKey: hash([user.id, session.id, novel.id, spec.id]) })
    const requests = await prisma.agentResearchRequest.findMany({ where: { ownerRun: { userId: user.id } }, select: { kind: true, status: true, units: true } })
    expect(requests.every(request => ['search', 'read'].includes(request.kind))).toBe(true)
    expect(requests.every(request => ['baseline', 'reserved', 'consumed', 'released'].includes(request.status))).toBe(true)
    // Recovery checkpoints must not masquerade as network requests or insert
    // zero-unit non-baseline rows into the frozen quota/accounting table.
    expect(requests.filter(request => request.status !== 'baseline').every(request => request.units === 1)).toBe(true)
    const artifacts = await prisma.agentArtifact.findMany({ where: { run: { userId: user.id } } })
    const reports = artifacts.filter(artifact => artifact.artifactType === 'researchReport')
    const checkpoints = artifacts.filter(artifact => artifact.artifactType === 'contextCheckpoint')
    expect(artifacts.length).toBe(reports.length + checkpoints.length)
    for (const kind of ['researchReadHandoff', 'researchLimitationDelivery']) {
      expect(checkpoints.filter(checkpoint => (checkpoint.metadata as { kind?: string })?.kind === kind).length).toBeLessThanOrEqual(1)
    }
    for (const checkpoint of checkpoints) {
      expect(checkpoint.content).toBe('')
      expect(checkpoint.metadata).toMatchObject({ version: 1, scopeKey: hash([user.id, session.id, novel.id, spec.id]), taskKey: spec.id })
      const metadata = checkpoint.metadata as { kind: string; status: string }
      expect(['researchReadHandoff', 'researchLimitationDelivery']).toContain(metadata.kind)
      expect(['pending', 'consumed']).toContain(metadata.status)
    }
    expect(await prisma.creditLedgerEntry.count({ where: { userId: user.id } })).toBe(0)
    expect(await prisma.chapter.count({ where: { novelId: novel.id } })).toBe(0)
  } finally {
    await prisma.agentArtifact.deleteMany({ where: { run: { userId: user.id } } })
    await prisma.agentRun.deleteMany({ where: { userId: user.id } })
    await prisma.agentSession.deleteMany({ where: { userId: user.id } })
    await prisma.novel.deleteMany({ where: { authorId: user.id } })
    await prisma.user.delete({ where: { id: user.id } })
  }
}

async function search(scope: Scope, results: WebSearchResult[]) {
  const callId = randomUUID(), call = { ...scope, callId }
  expect(await reserveResearchRequest(call, 'search', hash([query, callId]))).toBe(true)
  await settleResearchRequest(call, 'consumed')
  await saveResearchSearchOutcome(call, { provider: 'deepseek', results }, query)
  const sources = await Promise.all(results.map(result => registerResearchSource(scope, result.url, result.title)))
  return { callId, sources }
}

async function fourthSearch(scope: Scope, lastResults = [official]) {
  for (let index = 0; index < 3; index++) await search(scope, [unrelated])
  return search(scope, lastResults)
}

async function consumeRead(scope: Scope, key: string, ok = true) {
  const call = { ...scope, callId: randomUUID() }
  expect(await reserveResearchRequest(call, 'read', hash(key))).toBe(true)
  await settleResearchRequest(call, 'consumed')
  await recordResearchReadOutcome(call, ok)
}

async function persistUnknown(scope: Scope, state: 'reserved-read' | 'unknown-read' | 'unknown-provider') {
  if (state === 'unknown-provider') {
    await prisma.webToolCall.create({ data: { id: hash([scope.runId, 'unknown-fetch']), runId: scope.runId,
      requestHash: hash(official.url), kind: 'fetch', amountMilli: 0, multiplierBps: 10000, status: 'dispatched' } })
  } else {
    const call = { ...scope, callId: randomUUID() }
    expect(await reserveResearchRequest(call, 'read', hash(official.url))).toBe(true)
    if (state === 'unknown-read') await settleResearchRequest(call, 'consumed')
  }
}

describe.skipIf(!available)('bounded research recovery with isolated PostgreSQL and synthetic evidence', () => {
  it('hands the fourth search exact official source to an ordinary read once without adding quota', async () => {
    await fixture(async ({ scope, scopeKey, spec }) => {
      const fourth = await fourthSearch(scope)
      const before = await prisma.agentResearchRequest.count({ where: { scopeKey, kind: { in: ['search', 'read'] } } })
      const claimed = await claimResearchReadHandoff(scope, [fourth.callId])
      expect(claimed).toEqual({ sourceId: fourth.sources[0].id, receiptId: hash([scopeKey, 'research-read-handoff-v1']) })
      expect(await claimResearchReadHandoff(scope, [fourth.callId])).toBeNull()
      const receipt = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: claimed!.receiptId } })
      expect(receipt).toMatchObject({ artifactType: 'contextCheckpoint', content: '', runId: scope.runId,
        metadata: { kind: 'researchReadHandoff', version: 1, scopeKey, taskKey: spec.id, status: 'pending',
          sourceId: fourth.sources[0].id, searchId: hash([scopeKey, scope.runId, fourth.callId]) } })
      expect(await prisma.agentResearchRequest.count({ where: { scopeKey, kind: { in: ['search', 'read'] } } })).toBe(before)
      expect(await takeResearchReadHandoff(scope)).toEqual(claimed)
      expect(await takeResearchReadHandoff(scope)).toBeNull()
      expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: claimed!.receiptId } })).toMatchObject({ metadata: { status: 'consumed' } })
      await consumeRead(scope, 'first ordinary admitted read')
      const baseline = await prisma.agentResearchRequest.findFirstOrThrow({ where: { scopeKey, kind: 'read', status: 'baseline' } })
      expect(baseline).toMatchObject({ requestLimit: 8, units: 0 })
    })
  })

  it('persists a single task handoff under concurrent claimers and cannot replenish it after resume', async () => {
    await fixture(async ({ scope, spec, scopeKey }) => {
      const fourth = await fourthSearch(scope)
      const claims = await Promise.all(Array.from({ length: 5 }, () => claimResearchReadHandoff(scope, [fourth.callId])))
      expect(claims.filter(Boolean)).toHaveLength(1)
      expect(await handoffCount(scopeKey)).toBe(1)
      await consumeRead(scope, 'original read')
      await prisma.agentRun.update({ where: { id: scope.runId }, data: { status: 'paused' } })
      const resumed = { ...scope, runId: randomUUID() }
      await prisma.agentRun.create({ data: { id: resumed.runId, userId: scope.userId, novelId: scope.novelId, sessionId: scope.sessionId,
        ...runFields, taskSpec: JSON.parse(JSON.stringify({ ...spec, runId: resumed.runId })) } })
      const fifth = await search(resumed, [official])
      expect(await claimResearchReadHandoff(resumed, [fifth.callId])).toBeNull()
      const resumedTakes = await Promise.all(Array.from({ length: 4 }, () => takeResearchReadHandoff(resumed)))
      expect(resumedTakes.filter(Boolean)).toHaveLength(1)
      expect(resumedTakes.find(Boolean)).toEqual(claims.find(Boolean))
      expect(await takeResearchReadHandoff(resumed)).toBeNull()
      expect(await reserveResearchRequest({ ...resumed, callId: randomUUID() }, 'search', hash('sixth search'))).toBe(false)
      for (let index = 1; index < 8; index++) await consumeRead(resumed, `remaining-${index}`)
      expect(await reserveResearchRequest({ ...resumed, callId: randomUUID() }, 'read', hash('ninth read'))).toBe(false)
      expect(await handoffCount(scopeKey)).toBe(1)
      expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: claims.find(Boolean)!.receiptId } }))
        .toMatchObject({ runId: scope.runId, metadata: { status: 'consumed' } })
    })
  })

  it('never grants a handoff using a qualified result from a different batch', async () => {
    await fixture(async ({ scope, scopeKey }) => {
      await search(scope, [official])
      const current = await search(scope, [unrelated])
      expect(await claimResearchReadHandoff(scope, [current.callId])).toBeNull()
      expect(await claimResearchReadHandoff(scope, [])).toBeNull()
      expect(await claimResearchReadHandoff(scope, [randomUUID()])).toBeNull()
      expect(await handoffCount(scopeKey)).toBe(0)
    })
  })

  it.each([
    { label: 'legacy contract', overrides: { researchDiscoveryProtocol: undefined } },
    { label: 'explicit no-network contract', overrides: { networkAccess: 'denied' as const } },
    { label: 'explicit search-only contract', overrides: { researchReadAccess: 'denied' as const } },
    { label: 'identity-only task', overrides: { researchTarget: { ...target, textAnalysisRequired: false } } },
    { label: 'unknown official scope', overrides: { researchTarget: { title: target.title, author: target.author } } },
  ])('does not grant recovery authority to $label', async ({ overrides }) => {
    await fixture(async ({ scope, scopeKey, spec }) => {
      // Persist a historical successful search explicitly. The no-network task
      // is not allowed to obtain a new reserve merely to arrange this fixture.
      const source = await registerResearchSource(scope, official.url, official.title)
      const callId = randomUUID()
      await prisma.agentResearchRequest.create({ data: { id: hash([scopeKey, scope.runId, callId]), ownerRunId: scope.runId,
        scopeKey, kind: 'search', requestKey: hash(query), requestLimit: 5, status: 'consumed', savedOutcome: { provider: 'deepseek', query, results: [official] } } })
      expect(source.id).toBeTruthy()
      expect(await claimResearchReadHandoff(scope, [callId])).toBeNull()
      expect(await handoffCount(scopeKey)).toBe(0)
      const receiptId = hash([scopeKey, 'research-read-handoff-v1'])
      await prisma.agentArtifact.create({ data: { id: receiptId, runId: scope.runId, artifactType: 'contextCheckpoint', title: '研究来源交接', content: '',
        metadata: { kind: 'researchReadHandoff', version: 1, scopeKey, taskKey: spec.id, status: 'pending',
          sourceId: source.id, searchId: hash([scopeKey, scope.runId, callId]) } } })
      expect(await takeResearchReadHandoff(scope)).toBeNull()
      expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: receiptId } })).toMatchObject({ metadata: { status: 'pending' } })
    }, overrides)
  })

  it('rejects foreign ownership and inactive runs without adding recovery state or a report', async () => {
    await fixture(async ({ scope, scopeKey }) => {
      const fourth = await fourthSearch(scope)
      const foreign = { ...scope, userId: randomUUID() }
      await expect(claimResearchReadHandoff(foreign, [fourth.callId])).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_NOT_FOUND' })
      await expect(takeResearchReadHandoff(foreign)).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_NOT_FOUND' })
      await expect(saveResearchLimitationDelivery(foreign, 'foreign')).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_NOT_FOUND' })
      await prisma.agentRun.update({ where: { id: scope.runId }, data: { status: 'paused' } })
      expect(await claimResearchReadHandoff(scope, [fourth.callId])).toBeNull()
      expect(await takeResearchReadHandoff(scope)).toBeNull()
      expect(await saveResearchLimitationDelivery(scope, 'paused')).toBeNull()
      expect(await handoffCount(scopeKey)).toBe(0)
      expect(await prisma.agentArtifact.count({ where: { runId: scope.runId } })).toBe(0)
    })
  })

  it.each([
    { label: 'secondary interview', candidate: { ...official, title: '林青《河谷纪事》创作访谈', url: 'https://fiction.example.com/article/45' } },
    { label: 'wrong publisher host', candidate: { ...official, url: 'https://wrong.example.com/page/123' } },
    { label: 'derivative prefix', candidate: { ...official, title: '河谷纪事：同人番外第1章', url: 'https://fiction.example.com/reader/345' } },
  ])('does not hand off $label as original text', async ({ candidate }) => {
    await fixture(async ({ scope, scopeKey }) => {
      const fourth = await fourthSearch(scope, [candidate])
      expect(await claimResearchReadHandoff(scope, [fourth.callId])).toBeNull()
      expect(await handoffCount(scopeKey)).toBe(0)
    })
  })

  it('requires remaining frozen read quota and preserves the two-failure stop', async () => {
    await fixture(async ({ scope, scopeKey }) => {
      const fourth = await fourthSearch(scope)
      for (let index = 0; index < 8; index++) await consumeRead(scope, `used-${index}`)
      expect(await claimResearchReadHandoff(scope, [fourth.callId])).toBeNull()
      expect(await handoffCount(scopeKey)).toBe(0)
    })
    await fixture(async ({ scope, scopeKey }) => {
      const fourth = await fourthSearch(scope)
      await consumeRead(scope, 'failure-1', false)
      await consumeRead(scope, 'failure-2', false)
      expect(await claimResearchReadHandoff(scope, [fourth.callId])).toBeNull()
      expect(await handoffCount(scopeKey)).toBe(0)
    })
  })

  it.each(['reserved-read', 'unknown-read', 'unknown-provider'] as const)('does not dispatch after persisted %s evidence', async state => {
    await fixture(async ({ scope, scopeKey }) => {
      const fourth = await fourthSearch(scope)
      await persistUnknown(scope, state)
      const before = await prisma.agentResearchRequest.count({ where: { scopeKey } })
      expect(await claimResearchReadHandoff(scope, [fourth.callId])).toBeNull()
      expect(await prisma.agentResearchRequest.count({ where: { scopeKey } })).toBe(before)
      expect(await prisma.webToolCall.count({ where: { runId: scope.runId } })).toBe(state === 'unknown-provider' ? 1 : 0)
    })
  })

  it.each(['reserved-read', 'unknown-read', 'unknown-provider'] as const)('preserves pending handoff without taking it after inherited %s', async state => {
    await fixture(async ({ scope, scopeKey, spec }) => {
      const fourth = await fourthSearch(scope)
      const pending = await claimResearchReadHandoff(scope, [fourth.callId])
      expect(pending).not.toBeNull()
      await persistUnknown(scope, state)
      await prisma.agentRun.update({ where: { id: scope.runId }, data: { status: 'paused' } })
      const resumed = { ...scope, runId: randomUUID() }
      await prisma.agentRun.create({ data: { id: resumed.runId, userId: scope.userId, novelId: scope.novelId, sessionId: scope.sessionId,
        ...runFields, taskSpec: JSON.parse(JSON.stringify({ ...spec, runId: resumed.runId })) } })
      const before = await prisma.agentResearchRequest.count({ where: { scopeKey } })
      expect(await takeResearchReadHandoff(resumed)).toBeNull()
      expect(await prisma.agentResearchRequest.count({ where: { scopeKey } })).toBe(before)
      expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: pending!.receiptId } })).toMatchObject({ artifactType: 'contextCheckpoint', content: '', metadata: { status: 'pending' } })
    })
  })

  it.each(['quota', 'read-breaker'] as const)('does not consume a pending marker after %s becomes unavailable', async reason => {
    await fixture(async ({ scope }) => {
      const fourth = await fourthSearch(scope)
      const pending = await claimResearchReadHandoff(scope, [fourth.callId])
      expect(pending).not.toBeNull()
      if (reason === 'quota') for (let index = 0; index < 8; index++) await consumeRead(scope, `used-${index}`)
      else { await consumeRead(scope, 'first-failure', false); await consumeRead(scope, 'second-failure', false) }
      expect(await takeResearchReadHandoff(scope)).toBeNull()
      expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: pending!.receiptId } })).toMatchObject({ metadata: { status: 'pending' } })
    })
  })

  it.each(['artifact-type', 'nonempty-content', 'metadata-version', 'metadata-scope', 'cross-session-owner'] as const)(
    'rejects a malformed handoff checkpoint with %s without modifying it or dispatching a read', async violation => {
      await fixture(async ({ scope, scopeKey, spec }) => {
        const fourth = await fourthSearch(scope)
        const claimed = await claimResearchReadHandoff(scope, [fourth.callId])
        expect(claimed).not.toBeNull()
        const marker = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: claimed!.receiptId } })
        const metadata = marker.metadata as { kind: string; version: number; scopeKey: string; taskKey: string;
          status: string; sourceId: string; searchId: string }
        let ownerRunId = scope.runId
        if (violation === 'cross-session-owner') {
          const otherSession = await prisma.agentSession.create({ data: { userId: scope.userId, novelId: scope.novelId, title: '其他会话' } })
          ownerRunId = randomUUID()
          await prisma.agentRun.create({ data: { id: ownerRunId, userId: scope.userId, novelId: scope.novelId, sessionId: otherSession.id,
            ...runFields, taskSpec: JSON.parse(JSON.stringify({ ...spec, runId: ownerRunId })) } })
        }
        await prisma.agentArtifact.update({ where: { id: marker.id }, data: {
          artifactType: violation === 'artifact-type' ? 'researchReport' : marker.artifactType,
          content: violation === 'nonempty-content' ? '非协议空载体，不得按服务端交接凭证消费。' : '', runId: ownerRunId,
          metadata: violation === 'metadata-version' ? { ...metadata, version: 2 }
            : violation === 'metadata-scope' ? { ...metadata, scopeKey: hash('another scope') } : metadata,
        } })
        try {
          const malformed = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: marker.id } })
          const beforeRequests = await prisma.agentResearchRequest.findMany({ where: { scopeKey }, orderBy: { id: 'asc' } })
          await expect(takeResearchReadHandoff(scope)).rejects.toMatchObject({ code: 'RESEARCH_CHECKPOINT_INVALID' })
          expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: marker.id } })).toEqual(malformed)
          expect(await prisma.agentResearchRequest.findMany({ where: { scopeKey }, orderBy: { id: 'asc' } })).toEqual(beforeRequests)
          expect(await prisma.agentResearchRequest.count({ where: { scopeKey, kind: 'read' } })).toBe(0)
          expect(await prisma.webToolCall.count({ where: { run: { userId: scope.userId } } })).toBe(0)
          expect(await prisma.creditLedgerEntry.count({ where: { userId: scope.userId } })).toBe(0)
        } finally {
          // Remove this intentional non-protocol fixture before the shared
          // postconditions inspect legitimately created checkpoint carriers.
          await prisma.agentArtifact.delete({ where: { id: marker.id } })
        }
      })
    },
  )

  it('distinguishes metadata from a verified chapter and preserves the saved author report and section identity', async () => {
    await fixture(async ({ scope, scopeKey }) => {
      const text = '清晨村民沿着河岸检查水位，记录木桩上留下的痕迹，再返回村庄讨论修渠方向。'.repeat(12)
      const metadataSource = await registerResearchSource(scope, official.url, official.title)
      const metadataHtml = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Book', name: target.title, author: target.author })}</script><article>${text}</article>`
      await saveResearchContent(scope, metadataSource.id, { ...assessReaderText(text, target.title), finalUrl: metadataSource.canonicalUrl,
        provider: 'direct', retryable: false, contentKind: 'metadata', evidence: assessReaderEvidence(text, target.title, target, metadataHtml, metadataSource.canonicalUrl) })
      const authorSection = { id: 'author-notes', order: 100, content: '作者已经保存的书目核验说明，必须原样保留。', evidenceKind: 'source_identity' as const, citations: [] }
      await saveResearchReportSection(scope, { reportId: 'main', title: '原作者保存的研究报告', expectedRevision: 0, section: authorSection })
      const partial = await saveResearchLimitationDelivery(scope, '未取得分析所需的原作正文。')
      expect(partial).toContain(authorSection.content)
      expect(partial).toContain('元数据版本 1')
      expect(partial).toContain('已核验章节版本 0')
      expect(partial).toContain('尚无可供写法分析的已核验原作正文')
      const first = await readResearchReportForDelivery(scope)
      expect(first).toMatchObject({ title: '原作者保存的研究报告', evidence: { targetAnalysisSupported: false } })
      const marker = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: hash([scopeKey, 'research-limitation-delivery-v1']) } })
      expect(marker).toMatchObject({ artifactType: 'contextCheckpoint', content: '', runId: scope.runId,
        metadata: { kind: 'researchLimitationDelivery', version: 1, scopeKey, status: 'consumed' } })
      const sectionId = (marker.metadata as { sectionId: string }).sectionId
      expect(sectionId).toMatch(/^system-limitation-[0-9a-f-]{36}$/u)
      expect(first.sections).toEqual([{ id: sectionId, order: 99 }, { id: 'author-notes', order: 100 }])
      const state = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: first.artifactId! } })
      expect((state.metadata as { sections: unknown[] }).sections).toContainEqual(authorSection)
      expect(await saveResearchLimitationDelivery(scope, '未取得分析所需的原作正文。')).toBe(partial)
      expect((await readResearchReportForDelivery(scope)).revision).toBe(first.revision)
      expect((await prisma.agentArtifact.findUniqueOrThrow({ where: { id: marker.id } })).metadata).toEqual(marker.metadata)

      const chapterSource = await registerResearchSource(scope, 'https://fiction.example.com/reader/987', '河谷纪事第1章 清晨')
      const chapterHtml = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Chapter', articleBody: text, isPartOf: { '@type': 'Book', name: target.title, author: target.author } })}</script>`
      const chapter = await saveResearchContent(scope, chapterSource.id, { ...assessReaderText(text, '河谷纪事第1章 清晨'), finalUrl: chapterSource.canonicalUrl,
        provider: 'direct', retryable: false, contentKind: 'article', evidence: assessReaderEvidence(text, '河谷纪事第1章 清晨', target, chapterHtml, chapterSource.canonicalUrl) })
      await saveResearchReportSection(scope, { reportId: 'main', title: '原作者保存的研究报告', expectedRevision: first.revision,
        section: { id: 'sample-analysis', order: 1, content: '仅就这份已核验章节证据作局部分析。', citations: [{ contentRef: chapter.id, revision: chapter.revision,
          start: 0, end: 50, excerptHash: createHash('sha256').update(text.slice(0, 50)).digest('hex') }] } })
      const withChapter = await saveResearchLimitationDelivery(scope, '仍有目标样本与全文覆盖尚未完成。')
      expect(withChapter).toContain('元数据版本 1')
      expect(withChapter).toContain('已核验章节版本 1')
      expect(withChapter).toContain(authorSection.content)
      expect(withChapter).toContain('仅就这份已核验章节证据作局部分析。')
      expect(withChapter).toContain('未标记完成')
      expect((await readResearchReportForDelivery(scope)).sections).toHaveLength(3)
      expect(await prisma.agentArtifact.count({ where: { runId: scope.runId, artifactType: 'researchReport' } })).toBe(1)
      expect(await prisma.agentArtifact.count({ where: { runId: scope.runId, artifactType: 'contextCheckpoint' } })).toBe(1)
      expect(await prisma.agentArtifact.count({ where: { runId: scope.runId } })).toBe(2)
    })
  })

  it('does not overwrite an author section using the former fixed system limitation ID', async () => {
    await fixture(async ({ scope, scopeKey }) => {
      const authorSection = { id: 'system-source-limitation', order: 100, content: '这是作者自己的受限来源记录，系统不得覆盖或改名。',
        evidenceKind: 'source_identity' as const, citations: [] }
      await saveResearchReportSection(scope, { reportId: 'main', title: '作者命名的既有报告', expectedRevision: 0, section: authorSection })
      const firstDelivery = await saveResearchLimitationDelivery(scope, '当前没有可核验目标正文。')
      expect(firstDelivery).toContain(authorSection.content)
      const marker = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: hash([scopeKey, 'research-limitation-delivery-v1']) } })
      const sectionId = (marker.metadata as { sectionId: string }).sectionId
      expect(sectionId).toMatch(/^system-limitation-[0-9a-f-]{36}$/u)
      expect(sectionId).not.toBe(authorSection.id)
      const first = await readResearchReportForDelivery(scope)
      expect(first).toMatchObject({ title: '作者命名的既有报告', sections: [{ id: sectionId, order: 99 }, { id: authorSection.id, order: 100 }] })
      const firstArtifact = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: first.artifactId! } })
      expect((firstArtifact.metadata as { sections: unknown[] }).sections).toContainEqual(authorSection)
      await saveResearchLimitationDelivery(scope, '新的失败原因仍须写入原系统所属区块。')
      const updated = await readResearchReportForDelivery(scope)
      expect(updated.sections).toEqual(first.sections)
      expect(updated.content).toContain(authorSection.content)
      expect(updated.content).toContain('新的失败原因仍须写入原系统所属区块。')
      expect((await prisma.agentArtifact.findUniqueOrThrow({ where: { id: marker.id } })).metadata).toEqual(marker.metadata)
      expect(await prisma.agentArtifact.count({ where: { id: marker.id, artifactType: 'contextCheckpoint' } })).toBe(1)
      const updatedArtifact = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: first.artifactId! } })
      expect((updatedArtifact.metadata as { sections: unknown[] }).sections).toContainEqual(authorSection)
      expect(await prisma.agentArtifact.count({ where: { runId: scope.runId, artifactType: 'researchReport' } })).toBe(1)
      expect(await prisma.agentArtifact.count({ where: { runId: scope.runId, artifactType: 'contextCheckpoint' } })).toBe(1)
      expect(await prisma.agentArtifact.count({ where: { runId: scope.runId } })).toBe(2)
    })
  })
})
