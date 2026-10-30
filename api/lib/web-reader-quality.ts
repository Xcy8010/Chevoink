import { createHash } from 'node:crypto'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { parsePublicHttpUrl } from './public-http.js'
import { extractFanqieChapter, fanqieChapterText } from './fanqie-reader.js'
import { chapterTitleOrdinal, plainChapterTitle } from '../../shared/structure/chapter-title.js'

/** Follow only actual same-site anchors. Never synthesize reader/chapter IDs. */
export function extractReaderLinks(html: string, finalUrl: string): Array<{ url: string; title: string }> {
  const base = parsePublicHttpUrl(finalUrl, true)
  const { document } = parseHTML(html)
  const links = new Map<string, { url: string; title: string }>()
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (links.size >= 4096) break
    try {
      const url = parsePublicHttpUrl(new URL(anchor.getAttribute('href')!, base).href, true)
      const title = anchor.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? ''
      if (url.origin !== base.origin || url.href === base.href || !title || url.pathname === '/') continue
      links.set(url.href, { url: url.href, title })
    } catch { /* Unsupported/unsafe anchors are not discovery results. */ }
  }
  return [...links.values()].sort((a, b) => Number(/第.{1,12}章|chapter\s*\d/i.test(b.title)) - Number(/第.{1,12}章|chapter\s*\d/i.test(a.title)))
}

export type ReaderQuality = { readable: boolean; privateUseRatio: number; replacementRatio: number; textChars: number }
export type ReaderQualityResult = {
  status: 'ok' | 'blocked' | 'not_found' | 'unreadable'
  code: string
  text: string
  title: string
  quality: ReaderQuality
}

export type ReaderTarget = { title: string; author?: string; sourceHosts?: readonly string[]; chapterTitle?: string; chapterId?: string }
export type ReaderEvidence = {
  version: 1
  identity: { status: 'verified' | 'mismatch' | 'unknown'; title?: string; author?: string; chapterTitle?: string; chapterId?: string; pageType: 'chapter' | 'book' | 'unknown'; basis: 'structured_metadata' | 'page_title' | 'none' }
  integrity: { status: 'source_compared' | 'unverified' | 'damaged'; code: string; extractedHash: string; referenceHash?: string }
}

const textHash = (value: string) => createHash('sha256').update(value).digest('hex')
const compact = (value: string) => {
  type Node = { type: string; value?: string; children?: Node[] }
  const visible = (node: Node): string => node.type === 'definition' ? '' : node.value ?? node.children?.map(visible).join('') ?? ''
  return visible(fromMarkdown(value)).normalize('NFC').replace(/\s+/gu, '')
}
const identityValue = (value: string) => value.normalize('NFC').trim().replace(/^《|》$/gu, '').trim()

export function matchesReaderChapter(target: Pick<ReaderTarget, 'chapterTitle' | 'chapterId'>, actual: Pick<ReaderEvidence['identity'], 'chapterTitle' | 'chapterId'>): boolean {
  if (target.chapterId && target.chapterId !== actual.chapterId) return false
  if (!target.chapterTitle) return true
  if (!actual.chapterTitle) return false
  const expected = identityValue(target.chapterTitle), found = identityValue(actual.chapterTitle)
  const ordinal = chapterTitleOrdinal(expected)
  const expectedName = plainChapterTitle(expected)
  return ordinal !== null
    ? chapterTitleOrdinal(found) === ordinal && (expectedName === expected || plainChapterTitle(found) === expectedName)
    : plainChapterTitle(found) === expected
}

/** Metadata is source evidence, not authority. Never equate a title prefix,
 * common hostname or a search snippet with the requested original work. */
export function assessReaderEvidence(text: string, pageTitle: string, target?: ReaderTarget, sourceHtml?: string, sourceUrl?: string, purpose?: 'navigation'): ReaderEvidence {
  let title: string | undefined, author: string | undefined
  let basis: ReaderEvidence['identity']['basis'] = 'none'
  let pageType: ReaderEvidence['identity']['pageType'] = 'unknown'
  let reference: string | undefined
  let referenceHeading = ''
  let structuredReference = false
  const chapter = sourceHtml ? extractFanqieChapter(sourceHtml, sourceUrl) : null
  let chapterTitle = chapter?.chapterTitle, chapterId = chapter?.chapterId
  const chapterText = chapter ? fanqieChapterText(chapter) : null
  if (chapter) {
    title = chapter.bookTitle || undefined
    author = chapter.author || undefined
    basis = title ? 'structured_metadata' : 'none'
    pageType = 'chapter'
    reference = chapterText?.text
    structuredReference = true
  }
  if (sourceHtml) {
    const { document } = parseHTML(sourceHtml)
    if (!chapter) referenceHeading = document.querySelector('article h1,[role="main"] h1,main h1')?.textContent ?? ''
    const meta = (names: string[]) => {
      for (const node of document.querySelectorAll('meta[content]')) {
        if (names.includes((node.getAttribute('property') ?? node.getAttribute('name') ?? '').toLowerCase())) return node.getAttribute('content')?.trim()
      }
      return undefined
    }
    title ??= meta(['og:novel:book_name', 'og:book_name', 'book:name'])
    if (!title && purpose === 'navigation' && /^(?:book|novel)$/iu.test(meta(['og:type']) ?? '')) title = meta(['og:title'])
    author ??= meta(['og:novel:author', 'book:author', 'author'])
    const authorName = (value: unknown): string | undefined => typeof value === 'string' ? value : value && typeof value === 'object' && 'name' in value && typeof value.name === 'string' ? value.name : undefined
    const inspect = (value: unknown, depth = 0): void => {
      if (!value || typeof value !== 'object' || depth > 5) return
      if (Array.isArray(value)) { for (const item of value.slice(0, 100)) inspect(item, depth + 1); return }
      const entry = value as Record<string, unknown>
      const types = Array.isArray(entry['@type']) ? entry['@type'] : [entry['@type']]
      if (types.some(type => type === 'Book' || type === 'Novel')) {
        if (typeof entry.name === 'string') title ??= entry.name
        author ??= authorName(Array.isArray(entry.author) ? entry.author[0] : entry.author)
        if (depth === 0 && !chapter) pageType = 'book'
      }
      if (types.some(type => type === 'Chapter' || type === 'Article' || type === 'NewsArticle' || type === 'BlogPosting')) {
        if (typeof entry.articleBody === 'string' && !reference) { reference = entry.articleBody; structuredReference = true }
        if (types.includes('Chapter')) {
          pageType = 'chapter'
          if (typeof entry.name === 'string') chapterTitle ??= entry.name
          if (typeof entry.identifier === 'string') chapterId ??= entry.identifier
        }
        inspect(entry.isPartOf, depth + 1)
      }
      inspect(entry['@graph'], depth + 1)
      inspect(entry.mainEntity, depth + 1)
    }
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      if ((node.textContent?.length ?? 0) > 256_000) continue
      try { inspect(JSON.parse(node.textContent ?? '')) } catch { /* Invalid metadata cannot verify identity. */ }
    }
    if (title) { basis = 'structured_metadata'; if (pageType === 'unknown') pageType = 'book' }
    // Only an explicit article body can corroborate extraction. Whole-page
    // navigation, recommendations and hidden text are never a reference body.
    if (!reference && document.querySelector('article,[role="main"]')) {
      const extracted = extractReaderHtml(sourceHtml, false)
      if (extracted.status === 'ok' || extracted.code === 'WEB_READ_GARBLED') {
        reference = extracted.status === 'ok' ? extracted.text : undefined
      }
    }
  }
  {
    // A chapter page title can disprove a prefix match; without author metadata
    // it still cannot positively certify an original work.
    const chapter = pageTitle.match(/^(.{1,160}?)(?:第[零〇一二三四五六七八九十百千万\d]+章|\s*[-|–]\s*Chapter\s+\d)/iu)
    if (chapter) { pageType = 'chapter'; if (!title) { title = chapter[1]; basis = 'page_title' } }
  }
  if (!chapterTitle && chapterTitleOrdinal(referenceHeading) !== null) chapterTitle = referenceHeading.trim()
  if (title) title = identityValue(title).slice(0, 300)
  if (author) author = identityValue(author).slice(0, 300)
  const sourceMismatch = Boolean(target?.sourceHosts?.length && !target.sourceHosts.some(host => {
    try { const actual = new URL(sourceUrl ?? '').hostname.toLowerCase()
      return actual === host || actual.endsWith(`.${host}`) } catch { return false }
  }))
  const actualChapter = { chapterTitle, chapterId }
  const requestedChapterMatches = pageType === 'book' || !target || matchesReaderChapter(target, actualChapter)
  const chapterMismatch = Boolean(chapter?.chapterId && sourceUrl && new URL(sourceUrl).pathname.split('/')[2] !== chapter.chapterId)
    || Boolean(target && !requestedChapterMatches && (chapterTitle || chapterId))
  const mismatch = chapterMismatch || sourceMismatch || Boolean(target && ((title && title !== identityValue(target.title)) || (target.author && author && author !== identityValue(target.author))))
  const verified = Boolean(target && title === identityValue(target.title) && author && (!target.author || author === identityValue(target.author))
    && requestedChapterMatches && basis === 'structured_metadata')
  const integrity: ReaderEvidence['integrity'] = { status: 'unverified', code: 'SOURCE_COMPLETENESS_UNVERIFIED', extractedHash: textHash(text) }
  if (reference) {
    let extracted = compact(text)
    const original = compact(reference), heading = compact(referenceHeading)
    if (heading && extracted.startsWith(heading) && !original.startsWith(heading)) extracted = extracted.slice(heading.length)
    integrity.referenceHash = textHash(reference)
    if (original === extracted) { integrity.status = 'source_compared'; integrity.code = 'SOURCE_TEXT_MATCH' }
    else if (original.includes(extracted)) integrity.code = 'SOURCE_PREVIEW_ONLY'
    else if (extracted.length >= 150) {
      const deletionOnly = (span: string, sample: string) => {
        const chars = Array.from(sample)
        let cursor = 0
        for (const char of span) if (char === chars[cursor]) cursor++
        return cursor === chars.length && span.length - sample.length >= 8
      }
      if (structuredReference && deletionOnly(original, extracted)) {
        integrity.status = 'damaged'; integrity.code = 'SOURCE_TEXT_DELETION'
      }
      // Prove internal deletion only between matching, unique 24-character
      // boundaries. Formatting, a removed heading or a short excerpt is not loss.
      const prefix = extracted.slice(0, 24), suffix = extracted.slice(-24)
      const start = original.indexOf(prefix), end = original.indexOf(suffix, start + 24)
      if (start >= 0 && end >= start && original.indexOf(prefix, start + 1) < 0 && original.indexOf(suffix, end + 1) < 0) {
        const span = original.slice(start, end + suffix.length)
        if (deletionOnly(span, extracted)) {
          integrity.status = 'damaged'; integrity.code = 'SOURCE_TEXT_DELETION'
        }
      }
    }
  }
  if (chapter && (chapter.locked || chapter.declaredCharacters !== chapterText!.characters)) {
    integrity.status = 'unverified'
    integrity.code = chapter.locked || chapter.declaredCharacters && chapterText!.characters < chapter.declaredCharacters
      ? 'SOURCE_PREVIEW_ONLY' : 'SOURCE_COMPLETENESS_UNVERIFIED'
  }
  if (chapterMismatch) {
    integrity.status = 'damaged'; integrity.code = 'SOURCE_CHAPTER_MISMATCH'
  }
  return { version: 1, identity: { status: mismatch ? 'mismatch' : verified ? 'verified' : 'unknown', ...(title ? { title } : {}), ...(author ? { author } : {}),
    ...(chapterTitle ? { chapterTitle } : {}), ...(chapterId ? { chapterId } : {}), pageType, basis }, integrity }
}

const normalize = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
const blockedHeading = /^(?:(?:请|需要|必须)?(?:先)?登录(?:后|以|才|才能)|登录后阅读|访问受限|拒绝访问|安全验证|人机验证|验证码验证|付费阅读|订阅后阅读|access denied|forbidden|sign in to (?:read|continue)|log in to (?:read|continue)|just a moment|verify (?:you|that you))/i
const missingHeading = /^(?:404(?:\s*[-:：|]\s*|\s+)(?:not found|页面不存在)|404$|页面(?:不存在|未找到|已删除)|章节(?:不存在|已删除)|not found|page not found|410\s+gone)/i

/** Quality is measured on extracted content, not icon-heavy navigation or scripts. */
export function assessReaderText(text: string, title = ''): ReaderQualityResult {
  const normalized = normalize(text)
  let length = 0, privateUse = 0, replacement = 0
  for (const char of normalized) {
    if (/\s/u.test(char)) continue
    length++
    const point = char.codePointAt(0)!
    if ((point >= 0xe000 && point <= 0xf8ff) || (point >= 0xf0000 && point <= 0xffffd) || (point >= 0x100000 && point <= 0x10fffd)) privateUse++
    if (point === 0xfffd) replacement++
  }
  const quality: ReaderQuality = { readable: false, privateUseRatio: privateUse / Math.max(1, length), replacementRatio: replacement / Math.max(1, length), textChars: normalized.length }
  const result = (status: ReaderQualityResult['status'], code: string): ReaderQualityResult => ({ status, code, text: status === 'ok' ? normalized : '', title, quality: { ...quality, readable: status === 'ok' } })
  const headings = [title.trim(), normalized.split('\n')[0].trim()]
  if (headings.some(value => missingHeading.test(value))) return result('not_found', 'WEB_READ_NOT_FOUND')
  if (headings.some(value => blockedHeading.test(value))) return result('blocked', 'WEB_READ_BLOCKED')
  if ((privateUse >= 3 && quality.privateUseRatio > 0.01) || (replacement >= 3 && quality.replacementRatio > 0.005)) return result('unreadable', 'WEB_READ_GARBLED')
  if (length < 150) return result('unreadable', 'WEB_READ_INSUFFICIENT')
  return result('ok', 'WEB_READ_OK')
}

export function extractReaderHtml(html: string, useReadability = true, sourceUrl?: string): ReaderQualityResult {
  const chapter = extractFanqieChapter(html, sourceUrl)
  if (chapter) {
    if (chapter.locked) return { ...assessReaderText('', chapter.chapterTitle), status: 'blocked', code: 'WEB_READ_BLOCKED' }
    const body = fanqieChapterText(chapter)
    const assessed = assessReaderText(body.text, chapter.chapterTitle)
    // Structured chapter content has already separated the body from page
    // chrome. A genuinely short chapter is not an empty navigation page.
    const result = assessed.code === 'WEB_READ_INSUFFICIENT' && body.text.trim()
      ? { ...assessed, status: 'ok' as const, code: 'WEB_READ_OK', text: body.text, quality: { ...assessed.quality, readable: true } } : assessed
    if (body.unmapped) {
      return { ...result, status: 'unreadable', code: 'WEB_READ_GARBLED', text: '', quality: { ...result.quality, readable: false } }
    }
    if (result.status === 'ok' && chapter.declaredCharacters && body.characters < chapter.declaredCharacters) {
      return { ...result, code: 'WEB_READ_PARTIAL' }
    }
    return result
  }
  const { document } = parseHTML(html)
  // Empty/script-only/error fragments can have no root. linkedom's body getter
  // throws in that case; such a response is unreadable, not a parser crash.
  if (!document.documentElement) return assessReaderText('')
  const title = (document.querySelector('title')?.textContent ?? document.querySelector('h1')?.textContent ?? '').trim().slice(0, 300)
  if (document.querySelectorAll('*').length > 20000) return { ...assessReaderText('', title), status: 'unreadable', code: 'WEB_READ_COMPLEX_DOCUMENT' }
  // Do not strip explicit access/error gates before checking them.
  const heading = document.querySelector('h1')?.textContent ?? ''
  const gate = assessReaderText(heading, title)
  if (gate.status === 'blocked' || gate.status === 'not_found') return gate
  // A visible preview does not override the current page's explicit access
  // restriction. Parent-book pricing does not restrict a free chapter.
  const accessBlocked = (value: unknown): boolean => {
    const record = (entry: unknown): Record<string, unknown> | null => entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null
    const root = record(value)
    const entries = Array.isArray(value) ? value : Array.isArray(root?.['@graph']) ? root['@graph'] : [value]
    const nodes = entries.slice(0, 2000).map(record).filter((entry): entry is Record<string, unknown> => !!entry)
    const types = (entry: Record<string, unknown>) => Array.isArray(entry['@type']) ? entry['@type'] : [entry['@type']]
    const article = (entry: Record<string, unknown>) => types(entry).some(type => ['Chapter', 'Article', 'NewsArticle', 'BlogPosting'].includes(String(type)))
    const unique = (entries: Record<string, unknown>[]) => entries.length === 1 ? entries[0] : null
    // A recommendation in @graph is not the current article. Prefer an
    // explicit page/mainEntity link, then a unique chapter/article only.
    const primary = root && (article(root) || types(root).includes('WebPage') || root.mainEntity) ? root
      : unique(nodes.filter(entry => types(entry).includes('WebPage') && !!entry.mainEntity))
        ?? unique(nodes.filter(entry => types(entry).includes('Chapter')))
        ?? unique(nodes.filter(article))
    const inspect = (input: unknown, depth = 0): boolean => {
      if (depth > 5) return false
      const entry = record(input)
      if (!entry) return false
      if (entry.isAccessibleForFree === false && (article(entry) || types(entry).includes('WebPage'))) return true
      if (entry.mainEntity) return inspect(entry.mainEntity, depth + 1)
      const linked = typeof entry['@id'] === 'string' ? unique(nodes.filter(node => node !== entry && node['@id'] === entry['@id'])) : null
      return linked ? inspect(linked, depth + 1) : false
    }
    return primary ? inspect(primary) : false
  }
  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    if ((node.textContent?.length ?? 0) > 256_000) continue
    try {
      if (accessBlocked(JSON.parse(node.textContent ?? ''))) return { ...assessReaderText('', title), status: 'blocked', code: 'WEB_READ_BLOCKED' }
    } catch { /* Invalid metadata cannot establish an access restriction. */ }
  }
  for (const node of document.querySelectorAll('script,style,noscript,svg,nav,footer,aside,form,button,[hidden],[aria-hidden="true"]')) node.remove()
  for (const node of document.querySelectorAll('br')) node.replaceWith(document.createTextNode('\n'))
  for (const node of document.querySelectorAll('p,h1,h2,h3,h4,li,blockquote')) node.appendChild(document.createTextNode('\n\n'))
  const candidate = document.querySelector('article,[role="main"],main') ?? document.querySelector('body') ?? document.documentElement
  let text = candidate?.textContent ?? ''
  if (!text.trim()) text = document.documentElement?.textContent ?? ''
  if (useReadability) {
    try {
      const article = new Readability(document, { maxElemsToParse: 20000 }).parse()
      // Never replace an unreadable body with title/navigation to pass the threshold.
      if (article?.textContent && article.textContent.trim().length >= 150) text = article.textContent
    } catch { /* The cleaned DOM candidate is still subject to the same quality gate. */ }
  }
  return assessReaderText(text, title)
}

const navigationAccessRequirement = /(?:(?:请|需要|必须|只能|仅限|仅能|须|需).{0,24}(?:登录|付费|订阅|购买|解锁|SVIP|VIP|APP|客户端).{0,32}(?:阅读|查看|继续|访问|全文|章节|正文)|(?:登录|付费|订阅|购买|SVIP|VIP).{0,16}(?:后|才能|方可|才可).{0,16}(?:阅读|查看|继续|访问)|(?:本章|章节|本书|正文|全文).{0,16}(?:仅限|需要|必须|需).{0,24}(?:登录|付费|订阅|购买|SVIP|VIP|APP)|(?:please|must|only|requires?).{0,24}(?:sign.?in|log.?in|subscription|payment|premium|app).{0,32}(?:read|view|continue|access))/iu
const navigationVerificationGate = /(?:(?:请|需要|必须|需).{0,12}(?:验证码|安全验证|人机验证|身份验证)|(?:本章|章节|本书|正文|全文).{0,16}(?:SVIP|VIP|会员).{0,8}(?:专享|专属|限定)|(?:SVIP|VIP|会员)(?:专享|专属|限定)(?:章节|正文|全文|阅读))/iu
const navigationText = (value: string | undefined | null, max = 300) => {
  if (!value) return ''
  const text = value.replace(/\s+/gu, ' ').trim()
  if (/[\p{Co}\p{Cc}\uFFFD]/u.test(text)) return ''
  return /[\p{L}\p{N}]/u.test(text) ? text.slice(0, max) : ''
}

/** A separate metadata lane: no body extraction, glyph recovery or inference of
 * reader URLs. Even perfectly legible comments remain navigation, not prose. */
export function extractReaderNavigationHtml(html: string, finalUrl: string, target?: ReaderTarget): ReaderQualityResult & {
  links?: Array<{ url: string; title: string }>; canonicalUrl?: string; evidence?: ReaderEvidence
} {
  const base = parsePublicHttpUrl(finalUrl, true), { document } = parseHTML(html)
  if (!document.documentElement) return assessReaderText('')
  if (document.querySelectorAll('*').length > 20000) return { ...assessReaderText(''), code: 'WEB_READ_COMPLEX_DOCUMENT' }
  const pageTitle = navigationText(document.querySelector('title')?.textContent ?? document.querySelector('h1')?.textContent)
  const meta = (names: string[]) => [...document.querySelectorAll('meta[content]')].find(node =>
    names.includes((node.getAttribute('property') ?? node.getAttribute('name') ?? '').toLowerCase()))?.getAttribute('content') ?? ''
  const pageKind = meta(['og:type']).trim().toLowerCase()
  let book = /^(?:book|novel)$/u.test(pageKind) || Boolean(meta(['og:novel:book_name']))
  let other = /^(?:article|review|chapter|blog|blogposting|newsarticle)$/u.test(pageKind)
  const inspectPrimary = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== 'object' || depth > 5) return
    if (Array.isArray(value)) { value.slice(0, 100).forEach(item => inspectPrimary(item, depth + 1)); return }
    const entry = value as Record<string, unknown>, types = Array.isArray(entry['@type']) ? entry['@type'] : [entry['@type']]
    if (types.some(type => type === 'Book' || type === 'Novel')) book = true
    if (types.some(type => ['Review', 'Article', 'Chapter', 'BlogPosting', 'NewsArticle'].includes(String(type)))) other = true
    inspectPrimary(entry['@graph'], depth + 1)
    if (types.includes('WebPage')) inspectPrimary(entry.mainEntity, depth + 1)
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    if ((script.textContent?.length ?? 0) > 256_000) continue
    try { inspectPrimary(JSON.parse(script.textContent ?? '')) } catch { /* Invalid metadata proves no identity. */ }
  }
  // Inspect access requirements in the main content, never a site-wide APP/VIP
  // mention, download promotion, footer or incidental prose keyword.
  for (const node of document.querySelectorAll('script,style,noscript,svg,[hidden],[aria-hidden="true"]')) node.remove()
  const main = document.querySelector('main,[role="main"],article') ?? document.querySelector('body') ?? document.documentElement
  const gateMain = main?.cloneNode(true) as typeof main | undefined
  for (const node of gateMain?.querySelectorAll('header,footer,aside,nav,[role="banner"],[role="navigation"]') ?? []) node.remove()
  const gateNodes = [...gateMain?.querySelectorAll('h1,h2,h3,p,div,section,form,[role="alert"],[role="dialog"]') ?? []]
    .filter(node => ![...node.children].some(child => /^(?:H[1-3]|P|DIV|SECTION|FORM)$/u.test(child.tagName)))
  const gateTexts = [pageTitle, ...gateNodes.map(node => node.textContent ?? '')]
  if ((gateMain?.textContent?.length ?? 0) <= 500) gateTexts.push(gateMain?.textContent ?? '')
  for (const text of gateTexts) {
    if (text.length > 500) continue
    const gate = assessReaderText(text, pageTitle)
    if (gate.status === 'blocked' || gate.status === 'not_found') return gate
    if (navigationAccessRequirement.test(text.replace(/\s+/gu, ' ')) || navigationVerificationGate.test(text)) return { ...gate, status: 'blocked', code: 'WEB_READ_BLOCKED', text: '', quality: { ...gate.quality, readable: false } }
  }
  if (gateMain?.querySelector('form input[type="password"],form input[name*="captcha" i]')) return { ...assessReaderText('', pageTitle), status: 'blocked', code: 'WEB_READ_BLOCKED' }
  let hrefBase: URL | undefined = base
  const declaredBase = document.querySelector('base[href]')?.getAttribute('href')
  if (declaredBase !== undefined && declaredBase !== null) {
    try { hrefBase = parsePublicHttpUrl(new URL(declaredBase, base).href, true) } catch { hrefBase = undefined }
  }
  const publicLink = (href: string) => {
    try {
      const url = parsePublicHttpUrl(new URL(href, hrefBase).href, true)
      return url.origin === base.origin ? url.href : undefined
    } catch { return undefined }
  }
  const links = new Map<string, { url: string; title: string }>()
  let canonicalUrl: string | undefined
  for (const node of document.querySelectorAll('link[href]')) {
    if (!(node.getAttribute('rel') ?? '').toLowerCase().split(/\s+/u).includes('canonical')) continue
    const url = publicLink(node.getAttribute('href')!)
    if (url) { canonicalUrl = url; links.set(url, { url, title: 'canonical关系' }); break }
  }
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (links.size >= 4096) break
    const url = publicLink(anchor.getAttribute('href')!), title = navigationText(anchor.textContent, 160)
    if (url && url !== base.href && new URL(url).pathname !== '/' && title && url !== canonicalUrl) links.set(url, { url, title })
  }
  const evidence = assessReaderEvidence('', pageTitle, target, html, finalUrl, 'navigation')
  const title = evidence.identity.basis === 'structured_metadata' ? navigationText(evidence.identity.title) : '', author = navigationText(evidence.identity.author)
  const lines = [...new Set([pageTitle && `页面标题：${pageTitle}`, title && `书名元数据：${title}`, author && `作者元数据：${author}`].filter(Boolean))]
  if (!lines.length && !links.size) return assessReaderText('')
  const text = [...lines, ...[...links.values()].slice(0, 40).map(link => `实际链接：${link.title}`)].join('\n')
  const quality = assessReaderText(text, pageTitle || title)
  return { ...quality, status: 'ok', code: 'WEB_READ_OK', text, quality: { ...quality.quality, readable: true }, links: [...links.values()],
    ...(canonicalUrl ? { canonicalUrl } : {}), evidence: { ...evidence,
      identity: { status: evidence.identity.status === 'mismatch' ? 'mismatch'
        : evidence.identity.title && !title || evidence.identity.author && !author ? 'unknown' : evidence.identity.status,
        ...(title ? { title } : {}), ...(author ? { author } : {}), basis: evidence.identity.basis,
        pageType: book && !other && evidence.identity.basis === 'structured_metadata' ? 'book' : 'unknown' },
      integrity: { status: 'unverified', code: 'METADATA_ONLY', extractedHash: textHash(text) } } }
}
