import { fromMarkdown } from 'mdast-util-from-markdown'
import { parsePublicHttpUrl } from './public-http.js'

type MarkdownNode = { type: string; value?: string; url?: string; identifier?: string; children?: MarkdownNode[] }

/** Discover parsed links only; examples in code blocks are not source links. */
export function extractMarkdownReaderLinks(markdown: string, finalUrl: string): Array<{ url: string; title: string }> {
  const root: MarkdownNode = fromMarkdown(markdown)
  const nodes: MarkdownNode[] = []
  const queue = [root]
  while (queue.length) {
    const node = queue.pop()!
    if (nodes.length >= 20000) return []
    nodes.push(node)
    if (node.children) queue.push(...node.children)
  }
  const definitions = new Map(nodes.filter(node => node.type === 'definition').map(node => [node.identifier, node.url]))
  const base = parsePublicHttpUrl(finalUrl, true)
  const links = new Map<string, { url: string; title: string }>()
  const label = (node: MarkdownNode): string => node.value ?? node.children?.map(label).join('') ?? ''
  for (const node of nodes) {
    if (links.size >= 4096) break
    if (node.type !== 'link' && node.type !== 'linkReference') continue
    const href = node.url ?? definitions.get(node.identifier)
    if (!href) continue
    try {
      const url = parsePublicHttpUrl(new URL(href, base).href, true)
      const title = label(node).replace(/\s+/g, ' ').trim().slice(0, 160)
      if (url.origin !== base.origin || url.href === base.href || url.pathname === '/' || !title) continue
      links.set(url.href, { url: url.href, title })
    } catch { /* Untrusted links do not expand discovery to unsafe addresses. */ }
  }
  return [...links.values()].reverse()
}
