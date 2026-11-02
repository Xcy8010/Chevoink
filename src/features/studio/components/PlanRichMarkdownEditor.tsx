import { useEffect, useRef } from 'react'
import { CrepeBuilder } from '@milkdown/crepe/builder'
import { placeholder } from '@milkdown/crepe/feature/placeholder'
import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

import '@milkdown/crepe/theme/common/prosemirror.css'
import '@milkdown/crepe/theme/common/reset.css'
import '@milkdown/crepe/theme/common/placeholder.css'

import type { EditorSelectionState } from '../types'
import { useStreamingAutoFollow } from './useStreamingAutoFollow'
import { readPlanPosition, savePlanPosition } from './plan-view-position'

type Props = {
  markdown: string
  editable: boolean
  mobile: boolean
  onChange?: (markdown: string) => void
  onBlur?: () => void
  onSelectionChange?: (selection: EditorSelectionState) => void
  streaming?: boolean
  positionKey?: string
}

export default function PlanRichMarkdownEditor({ markdown, editable, mobile, onChange, onBlur, onSelectionChange, streaming = false, positionKey }: Props) {
  const streamingScroll = useStreamingAutoFollow<HTMLDivElement>(streaming, markdown)
  const rootRef = streamingScroll.nodeRef
  const editorRef = useRef<CrepeBuilder | null>(null)
  const currentMarkdownRef = useRef(markdown)
  const desiredMarkdownRef = useRef(markdown)
  const synchronizedDocRef = useRef<ProseNode | null>(null)
  const editableRef = useRef(editable)
  editableRef.current = editable
  const onChangeRef = useRef(onChange)
  const onBlurRef = useRef(onBlur)
  const onSelectionChangeRef = useRef(onSelectionChange)

  useEffect(() => {
    onChangeRef.current = onChange
    onBlurRef.current = onBlur
    onSelectionChangeRef.current = onSelectionChange
  }, [onBlur, onChange, onSelectionChange])

  desiredMarkdownRef.current = markdown

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    let disposed = false
    let created = false
    let acceptingUpdates = false
    const editor = new CrepeBuilder({ root, defaultValue: markdown })
      .addFeature(placeholder, { text: '继续完善这份创作计划。', mode: 'block' })

    currentMarkdownRef.current = markdown
    editor.setReadonly(!editable)
    editor.on((listener) => {
      listener.updated((ctx, doc) => {
        if (disposed || !acceptingUpdates || !editableRef.current) return
        // The listener is debounced. Compare actual documents: parsing its
        // serialized Markdown would drop the trailing paragraph of a list.
        if (!doc.eq(ctx.get(editorViewCtx).state.doc) || synchronizedDocRef.current?.eq(doc)) return
        // A later undo to the server document is a real edit after this save.
        synchronizedDocRef.current = null
        const nextMarkdown = ctx.get(serializerCtx)(doc)
        if (nextMarkdown === currentMarkdownRef.current) return
        currentMarkdownRef.current = nextMarkdown
        onChangeRef.current?.(nextMarkdown)
      })
      listener.blur(() => { if (!disposed) onBlurRef.current?.() })
    })

    void editor.create().then(() => {
      created = true
      if (disposed) {
        void editor.destroy()
        return
      }
      editorRef.current = editor
      editor.setReadonly(!editableRef.current)
      synchronizedDocRef.current = editor.editor.action(ctx => ctx.get(editorViewCtx).state.doc)
      acceptingUpdates = true
      const desiredMarkdown = desiredMarkdownRef.current
      if (desiredMarkdown !== currentMarkdownRef.current) {
        currentMarkdownRef.current = desiredMarkdown
        synchronizedDocRef.current = synchronizeMarkdown(editor, desiredMarkdown)
      }
      // Restore only once, after the async editor has laid out its real document.
      root.scrollTop = readPlanPosition(positionKey)
    })

    return () => {
      disposed = true
      if (editorRef.current === editor) editorRef.current = null
      if (created) void editor.destroy()
    }
    // 每份计划以独立组件实例挂载；外部内容变化由下方无历史事务同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || markdown === currentMarkdownRef.current) return
    currentMarkdownRef.current = markdown
    synchronizedDocRef.current = synchronizeMarkdown(editor, markdown)
  }, [markdown])

  useEffect(() => {
    editorRef.current?.setReadonly(!editable)
  }, [editable])

  function emitVisualSelection() {
    const root = rootRef.current
    const selection = window.getSelection()
    if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      onSelectionChangeRef.current?.({ start: 0, end: 0, text: '' })
      return
    }

    const range = selection.getRangeAt(0)
    if (!root.contains(range.commonAncestorContainer)) return
    const text = selection.toString()
    const start = text ? currentMarkdownRef.current.indexOf(text) : -1
    onSelectionChangeRef.current?.({
      start: start >= 0 ? start : 0,
      end: start >= 0 ? start + text.length : text.length,
      text,
    })
  }

  return (
    <div
      ref={streamingScroll.ref}
      className={`plan-rich-markdown min-h-0 flex-1 ${mobile ? 'min-h-[60vh]' : 'overflow-y-auto'}`}
      onMouseUp={emitVisualSelection}
      onKeyUp={emitVisualSelection}
      onScroll={() => { streamingScroll.onScroll(); if (editorRef.current) savePlanPosition(positionKey, rootRef.current) }}
      data-mobile={mobile ? 'true' : 'false'}
    />
  )
}

/** Equivalent serialized markdown must not replace the document and map the cursor. */
function synchronizeMarkdown(editor: CrepeBuilder, markdown: string): ProseNode | null {
  return editor.editor.action(ctx => {
    const view = ctx.get(editorViewCtx)
    const next = ctx.get(parserCtx)(markdown)
    if (!next) return null
    if (view.state.doc.eq(next)) return view.state.doc
    // A server update is not a user edit. In particular, serializing Markdown
    // can normalize lists; publishing that serialization would race the next
    // Agent append and could restore an older, shorter document.
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, next.content).setMeta('addToHistory', false))
    // ProseMirror has now applied trailing-plugin transactions too.
    return view.state.doc
  })
}
