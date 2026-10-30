import { Component, Suspense, lazy, memo, type ReactNode } from 'react'
import { useStreamingText } from '../../components/use-streaming-text'
import type { Components } from 'react-markdown'

// Keep the parser out of the initial workbench chunk. Failure retains the answer.
const Markdown = lazy(async () => {
  const [renderer, gfm, protocol] = await Promise.all([import('react-markdown'), import('remark-gfm'), import('../../../../../shared/agent-output.js')])
  const plugins = [gfm.default, () => removeProtocolText(protocol)]
  return { default: ({ text }: { text: string }) => <renderer.default skipHtml remarkPlugins={plugins}
    urlTransform={safeLink} components={components}>{protocol.stripAgentProtocolArtifacts(text)}</renderer.default> }
})

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] }
/** Clean protocol artifacts after parsing, never inside code examples or JSON fences. */
function removeProtocolText({ containsAgentProtocolArtifact, stripAgentProtocolArtifacts }: typeof import('../../../../../shared/agent-output.js')) {
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

function safeLink(value: string): string {
  if (/^#[\w-]+$/.test(value)) return value
  if (!/^https?:\/\//i.test(value)) return ''
  try {
    const url = new URL(value)
    return url.username || url.password ? '' : url.href
  } catch { return '' }
}

const heading = 'mb-2 mt-4 text-base font-semibold first:mt-0'
const components: Components = {
  h1: ({ children }) => <h3 className={heading}>{children}</h3>,
  h2: ({ children }) => <h4 className={heading}>{children}</h4>,
  h3: ({ children }) => <h5 className={heading}>{children}</h5>,
  h4: ({ children }) => <h6 className={heading}>{children}</h6>,
  h5: ({ children }) => <h6 className={heading}>{children}</h6>,
  h6: ({ children }) => <h6 className={heading}>{children}</h6>,
  p: ({ children }) => <p className="my-2 whitespace-pre-wrap first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-6">{children}</ul>,
  ol: ({ children, start }) => <ol start={start} className="my-2 list-decimal space-y-1 pl-6">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-[var(--border-subtle)] pl-4 text-[var(--text-secondary)]">{children}</blockquote>,
  pre: ({ children }) => <pre tabIndex={0} className="my-2 max-w-full overflow-x-auto rounded-xl bg-[var(--bg-secondary)] p-3 text-xs leading-6">{children}</pre>,
  code: ({ children }) => <code className="font-mono">{children}</code>,
  table: ({ children }) => <div role="region" aria-label="分析表格，可横向滚动" tabIndex={0} className="my-3 max-w-full overflow-x-auto rounded-lg border border-[var(--border-subtle)]">
    <table className="w-full border-collapse text-left text-sm">{children}</table>
  </div>,
  th: ({ children }) => <th scope="col" className="min-w-24 border-b border-[var(--border-subtle)] px-3 py-2 font-semibold">{children}</th>,
  td: ({ children }) => <td className="min-w-24 border-b border-[var(--border-subtle)] px-3 py-2 align-top">{children}</td>,
  a: ({ children, href }) => href ? <a href={href} target={href.startsWith('#') ? undefined : '_blank'}
    rel="noopener noreferrer" className="break-all underline underline-offset-2">{children}</a> : <span>{children}</span>,
  // No img element, even in a hidden/loading state: untrusted prose cannot make tracking requests.
  img: ({ alt }) => <span className="text-[var(--text-secondary)]">{alt ? `[图片：${alt}，未自动加载]` : '[图片未自动加载]'}</span>,
}

class MarkdownBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { console.warn('[agent-markdown] Rendering unavailable; displaying plain text.') }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

export const AgentMarkdownText = memo(function AgentMarkdownText({ text, streaming = false, identity = '' }: {
  text: string; streaming?: boolean; identity?: string
}) {
  const content = useStreamingText(text, streaming, identity)
  if (!content.trim()) return null
  const fallback = <p className="whitespace-pre-wrap break-words">{content}</p>
  return <div className="min-w-0 max-w-full break-words text-sm leading-7 text-[var(--text-primary)] [overflow-wrap:anywhere]">
    <MarkdownBoundary key={identity} fallback={fallback}><Suspense fallback={fallback}><Markdown text={content} /></Suspense></MarkdownBoundary>
  </div>
})
