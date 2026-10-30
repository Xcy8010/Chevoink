import { chapterTitleOrdinal } from '../../../shared/structure/chapter-title.js'

/** Only the original human request supplies policy. Source prose never does. */
function directiveText(prompt: string, authorLabels: boolean): string {
  const pairs: Record<string, string> = { '“': '”', '「': '」', '"': '"', "'": "'", '`': '`', '```': '```' }
  const stack: Array<{ close: string; author: boolean; text: string }> = []
  let output = ''
  for (let index = 0; index < prompt.length; index++) {
    const char = prompt[index], current = stack.at(-1), token = prompt.startsWith('```', index) ? '```' : char
    let slashes = 0
    for (let before = index - 1; before >= 0 && prompt[before] === '\\'; before--) slashes++
    const escaped = slashes % 2 === 1
    const apostrophe = char === "'" && /[\p{L}\p{N}]/u.test(prompt[index - 1] ?? '') && /[\p{L}\p{N}]/u.test(prompt[index + 1] ?? '')
    if (current && token === current.close && !apostrophe && !escaped) {
      stack.pop()
      index += token.length - 1
      if (!stack.length && current.author && current.text.length <= 120 && !/[\r\n]/u.test(current.text)) output += ` ${current.text}`
      continue
    }
    if (current && (current.close === '`' || current.close === '```')) continue
    if (pairs[token] && !apostrophe && !escaped) {
      if (stack.length >= 16) return output
      if (current) stack[0].author = false
      stack.push({ close: pairs[token], author: !current && authorLabels && /(?:候选)?作者\s*(?:是|为|[:：])?\s*$/u.test(output), text: '' })
      index += token.length - 1
      continue
    }
    if (current) { if (stack.length === 1 && current.author) current.text += char; continue }
    // An unmatched closing quote has no reliable directive/data boundary.
    if (char === '”' || char === '」') return ''
    output += char
  }
  return output
}

function directives(prompt: string, authorLabels = false): string[] {
  const unquoted = directiveText(prompt, authorLabels)
  return unquoted.replace(/《[^》]*》/gu, '').split(/[。！？!?；;\n]+/u)
    .filter(clause => !/^\s*(?:(?:例如|示例|例句|举例|比如|for example)|(?:书评|网页|来源|材料|引用|原文|提示词样例|quoted text)\s*(?:写道|说|提到|显示|[:：]))/iu.test(clause))
}

export function researchAuthor(prompt: string): string | undefined {
  const names = new Set<string>()
  for (const clause of directives(prompt, true)) {
    if (/(?:不要|并非|不是|非)(?:把|以)?[^，,]{0,16}作者/u.test(clause)) continue
    for (const match of clause.matchAll(/(?:候选)?作者(?:\s*(?:是|为|[:：])\s*|\s+)([^\s，,。；;、()（）《》：:”“「」"']{1,120})/gu)) {
      const name = match[1].replace(/(?:的作品|的小说|的书)$/u, '')
      if (name && !/^(?:身份|信息|姓名|是谁|谁|何人|哪位|及|和|并|核验|核对|未知|不详|待核)/u.test(name)) names.add(name)
    }
  }
  return names.size === 1 ? [...names][0] : undefined
}

/** A named chapter refines the requested work without rewriting its frozen identity. */
export function researchChapterTitle(prompt: string): string | undefined {
  const chapters = new Map<number, string>()
  for (const clause of sourceClauses(prompt)) {
    if (/(?:不要|不得|禁止|不许|不能|不允许|无需|不用|不必|不是|并非|do not|don't|don’t|cannot|can't|can’t|must not|never)/iu.test(clause)) continue
    for (const match of clause.matchAll(/第\s*[^\s，,。；;《》]+?\s*[章回节集]/gu)) {
      const ordinal = chapterTitleOrdinal(match[0])
      if (ordinal !== null) chapters.set(ordinal, match[0].trim())
    }
  }
  return chapters.size === 1 ? [...chapters.values()][0] : undefined
}

export function researchAlternativeSelection(prompt: string): 'denied' | 'after_preferred_unavailable' {
  // Quoted material has no directive role. Keep sentence boundaries outside
  // quotes so a quoted full stop cannot expose the rest as a new permission.
  const clauses = directives(prompt)
  const change = '(?:换(?:一本|书|作品)|换(?:其他|其它|别的)(?:书|作品)|另选|改选|更换.{0,8}(?:书|作品)|(?:alternative|another|different) (?:book|work))'
  const denial = new RegExp(`(?:不要|不得|禁止|不许|不能|不允许|无需|无须|不用|不必|do not|don't|don’t|cannot|can't|can’t|must not|mustn't|mustn’t|never)[^，,。；;]{0,16}${change}`, 'iu')
  if (clauses.some(clause => denial.test(clause))) return 'denied'
  const grant = new RegExp(`(?:可以|允许|准许|可|\\byou may\\b|\\ballow(?:ed)?\\b)[^，,。；;]{0,16}${change}`, 'giu')
  const permissions = clauses.flatMap(clause => [...clause.matchAll(grant)].map(match => ({ clause,
    denied: /(?:不|未|从未|没有|并未|无)(?:曾经?|明确|事先|被|得到|获得|予以){0,3}\s*$|\b(?:not|never|no|don't|don’t|cannot|can't|can’t|mustn't|mustn’t)(?:\s+(?:explicitly|currently|yet|ever|previously))*\s*$/iu.test(clause.slice(0, match.index)),
  })))
  if (permissions.some(permission => permission.denied)) return 'denied'
  return permissions.some(({ clause }) => !/(?:是否|能否|可否|判断|评估|询问|\?|how|whether|assess)/iu.test(clause)
    && /(?:找不到|不可用|不可读|无法(?:找到|获取|读取)|未能(?:找到|获取|读取)|unavailable|cannot (?:find|read))/iu.test(clause))
    ? 'after_preferred_unavailable' : 'denied'
}

export function researchSourceSites(prompt: string): string[] {
  const boundaries = new Set<string>()
  for (const clause of sourceClauses(prompt)) {
    const denied = /(?:不要|不得|禁止|不许|不能|不允许|无需|不用|不必|do not|don't|don’t|cannot|can't|can’t|must not|mustn't|mustn’t|never)/iu.test(clause)
    const hardScope = /(?:仅(?:限|在)?|只(?:能|在|允许)?|限定|限制|来源范围|搜索范围|\bonly\b|\bwithin\b|restricted)/iu.test(clause)
    for (const match of clause.matchAll(/(?<![a-z0-9_-])(-?site:[^\s，,。；;]+)/giu)) {
      if (match[1].startsWith('-') || denied || hardScope) boundaries.add(denied && !match[1].startsWith('-') ? `-${match[1]}` : match[1])
    }
    if (denied) for (const match of clause.matchAll(/https?:\/\/[^\s，,。；;]+/giu)) {
      try { const url = new URL(match[0]); boundaries.add(`-site:${url.hostname}${url.pathname === '/' ? '' : url.pathname}`) } catch { /* No positive grant from invalid addresses. */ }
    }
  }
  return [...boundaries].slice(0, 8)
}

const sourceClauses = (prompt: string) => directives(prompt).flatMap(clause => clause.split(/[，,]+|(?:但是|但|\bbut\b)/iu))

export function researchSourceHosts(prompt: string): string[] {
  const hosts = new Set<string>()
  const text = sourceClauses(prompt).filter(clause => !/(?:不要|不得|禁止|不许|不能|不允许|无需|不用|不必|不仅|不只|do not|don't|don’t|cannot|can't|can’t|must not|mustn't|mustn’t|never)/iu.test(clause)
    && /(?:(?:只|仅)(?:允许|能|限)?(?:限于|限|在|从|用|研究|搜索|检索|读取|获取|使用)?\s*(?:番茄小说|fanqienovel\.com|site:|https?:\/\/)|限定|限制|来源范围|搜索范围|\bonly\s+(?:(?:on|from|within|at|use)\s+)?(?:site:|https?:\/\/|fanqienovel)|\bwithin\s+(?:site:|https?:\/\/)|restricted)|^\s*site:/iu.test(clause)).join('\n')
  if (/番茄小说|fanqienovel\.com/iu.test(text)) hosts.add('fanqienovel.com')
  for (const match of text.matchAll(/(?:(?<![-\w])site:|https?:\/\/)((?:[a-z0-9-]+\.)+[a-z]{2,63})(?:[\s/:]|$)/giu)) {
    if (hosts.size < 8 && match[1].length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu.test(match[1])) hosts.add(match[1].toLowerCase())
  }
  return [...hosts]
}
