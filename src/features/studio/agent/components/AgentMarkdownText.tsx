import { Component, Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Element, Root } from 'hast'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownResources, safeMarkdownUrl } from './markdown-resources'
import { useStreamingText } from '../../components/use-streaming-text'
import { containsAgentProtocolArtifact, stripAgentProtocolArtifacts } from '../../../../../shared/agent-output.js'
import { escapeLiteralActivityLine } from '../../../../../shared/agent-activity-title.js'

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] }
/** Clean protocol artifacts after parsing, never inside code examples or JSON fences. */
function removeProtocolText() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === 'code' || node.type === 'inlineCode') return
      if (node.type === 'text' && node.value) {
        if (containsAgentProtocolArtifact(node.value)) {
          const leading = node.value.match(/^\s*/)?.[0] ?? ''
          const trailing = node.value.match(/\s*$/)?.[0] ?? ''
          const clean = stripAgentProtocolArtifacts(node.value)
          node.value = clean ? leading + clean + trailing : ''
        }
        const cleaned = node.value.replace(/^[\t ]*\[调用\s*(?:工具|tool)[^\r\n]*(?:\r?\n|$)/gim, '')
        // Hidden status lines must not leave whitespace-pre-wrap line boxes behind.
        if (cleaned !== node.value) node.value = cleaned.trimEnd()
      }
      node.children?.forEach(visit)
      if (node.children) node.children = node.children.filter(child =>
        !(child.type === 'text' && !child.value) && !(child.type === 'paragraph' && !child.children?.length))
    }
    visit(tree)
  }
}

const heading = 'mb-2 mt-4 text-base font-semibold first:mt-0'
const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null

// Annotate just the visible writing edge, after Markdown has produced its semantic elements.
function markReplyInk(from: number) {
  return (tree: Root) => {
    function visit(parent: Root | Element) {
      parent.children.forEach((node, i) => {
        if (node.type === 'element' && node.tagName !== 'code' && node.tagName !== 'pre') visit(node)
        if (node.type !== 'text' || !node.value.trim()) return
        const end = node.position?.end.offset
        if (end === undefined || end <= from) return
        const start = Math.max(0, node.value.length - (end - from))
        parent.children[i] = { type: 'element', tagName: 'span', properties: {dataInkStart: start}, children: [node] }
      })
    }
    visit(tree)
  }
}

const components: Components = {
  ...markdownResources,
  span: ({ node, children, ...props }) => {
    const offset = node?.properties.dataInkStart
    if (typeof offset !== 'number' || typeof children !== 'string') return <span {...props}>{children}</span>
    const start = graphemes?.segment(children).containing(offset)?.index ?? offset
    const tail = children.slice(start)
    const letters = graphemes ? Array.from(graphemes.segment(tail), g => g.segment) : Array.from(tail)
    let index = start
    return <>{children.slice(0, start)}{letters.map(letter => {
      const key = index
      index += letter.length
      return /\s/u.test(letter) ? <Fragment key={key}>{letter}</Fragment>
        : <span key={key} className="agent-reply-ink">{letter}</span>
    })}</>
  },
  h1: ({ children }) => <h3 className={heading}>{children}</h3>,
  h2: ({ children }) => <h4 className={heading}>{children}</h4>,
  h3: ({ children }) => <h5 className={heading}>{children}</h5>,
  h4: ({ children }) => <h6 className={heading}>{children}</h6>,
  h5: ({ children }) => <h6 className={heading}>{children}</h6>,
  h6: ({ children }) => <h6 className={heading}>{children}</h6>,
  p: ({ children }) => <p className="my-2 whitespace-pre-wrap text-pretty first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-6 text-pretty">{children}</ul>,
  ol: ({ children, start }) => <ol start={start} className="my-2 list-decimal space-y-1 pl-6 text-pretty">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-[var(--border-subtle)] pl-4 text-[var(--text-secondary)]">{children}</blockquote>,
  pre: ({ children }) => <pre tabIndex={0} className="my-2 max-w-full overflow-x-auto rounded-xl bg-[var(--bg-secondary)] p-3 text-xs leading-6">{children}</pre>,
  code: ({ children }) => <code className="font-mono">{children}</code>,
  table: ({ children }) => <div role="region" aria-label="分析表格，可横向滚动" tabIndex={0} className="my-3 max-w-full overflow-x-auto rounded-lg border border-[var(--border-subtle)]">
    <table className="w-full border-collapse text-left text-sm">{children}</table>
  </div>,
  th: ({ children }) => <th scope="col" className="min-w-24 border-b border-[var(--border-subtle)] px-3 py-2 font-semibold">{children}</th>,
  td: ({ children }) => <td className="min-w-24 border-b border-[var(--border-subtle)] px-3 py-2 align-top">{children}</td>,
}

export const REPLY_INK_SETTLE_MS = 180

const plugins = [remarkGfm, removeProtocolText]

// Studio and creation records are already lazy routes. Paint the real block
// layout with the history, so parsing cannot move adjacent tool rows later.
function Markdown({ text, replyInk }: { text: string; replyInk: boolean }) {
  const source = escapeLiteralActivityLine(stripAgentProtocolArtifacts(text))
  const previous = useRef('')
  const [inkFrom, setInkFrom] = useState<number | null>(null)
  useLayoutEffect(() => {
    const before = previous.current
    previous.current = source
    if (source === before) return
    if (replyInk && source.startsWith(before) && document.visibilityState !== 'hidden'
      && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setInkFrom(start => start ?? before.length)
    } else {
      setInkFrom(null)
    }
  }, [source, replyInk])
  useEffect(() => {
    if (inkFrom === null) return
    const timer = window.setTimeout(() => setInkFrom(null), REPLY_INK_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [inkFrom, source])
  const from = inkFrom === null ? null : Math.max(inkFrom, source.length - 64)
  return <ReactMarkdown skipHtml remarkPlugins={plugins} rehypePlugins={from === null ? undefined : [[markReplyInk, from]]}
    urlTransform={safeMarkdownUrl} components={components}>
    {source}
  </ReactMarkdown>
}

class MarkdownBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { console.warn('[agent-markdown] Rendering unavailable; displaying plain text.') }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

export const AgentMarkdownText = memo(function AgentMarkdownText({ text, streaming = false, identity = '', replyInk = false }: {
  text: string; streaming?: boolean; identity?: string; replyInk?: boolean
}) {
  const content = useStreamingText(text, streaming, identity)
  if (!content.trim()) return null
  const fallback = <p className="whitespace-pre-wrap break-words text-pretty">{content}</p>
  return <div className="min-w-0 max-w-full break-words text-sm font-normal leading-7 text-[var(--text-primary)] [overflow-wrap:anywhere]">
    <MarkdownBoundary key={identity} fallback={fallback}><Markdown text={content} replyInk={replyInk} /></MarkdownBoundary>
  </div>
})
