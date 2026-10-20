import { createHash } from 'node:crypto'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { parsePublicHttpUrl } from './public-http.js'

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

export type ReaderTarget = { title: string; author?: string }
export type ReaderEvidence = {
  version: 1
  identity: { status: 'verified' | 'mismatch' | 'unknown'; title?: string; author?: string; pageType: 'chapter' | 'book' | 'unknown'; basis: 'structured_metadata' | 'page_title' | 'none' }
  integrity: { status: 'source_compared' | 'unverified' | 'damaged'; code: string; extractedHash: string; referenceHash?: string }
}

const textHash = (value: string) => createHash('sha256').update(value).digest('hex')
const compact = (value: string) => {
  type Node = { type: string; value?: string; children?: Node[] }
  const visible = (node: Node): string => node.type === 'definition' ? '' : node.value ?? node.children?.map(visible).join('') ?? ''
  return visible(fromMarkdown(value)).normalize('NFC').replace(/\s+/gu, '')
}
const identityValue = (value: string) => value.normalize('NFC').trim().replace(/^《|》$/gu, '').trim()

/** Metadata is source evidence, not authority. Never equate a title prefix,
 * common hostname or a search snippet with the requested original work. */
export function assessReaderEvidence(text: string, pageTitle: string, target?: ReaderTarget, sourceHtml?: string): ReaderEvidence {
  let title: string | undefined, author: string | undefined
  let basis: ReaderEvidence['identity']['basis'] = 'none'
  let pageType: ReaderEvidence['identity']['pageType'] = 'unknown'
  let reference: string | undefined
  let structuredReference = false
  if (sourceHtml) {
    const { document } = parseHTML(sourceHtml)
    const meta = (names: string[]) => {
      for (const node of document.querySelectorAll('meta[content]')) {
        if (names.includes((node.getAttribute('property') ?? node.getAttribute('name') ?? '').toLowerCase())) return node.getAttribute('content')?.trim()
      }
      return undefined
    }
    title = meta(['og:novel:book_name', 'og:book_name', 'book:name'])
    author = meta(['og:novel:author', 'book:author', 'author'])
    const authorName = (value: unknown): string | undefined => typeof value === 'string' ? value : value && typeof value === 'object' && 'name' in value && typeof value.name === 'string' ? value.name : undefined
    const inspect = (value: unknown, depth = 0): void => {
      if (!value || typeof value !== 'object' || depth > 5) return
      if (Array.isArray(value)) { for (const item of value.slice(0, 100)) inspect(item, depth + 1); return }
      const entry = value as Record<string, unknown>
      const types = Array.isArray(entry['@type']) ? entry['@type'] : [entry['@type']]
      if (types.some(type => type === 'Book' || type === 'Novel')) {
        if (typeof entry.name === 'string') title ??= entry.name
        author ??= authorName(Array.isArray(entry.author) ? entry.author[0] : entry.author)
        if (depth === 0) pageType = 'book'
      }
      if (types.some(type => type === 'Chapter' || type === 'Article' || type === 'NewsArticle' || type === 'BlogPosting')) {
        if (typeof entry.articleBody === 'string' && !reference) { reference = entry.articleBody; structuredReference = true }
        if (types.includes('Chapter')) pageType = 'chapter'
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
  if (title) title = identityValue(title).slice(0, 300)
  if (author) author = identityValue(author).slice(0, 300)
  const mismatch = Boolean(target && ((title && title !== identityValue(target.title)) || (target.author && author && author !== identityValue(target.author))))
  const verified = Boolean(target && title === identityValue(target.title) && author && (!target.author || author === identityValue(target.author)) && basis === 'structured_metadata')
  const integrity: ReaderEvidence['integrity'] = { status: 'unverified', code: 'SOURCE_COMPLETENESS_UNVERIFIED', extractedHash: textHash(text) }
  if (reference) {
    const extracted = compact(text), original = compact(reference)
    integrity.referenceHash = textHash(reference)
    if (original.includes(extracted) || extracted.includes(original)) { integrity.status = 'source_compared'; integrity.code = 'SOURCE_TEXT_MATCH' }
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
  return { version: 1, identity: { status: mismatch ? 'mismatch' : verified ? 'verified' : 'unknown', ...(title ? { title } : {}), ...(author ? { author } : {}), pageType, basis }, integrity }
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

export function extractReaderHtml(html: string, useReadability = true): ReaderQualityResult {
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
