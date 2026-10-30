import { describe, expect, it } from 'vitest'
import { extractFanqieInitialState } from '../../api/lib/fanqie-reader.js'
import { decodeFanqieText } from '../../api/lib/fanqie-font-map.js'
import { assessReaderEvidence, extractReaderHtml } from '../../api/lib/web-reader-quality.js'

const source = 'https://fanqienovel.com/reader/123'
const target = { title: '河谷纪事', author: '林青' }
const css = '@font-face{font-family:DNMrHsV173Pd4pgy;src:url(https://lf6-awef.bytetos.com/obj/awesome-font/c/dc027189e0ba4cd.woff2)}'
const paragraph = '一时，村民沿着水渠查看清晨水位，随后核对木桩编号，带着观察记录回到村庄。'
const original = paragraph.repeat(8)
const encoded = original.replaceAll('一', '\ue4de').replaceAll('时', '\ue4fc')
function page(change: Record<string, unknown> = {}, fontCss = css) {
  return `<html><head><title>河谷纪事第1章 清晨</title></head><body><div>下载客户端</div><script>(function(){window.__INITIAL_STATE__=${JSON.stringify({
    common: { css: fontCss }, reader: { chapterData: { bookName: target.title, author: target.author, bookId: '99', itemId: '123',
      title: '第1章 清晨', chapterWordNumber: String(original.length), needPay: 0, isChapterLock: false, content: `<p>${encoded}</p>`, ...change } },
  })};})();</script></body></html>`
}

describe('public Fanqie chapter extraction', () => {
  it('reads nested JSON with escaped delimiters and leaves the following script unexecuted', () => {
    const value = { x: 'a;"b}', y: [{}] }
    expect(extractFanqieInitialState(`window.__INITIAL_STATE__ = ${JSON.stringify(value)}; throw new Error('not executed')`)).toEqual(value)
    expect(extractFanqieInitialState('window.__INITIAL_STATE__=process.exit();')).toBeNull()
  })
  it('decodes the observed public font after HTML entities and preserves paragraph boundaries', () => {
    const html = page({ content: `<p>${encoded.slice(0, encoded.length / 2)}</p><p>${encoded.slice(encoded.length / 2)}</p>` })
    const result = extractReaderHtml(html, true, source)
    expect(result).toMatchObject({ status: 'ok', title: '第1章 清晨', quality: { privateUseRatio: 0, replacementRatio: 0 } })
    expect(result.text.replaceAll('\n', '')).toBe(original)
    expect(result.text).toContain('\n\n')
    expect(assessReaderEvidence(result.text, result.title, target, html, source)).toMatchObject({
      identity: { status: 'verified', title: target.title, author: target.author, pageType: 'chapter' },
      integrity: { status: 'source_compared', code: 'SOURCE_TEXT_MATCH' },
    })
    const entities = page({ content: `<p>${encoded.replaceAll('\ue4de', '&#xE4DE;').replaceAll('\ue4fc', '&#58620;')}&amp;&nbsp;</p>`,
      chapterWordNumber: String(original.length + 2) })
    expect(extractReaderHtml(entities, true, source).text).toBe(`${original}&`)
  })
  it('uses upstream corrected character facts without substituting context-based guesses', () => {
    const glyphs = [58527, 58536, 58554, 58577, 58589, 58593, 58606, 58620, 58652, 58676]
    expect(decodeFanqieText(String.fromCharCode(...glyphs.map(gid => 0xe3e8 + gid - 58344)), 'DNMrHsV173Pd4pgy', css))
      .toEqual({ text: '意点本给行动名时情己', unmapped: 0 })
    expect(decodeFanqieText('\ue000', 'DNMrHsV173Pd4pgy', css)).toEqual({ text: '\ue000', unmapped: 1 })
  })
  it.each(['font-family:newFont;', css.replace('dc027189e0ba4cd', 'different-font-version')])('retains unknown glyphs for the existing quality failure: %s', fontCss => {
    const garbled = page({ content: `<p>${'\ue4de\ue4fc'.repeat(120)}</p>`, chapterWordNumber: '240' }, fontCss)
    expect(extractReaderHtml(garbled, true, source)).toMatchObject({ status: 'unreadable', code: 'WEB_READ_GARBLED', text: '' })
  })
  it('does not certify a mostly readable chapter with one unmapped font character', () => {
    expect(extractReaderHtml(page({ content: `<p>${encoded}\ue000</p>`, chapterWordNumber: String(original.length + 1) }), true, source))
      .toMatchObject({ status: 'unreadable', code: 'WEB_READ_GARBLED', text: '' })
  })
  it('retains a genuinely short structured chapter and checks the requested chapter rather than an arbitrary text-length floor', () => {
    const text = '村民沿着河岸查看水位，核对木桩编号后回村。'
    const html = page({ content: `<p>${text}</p>`, chapterWordNumber: String(text.length) })
    const result = extractReaderHtml(html, true, source)
    expect(result).toMatchObject({ status: 'ok', text })
    expect(assessReaderEvidence(text, '第1章 清晨', { ...target, chapterTitle: '第一章' }, html, source))
      .toMatchObject({ identity: { status: 'verified', chapterTitle: '第1章 清晨', chapterId: '123' } })
    expect(assessReaderEvidence(text, '第1章 清晨', { ...target, chapterTitle: '第五章' }, html, source))
      .toMatchObject({ identity: { status: 'mismatch' }, integrity: { code: 'SOURCE_CHAPTER_MISMATCH' } })
  })
  it.each([{ needPay: 1 }, { isChapterLock: true }])('keeps an explicit chapter access restriction even with a long visible preview: %j', flags => {
    expect(extractReaderHtml(page(flags), true, source)).toMatchObject({ status: 'blocked', code: 'WEB_READ_BLOCKED', text: '' })
  })
  it('does not label a long visible preview or an uncounted body as complete', () => {
    const html = page({ chapterWordNumber: String(original.length * 2) })
    expect(extractReaderHtml(html, true, source)).toMatchObject({ status: 'ok', code: 'WEB_READ_PARTIAL', text: expect.any(String) })
    expect(assessReaderEvidence(original, '第1章 清晨', target, html, source).integrity)
      .toMatchObject({ status: 'unverified', code: 'SOURCE_PREVIEW_ONLY' })
    expect(assessReaderEvidence(original, '第1章 清晨', target, page({ chapterWordNumber: undefined }), source).integrity.status).toBe('unverified')
  })
  it.each([{ bookName: '河谷纪事：番外' }, { author: '另一作者' }, { itemId: '456' }])('excludes a different work, author or chapter: %j', fields => {
    expect(assessReaderEvidence(original, '第1章 清晨', target, page(fields), source).identity.status).toBe('mismatch')
  })
  it('uses the same source comparison for a provider preview and a source body with internal deletion', () => {
    const html = page()
    expect(assessReaderEvidence(original.slice(0, 200), '第1章 清晨', target, html, source).integrity)
      .toMatchObject({ status: 'unverified', code: 'SOURCE_PREVIEW_ONLY' })
    expect(assessReaderEvidence(original.replaceAll('核对木桩编号', ''), '第1章 清晨', target, html, source).integrity.status).toBe('damaged')
  })
})
