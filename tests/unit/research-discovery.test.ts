import { describe, expect, it } from 'vitest'
import { planResearchDiscovery, researchDiscoveryStepKey, type DiscoverySource } from '../../api/lib/agent/research-discovery.js'
import { extractReaderNavigationHtml } from '../../api/lib/web-reader-quality.js'

const target = { title: '河谷纪事', author: '林青' }
const source = (id: string, url: string, overrides: Partial<DiscoverySource> = {}): DiscoverySource => ({
  id, url, title: '河谷纪事 第一章', failed: false, eligible: true, pageType: 'chapter', versions: [], ...overrides,
})
const plan = (overrides: Partial<Parameters<typeof planResearchDiscovery>[0]> = {}) => planResearchDiscovery({
  target, sources: [], queries: [], consumed: new Set(), searchRemaining: 5, readRemaining: 8,
  navigation: true, allowedTools: ['web_search', 'web_read'], ...overrides,
})

describe('unified original and alternative source acquisition', () => {
  it('starts with the original site, then reads a real eligible URL before spending another search', () => {
    expect(plan()).toMatchObject({ name: 'web_search', args: { query: expect.stringContaining('site:fanqienovel.com') } })
    const alternate = source('other', 'https://publisher.example/chapter/1')
    const original = source('original', 'https://fanqienovel.com/reader/1')
    expect(plan({ sources: [alternate, original] })).toMatchObject({ name: 'web_read', args: { sourceId: 'original' } })
    expect(plan({ sources: [alternate, { ...original, failed: true }] })).toMatchObject({ name: 'web_read', args: { sourceId: 'other' } })
  })

  it('changes query and removes the preferred-site term after original-site attempts yield no qualified text', () => {
    const first = plan()!
    const second = plan({ queries: [first.args.query as string] })!
    expect(second).toMatchObject({ name: 'web_search', args: { query: expect.stringContaining('第一章') } })
    const third = plan({ sources: [source('failed', 'https://fanqienovel.com/reader/1', { failed: true })],
      queries: [first.args.query as string, second.args.query as string] })!
    expect(third).toMatchObject({ name: 'web_search', args: { query: '《河谷纪事》 林青 正文' } })
  })

  it('retains the requested chapter across original-site and open-web queries', () => {
    const requested = { ...target, chapterTitle: '第五章' }
    const queries: string[] = []
    for (let index = 0; index < 4; index++) {
      const step = plan({ target: requested, queries })!
      expect(step.name).toBe('web_search')
      queries.push(step.args.query as string)
    }
    expect(queries[0]).toContain('第五章 site:fanqienovel.com')
    expect(queries[2]).toBe('《河谷纪事》 林青 第五章 正文')
    expect(queries.join('\n')).not.toContain('第一章')
  })

  it('uses discovered chapter hrefs from a verified book page rather than inventing chapter URLs', () => {
    const url = 'https://publisher.example/chapter/actual-id'
    const book = source('book', 'https://publisher.example/book/1', { pageType: 'book', versions: [
      { contentKind: 'metadata', verifiedChapter: false, links: [{ url, title: '第一章' }] },
    ] })
    expect(plan({ sources: [book, source('chapter', url, { eligible: false })] })).toMatchObject({ name: 'web_read', args: { sourceId: 'chapter' } })
  })

  it('keeps a same-work directory verified when the original request names a later chapter', () => {
    const requested = { ...target, chapterTitle: '第五章' }
    const url = 'https://publisher.example/chapter/actual-fifth'
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Book', name: target.title, author: target.author })}</script><a href="${url}">第五章 归来</a>`
    const directory = extractReaderNavigationHtml(html, 'https://publisher.example/book/1', requested)
    expect(directory.evidence?.identity).toMatchObject({ status: 'verified', pageType: 'book' })
    const book = source('book', 'https://publisher.example/book/1', { pageType: 'book', versions: [
      { contentKind: 'metadata', verifiedChapter: false, links: directory.links },
    ] })
    expect(plan({ target: requested, sources: [book, source('fifth', url, { eligible: false })] }))
      .toMatchObject({ name: 'web_read', args: { sourceId: 'fifth' } })
  })

  it('keeps partial and preview evidence without treating it as a full chapter or reading the same URL again', () => {
    const partial = source('partial', 'https://fanqienovel.com/reader/1', { versions: [{ contentKind: 'article', verifiedChapter: false, links: [] }] })
    expect(plan({ sources: [partial] })).toMatchObject({ name: 'web_search' })
    expect(plan({ sources: [{ ...partial, versions: [{ contentKind: 'article', verifiedChapter: true, links: [] }] }] })).toBeNull()
  })

  it('does not use wrong-work results and preserves explicit only-site scope', () => {
    const wrong = source('wrong', 'https://other.example/chapter/1', { eligible: false })
    expect(plan({ sources: [wrong] })?.name).toBe('web_search')
    const restricted = plan({ target: { ...target, sourceHosts: ['publisher.example'] }, sources: [] })!
    expect(restricted).toMatchObject({ args: { query: expect.stringContaining('site:publisher.example') } })
    expect((restricted.args as { query: string }).query).not.toContain('fanqienovel')
  })

  it.each([
    ['-site:fanqienovel.com', 'https://fanqienovel.com/reader/1'],
    ['-site:fanqienovel.com/private', 'https://fanqienovel.com/private/chapter/1'],
    ['site:publisher.example/public', 'https://publisher.example/private/chapter/1'],
  ])('applies original source boundary %s to candidates and generated queries', (site, url) => {
    const denied = source('denied', url)
    const step = plan({ sourceSites: [site], sources: [denied] })!
    expect(step.name).toBe('web_search')
    expect(step.args.query).toContain(site)
    if (site === '-site:fanqienovel.com') expect(step.args.query).not.toContain(' site:fanqienovel.com')
    const allowed = source('allowed', 'https://publisher.example/public/chapter/1')
    expect(plan({ sourceSites: [site], sources: [denied, allowed] })).toMatchObject({ name: 'web_read', args: { sourceId: 'allowed' } })
  })
  it('reuses order-independent handoff identity after JSONB storage and does not redispatch a consumed source', () => {
    expect(researchDiscoveryStepKey({ name: 'web_search', args: { query: '书', maxResults: 8 } }))
      .toBe(researchDiscoveryStepKey({ name: 'web_search', args: { maxResults: 8, query: '书' } }))
    const original = source('original', 'https://fanqienovel.com/reader/1')
    const taken = plan({ sources: [original] })!
    expect(plan({ sources: [original], consumed: new Set([researchDiscoveryStepKey(taken)]) })?.name).toBe('web_search')
  })

  it('stops when evidence is sufficient or shared budgets are exhausted, and respects actual tool authority', () => {
    const completed = source('done', 'https://publisher.example/chapter/1', { versions: [{ contentKind: 'article', verifiedChapter: true, links: [] }] })
    expect(plan({ sources: [completed] })).toBeNull()
    expect(plan({ searchRemaining: 0, readRemaining: 0 })).toBeNull()
    expect(plan({ allowedTools: [] })).toBeNull()
    expect(plan({ sources: [source('unread', 'https://publisher.example/chapter/1')], allowedTools: ['web_search'] })?.name).toBe('web_search')
  })
})
