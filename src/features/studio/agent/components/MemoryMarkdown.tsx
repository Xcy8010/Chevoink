import { memo } from 'react'
import type { Root } from 'mdast'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownResources, safeMarkdownUrl } from './markdown-resources'

type TextNode = { type: string; value?: string; alt?: string | null; children?: readonly TextNode[] }

function nodeText(node: TextNode): string {
  if (node.type === 'html') return ''
  if (node.value !== undefined) return node.value
  if (node.alt) return node.alt
  return node.children?.map(nodeText).join(['table', 'tableRow', 'list'].includes(node.type) ? ' · ' : '') ?? ''
}

function prepareCardText(title: string) {
  return (tree: Root, file: { value: string | Uint8Array }) => {
    const first = tree.children[0]
    if (first?.type === 'heading' && first.depth === 1 && nodeText(first).trim() === title.trim()) {
      tree.children.shift()
    } else if (typeof file.value === 'string' && tree.children.every(block => block.type === 'paragraph' && block.children.every(child => child.type === 'text')
      && nodeText(block) === file.value.slice(block.position?.start.offset, block.position?.end.offset))) {
      // Legacy plain-text cards keep their original paragraph breaks and spacing.
      tree.children = [{ type: 'paragraph', children: [{ type: 'text', value: file.value }] }]
    }
  }
}

function extractSnippet() {
  return (tree: Root) => {
    const body = tree.children.find(node => !['heading', 'definition', 'html', 'thematicBreak'].includes(node.type))
    const line = body ?? tree.children.find(node => node.type === 'heading')
    tree.children = line ? [{ type: 'paragraph', children: [{ type: 'text', value: nodeText(line).replace(/\s+/g, ' ').trim().slice(0, 150) }] }] : []
  }
}

const snippetElements: Components = { p: ({ children }) => <>{children}</> }
export const MemorySnippet = memo(function MemorySnippet({ title, content }: { title: string; content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, [prepareCardText, title], extractSnippet]} components={snippetElements}>
    {content.slice(0, 1600)}
  </ReactMarkdown>
})

const elements: Components = {
  ...markdownResources,
  h1: ({ children }) => <h4>{children}</h4>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h5>{children}</h5>,
  h4: ({ children }) => <h6>{children}</h6>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
  table: ({ children }) => <div className="memory-table-scroll" role="region" aria-label="卡片表格，可横向滚动" tabIndex={0}>
    <table>{children}</table>
  </div>,
  pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
}

export const MemoryMarkdown = memo(function MemoryMarkdown({ title, content }: { title: string; content: string }) {
  return <div className="memory-markdown"><ReactMarkdown remarkPlugins={[remarkGfm, [prepareCardText, title]]}
    urlTransform={safeMarkdownUrl} components={elements}>{content}</ReactMarkdown></div>
})
