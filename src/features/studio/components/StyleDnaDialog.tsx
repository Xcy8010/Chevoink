import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Fingerprint, LoaderCircle, Upload, X } from 'lucide-react'

import type { AuthorStyleProfileView, StudioPayload, StyleSampleRequest } from '../../../../shared/contracts/index.js'
import { STYLE_SAMPLE_UPLOAD_MAX_BYTES, STYLE_SAMPLE_UPLOAD_MAX_CHARS } from '../../../../shared/contracts/index.js'

type UploadedSample = NonNullable<StyleSampleRequest['uploadedFile']>

export default function StyleDnaDialog({ chapters, profile, busy, onClose, onSubmit, error }: {
  chapters: StudioPayload['chapters']
  profile: AuthorStyleProfileView | null
  busy: boolean
  error?: string
  onClose: () => void
  onSubmit: (input: StyleSampleRequest) => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [title, setTitle] = useState(profile?.name ?? '我的写作样章')
  const [selectedChapterIds, setSelectedChapterIds] = useState<string[]>([])
  const [uploadedFile, setUploadedFile] = useState<UploadedSample | undefined>()
  const [consent, setConsent] = useState(false)
  const [fileError, setFileError] = useState('')
  useEffect(() => {
    const node = dialogRef.current
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    node?.showModal()
    return () => { node?.close(); document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }) }
  }, [])

  if (typeof document === 'undefined') return null

  const chooseFile = async (file: File | undefined) => {
    if (!file) return
    setFileError('')
    if (!/\.(?:txt|md|markdown)$/i.test(file.name)) {
      setFileError('仅支持 TXT、MD 或 Markdown 文本文件。')
      return
    }
    if (file.size > STYLE_SAMPLE_UPLOAD_MAX_BYTES) {
      setFileError('文件不能超过 512 KB。')
      return
    }
    let content: string
    try { content = (await file.text()).trim() } catch { setFileError('文件读取失败，请重新选择文件。'); return }
    if (content.length < 200) {
      setFileError('样章文件至少需要 200 个有效字符。')
      return
    }
    if (content.length > STYLE_SAMPLE_UPLOAD_MAX_CHARS) {
      setFileError('样章文件有效文本不能超过 12 万字符。')
      return
    }
    setUploadedFile({ name: file.name, size: file.size, content })
  }

  const valid = Boolean(title.trim() && (selectedChapterIds.length > 0 || uploadedFile) && consent && !fileError)
  return createPortal(
    <dialog ref={dialogRef} data-native-back-dismiss onCancel={event => { event.preventDefault(); if (!busy) onClose() }} className="studio-workspace m-auto h-[94dvh] max-h-[94dvh] w-[min(760px,96vw)] overflow-hidden rounded-2xl border-0 bg-transparent p-0 text-[var(--text-primary)] backdrop:bg-black/45 md:h-auto" aria-label="添加写作样章">
      <section className="flex h-full w-full flex-col bg-[var(--surface-default)] md:h-auto md:max-h-[86vh] md:w-[min(760px,calc(100vw-48px))] md:rounded-[14px] md:border md:border-[var(--border-default)]">
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3 md:px-5">
          <Fingerprint className="h-4 w-4 text-[var(--text-secondary)]" />
          <div><h2 className="text-sm font-semibold text-[var(--text-primary)]">添加写作样章</h2><p className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">保存后可查看原文，再选择模型开始学习；保存本身不调用模型。</p></div>
          <button type="button" onClick={onClose} className="ml-auto flex h-9 w-9 items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)]" aria-label="关闭"><X className="h-4 w-4" /></button>
        </header>
        <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 md:p-5">
          {error ? <p role="alert" className="text-sm text-[var(--color-error)]">{error}</p> : null}
          {profile ? <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-b border-[var(--border-subtle)] pb-4 text-[10px] text-[var(--text-secondary)] sm:grid-cols-4">
            <span>对白 {Math.round(profile.stats.dialogueRatio * 100)}%</span><span>句中位 {profile.stats.medianSentenceChars} 字</span><span>段中位 {profile.stats.medianParagraphChars} 字</span><span>修辞 {Math.round(profile.stats.imageryDensity * 100)}%</span>
          </div> : null}
          <label className="mt-4 block text-xs text-[var(--text-secondary)]">画像名称<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} className="mt-1 h-10 w-full border-b border-[var(--border-strong)] bg-transparent px-0 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-primary)]" /></label>
          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <section>
              <h3 className="text-xs font-medium text-[var(--text-primary)]">从当前作品选择</h3>
              <p className="mt-1 text-[10px] text-[var(--text-tertiary)]">最多 12 章，可与上传样章同时使用。</p>
              <div className="scrollbar-none mt-3 max-h-60 overflow-y-auto overscroll-contain border-y border-[var(--border-subtle)] py-1">
                {chapters.length === 0 ? <p className="py-6 text-center text-[10px] text-[var(--text-tertiary)]">当前作品还没有可选章节。</p> : chapters.map((chapter) => {
                  const checked = selectedChapterIds.includes(chapter.id)
                  return <label key={chapter.id} className="flex cursor-pointer items-center gap-2 px-1 py-2 text-[11px] hover:bg-[var(--surface-muted)]">
                    <input type="checkbox" checked={checked} disabled={!checked && selectedChapterIds.length >= 12} onChange={() => setSelectedChapterIds((ids) => checked ? ids.filter((id) => id !== chapter.id) : [...ids, chapter.id])} />
                    <span className="min-w-0 truncate">第 {chapter.orderIndex} 章 · {chapter.title}</span>
                  </label>
                })}
              </div>
            </section>
            <section className="md:border-l md:border-[var(--border-subtle)] md:pl-5">
              <h3 className="text-xs font-medium text-[var(--text-primary)]">上传自有样章</h3>
              <p className="mt-1 text-[10px] leading-5 text-[var(--text-tertiary)]">TXT、MD、Markdown；单文件最大 512 KB，最多读取 12 万字符。</p>
              <input ref={inputRef} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" className="hidden" onChange={(event) => void chooseFile(event.target.files?.[0])} />
              {uploadedFile ? <div className="mt-3 flex items-center gap-2 border-y border-[var(--border-subtle)] py-3 text-xs"><FileText className="h-4 w-4 text-[var(--text-tertiary)]" /><span className="min-w-0 flex-1 truncate">{uploadedFile.name}</span><span className="text-[10px] text-[var(--text-tertiary)]">{Math.ceil(uploadedFile.size / 1024)} KB</span><button type="button" onClick={() => setUploadedFile(undefined)} aria-label="移除文件"><X className="h-3.5 w-3.5" /></button></div> : <button type="button" onClick={() => inputRef.current?.click()} className="mt-3 inline-flex h-9 items-center gap-2 border border-[var(--border-strong)] px-3 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><Upload className="h-3.5 w-3.5" />选择文件</button>}
              {fileError ? <p className="mt-2 text-[10px] text-[var(--color-error)]">{fileError}</p> : null}
            </section>
          </div>
          <label className="mt-5 flex items-start gap-2 border-t border-[var(--border-subtle)] pt-4 text-[10px] leading-5 text-[var(--text-secondary)]"><input className="mt-1" type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>我确认所选章节和上传文件由我拥有，并同意仅在当前作品内生成 Style DNA；不会进入公共文笔库或跨作者召回。</span></label>
        </div>
        <footer className="flex shrink-0 justify-end gap-3 border-t border-[var(--border-subtle)] px-4 py-3 md:px-5">
          <button type="button" onClick={onClose} className="h-9 px-3 text-xs text-[var(--text-secondary)]">取消</button>
          <button type="button" disabled={!valid || busy} onClick={() => onSubmit({ title: title.trim(), chapterIds: selectedChapterIds, uploadedFile, consent: true })} className="inline-flex h-9 items-center bg-[var(--surface-contrast)] px-4 text-xs text-[var(--text-contrast)] disabled:opacity-40">{busy ? <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}保存样章</button>
        </footer>
      </section>
    </dialog>,
    document.body,
  )
}
