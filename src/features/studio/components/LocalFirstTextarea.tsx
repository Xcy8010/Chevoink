import { forwardRef, useCallback, useEffect, useRef, useState, type ChangeEvent, type CompositionEvent, type FocusEvent, type SyntheticEvent, type TextareaHTMLAttributes } from 'react'

import { cn } from '@/lib/utils'
import { useLayoutEffect } from 'react'
import { isWindowsDesktopApp } from '@/lib/desktop-app'
import { registerDesktopSave } from '@/lib/desktop-lifecycle'

import type { EditorSelectionState } from '../types'

type LocalFirstTextareaProps = {
  /** 外部权威值：Agent 写入、审查保留/撤销、服务端同步都会更新它 */
  value: string
  /** 输入停顿后一次性上报的最新内容；自动保存链路沿用原 onChange 语义 */
  onCommit: (value: string) => void
  /** 章节/文档标识：变化时强制用外部 value 重置本地（切章、切计划） */
  resetKey?: string
  onSelectionChange?: (selection: EditorSelectionState) => void
  /** 影子层自增高布局（沉浸区正文），排版类名请放在 className 上 */
  autoGrow?: boolean
  wrapperClassName?: string
  /** 输入停止后多久上报一次全局状态 */
  commitDelay?: number
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'onSelect' | 'onClick' | 'onKeyUp' | 'defaultValue'>

const DEFAULT_COMMIT_DELAY = 160
const SELECTION_REPORT_DELAY = 140

/**
 * 击键只重渲染本组件的 textarea：输入先落在本地 state，停顿后一次性上报全局。
 *
 * 之前每次击键都会同步写全局 chapterDraft / editorSelection，StudioWorkspace 整树
 * 每个字重渲染两三遍，表现为「打一个字界面断一下」。本组件把高频输入隔离在子树内：
 * - IME 组合期间不上报，避免候选词变化打断中文输入；
 * - 失焦/卸载立即上报，blur 保存链路拿到最新内容；
 * - 外部 value 变化（非本地上报回声）时覆盖本地：Agent 写入、审查 hunks、切章同步都走这里；
 * - 光标折叠态的选区不上报（打字不触发全局渲染），仅选中/取消选中文字时上报一次。
 */
const LocalFirstTextarea = forwardRef<HTMLTextAreaElement, LocalFirstTextareaProps>(function LocalFirstTextarea(
  {
    value,
    onCommit,
    resetKey,
    onSelectionChange,
    autoGrow = false,
    wrapperClassName,
    commitDelay = DEFAULT_COMMIT_DELAY,
    readOnly,
    className,
    onBlur,
    onScroll,
    ...textareaProps
  },
  forwardedRef,
) {
  const [local, setLocal] = useState(value)
  const localRef = useRef(value)
  const committedRef = useRef(value)
  const commitTimerRef = useRef<number | null>(null)
  const selectionTimerRef = useRef<number | null>(null)
  const composingRef = useRef(false)
  const documentKeyRef = useRef(resetKey)
  const currentKeyRef = useRef(resetKey)
  currentKeyRef.current = resetKey
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const authorCommitRef = useRef<{ key: string | undefined; commit: (value: string) => void } | null>(null)
  const lastSelectionCollapsedRef = useRef<boolean | null>(null)
  const onCommitRef = useRef(onCommit)
  const onSelectionChangeRef = useRef(onSelectionChange)
  onCommitRef.current = onCommit
  onSelectionChangeRef.current = onSelectionChange

  const clearCommitTimer = useCallback(() => {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current)
      commitTimerRef.current = null
    }
  }, [])

  const flushPending = useCallback(() => {
    clearCommitTimer()
    if (localRef.current !== committedRef.current) {
      const author = authorCommitRef.current
      if (author && author.key !== currentKeyRef.current) return
      committedRef.current = localRef.current
      const commit = readOnlyRef.current ? author?.commit ?? onCommitRef.current : onCommitRef.current
      commit(localRef.current)
    }
  }, [clearCommitTimer])

  const scheduleCommit = useCallback(
    (delay = commitDelay) => {
      clearCommitTimer()
      commitTimerRef.current = window.setTimeout(() => {
        commitTimerRef.current = null
        flushPending()
      }, delay)
    },
    [clearCommitTimer, commitDelay, flushPending],
  )

  useEffect(() => {
    if (!isWindowsDesktopApp()) return
    const flush = () => { if (!composingRef.current) flushPending() }
    window.addEventListener('chevoink:desktop-flush-input', flush)
    const unregister = registerDesktopSave(() => !composingRef.current && localRef.current === committedRef.current)
    return () => { window.removeEventListener('chevoink:desktop-flush-input', flush); unregister() }
  }, [flushPending])

  // 外部权威值变化（Agent 写入、审查保留/撤销、服务端同步、切章）时覆盖本地。
  // 本地上报后的回声（value === committedRef）不会触发覆盖，光标与滚动保持稳定。
  useLayoutEffect(() => {
    if (documentKeyRef.current !== resetKey || composingRef.current) return
    if (value === committedRef.current && !readOnly) return
    // Preserve a pending author edit before an Agent lock supersedes the displayed buffer.
    if (readOnly && !composingRef.current) flushPending()
    clearCommitTimer()
    committedRef.current = value
    localRef.current = value
    setLocal(value)
  }, [clearCommitTimer, flushPending, readOnly, resetKey, value])

  // resetKey（章节/文档 id）变化时强制重置，即使两份内容恰好相同。
  useLayoutEffect(() => {
    documentKeyRef.current = resetKey
    authorCommitRef.current = null
    composingRef.current = false
    clearCommitTimer()
    committedRef.current = value
    localRef.current = value
    setLocal(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  // 卸载时上报最后一批输入并清掉定时器，防止切视图丢字。
  useEffect(
    () => () => {
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current)
      if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current)
      if (!composingRef.current && localRef.current !== committedRef.current) {
        const author = authorCommitRef.current
        if (!author || author.key === currentKeyRef.current) {
          const commit = readOnlyRef.current ? author?.commit ?? onCommitRef.current : onCommitRef.current
          commit(localRef.current)
        }
      }
    },
    [],
  )

  const reportSelection = useCallback((target: HTMLTextAreaElement) => {
    const start = target.selectionStart ?? 0
    const end = target.selectionEnd ?? start
    const collapsed = start === end
    // 连续打字（折叠态 → 折叠态）不上报，避免每个按键都引发全局重渲染；
    // 选中文字或从选中回到折叠时上报一次，驱动「添加到输入框」按钮状态。
    if (collapsed && lastSelectionCollapsedRef.current !== false) return
    lastSelectionCollapsedRef.current = collapsed
    onSelectionChangeRef.current?.({ start, end, text: target.value.slice(start, end) })
  }, [])

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    authorCommitRef.current = { key: resetKey, commit: onCommitRef.current }
    const next = event.currentTarget.value
    setLocal(next)
    localRef.current = next
    if (!composingRef.current) scheduleCommit()
  }

  const handleCompositionStart = () => {
    clearCommitTimer()
    authorCommitRef.current = { key: resetKey, commit: onCommitRef.current }
    composingRef.current = true
  }

  const handleCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false
    if (authorCommitRef.current?.key !== resetKey) return
    const next = readOnly ? localRef.current : event.currentTarget.value
    setLocal(next)
    localRef.current = next
    // 组合结束后尽快上报，缩短自动保存的追平窗口。
    scheduleCommit(40)
  }

  const handleSelect = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget
    if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current)
    selectionTimerRef.current = window.setTimeout(() => {
      selectionTimerRef.current = null
      reportSelection(target)
    }, SELECTION_REPORT_DELAY)
  }

  const handleBlur = (event: FocusEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget
    if (selectionTimerRef.current !== null) {
      window.clearTimeout(selectionTimerRef.current)
      selectionTimerRef.current = null
    }
    // 失焦先同步上报选区与内容，再交给外部的失焦保存逻辑。
    lastSelectionCollapsedRef.current = target.selectionStart === target.selectionEnd
    onSelectionChangeRef.current?.({
      start: target.selectionStart ?? 0,
      end: target.selectionEnd ?? 0,
      text: target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0),
    })
    flushPending()
    onBlur?.(event)
  }

  const displayValue = readOnly ? value : local
  const textarea = (
    <textarea
      {...textareaProps}
      ref={forwardedRef}
      value={displayValue}
      readOnly={readOnly}
      onChange={handleChange}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onSelect={handleSelect}
      onClick={handleSelect}
      onKeyUp={handleSelect}
      onBlur={handleBlur}
      onScroll={onScroll}
      className={cn(autoGrow && 'min-w-0 resize-none overflow-hidden [grid-area:1/1]', className)}
    />
  )

  if (!autoGrow) {
    return textarea
  }

  return (
    <div className={cn('grid shrink-0', wrapperClassName)}>
      <div aria-hidden className={cn('invisible min-w-0 whitespace-pre-wrap break-words [grid-area:1/1]', className)}>
        {`${displayValue}\n`}
      </div>
      {textarea}
    </div>
  )
})

export default LocalFirstTextarea

