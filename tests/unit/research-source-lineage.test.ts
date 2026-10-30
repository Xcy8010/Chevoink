import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { authorizeResearchNavigation, getResearchReadTarget, registerResearchSource, saveResearchContent, readResearchContent,
  saveResearchReportSection, recordResearchWindow } from '../../api/lib/agent/research-sources.js'
import { assessReaderEvidence, assessReaderText, extractReaderNavigationHtml } from '../../api/lib/web-reader-quality.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const work = { title: '霜河档案', author: '周禾' }
const bookUrl = 'https://first.example.com/books/river', otherBookUrl = 'https://other.example.com/books/river', otherChapterUrl = 'https://other.example.com/chapters/ice'
const text = '村民沿河查看旧冰的边缘，逐一记录木桩留下的水线，再带着不同的观察返回仓房核对记录。'.repeat(12)
type RecordData = Record<string, unknown>
function fixture(kind: 'open' | 'historical' | 'only' = 'open') {
  const prompt = kind === 'only' ? '联网研究《霜河档案》，作者：周禾。只在 https://first.example.com 读取公开章节并分析。'
    : kind === 'historical' ? '联网研究《霜河档案》，作者：周禾。优先从 https://first.example.com 读取公开章节并分析。'
      : '联网研究《霜河档案》，作者：周禾。优先番茄小说，读取公开章节并分析。'
  const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', prompt, researchAdmission: 1, researchNavigationAdmission: 1 })
  if (kind === 'historical') {
    // This fixture represents the old platform-inferred host in an admitted contract.
    spec.researchTarget!.sourceHosts = ['first.example.com']; spec.researchNavigation!.sourceHosts = ['first.example.com']
  }
  const run = { id: 'run', userId: 'user', novelId: 'novel', sessionId: 'session', taskSpec: spec, status: 'running', runtimeProtocolVersion: 0 }
  const sources = new Map<string, RecordData>(), contents = new Map<string, RecordData>(), artifacts = new Map<string, RecordData>()
  const results: Array<{ savedOutcome: { provider: string; query: string; results: Array<{ title: string; url: string; snippet: string; source: string }> } }> = []
  const db = {
    $queryRaw: vi.fn(async () => []),
    agentRun: { findFirst: vi.fn(async () => run) },
    agentMessage: { findMany: vi.fn(async () => [{ parts: [{ type: 'text', text: prompt }] }]) },
    agentResearchRequest: { findMany: vi.fn(async () => results) },
    agentResearchSource: {
      upsert: vi.fn(async ({ where, create }: { where: { id: string }; create: RecordData }) => {
        if (!sources.has(where.id)) sources.set(where.id, { readFailure: null, ...create }); return sources.get(where.id)
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => sources.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: RecordData }) => Object.assign(sources.get(where.id)!, data)),
    },
    agentResearchContent: {
      upsert: vi.fn(async ({ where, create }: { where: { sourceId_revision: { sourceId: string; revision: string } }; create: RecordData }) => {
        const prior = [...contents.values()].find(item => item.sourceId === where.sourceId_revision.sourceId && item.revision === where.sourceId_revision.revision)
        if (prior) return prior
        const value = { providedRanges: [], ...create }; contents.set(String(value.id), value); return value
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const value = contents.get(where.id); return value ? { ...value, source: sources.get(String(value.sourceId)) } : null
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => contents.get(where.id)!),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: RecordData }) => Object.assign(contents.get(where.id)!, data)),
      findMany: vi.fn(async ({ where }: { where: { finalUrl?: { not: string } } }) => [...contents.values()].reverse().filter(item => item.finalUrl !== where.finalUrl?.not)),
    },
    agentArtifact: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => { const value = artifacts.get(where.id); return value ? { ...value, run } : null }),
      create: vi.fn(async ({ data }: { data: RecordData }) => { artifacts.set(String(data.id), data); return data }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: RecordData }) => Object.assign(artifacts.get(where.id)!, data)),
    },
  }
  const tx = db as unknown as Prisma.TransactionClient
  const scope = { userId: 'user', novelId: 'novel', sessionId: 'session', runId: 'run', transaction: tx }
  const navigation = (url: string, links: string[] = []) => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Book', name: work.title, author: work.author })}</script><main>${links.map(link => `<a href="${link}">第2章 冰河</a>`).join('')}</main>`
    return { ...extractReaderNavigationHtml(html, url, { ...work, sourceHosts: [] }), finalUrl: url, provider: 'direct' as const, retryable: false,
      contentKind: 'metadata' as const, purpose: 'navigation' as const }
  }
  const body = (url: string, actual = work, structured = true) => {
    const html = structured ? `<script type="application/ld+json">${JSON.stringify({ '@type': 'Chapter', articleBody: text, isPartOf: { '@type': 'Book', name: actual.title, author: actual.author } })}</script>` : `<article>${text}</article>`
    return { ...assessReaderText(text, `${actual.title}第2章 冰河`), finalUrl: url, provider: 'direct' as const, retryable: false, contentKind: 'article' as const,
      evidence: assessReaderEvidence(text, `${actual.title}第2章 冰河`, { ...work, sourceHosts: [] }, html, url) }
  }
  const discover = (url: string) => results.push({ savedOutcome: { provider: 'sogou', query: '霜河档案 周禾 公开章节',
    results: [{ title: `${work.title}作品目录`, url, snippet: `作者：${work.author}`, source: new URL(url).hostname }] } })
  const seed = async () => {
    const source = await registerResearchSource(scope, bookUrl, work.title)
    const saved = await saveResearchContent(scope, source.id, navigation(bookUrl))
    if (kind === 'historical') {
      // Reconstruct the exact old v4 receipt once, before exercising compatibility.
      const record = [...artifacts.values()][0], metadata = record.metadata as { target: { sourceHosts: string[] }; identityHash: string; revision: string }
      metadata.target.sourceHosts = ['first.example.com']; metadata.identityHash = hash(JSON.stringify({ ...work, sourceHosts: ['first.example.com'] }))
      const stored = contents.get(saved.id)!, quality = stored.quality as { links: unknown; evidence: unknown; binding: { identityHash: string } }
      quality.binding.identityHash = metadata.identityHash
      stored.revision = hash(JSON.stringify([stored.contentHash, stored.finalUrl, stored.contentKind, quality.links, quality.evidence, quality.binding]))
      metadata.revision = String(stored.revision)
    }
    return { selection: structuredClone([...artifacts.values()][0]), first: structuredClone([...contents.values()][0]), spec: structuredClone(spec) }
  }
  const cite = (saved: { id: string; revision: string }) => saveResearchReportSection(scope, { reportId: 'main', title: '研究报告', expectedRevision: 0,
    section: { id: 'sample', order: 0, content: '根据实际章节样本分析叙事。', citations: [{ contentRef: saved.id, revision: saved.revision, start: 0, end: 40, excerptHash: hash(text.slice(0, 40)) }] } }, tx)
  return { spec, scope, sources, contents, artifacts, db, seed, discover, navigation, body, cite }
}

describe('same-work sources without an inferred first-site restriction', () => {
  it.each(['open', 'historical'] as const)('%s accepts a discovered same-work directory on another site and preserves the original selection/hash', async kind => {
    const f = fixture(kind), before = await f.seed()
    expect(await getResearchReadTarget(f.scope)).toMatchObject({ ...work, sourceHosts: [] })
    f.discover(otherBookUrl)
    const directory = await registerResearchSource(f.scope, otherBookUrl, work.title)
    await authorizeResearchNavigation(f.scope, directory.id)
    await saveResearchContent(f.scope, directory.id, f.navigation(otherBookUrl, [otherChapterUrl]))
    const chapter = await registerResearchSource(f.scope, otherChapterUrl, '第2章 冰河')
    const saved = await saveResearchContent(f.scope, chapter.id, f.body(otherChapterUrl))
    expect(await readResearchContent(f.scope, { contentRef: saved.id, revision: saved.revision })).toMatchObject({ text, evidence: { identity: { status: 'verified', pageType: 'chapter' } } })
    expect(await f.cite(saved)).toMatchObject({ revision: 1 })
    expect([...f.artifacts.values()][0]).toEqual(before.selection)
    expect([...f.contents.values()][0]).toEqual(before.first)
    expect(f.spec).toEqual(before.spec)
  })
  it('accepts a directly discovered chapter only after actual same-work chapter evidence, not the search identity claim', async () => {
    const f = fixture(); await f.seed(); f.discover(otherChapterUrl)
    const source = await registerResearchSource(f.scope, otherChapterUrl, work.title)
    const saved = await saveResearchContent(f.scope, source.id, f.body(otherChapterUrl))
    expect(await f.cite(saved)).toMatchObject({ revision: 1 })
  })
  it('retains a source-proven short preview and permits only an actually read citation range', async () => {
    const f = fixture(); await f.seed(); f.discover(otherChapterUrl)
    const source = await registerResearchSource(f.scope, otherChapterUrl, work.title)
    const full = f.body(otherChapterUrl), partialText = text.slice(0, 120)
    const preview = { ...full, status: 'ok' as const, code: 'WEB_READ_PARTIAL' as const, text: partialText,
      quality: { ...full.quality, readable: true }, evidence: { ...full.evidence, integrity: {
        status: 'unverified' as const, code: 'SOURCE_PREVIEW_ONLY', extractedHash: hash(partialText), referenceHash: hash(text),
      } } }
    const saved = await saveResearchContent(f.scope, source.id, preview)
    expect(await readResearchContent(f.scope, { contentRef: saved.id, revision: saved.revision })).toMatchObject({ text: partialText,
      evidence: { integrity: { code: 'SOURCE_PREVIEW_ONLY', status: 'unverified' } } })
    await expect(f.cite(saved)).rejects.toMatchObject({ code: 'RESEARCH_CITATION_INVALID' })
    await recordResearchWindow(f.scope, { contentRef: saved.id, revision: saved.revision, start: 0, end: 40 })
    expect(await f.cite(saved)).toMatchObject({ revision: 1 })
  })
  it('keeps an explicit only-source boundary on navigation and final body storage', async () => {
    const f = fixture('only'), before = await f.seed(); f.discover(otherBookUrl)
    const source = await registerResearchSource(f.scope, otherBookUrl, work.title)
    await expect(authorizeResearchNavigation(f.scope, source.id)).rejects.toMatchObject({ code: 'RESEARCH_NAVIGATION_DENIED' })
    await expect(saveResearchContent(f.scope, source.id, f.body(otherBookUrl))).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_SCOPE_MISMATCH' })
    expect([...f.artifacts.values()][0]).toEqual(before.selection)
  })
  it('does not accept an undiscovered second-site directory or arbitrary chapter despite matching page metadata', async () => {
    const f = fixture(); await f.seed()
    const directory = await registerResearchSource(f.scope, otherBookUrl, work.title)
    await expect(authorizeResearchNavigation(f.scope, directory.id)).rejects.toMatchObject({ code: 'RESEARCH_NAVIGATION_UNRELATED' })
    await saveResearchContent(f.scope, directory.id, f.navigation(otherBookUrl, [otherChapterUrl]))
    const chapter = await registerResearchSource(f.scope, otherChapterUrl, work.title)
    await expect(saveResearchContent(f.scope, chapter.id, f.body(otherChapterUrl))).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_LINEAGE_REQUIRED' })
  })
  it.each(['wrong-title', 'wrong-author', 'no-structured-chapter'] as const)('does not turn a discovered search URL into target text for %s', async invalid => {
    const f = fixture(), before = await f.seed(); f.discover(otherChapterUrl)
    const source = await registerResearchSource(f.scope, otherChapterUrl, work.title)
    const saved = await saveResearchContent(f.scope, source.id, f.body(otherChapterUrl, invalid === 'wrong-title' ? { ...work, title: '别的作品' }
      : invalid === 'wrong-author' ? { ...work, author: '另一人' } : work, invalid !== 'no-structured-chapter'))
    await expect(f.cite(saved)).rejects.toMatchObject({ code: 'RESEARCH_TARGET_EVIDENCE_REQUIRED' })
    expect([...f.artifacts.values()][0]).toEqual(before.selection)
  })
})
