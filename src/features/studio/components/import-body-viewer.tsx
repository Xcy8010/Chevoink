import { useState } from 'react'
import { IMPORT_BODY_WINDOW, importRawCursor } from '../lib/import-body'

function safeBoundary(content: string, offset: number) {
  return offset > 0 && /[\uD800-\uDBFF]/.test(content[offset - 1]) && /[\uDC00-\uDFFF]/.test(content[offset] ?? '') ? offset - 1 : offset
}

/** Bounded DOM rendering. Source text stays untouched; this is not a network pagination claim. */
export function ImportBodyViewer({ content, onCursor }: { content: string; onCursor?: (offset: number) => void }) {
  const [windowState, setWindow] = useState({ content, start: 0 })
  const [jump, setJump] = useState('0')
  const start = windowState.content === content ? windowState.start : 0
  const end = safeBoundary(content, Math.min(content.length, start + IMPORT_BODY_WINDOW))
  const text = content.slice(start, end)
  const move = (offset: number) => {
    setWindow({ content, start: safeBoundary(content, Math.max(0, Math.min(offset, content.length - 1))) })
  }
  const remember = (element: HTMLTextAreaElement) => onCursor?.(start + importRawCursor(text, element.selectionStart))
  const jumpNumber = Number(jump)
  const canJump = jump.trim() !== '' && Number.isInteger(jumpNumber) && jumpNumber >= 0 && jumpNumber <= content.length
  return <div className="min-w-0 space-y-2">
    {content.length > IMPORT_BODY_WINDOW && <div className="space-y-2 text-xs">
      <p>长正文分段显示：当前字符 {start + 1}–{end} / {content.length}。未显示内容仍保留，拆分位置按完整原文计算。</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="rounded border px-3 disabled:opacity-40" disabled={start === 0} onClick={() => move(Math.max(0, start - IMPORT_BODY_WINDOW))}>上一段原文</button>
        <button type="button" className="rounded border px-3 disabled:opacity-40" disabled={end >= content.length} onClick={() => move(end)}>下一段原文</button>
        <label className="flex min-w-0 items-center gap-2">跳转字符位置<input className="w-28 min-w-0 rounded border bg-[var(--surface-default)] px-2" type="number" min={0} max={content.length} value={jump} onChange={event => setJump(event.target.value)} /></label>
        <button type="button" className="rounded border px-3 disabled:opacity-40" disabled={!canJump} onClick={() => {
          const offset = safeBoundary(content, jumpNumber)
          const nextStart = Math.max(0, offset - Math.floor(IMPORT_BODY_WINDOW / 2))
          move(nextStart)
          onCursor?.(offset)
        }}>定位拆分光标</button>
      </div>
      <p>位置从 0 开始；定位按钮可直接指定拆分边界，也可在当前段内点击原文选择。</p>
    </div>}
    <label className="block text-sm">原文正文（只读）<textarea aria-label="原文正文" readOnly value={text} onSelect={event => remember(event.currentTarget)} onClick={event => remember(event.currentTarget)} onKeyUp={event => remember(event.currentTarget)} onFocus={event => remember(event.currentTarget)} className="mt-1 h-64 w-full min-w-0 resize-y whitespace-pre-wrap rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] p-3 text-sm leading-7" /></label>
  </div>
}
