import { useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { NovelImportPreview } from '../../../../shared/contracts/novel-import.js'
import { importChapterMergeIssue, importPreviewCounts, mergeImportChapters, moveImportChapter, reorderImportItem, splitImportChapter } from '../lib/import-preview'
import { NOVEL_IMPORT_LIMITS } from '../../../../shared/contracts/novel-import.js'
import { ImportBodyViewer } from './import-body-viewer'

const inputClass = 'w-full min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 text-sm'
const actionClass = 'rounded-lg border border-[var(--border-subtle)] px-3 text-sm disabled:opacity-40'

export function ImportPreviewEditor({ preview, onChange, disabled, currentMetadata }: {
  preview: NovelImportPreview
  onChange: (preview: NovelImportPreview) => void
  disabled: boolean
  currentMetadata: { title: string; summary?: string; tags?: string[] }
}) {
  const [volumeIndex, setVolumeIndex] = useState(0)
  const [chapterIndex, setChapterIndex] = useState(0)
  const [page, setPage] = useState(0)
  const [mobileTab, setMobileTab] = useState<'tree' | 'body'>('tree')
  const [splitCursor, setSplitCursor] = useState<{ chapter: NovelImportPreview['volumes'][number]['chapters'][number]; offset: number } | null>(null)
  const volumes = preview.volumes
  const volume = volumes[volumeIndex] ?? volumes[0]
  const chapter = volume?.chapters[chapterIndex]
  const mergeIssue = importChapterMergeIssue(volumes, volumeIndex, chapterIndex)
  const counts = importPreviewCounts(volumes)
  const updateVolumes = (next: typeof volumes) => onChange({ ...preview, volumes: next })
  const pageSize = 30
  return <div className="space-y-4">
    <p className="text-sm">待导入 {volumes.length} 卷 {counts.chapters} 章 · {counts.characters.toLocaleString()} 字符。正文必须来自原文件，不使用 AI 补写。</p>
    <fieldset disabled={disabled} className="min-w-0 space-y-3 rounded-xl border border-[var(--border-subtle)] p-3">
      <legend className="px-1 text-sm font-medium">可选作品信息（默认保留当前值）</legend>
      {(['title', 'summary', 'tags'] as const).map(key => {
        const value = preview.metadata[key]
        const hasValue = Array.isArray(value) ? value.length > 0 : !!value?.trim()
        const label = { title: '书名', summary: '简介', tags: '标签' }[key]
        return <label key={key} className="flex min-h-11 items-start gap-3 text-sm">
          <input type="checkbox" className="mt-3 h-5 w-5 shrink-0" disabled={!hasValue} checked={Object.prototype.hasOwnProperty.call(preview.metadataSelection, key)} onChange={event => {
            const selection = { ...preview.metadataSelection }
            if (event.target.checked) Object.assign(selection, { [key]: value })
            else delete selection[key]
            onChange({ ...preview, metadataSelection: selection })
          }} />
          <span className="min-w-0 break-words">应用识别{label}<span className="block whitespace-pre-wrap text-xs text-[var(--text-secondary)]">{String(currentMetadata[key] || '未设置')} → {hasValue ? String(value) : '未识别（不更改）'}</span></span>
        </label>
      })}
      <p className="text-xs text-[var(--text-secondary)]">封面不更改。当前解析接口未提供封面候选及元数据来源定位。</p>
    </fieldset>
    {preview.warnings.length > 0 && <section aria-label="识别警告" className="space-y-2 rounded-xl bg-[var(--surface-muted)] p-3">
      {preview.warnings.map((warning, i) => <p key={`${warning.code}:${i}`} className="break-words text-sm">{warning.blocking ? '阻断：' : '注意：'}{warning.message}</p>)}
    </section>}
    <div className="flex gap-2 sm:hidden">{(['tree', 'body'] as const).map(tab => <button key={tab} type="button" className={actionClass} aria-pressed={mobileTab === tab} onClick={() => setMobileTab(tab)}>{tab === 'tree' ? '卷章目录' : '原文预览'}</button>)}</div>
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      <fieldset disabled={disabled} className={`${mobileTab !== 'tree' ? 'hidden sm:block' : ''} min-w-0 space-y-3`}>
        <label className="block text-sm">选择卷<select className={inputClass} value={volumeIndex} onChange={event => { setVolumeIndex(Number(event.target.value)); setChapterIndex(0); setPage(0) }}>{volumes.map((item, i) => <option key={i} value={i}>{i + 1}. {item.title}</option>)}</select></label>
        {volume && <>
          <label className="block text-sm">卷名<input className={inputClass} value={volume.title} maxLength={128} onChange={event => updateVolumes(volumes.map((item, i) => i === volumeIndex ? { ...item, title: event.target.value } : item))} /></label>
          <div className="flex gap-2"><button type="button" className={actionClass} disabled={volumeIndex <= 0} onClick={() => { updateVolumes(reorderImportItem(volumes, volumeIndex, -1)); setVolumeIndex(volumeIndex - 1) }}>卷上移</button><button type="button" className={actionClass} disabled={volumeIndex >= volumes.length - 1} onClick={() => { updateVolumes(reorderImportItem(volumes, volumeIndex, 1)); setVolumeIndex(volumeIndex + 1) }}>卷下移</button></div>
          <div className="max-h-64 space-y-1 overflow-y-auto" aria-label="章节目录">{volume.chapters.slice(page * pageSize, (page + 1) * pageSize).map((item, localIndex) => {
            const index = page * pageSize + localIndex
            return <button type="button" key={index} aria-pressed={chapterIndex === index} className="block w-full break-words rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-left text-sm aria-pressed:bg-[var(--surface-muted)]" onClick={() => { setChapterIndex(index); setMobileTab('body') }}>{index + 1}. {item.title} · {item.content.length} 字符</button>
          })}</div>
          {volume.chapters.length > pageSize && <div className="flex items-center gap-2"><button type="button" className={actionClass} disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span className="text-xs">{page + 1} / {Math.ceil(volume.chapters.length / pageSize)}</span><button type="button" className={actionClass} disabled={(page + 1) * pageSize >= volume.chapters.length} onClick={() => setPage(page + 1)}>下一页</button></div>}
        </>}
      </fieldset>
      <fieldset disabled={disabled} className={`${mobileTab !== 'body' ? 'hidden sm:block' : ''} min-w-0 space-y-3`}>
        {chapter ? <>
          <label className="block text-sm">章名<input className={inputClass} value={chapter.title} maxLength={128} onChange={event => updateVolumes(volumes.map((item, i) => i === volumeIndex ? { ...item, chapters: item.chapters.map((c, j) => j === chapterIndex ? { ...c, title: event.target.value } : c) } : item))} /></label>
          <div className="flex gap-2">{([-1, 1] as const).map(direction => <button type="button" key={direction} className={actionClass} aria-label={direction === -1 ? '章上移' : '章下移'} disabled={chapterIndex + direction < 0 || chapterIndex + direction >= volume.chapters.length} onClick={() => { updateVolumes(volumes.map((item, i) => i === volumeIndex ? { ...item, chapters: reorderImportItem(item.chapters, chapterIndex, direction) } : item)); setChapterIndex(chapterIndex + direction) }}>{direction === -1 ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}</button>)}</div>
          <label className="block text-sm">归属卷<select className={inputClass} value={volumeIndex} onChange={event => { const target = Number(event.target.value); const index = volumes[target].chapters.length; updateVolumes(moveImportChapter(volumes, volumeIndex, chapterIndex, target)); setVolumeIndex(target); setChapterIndex(index); setPage(Math.floor(index / pageSize)) }}>{volumes.map((item, i) => <option key={i} value={i}>{item.title}</option>)}</select></label>
          <p className="break-words text-xs text-[var(--text-secondary)]">来源：{chapter.source.memberPath ?? chapter.source.filename ?? '上传文件'}{chapter.source.page ? ` · 第 ${chapter.source.page} 页` : ''}</p>
          <ImportBodyViewer key={`${volumeIndex}:${chapterIndex}`} content={chapter.content} onCursor={offset => setSplitCursor({ chapter, offset })} />
          {chapter.content.length > NOVEL_IMPORT_LIMITS.chapterCharacters && <p role="alert" className="text-sm">本章 {chapter.content.length} 字符，超过单章 {NOVEL_IMPORT_LIMITS.chapterCharacters} 字符限制。请定位原文光标并拆分，正文末尾不会截断。</p>}
          <button type="button" className={actionClass} disabled={splitCursor?.chapter !== chapter || splitCursor.offset <= 0 || splitCursor.offset >= chapter.content.length || counts.chapters >= NOVEL_IMPORT_LIMITS.chapters} onClick={event => {
            if (event.detail > 1 || splitCursor?.chapter !== chapter) return
            const next = splitImportChapter(volumes, volumeIndex, chapterIndex, splitCursor.offset)
            if (next !== volumes) { updateVolumes(next); setSplitCursor(null) }
          }}>在光标处拆分为两章</button>
          <p className="text-xs text-[var(--text-secondary)]">在原文中点击或移动光标，再拆分。两章沿用同一来源，所有字符和末尾内容原样保留。</p>
          <button type="button" className={actionClass} disabled={!!mergeIssue} onClick={event => {
            if (event.detail > 1) return
            const result = mergeImportChapters(volumes, volumeIndex, chapterIndex)
            if (!result.error) { updateVolumes(result.volumes); setSplitCursor(null) }
          }}>与下一章合并（同来源）</button>
          <p className="text-xs text-[var(--text-secondary)]">合并分隔符：空字符串（不额外插入换行）。保留当前章名，下一章标题不拼入正文；两章正文按顺序逐字符连接，空行和末尾内容全部保留。合并后需保存预览调整。</p>
          {mergeIssue && <p role="status" className="text-xs text-[var(--text-secondary)]">{mergeIssue}</p>}
        </> : <p className="text-sm">此卷没有章节。至少需要一章非空原文正文。</p>}
      </fieldset>
    </div>
    <p className="text-xs text-[var(--text-secondary)]">当前版本支持改名、排序、归卷、光标拆分及同来源相邻章合并；跨来源合并、逐页图片对照尚不可用。</p>
  </div>
}
