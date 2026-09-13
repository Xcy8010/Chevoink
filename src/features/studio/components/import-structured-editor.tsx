import { useEffect, useRef, useState } from 'react'
import type { NovelImportChapterDto, NovelImportPreviewSummary, NovelImportReportDto } from '../../../../shared/contracts/novel-import-preview.js'
import { importPreviewApi, type ImportStructureEdit } from '../import-preview-api'
import { importSegmentLength, sameImportSegmentSource, splitImportSegments, type ImportSegments } from '../lib/import-structure'
import { reorderImportItem } from '../lib/import-preview'
import { ImportBodyViewer } from './import-body-viewer'
import { ImportAiSuggestions } from './import-ai-suggestions'
import { ImportCoverPicker } from './import-cover-picker'

const button = 'min-h-11 min-w-11 rounded-lg border border-[var(--border-subtle)] px-3 text-sm disabled:opacity-40'
const input = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 text-sm'
export function ImportStructuredEditor({ novelId, jobId, summary, report, draft, disabled, dirty, aiEnabled, currentMetadata, onChange, client = importPreviewApi }: {
  novelId: string; jobId: string; summary: NovelImportPreviewSummary; draft: ImportStructureEdit; disabled: boolean; dirty: boolean; aiEnabled: boolean
  currentMetadata: { title: string; summary?: string; tags?: string[] }; onChange: (next: ImportStructureEdit) => void; client?: typeof importPreviewApi
  report?: NovelImportReportDto
}) {
  const [volumeIndex, setVolume] = useState(0), [chapterIndex, setChapter] = useState(0), [page, setPage] = useState(0)
  const [tab, setTab] = useState<'tree' | 'body'>('tree')
  const [loaded, setLoaded] = useState<{ segments: ImportSegments; content: string } | null>(null)
  const [error, setError] = useState('')
  const [cursor, setCursor] = useState<{ segments: ImportSegments; offset: number } | null>(null)
  const cache = useRef(new Map<string, NovelImportChapterDto>())
  const volumes = draft.volumes, volume = volumes[volumeIndex], chapter = volume?.chapters[chapterIndex]
  const segments = chapter?.segments
  const body = loaded?.segments === segments ? loaded?.content : undefined
  const count = volumes.reduce((n, item) => n + item.chapters.length, 0)
  useEffect(() => {
    if (!segments) return
    let alive = true
    setError('')
    void (async () => {
      const parts: string[] = []
      for (const segment of segments) {
        const key = `${summary.manifestRevision}:${segment.volumeIndex}:${segment.chapterIndex}`
        let source = cache.current.get(key)
        if (!source) {
          source = await client.chapter(novelId, jobId, summary.manifestRevision, segment.volumeIndex, segment.chapterIndex)
          if (!alive) return
          const expected = summary.volumes[segment.volumeIndex]?.chapters[segment.chapterIndex]
          if (!expected || source.manifestRevision !== summary.manifestRevision || source.manifestHash !== summary.manifestHash || source.volumeIndex !== segment.volumeIndex || source.chapterIndex !== segment.chapterIndex || source.contentHash !== expected.contentHash || source.content.length !== expected.characters) throw new Error('正文与当前预览版本不匹配，请查询任务并刷新预览。')
          // Bound retained full bodies; switching around a book must not cache the entire manuscript.
          if (cache.current.size >= 3) cache.current.delete(cache.current.keys().next().value!)
          cache.current.set(key, source)
        }
        if (segment.start < 0 || segment.end > source.content.length || segment.end < segment.start) throw new Error('正文引用范围异常，已停止。')
        parts.push(source.content.slice(segment.start, segment.end))
      }
      if (alive) setLoaded({ segments, content: parts.join('') })
    })().catch(failure => { if (alive) setError(failure instanceof Error ? failure.message : '正文加载失败，请重新选择章节。') })
    return () => { alive = false }
  }, [client, jobId, novelId, segments, summary])
  const changeVolumes = (next: typeof volumes) => onChange({ ...draft, volumes: next })
  const replaceChapter = (chapters: typeof volume.chapters) => changeVolumes(volumes.map((item, index) => index === volumeIndex ? { ...item, chapters } : item))
  const nextChapter = volume?.chapters[chapterIndex + 1]
  const mergeError = !chapter || !nextChapter ? '仅支持同卷相邻章节。'
    : !sameImportSegmentSource(summary, [...chapter.segments, ...nextChapter.segments]) ? '来源不同或不完整，跨来源合并已禁用。'
      : importSegmentLength(chapter.segments) + importSegmentLength(nextChapter.segments) > 100000 ? '合并后超过 100,000 字符，请先拆分相邻章节；不会截断正文。' : null
  return <section className="min-w-0 space-y-4" aria-label="按需卷章预览">
    <p className="text-sm">{volumes.length} 卷 {count} 章。目录不含整书正文；选择章节时读取原文。保存仅提交版本绑定的字符范围引用，不会把未加载正文写为空。</p>
    <fieldset disabled={disabled} className="space-y-2 rounded-lg border p-3"><legend>可选作品信息（默认保持不变）</legend>{(['title', 'summary', 'tags'] as const).map(key => {
      const value = summary.metadata[key], label = { title: '书名', summary: '简介', tags: '标签' }[key]
      return <label key={key} className="flex min-h-11 min-w-0 items-start gap-2 text-sm"><input type="checkbox" className="mt-3 h-5 w-5" disabled={!value || !value.length} checked={Object.prototype.hasOwnProperty.call(draft.metadataSelection ?? {}, key)} onChange={event => { const selection = { ...draft.metadataSelection }; if (event.target.checked) Object.assign(selection, { [key]: value }); else delete selection[key]; onChange({ ...draft, metadataSelection: selection }) }} /><span className="min-w-0 break-words">应用识别{label}<span className="block whitespace-pre-wrap text-xs">{String(currentMetadata[key] || '未设置')} → {String(value || '未识别，不更改')}</span></span></label>
    })}</fieldset>
    <ImportCoverPicker novelId={novelId} jobId={jobId} summary={summary} report={report} selectedId={draft.metadataSelection?.coverArtifactId} disabled={disabled} onSelect={id => {
      const selection = { ...draft.metadataSelection }
      if (id) selection.coverArtifactId = id
      else delete selection.coverArtifactId
      onChange({ ...draft, metadataSelection: selection })
    }} />
    <div className="flex gap-2 sm:hidden"><button type="button" className={button} aria-pressed={tab === 'tree'} onClick={() => setTab('tree')}>卷章目录</button><button type="button" className={button} aria-pressed={tab === 'body'} onClick={() => setTab('body')}>原文预览</button></div>
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      <fieldset className={`min-w-0 space-y-3 ${tab !== 'tree' ? 'hidden sm:block' : ''}`}>
        <label className="block text-sm">选择卷<select className={input} value={volumeIndex} onChange={event => { setVolume(Number(event.target.value)); setChapter(0); setPage(0) }}>{volumes.map((item, index) => <option key={index} value={index}>{index + 1}. {item.title}</option>)}</select></label>
        {volume && <><label className="block text-sm">卷名<input disabled={disabled} className={input} maxLength={128} value={volume.title} onChange={event => changeVolumes(volumes.map((item, index) => index === volumeIndex ? { ...item, title: event.target.value } : item))} /></label><div className="flex gap-2">{([-1, 1] as const).map(direction => <button key={direction} type="button" className={button} disabled={disabled || volumeIndex + direction < 0 || volumeIndex + direction >= volumes.length} onClick={() => { changeVolumes(reorderImportItem(volumes, volumeIndex, direction)); setVolume(volumeIndex + direction) }}>{direction < 0 ? '卷上移' : '卷下移'}</button>)}</div><div aria-label="章节目录" className="max-h-72 space-y-1 overflow-y-auto">{volume.chapters.slice(page * 30, page * 30 + 30).map((item, index) => <button key={page * 30 + index} type="button" className={`${button} block w-full break-words text-left aria-pressed:bg-[var(--surface-muted)]`} aria-pressed={chapterIndex === page * 30 + index} onClick={() => { setChapter(page * 30 + index); setTab('body') }}>{page * 30 + index + 1}. {item.title} · {importSegmentLength(item.segments)} 字符</button>)}</div>{volume.chapters.length > 30 && <div className="flex items-center gap-2"><button type="button" className={button} disabled={!page} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1}/{Math.ceil(volume.chapters.length / 30)}</span><button type="button" className={button} disabled={(page + 1) * 30 >= volume.chapters.length} onClick={() => setPage(page + 1)}>下一页</button></div>}</>}
      </fieldset>
      <fieldset className={`min-w-0 space-y-3 ${tab !== 'body' ? 'hidden sm:block' : ''}`}>
        {chapter ? <><label className="block text-sm">章名<input disabled={disabled} className={input} maxLength={128} value={chapter.title} onChange={event => replaceChapter(volume.chapters.map((item, index) => index === chapterIndex ? { ...item, title: event.target.value } : item))} /></label><div className="flex gap-2">{([-1, 1] as const).map(direction => <button key={direction} type="button" className={button} disabled={disabled || chapterIndex + direction < 0 || chapterIndex + direction >= volume.chapters.length} onClick={() => { replaceChapter(reorderImportItem(volume.chapters, chapterIndex, direction)); setChapter(chapterIndex + direction) }}>{direction < 0 ? '章上移' : '章下移'}</button>)}</div>
          <label className="block text-sm">归属卷<select disabled={disabled} className={input} value={volumeIndex} onChange={event => { const target = Number(event.target.value); const index = volumes[target].chapters.length; changeVolumes(volumes.map((item, i) => i === volumeIndex ? { ...item, chapters: item.chapters.filter((_, j) => j !== chapterIndex) } : i === target ? { ...item, chapters: [...item.chapters, chapter] } : item)); setVolume(target); setChapter(index); setPage(Math.floor(index / 30)) }}>{volumes.map((item, index) => <option key={index} value={index}>{item.title}</option>)}</select></label>
          <p className="break-all text-xs">来源：{chapter.segments.map(item => summary.volumes[item.volumeIndex]?.chapters[item.chapterIndex]?.source).map(source => source?.memberPath ?? source?.filename ?? '上传文件').filter((value, index, all) => all.indexOf(value) === index).join('、')}</p>
          {error ? <p role="alert">{error}</p> : body === undefined ? <p role="status">正在按需加载选中章节原文…</p> : <ImportBodyViewer key={`${volumeIndex}:${chapterIndex}`} content={body} onCursor={offset => setCursor({ segments: chapter.segments, offset })} />}
          {importSegmentLength(chapter.segments) > 100000 && <p role="alert">本章超过 100,000 字符，必须拆分后才能导入；正文不会被截断。</p>}
          <button type="button" className={button} disabled={disabled || body === undefined || count >= 2000 || cursor?.segments !== chapter.segments || cursor.offset <= 0 || cursor.offset >= importSegmentLength(chapter.segments)} onClick={event => {
            if (event.detail > 1 || cursor?.segments !== chapter.segments || body === undefined) return
            if (/[\uD800-\uDBFF]/.test(body[cursor.offset - 1]) && /[\uDC00-\uDFFF]/.test(body[cursor.offset] ?? '')) return
            const split = splitImportSegments(chapter.segments, cursor.offset)
            if (split) { replaceChapter([...volume.chapters.slice(0, chapterIndex), { ...chapter, segments: split[0] }, { title: `${chapter.title.slice(0, 125).replace(/[\uD800-\uDBFF]$/, '')}（续）`, segments: split[1] }, ...volume.chapters.slice(chapterIndex + 1)]); setCursor(null) }
          }}>在光标处拆分为两章</button>
          <button type="button" className={button} disabled={disabled || !!mergeError} onClick={event => { if (event.detail > 1 || mergeError || !nextChapter) return; replaceChapter([...volume.chapters.slice(0, chapterIndex), { ...chapter, segments: [...chapter.segments, ...nextChapter.segments] }, ...volume.chapters.slice(chapterIndex + 2)]); setCursor(null) }}>与下一章合并（同来源）</button>
          <p className="text-xs">合并分隔符为空字符串；保留当前章名，不插入下一章标题，不丢空行或末尾正文。{mergeError}</p>
          {aiEnabled && body !== undefined && <ImportAiSuggestions novelId={novelId} jobId={jobId} selection={{ manifestRevision: summary.manifestRevision, manifestHash: summary.manifestHash, volumeIndex, chapterIndex }} content={body} disabled={disabled || dirty} onApply={boundaries => {
            if (count + boundaries.length - 1 > 2000) { setError('应用后超过 2,000 章上限，请减少边界。'); return }
            let remaining = chapter.segments
            const parts = boundaries.map((boundary, index) => { const next = boundaries[index + 1]; if (!next) return { title: boundary.title, segments: remaining }; const split = splitImportSegments(remaining, next.offset - boundary.offset)!; remaining = split[1]; return { title: boundary.title, segments: split[0] } })
            replaceChapter([...volume.chapters.slice(0, chapterIndex), ...parts, ...volume.chapters.slice(chapterIndex + 1)])
          }} />}
        </> : <p>本卷没有章节。请从其他卷移动章节，或保留空卷。</p>}
      </fieldset>
    </div>
  </section>
}
