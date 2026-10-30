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
  it('reuses the task search cache after resume and word reordering without another reservation', async () => {
    const f = fixture(); expect(await f.search('样本 作者 site:fanqienovel.com', 'saved')).toBe(true)
    const before = structuredClone(f.rows)
    expect(normalizeResearchSearchQuery('作者，样本 site:fanqienovel.com')).toBe(normalizeResearchSearchQuery('样本 作者 site:fanqienovel.com'))
    expect(await findResearchSearchOutcome({ ...f.scope, runId: 'resumed' }, 'different-key', '作者，样本 site:fanqienovel.com'))
      .toMatchObject({ provider: 'bocha', query: '样本 作者 site:fanqienovel.com', results: [] })
    expect(f.rows).toEqual(before)
    expect(await f.search('作者，样本 site:fanqienovel.com', 'repeat')).toBe(false)
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
