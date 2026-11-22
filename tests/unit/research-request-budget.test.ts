import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { findResearchSearchOutcome, normalizeResearchSearchQuery, readResearchRequestBudget, reserveResearchRequest,
  saveResearchSearchOutcome, settleResearchRequest, recordResearchReadOutcome, recordResearchSearchFailure } from '../../api/lib/agent/research-sources.js'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Row = { id: string; scopeKey: string; ownerRunId: string; kind: string; requestKey: string; units: number; requestLimit: number; status: string; savedOutcome: unknown }
function fixture() {
  const rows: Row[] = []
  const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', prompt: '联网研究《样本》并分析公开正文', researchAdmission: 1 })
  const run = { id: 'run', taskRootId: 'root', taskSpec: spec, status: 'running' }
  const matches = (row: Row, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => {
    const actual = row[key as keyof Row]
    if (key === 'OR') return (value as Record<string, unknown>[]).some(clause => matches(row, clause))
    if (value && typeof value === 'object') {
      const constraint = value as Record<string, unknown>
      if ('not' in constraint) return constraint.not === Prisma.DbNull ? actual !== null : actual !== constraint.not
      if ('equals' in constraint) {
        if ('path' in constraint) return (constraint.path as string[]).reduce<unknown>((value, part) => value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined, actual) === constraint.equals
        return constraint.equals === Prisma.DbNull ? actual === null : JSON.stringify(actual) === JSON.stringify(constraint.equals)
      }
      if ('in' in constraint) return (constraint.in as unknown[]).includes(actual)
      return true
    }
    return actual === value
  })
  const legacy = { units: 0 }
  const qualified = { value: false }
  const db = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => parts.join('').includes('count(*)') ? [{ units: BigInt(legacy.units) }] : []),
    agentRun: { findFirst: vi.fn(async () => run) },
    webToolCall: { findFirst: vi.fn(async () => null), findUnique: vi.fn() },
    creditRefundIntent: { findFirst: vi.fn(async () => null) },
    agentResearchRequest: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find(row => row.id === where.id) ?? null),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => [...rows].reverse().find(row => matches(row, where)) ?? null),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter(row => matches(row, where))),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { units: 1, status: 'reserved', savedOutcome: null, ...data } as Row
        rows.push(row); return row
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const selected = rows.filter(row => matches(row, where)); selected.forEach(row => Object.assign(row, data)); return { count: selected.length }
      }),
    },
    agentResearchContent: { findFirst: vi.fn(async () => qualified.value ? { id: 'qualified-body' } : null) },
  }
  const tx = db as unknown as Prisma.TransactionClient
  const scope = { userId: 'user', sessionId: 'session', novelId: 'novel', runId: 'run', transaction: tx }
  const call = (callId: string) => ({ ...scope, callId })
  const search = async (query: string, callId: string, extension?: Parameters<typeof reserveResearchRequest>[5]) => {
    const request = call(callId)
    const allowed = await reserveResearchRequest(request, 'search', digest(query), undefined, tx, extension ?? { query })
    if (allowed) {
      await settleResearchRequest(request, 'consumed', tx)
      await saveResearchSearchOutcome(request, { provider: 'bocha', results: [] }, query)
    }
    return allowed
  }
  const seedSearches = async () => {
    for (let index = 0; index < 5; index++) expect(await search(`site:fanqienovel.com 样本 作者 ${index}`, `seed-${index}`)).toBe(true)
  }
  return { rows, db, tx, scope, call, run, spec, search, seedSearches, legacy, qualified }
}

describe('one task research request budget', () => {
  it('keeps ordinary Search at five and extends only a real missing-text gap with an actual new direction, up to total ten', async () => {
    const f = fixture(); await f.seedSearches()
    expect(await readResearchRequestBudget(f.scope, 'search', f.tx)).toEqual({ used: 5, limit: 5, remaining: 0 })
    expect(await f.search('site:fanqienovel.com 样本 不同字词', 'same-direction')).toBe(false)
    expect(await f.search('site:fanqienovel.com，样本 字序变化', 'punctuation-direction')).toBe(false)
    expect(await f.search('作者 0 样本 site:fanqienovel.com', 'reordered')).toBe(false)
    expect(await f.search('site:other.example.com 样本 正文', 'new-host')).toBe(true)
    expect(await f.search('样本 正文', 'open-web')).toBe(true)
    expect(await f.search('样本 目录', 'catalogue')).toBe(true)
    expect(await f.search('site:third.example.com 样本 正文', 'third-host')).toBe(true)
    expect(await f.search('site:fourth.example.com 样本 正文', 'fourth-host')).toBe(true)
    expect(await f.search('site:fifth.example.com 样本 正文', 'over-ten')).toBe(false)
    expect(f.rows.filter(row => row.kind === 'search' && row.status === 'consumed')).toHaveLength(10)
    expect(f.rows.find(row => row.kind === 'search' && row.status === 'baseline')).toMatchObject({ requestLimit: 5, units: 0 })
  })
  it('does not expand when qualified body already exists without an identified real unavailable source', async () => {
    const f = fixture(); await f.seedSearches(); f.qualified.value = true
    expect(await f.search('site:other.example.com 样本 正文', 'enough')).toBe(false)
    expect(await f.search('site:other.example.com 样本 正文', 'claimed-gap', { query: 'site:other.example.com 样本 正文',
      extension: { gap: 'source_unavailable', direction: 'site', host: 'other.example.com' } })).toBe(false)
    const request = f.call('real-failed-read')
    expect(await reserveResearchRequest(request, 'read', 'failed-page', undefined, f.tx)).toBe(true)
    await settleResearchRequest(request, 'consumed', f.tx); await recordResearchReadOutcome(request, false)
    expect(await f.search('site:other.example.com 样本 正文', 'real-gap')).toBe(true)
  })
  it('shares Fetch eight across a resumed path, and two real failed pages do not disable other sources or Search', async () => {
    const f = fixture()
    for (let index = 0; index < 2; index++) {
      const request = f.call(`failed-${index}`)
      expect(await reserveResearchRequest(request, 'read', `failed-page-${index}`, undefined, f.tx)).toBe(true)
      await settleResearchRequest(request, 'consumed', f.tx); await recordResearchReadOutcome(request, false)
    }
    expect(await f.search('样本 作者', 'after-two-failures')).toBe(true)
    const resumed = { ...f.scope, runId: 'resumed' }
    for (let index = 2; index < 8; index++) expect(await reserveResearchRequest({ ...resumed, callId: `read-${index}` }, 'read', `page-${index}`, undefined, f.tx)).toBe(true)
    expect(await readResearchRequestBudget(resumed, 'read', f.tx)).toEqual({ used: 8, limit: 8, remaining: 0 })
    expect(await reserveResearchRequest({ ...resumed, callId: 'ninth' }, 'read', 'page-9', undefined, f.tx)).toBe(false)
    expect(await readResearchRequestBudget(resumed, 'search', f.tx)).toEqual({ used: 1, limit: 5, remaining: 4 })
  })
  it('uses one Fetch-eight budget for navigation and bodies, with no navigation-two sublimit', async () => {
    const f = fixture()
    f.spec.researchNavigation = { version: 1, requestHash: digest('original'), alternativeSelection: 'denied' }
    for (let index = 0; index < 8; index++) {
      const request = f.call(`navigation-${index}`)
      expect(await reserveResearchRequest(request, 'read', `navigation-${index}`, 'navigation', f.tx)).toBe(true)
      await settleResearchRequest(request, 'consumed', f.tx); await recordResearchReadOutcome(request, true)
    }
    expect(await reserveResearchRequest(f.call('ninth-navigation'), 'read', 'ninth-navigation', 'navigation', f.tx)).toBe(false)
    expect(await readResearchRequestBudget(f.scope, 'read', f.tx)).toEqual({ used: 8, limit: 8, remaining: 0 })
    const legacy = fixture()
    await expect(reserveResearchRequest(legacy.call('no-purpose-grant'), 'read', 'key', 'navigation', legacy.tx))
      .rejects.toMatchObject({ code: 'RESEARCH_NAVIGATION_DENIED' })
  })
  it('keeps historical default-two baseline rows and units unchanged while applying current five/eight ceilings', async () => {
    const f = fixture(); f.legacy.units = 2
    const scopeKey = digest(['user', 'session', 'novel', 'root'])
    for (const kind of ['search', 'read'] as const) f.rows.push({ id: digest([scopeKey, kind, 'baseline']), ownerRunId: 'run', scopeKey, kind,
      units: 2, requestLimit: 2, requestKey: 'legacy-baseline', status: 'baseline', savedOutcome: null })
    const before = structuredClone(f.rows)
    expect(await f.search('样本 作者', 'third-search')).toBe(true)
    expect(await reserveResearchRequest(f.call('third-read'), 'read', 'new-page', undefined, f.tx)).toBe(true)
    expect(await readResearchRequestBudget(f.scope, 'search', f.tx)).toEqual({ used: 3, limit: 5, remaining: 2 })
    expect(await readResearchRequestBudget(f.scope, 'read', f.tx)).toEqual({ used: 3, limit: 8, remaining: 5 })
    expect(f.rows.filter(row => row.status === 'baseline')).toEqual(before)
  })
  it('recovers legacy results by exact request key and preserves the budget for equivalent keywords', async () => {
    const f = fixture(), original = '样本 作者 site:fanqienovel.com'
    expect(await f.search(original, 'saved')).toBe(true)
    const before = structuredClone(f.rows)
    expect(normalizeResearchSearchQuery('作者，样本 site:fanqienovel.com')).toBe(normalizeResearchSearchQuery('样本 作者 site:fanqienovel.com'))
    const resumed = { ...f.scope, runId: 'resumed' }
    expect(await findResearchSearchOutcome(resumed, digest(original))).toMatchObject({ provider: 'bocha', query: original, results: [] })
    expect(await findResearchSearchOutcome(resumed, 'different-key', '作者，样本 site:fanqienovel.com',
      { key: digest('changed count or provider') })).toBeNull()
    expect(f.rows).toEqual(before)
    expect(await f.search('作者，样本 site:fanqienovel.com', 'repeat')).toBe(false)
  })
  it('replays full ranking metadata only for the same public question and query semantics', async () => {
    const f = fixture(), query = '"river song" lang:zh,en after:2025 before:2027'
    const call = f.call('ranked-search'), contextKey = digest(['public question', 6, 'provider config'])
    expect(await reserveResearchRequest(call, 'search', 'ranked-key', undefined, f.tx, { query })).toBe(true)
    await settleResearchRequest(call, 'consumed', f.tx)
    const result = { title: 'Official source', url: 'https://sources.example.com/official', source: 'sources.example.com',
      snippet: 'Short excerpt', summary: 'Actual public summary. '.repeat(25), authority: 4, rerankScore: 2.9, publishedAt: '2026-10-01T00:00:00.000Z' }
    await saveResearchSearchOutcome(call, { provider: 'deepseek', results: [result], contextKey }, query)
    const resumed = { ...f.scope, runId: 'resumed' }
    const matching = { key: contextKey }
    expect(await findResearchSearchOutcome(resumed, 'different-worktree-key', query, matching)).toMatchObject({ query, results: [result] })
    expect(await findResearchSearchOutcome(resumed, 'other', query, { ...matching, key: digest('different public question') })).toBeNull()
    for (const change of [query.replace('lang:zh,en', 'lang:zh'), query.replace('before:2027', 'before:2026'),
      query.replace('"river song"', '"song river"'), query.replace('"river song"', '"river  song"')]) {
      expect(await findResearchSearchOutcome(resumed, 'other', change, matching)).toBeNull()
    }
    expect(await readResearchRequestBudget(resumed, 'search', f.tx)).toMatchObject({ used: 1, remaining: 4 })
  })
  it('reuses a pre-lookup receipt only in its original task with the old request key or identical query and old settings', async () => {
    const f = fixture(), query = 'site:book.example.com/book/it it novel', request = f.call('old-lookup')
    const prior = { requestKey: digest(['old', query]), contextKey: digest(['old', 6, 'config', 'question']) }
    expect(await reserveResearchRequest(request, 'search', prior.requestKey, undefined, f.tx, { query })).toBe(true)
    await settleResearchRequest(request, 'consumed', f.tx)
    await saveResearchSearchOutcome(request, { provider: 'bocha', results: [], contextKey: prior.contextKey }, query)
    const read = (scope: typeof f.scope, value: string, preLookup: typeof prior) =>
      findResearchSearchOutcome(scope, digest('with-target'), value, { key: digest('with-target-context'), preLookup })
    const resumed = { ...f.scope, runId: 'resumed' }
    const otherKey = { ...prior, requestKey: digest('changed-request') }
    expect(await read(resumed, query, { ...prior, contextKey: digest('unavailable-context') })).toMatchObject({ query })
    expect(await read(resumed, query, otherKey)).toMatchObject({ query })
    expect(await read(resumed, 'site:book.example.com/book/it novel it', otherKey)).toBeNull()
    expect(await read(resumed, query, { ...otherKey, contextKey: digest(['old', 5, 'config', 'question']) })).toBeNull()
    f.run.taskRootId = 'different-root'
    expect(await read(f.scope, query, prior)).toBeNull()
  })
  it('accepts an ordered legacy key only with the exact same original query', async () => {
    const f = fixture(), original = '"two  spaces" after:2025'
    expect(await f.search(original, 'old-ordered')).toBe(true)
    const resumed = { ...f.scope, runId: 'resumed' }, context = { key: digest('original scope'), legacyRequestKey: digest(original) }
    expect(await findResearchSearchOutcome(resumed, 'v2-key', original, context)).toMatchObject({ provider: 'bocha', query: original })
    expect(await findResearchSearchOutcome(resumed, 'another-v2-key', '"two spaces" after:2025', context)).toBeNull()
  })
  it.each(['free-failed', 'refunded-failed', 'unknown', 'wrong-request', 'no-refund'] as const)('records only original confirmed HTTP failure: %s', async state => {
    const f = fixture(), call = f.call('original-http-failure'), request = { query: '样本 作者', count: 2 }
    expect(await reserveResearchRequest(call, 'search', 'http-key', undefined, f.tx, { query: request.query })).toBe(true)
    await settleResearchRequest(call, 'consumed', f.tx)
    const receipt = { id: digest(['user', 'run', call.callId, 'search']), runId: 'run', kind: 'search',
      requestHash: state === 'wrong-request' ? 'other' : digest(request), status: state === 'unknown' ? 'dispatched' : 'failed',
      amountMilli: state === 'refunded-failed' || state === 'no-refund' ? 2000 : 0 }
    f.db.webToolCall.findUnique.mockResolvedValue(receipt)
    if (state === 'refunded-failed') f.db.creditRefundIntent.findFirst.mockResolvedValue({ originalEntryId: 'original-debit' } as never)
    const known = state === 'free-failed' || state === 'refunded-failed'
    expect(await recordResearchSearchFailure(call, request, [{ provider: 'bocha', httpStatus: 429 }])).toBe(known)
    const saved = f.rows.find(row => row.status === 'consumed')!
    expect(saved.savedOutcome).toEqual(known ? { kind: 'known_http_failure', query: request.query, failures: [{ provider: 'bocha', httpStatus: 429 }] } : null)
    expect(saved.units).toBe(1)
    expect(f.rows).toHaveLength(2)
    if (known) expect(await f.search('样本 目录', 'next-direction')).toBe(true)
  })
  it('preserves original network and search-only permission boundaries', async () => {
    const f = fixture(); f.run.taskSpec = { ...f.spec, networkAccess: 'denied' }
    await expect(reserveResearchRequest(f.call('denied'), 'search', 'key', undefined, f.tx)).rejects.toMatchObject({ code: 'RESEARCH_NETWORK_DENIED' })
    f.run.taskSpec = { ...f.spec, researchReadAccess: 'denied' }
    await expect(reserveResearchRequest(f.call('read-denied'), 'read', 'key', undefined, f.tx)).rejects.toMatchObject({ code: 'RESEARCH_READ_DENIED' })
    expect(f.rows).toEqual([])
  })
})
