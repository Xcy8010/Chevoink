import dns from 'node:dns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readPublicWebPage } from '../../api/lib/web-reader-service.js'

const transport = vi.hoisted(() => vi.fn())
vi.mock('undici', async original => ({ ...await original<typeof import('undici')>(), fetch: (...args: unknown[]) => transport(...args) }))
const configured = { provider: 'deepseek', modelName: 'deepseek-fetch', baseUrl: 'https://api.deepseek.com', apiKey: 'offline-fixture-key' }
const target = { title: '河谷纪事', author: '林青' }
const body = '一时，村民沿着水渠观察清晨水位，核对木桩编号，再将不同意见记录在纸上。'.repeat(8)
const chapter = { bookName: target.title, author: target.author, bookId: '99', itemId: '123', title: '第1章 清晨',
  needPay: 0, isChapterLock: false, chapterWordNumber: String(body.length), content: `<p>${body.replaceAll('一', '\ue4de').replaceAll('时', '\ue4fc')}</p>` }
const fanqie = (change: Record<string, unknown> = {}) => `<script>window.__INITIAL_STATE__=${JSON.stringify({
  common: { css: 'font-family:DNMrHsV173Pd4pgy;src:url(https://lf6-awef.bytetos.com/obj/awesome-font/c/dc027189e0ba4cd.woff2)' },
  reader: { chapterData: { ...chapter, ...change } },
})};</script>`
const response = (html: string) => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
beforeEach(() => {
  transport.mockReset()
  vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _options: dns.LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => callback(null, [{ address: '1.1.1.1', family: 4 }])) as typeof dns.lookup)
})
afterEach(() => { vi.restoreAllMocks() })

describe('original and alternative sources share extraction evidence', () => {
  it('returns decoded original source text before the existing configured provider', async () => {
    transport.mockResolvedValueOnce(response(fanqie()))
    const result = await readPublicWebPage('https://fanqienovel.com/reader/123', new AbortController().signal, configured, target)
    expect(result).toMatchObject({ status: 'ok', provider: 'direct', text: body, evidence: {
      identity: { status: 'verified', title: target.title, author: target.author, pageType: 'chapter' },
      integrity: { status: 'source_compared' },
    } })
    expect(transport).toHaveBeenCalledOnce()
    expect(transport.mock.calls[0][1].headers).not.toHaveProperty('Authorization')
  })
  it('accepts the same publicly readable work on another legal source under the same identity and completeness checks', async () => {
    const metadata = { '@type': 'Chapter', articleBody: body, isPartOf: { '@type': 'Book', name: target.title, author: target.author } }
    transport.mockResolvedValueOnce(response(`<title>河谷纪事第1章</title><script type="application/ld+json">${JSON.stringify(metadata)}</script><article><p>${body}</p></article>`))
    const result = await readPublicWebPage('https://author.example.com/chapter/1', new AbortController().signal, configured, target)
    expect(result).toMatchObject({ status: 'ok', provider: 'direct', evidence: { identity: { status: 'verified' }, integrity: { status: 'source_compared' } } })
    expect(transport).toHaveBeenCalledOnce()
  })
  it('reports a long original preview without asking a provider to get around its chapter state', async () => {
    transport.mockResolvedValueOnce(response(fanqie({ chapterWordNumber: String(body.length * 2) })))
    expect(await readPublicWebPage('https://fanqienovel.com/reader/123', new AbortController().signal, configured, target))
      .toMatchObject({ status: 'ok', provider: 'direct', code: 'WEB_READ_PARTIAL', text: body,
        evidence: { integrity: { status: 'unverified', code: 'SOURCE_PREVIEW_ONLY' } } })
    expect(transport).toHaveBeenCalledOnce()
  })
  it('keeps the configured provider for a public dynamic shell and compares its preview to the actual source body', async () => {
    const metadata = { '@type': 'Chapter', articleBody: body, isPartOf: { '@type': 'Book', name: target.title, author: target.author } }
    transport.mockResolvedValueOnce(response(`<script type="application/ld+json">${JSON.stringify(metadata)}</script><script src="app.js"></script>`))
      .mockResolvedValueOnce(Response.json({ title: '河谷纪事第1章', content: body.slice(0, 200) }))
    expect(await readPublicWebPage('https://author.example.com/chapter/1', new AbortController().signal, configured, target))
      .toMatchObject({ status: 'ok', provider: 'deepseek', code: 'WEB_READ_PARTIAL', text: body.slice(0, 200),
        evidence: { integrity: { status: 'unverified', code: 'SOURCE_PREVIEW_ONLY' } } })
    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport.mock.calls[1][0]).toBe('https://api.deepseek.com/v1/tools/fetch')
    expect(JSON.parse(transport.mock.calls[1][1].body)).toEqual({ url: 'https://author.example.com/chapter/1' })
  })
  it('preserves an actual original-page failure when the existing configured reader recovers', async () => {
    transport.mockRejectedValueOnce(new Error('private upstream transport detail'))
      .mockResolvedValueOnce(Response.json({ title: '河谷纪事第1章', content: body }))
    const result = await readPublicWebPage('https://author.example.com/chapter/1', new AbortController().signal, configured, target)
    expect(result).toMatchObject({ status: 'ok', provider: 'deepseek', sourceAttempt: {
      status: 'transient_error', code: 'WEB_READ_UNAVAILABLE', finalUrl: 'https://author.example.com/chapter/1',
    }, evidence: { integrity: { status: 'unverified' } } })
    expect(JSON.stringify(result)).not.toContain('private upstream transport detail')
    expect(transport).toHaveBeenCalledTimes(2)
  })
})
