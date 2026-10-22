import { describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import { assessReaderText, assessReaderEvidence, extractReaderHtml, extractReaderLinks } from '../../api/lib/web-reader-quality.js'
import { decodeWebPageBuffer } from '../../api/lib/html-extract.js'

const body = '山谷里的村民清晨出发，沿着河岸查看新修的水渠。他们记录水位与天气，并讨论下一阶段的耕种计划。'

describe('reader content quality without navigation false positives', () => {
  it.each(['', '<!-- gateway response -->', '<script>window.location="/verify"</script>'])('handles rootless or script-only HTML without throwing: %s', html => {
    expect(extractReaderHtml(html)).toMatchObject({ status: 'unreadable', code: 'WEB_READ_INSUFFICIENT', text: '' })
  })
  it('returns actual bounded same-site chapter links without inventing URLs', () => {
    const html = '<a href="/about">关于</a><a href="http://127.0.0.1/private">私网</a><a href="javascript:alert(1)">脚本</a><a href="https://other.example/reader/1">其他站点</a>'
      + Array.from({ length: 12 }, (_, i) => `<a href="/reader/${100 + i}?page=2&amp;source=index">第${i + 1}章</a>`).join('')
    const links = extractReaderLinks(html, 'https://fanqienovel.com/page/123')
    expect(links).toHaveLength(13)
    expect(links[0]).toEqual({ title: '第1章', url: 'https://fanqienovel.com/reader/100?page=2&source=index' })
    expect(links.slice(0, 12).every(item => item.url.startsWith('https://fanqienovel.com/reader/'))).toBe(true)
    expect(links[11].title).toBe('第12章')
  })
  it('excludes private-use icon navigation and hidden content from body quality', () => {
    const result = extractReaderHtml(`<html><head><title>水渠观察</title></head><body><nav>${'\ue123'.repeat(1000)}</nav><div hidden>${'\ufffd'.repeat(500)}</div><article><h1>水渠观察</h1><p>${body.repeat(6)}</p></article></body></html>`)
    expect(result.status).toBe('ok')
    expect(result.quality.privateUseRatio).toBe(0)
    expect(result.quality.replacementRatio).toBe(0)
  })
  it('does not reject an article merely mentioning login and HTTP 404', () => {
    const result = extractReaderHtml(`<html><title>网页错误处理指南</title><body><a href="/login">登录</a><article><h1>网页错误处理指南</h1><p>本节解释登录、HTTP 404和验证码的设计。</p><p>${body.repeat(6)}</p></article></body></html>`)
    expect(result.status).toBe('ok')
  })
  it('does not deliver a preview as readable chapter text when structured access metadata denies free access', () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Chapter', isAccessibleForFree: false })}</script></head><body><article><h1>河谷纪事第1章</h1><p>${body.repeat(6)}</p></article></body></html>`
    expect(extractReaderHtml(html)).toMatchObject({ status: 'blocked', code: 'WEB_READ_BLOCKED', text: '' })
  })
  it('keeps a free chapter readable when only its parent book requires payment', () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Chapter', isAccessibleForFree: true,
      isPartOf: { '@type': 'Book', isAccessibleForFree: false } })}</script></head><body><article><h1>河谷纪事第1章</h1><p>${body.repeat(6)}</p></article></body></html>`
    expect(extractReaderHtml(html).status).toBe('ok')
  })
  it('does not apply a related paid article restriction to the current free chapter', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@graph': [
      { '@type': 'Chapter', isAccessibleForFree: true }, { '@type': 'Article', isAccessibleForFree: false, url: '/related-review' },
    ] })}</script><article><h1>河谷纪事第1章</h1><p>${body.repeat(6)}</p></article>`
    expect(extractReaderHtml(html).status).toBe('ok')
  })
  it('resolves the current page mainEntity before honoring its explicit access restriction', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@graph': [
      { '@type': 'WebPage', mainEntity: { '@id': '#current' } },
      { '@id': '#current', '@type': 'Article', isAccessibleForFree: false },
      { '@id': '#related', '@type': 'Article', isAccessibleForFree: true },
    ] })}</script><article><h1>河谷纪事第1章</h1><p>${body.repeat(6)}</p></article>`
    expect(extractReaderHtml(html)).toMatchObject({ status: 'blocked', text: '' })
  })
  it.each(['\ue123', '\u{f0123}', '\u{100123}', '\ufffd'])('refuses significant unreadable glyph content %s', glyph => {
    const result = assessReaderText(`${body}${glyph.repeat(400)}`)
    expect(result.code).toBe('WEB_READ_GARBLED')
    expect(result.text).toBe('')
    expect(result.quality.readable).toBe(false)
  })
  it('keeps paragraph boundaries instead of collapsing the whole page onto one line', () => {
    const result = extractReaderHtml(`<article><h1>水渠观察</h1><p>${body.repeat(3)}</p><p>${body.repeat(3)}</p></article>`, false)
    expect(result.status).toBe('ok')
    expect(result.text).toContain('\n\n')
  })
  it('refuses documents exceeding the DOM element budget', () => {
    const result = extractReaderHtml(`<article>${'<span>字</span>'.repeat(20001)}</article>`)
    expect(result.code).toBe('WEB_READ_COMPLEX_DOCUMENT')
  })
  it.each(['GBK', 'GB2312', 'GB18030'])('decodes an explicitly declared %s page', charset => {
    const bytes = iconv.encode(body, charset)
    expect(decodeWebPageBuffer(bytes, `text/html; charset = "${charset}"`)).toBe(body)
  })
  it('uses meta charset when HTTP charset is missing', () => {
    const html = `<meta charset="gbk"><article>${body}</article>`
    expect(decodeWebPageBuffer(iconv.encode(html, 'gbk'), 'text/html')).toBe(html)
  })
})

describe('source-grounded work identity and extraction integrity', () => {
  const target = { title: '河谷纪事', author: '林青' }
  const original = Array.from({ length: 18 }, (_, index) => `第${index + 1}次观察记录了清晨水位，村民沿着岸边逐一核对木桩编号，随后带着不同的意见返回村庄。`).join('\n\n')
  const html = (title = target.title, author = target.author, text = original) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Chapter', articleBody: text, isPartOf: { '@type': 'Book', name: title, author: { '@type': 'Person', name: author } } })}</script></head><body><article>${text}</article></body></html>`
  it('matches exact structured book and author, independently from readable body quality', () => {
    expect(assessReaderEvidence(original, '河谷纪事第1章 清晨', target, html())).toMatchObject({ identity: { status: 'verified', title: target.title, author: target.author, pageType: 'chapter' }, integrity: { status: 'source_compared', code: 'SOURCE_TEXT_MATCH' } })
  })
  it('uses the final source host, including redirects, before certifying a frozen official source', () => {
    const scoped = { ...target, sourceHosts: ['publisher.example'] }
    for (const url of [undefined, 'https://other.example/chapter/1', 'https://publisher.example.evil.example/chapter/1']) {
      expect(assessReaderEvidence(original, target.title, scoped, html(), url).identity.status).toBe('mismatch')
    }
    expect(assessReaderEvidence(original, target.title, scoped, html(), 'https://www.publisher.example/chapter/1').identity.status).toBe('verified')
  })
  it('accepts the same work from an explicitly authorized author channel and rejects unapproved or mismatched sources', () => {
    const scoped = { ...target, sourceHosts: ['publisher.example', 'author.example'] }
    expect(assessReaderEvidence(original, '河谷纪事第1章', scoped, html(), 'https://author.example/chapter/1'))
      .toMatchObject({ identity: { status: 'verified', pageType: 'chapter' }, integrity: { status: 'source_compared' } })
    expect(assessReaderEvidence(original, '河谷纪事第1章', scoped, html(), 'https://unknown-free.example/chapter/1').identity.status).toBe('mismatch')
    expect(assessReaderEvidence(original, '河谷纪事第1章', scoped, html(target.title, '另一作者'), 'https://author.example/chapter/1').identity.status).toBe('mismatch')
  })
  it.each(['河谷纪事：番外', '河谷纪事青龙', '另一部作品'])('rejects the original-name prefix as identity proof: %s', title => {
    expect(assessReaderEvidence(original, `${title}第1章`, target, html(title)).identity.status).toBe('mismatch')
    expect(assessReaderText(original).status).toBe('ok')
  })
  it('does not accept a different author or an uncorroborated chapter title', () => {
    expect(assessReaderEvidence(original, '河谷纪事第1章', target, html(target.title, '其他作者')).identity.status).toBe('mismatch')
    expect(assessReaderEvidence(original, '河谷纪事第1章', target).identity.status).toBe('unknown')
  })
  it('does not mistake book metadata for a chapter page', () => {
    const source = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Book', name: target.title, author: target.author })}</script><article>${original}</article>`
    expect(assessReaderEvidence(original, target.title, target, source).identity).toMatchObject({ status: 'verified', pageType: 'book' })
  })
  it('proves deletion of ordinary characters without relying on PUA or whitespace ratios', () => {
    const damaged = original.replaceAll('逐一核对', '')
    expect(assessReaderText(damaged)).toMatchObject({ status: 'ok', quality: { privateUseRatio: 0, replacementRatio: 0 } })
    expect(assessReaderEvidence(damaged, '河谷纪事第1章', target, html()).integrity).toMatchObject({ status: 'damaged', code: 'SOURCE_TEXT_DELETION' })
  })
  it('permits normal spaces, paragraph formatting, Markdown and source-bounded excerpts', () => {
    for (const text of [original.replaceAll('，', '，  '), original.split('\n\n').map(paragraph => `**${paragraph}**`).join('\n\n'), original.slice(50, -50)]) {
      expect(assessReaderEvidence(text, '河谷纪事第1章', target, html()).integrity.status).toBe('source_compared')
    }
    const english = 'The village recorded the water level each morning and carefully compared the resulting evidence. '.repeat(5)
    expect(assessReaderEvidence(english, 'Chapter 1', undefined, html(target.title, target.author, english)).integrity.status).toBe('source_compared')
  })
  it('preserves unknown completeness when no source comparison is available', () => {
    expect(assessReaderEvidence(original, '河谷纪事第1章', target).integrity.status).toBe('unverified')
    expect(assessReaderText('中 文 留 白\n'.repeat(40)).status).toBe('ok')
  })
})
