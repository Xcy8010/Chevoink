import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element, ElementContent, Root } from 'hast'

import '@milkdown/crepe/theme/common/prosemirror.css'
import '@milkdown/crepe/theme/common/reset.css'
import '@milkdown/crepe/theme/common/placeholder.css'

import type { EditorSelectionState } from '../types'
import { markdownResources, safeMarkdownUrl } from '../agent/components/markdown-resources'
import LocalFirstTextarea from './LocalFirstTextarea'
import { useStreamingAutoFollow } from './useStreamingAutoFollow'
import { readPlanPosition, savePlanPosition } from './plan-view-position'

const PlanRichMarkdownEditor = lazy(() => import('./PlanRichMarkdownEditor'))

// ProseMirror preserves whitespace. Markdown's HTML formatting newlines between
// blocks would paint as extra lines until the editable document replaces them.
function alignReadingBlocks() {
  const blockTags = new Set(['p', 'ul', 'ol', 'blockquote', 'pre', 'table', 'hr', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
  const isBlock = (child: ElementContent | undefined) => child?.type === 'element' && blockTags.has(child.tagName)
  const emptyParagraph = (): Element => ({ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'element', tagName: 'br', properties: {}, children: [] }] })
  function visit(node: Root | Element) {
    for (const child of node.children) if (child.type === 'element') visit(child)
    if (node.type === 'root' || ['ul', 'ol', 'blockquote'].includes(node.tagName)) {
      node.children = node.children.filter(child => child.type !== 'text' || child.value !== '\n')
    } else if (['li', 'th', 'td'].includes(node.tagName)) {
      // Milkdown places tight list items and table cell text inside paragraphs.
      const blocks: ElementContent[] = []
      let paragraph: Element | undefined
      for (const [index, child] of node.children.entries()) {
        if (child.type === 'text' && child.value === '\n' && (!paragraph || isBlock(node.children[index + 1]) || index === node.children.length - 1)) continue
        if (isBlock(child)) {
          paragraph = undefined
          blocks.push(child)
        } else {
          if (!paragraph) {
            paragraph = { type: 'element', tagName: 'p', properties: {}, children: [] }
            blocks.push(paragraph)
          }
          paragraph.children.push(child)
        }
      }
      node.children = blocks.length ? blocks : [emptyParagraph()]
    }
  }
  return (tree: Root) => {
    visit(tree)
    // Milkdown reserves a final editable line after a list, table or other block.
    const last = tree.children.at(-1)
    if (last?.type === 'element' && blockTags.has(last.tagName) && !/^(p|h[1-6])$/.test(last.tagName)) tree.children.push(emptyParagraph())
  }
}

const ReadingMarkdown = memo(function ReadingMarkdown({ markdown }: { markdown: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[alignReadingBlocks]} skipHtml components={markdownResources} urlTransform={safeMarkdownUrl}>{markdown}</ReactMarkdown>
})

export type PlanEditorMode = 'preview' | 'markdown'

type Props = {
  documentId: string
  markdown: string
  editable?: boolean
  mobile?: boolean
  className?: string
  onChange?: (markdown: string) => void
  onBlur?: () => void
  onSelectionChange?: (selection: EditorSelectionState) => void
  streaming?: boolean
  positionScope?: string
}

function PlanEditorModeSwitch({ mode, onChange }: { mode: PlanEditorMode; onChange: (mode: PlanEditorMode) => void }) {
  return (
    <div
      className="inline-flex h-8 items-center rounded-lg bg-[var(--surface-muted)] p-0.5 text-xs"
      role="group"
      aria-label="计划文档显示方式"
    >
      {(['preview', 'markdown'] as const).map((nextMode) => (
        <button
          key={nextMode}
          type="button"
          onClick={() => onChange(nextMode)}
          aria-pressed={mode === nextMode}
          className={`h-7 rounded-md px-3 transition-[background-color,color,box-shadow] duration-200 ${
            mode === nextMode
              ? 'bg-[var(--surface-default)] text-[var(--text-primary)] shadow-sm'
              : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
          }`}
        >
          {nextMode === 'preview' ? '预览' : 'Markdown'}
        </button>
      ))}
    </div>
  )
}

export default function PlanMarkdownEditor(props: Props) {
  // The debounce buffer and callbacks belong to the document, not only Milkdown.
  return <PlanMarkdownEditorDocument key={`${props.positionScope ?? ''}:${props.documentId}`} {...props} />
}

function PlanMarkdownEditorDocument({
  documentId,
  markdown,
  editable = true,
  mobile = false,
  className = '',
  onChange,
  onBlur,
  onSelectionChange,
  streaming = false,
  positionScope,
}: Props) {
  const positionKey = positionScope ? `${positionScope}:${documentId}` : undefined
  const [mode, setMode] = useState<PlanEditorMode>('preview')
  const [richReady, setRichReady] = useState(false)
  const [richFailed, setRichFailed] = useState(false)
  const [mountEditor, setMountEditor] = useState(false)
  useEffect(() => {
    // Let the selected plan paint before constructing the editable ProseMirror document.
    let timer: number | undefined
    const frame = requestAnimationFrame(() => { timer = window.setTimeout(() => setMountEditor(true), 0) })
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer) }
  }, [])
  const previewKey = positionKey ? `${positionKey}:preview` : undefined
  const restorePreviewScroll = useCallback((node: HTMLDivElement | null) => {
    if (node) node.scrollTop = readPlanPosition(previewKey)
  }, [previewKey])
  const markdownScroll = useStreamingAutoFollow<HTMLTextAreaElement>(streaming, markdown)
  const markdownRef = markdownScroll.ref
  const restoreMarkdownScroll = useCallback((node: HTMLTextAreaElement | null) => {
    markdownRef(node)
    if (node) node.scrollTop = readPlanPosition(positionKey ? `${positionKey}:markdown` : undefined)
  }, [markdownRef, positionKey])

  // Milkdown 富文本每次击键都会同步上报 markdown，直接透传会让 StudioWorkspace 整树
  // 每字重渲染一遍（与章节正文同样的“打字断一下”问题）；这里先缓冲，停顿后一次性上报。
  const pendingMarkdownRef = useRef<{ content: string; commit?: (markdown: string) => void } | null>(null)
  const markdownCommitTimerRef = useRef<number | null>(null)
  const onChangeRef = useRef(onChange)
  const onBlurRef = useRef(onBlur)
  onChangeRef.current = onChange
  onBlurRef.current = onBlur

  const flushPendingMarkdown = useCallback(() => {
    if (markdownCommitTimerRef.current !== null) {
      window.clearTimeout(markdownCommitTimerRef.current)
      markdownCommitTimerRef.current = null
    }
    if (pendingMarkdownRef.current !== null) {
      const next = pendingMarkdownRef.current
      pendingMarkdownRef.current = null
      next.commit?.(next.content)
    }
  }, [])

  const handleRichMarkdownChange = useCallback(
    (next: string) => {
      pendingMarkdownRef.current = { content: next, commit: pendingMarkdownRef.current?.commit ?? onChangeRef.current }
      if (markdownCommitTimerRef.current !== null) window.clearTimeout(markdownCommitTimerRef.current)
      markdownCommitTimerRef.current = window.setTimeout(() => {
        markdownCommitTimerRef.current = null
        flushPendingMarkdown()
      }, 160)
    },
    [flushPendingMarkdown],
  )

  const handleRichEditorBlur = useCallback(() => {
    // 失焦先把缓冲的计划内容上报，再交给外部的失焦保存逻辑。
    flushPendingMarkdown()
    onBlurRef.current?.()
  }, [flushPendingMarkdown])

  const commitLatestTransaction = useCallback((content: string) => {
    if (markdownCommitTimerRef.current !== null) window.clearTimeout(markdownCommitTimerRef.current)
    markdownCommitTimerRef.current = null
    const commit = pendingMarkdownRef.current?.commit ?? onChangeRef.current
    pendingMarkdownRef.current = null
    commit?.(content)
  }, [])

  // 卸载时上报最后一批输入，防止切计划丢字。
  useEffect(
    () => () => {
      if (markdownCommitTimerRef.current !== null) window.clearTimeout(markdownCommitTimerRef.current)
      if (pendingMarkdownRef.current !== null) pendingMarkdownRef.current.commit?.(pendingMarkdownRef.current.content)
    },
    [],
  )

  return (
    <div className={`plan-markdown-editor flex min-h-0 flex-1 flex-col ${className}`} data-mode={mode}>
      <div className="sticky top-0 z-20 flex shrink-0 justify-end bg-[var(--surface-default)]/95 pb-2 backdrop-blur-sm">
        <PlanEditorModeSwitch mode={mode} onChange={next => {
          if (next === mode) return
          setRichReady(false)
          setRichFailed(false)
          setMode(next)
        }} />
      </div>

      {mode === 'preview' ? (
        <div className={`grid flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] ${mobile ? 'min-h-[60vh]' : 'min-h-0'}`}>
          {!richReady && <div ref={restorePreviewScroll} onScroll={event => savePlanPosition(previewKey, event.currentTarget)} className="plan-rich-markdown overflow-auto [grid-area:1/1]" data-mobile={mobile} data-plan-reading-preview>
            {richFailed && <p role="status" className="pb-2 text-xs text-[var(--text-secondary)]">富文本编辑器暂不可用，可切换到 Markdown 继续编辑。</p>}
            <div className="milkdown"><div className="ProseMirror">
              <ReadingMarkdown markdown={markdown} />
            </div></div>
          </div>}
          <div aria-hidden={!richReady} className={`flex min-h-0 flex-col [grid-area:1/1] ${richReady ? '' : 'invisible'}`}>
            <Suspense fallback={null}>
              {mountEditor && <PlanRichMarkdownEditor
                markdown={markdown}
                editable={editable}
                mobile={mobile}
                onReady={() => setRichReady(true)}
                onCreateError={() => setRichFailed(true)}
                onChange={handleRichMarkdownChange}
                onCommitPending={commitLatestTransaction}
                onBlur={handleRichEditorBlur}
                onSelectionChange={onSelectionChange}
                streaming={streaming}
                positionKey={previewKey}
              />}
            </Suspense>
          </div>
        </div>
      ) : (
        <LocalFirstTextarea
          ref={restoreMarkdownScroll}
          onScroll={() => { markdownScroll.onScroll(); savePlanPosition(positionKey ? `${positionKey}:markdown` : undefined, markdownScroll.nodeRef.current) }}
          value={markdown}
          readOnly={!editable}
          resetKey={documentId}
          onCommit={(next) => onChange?.(next)}
          onSelectionChange={onSelectionChange}
          onBlur={onBlur}
          spellCheck={false}
          className={`${
            mobile ? 'min-h-[60vh]' : 'min-h-[28rem] flex-1'
          } w-full resize-none overflow-y-auto bg-transparent font-mono text-[13px] leading-7 text-[var(--text-primary)] outline-none`}
          placeholder="继续完善这份创作计划。"
          aria-label="Markdown 原文"
        />
      )}
    </div>
  )
}
