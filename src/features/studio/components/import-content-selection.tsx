import type { NovelImportPreviewSummary, NovelImportReportDto } from '../../../../shared/contracts/novel-import-preview.js'
import type { ImportSelectionEdit } from '../import-preview-api'
import { ImportCoverPicker } from './import-cover-picker'

export function defaultImportSelection(summary: NovelImportPreviewSummary): ImportSelectionEdit {
  return {
    expectedManifestRevision: summary.manifestRevision, manifestHash: summary.manifestHash,
    chapters: summary.volumes.flatMap((volume, volumeIndex) => volume.chapters.map((_, chapterIndex) => ({ volumeIndex, chapterIndex }))),
    plans: (summary.plans ?? []).map((_, index) => index), memories: (summary.memories ?? []).map((_, index) => index),
    metadataSelection: { ...summary.metadataSelection },
  }
}

export function hasImportSelection(value: ImportSelectionEdit | null) {
  return !!value && !!(value.chapters.length || value.plans.length || value.memories.length || Object.keys(value.metadataSelection ?? {}).length)
}

export function ImportContentSelection({ novelId, jobId, summary, report, value, disabled, onChange }: {
  novelId: string; jobId: string; summary: NovelImportPreviewSummary; report: NovelImportReportDto | null
  value: ImportSelectionEdit; disabled: boolean; onChange: (next: ImportSelectionEdit) => void
}) {
  const all = defaultImportSelection(summary)
  const metadata = value.metadataSelection ?? {}
  const infoKeys = (['title', 'summary', 'tags'] as const).filter(key => !!summary.metadata[key]?.length)
  const infoChecked = infoKeys.length > 0 && infoKeys.every(key => Object.prototype.hasOwnProperty.call(metadata, key))
  const row = 'flex min-h-12 items-center gap-3 rounded-xl px-3 py-2 hover:bg-[var(--surface-muted)]'
  return <fieldset disabled={disabled} className="min-w-0 space-y-2" aria-label="选择导入内容">
    <legend className="mb-3 text-sm font-medium">选择要导入的内容</legend>
    <label className={row}><input type="checkbox" className="h-5 w-5" ref={node => { if (node) node.indeterminate = value.chapters.length > 0 && value.chapters.length < all.chapters.length }} checked={!!all.chapters.length && value.chapters.length === all.chapters.length} disabled={disabled || !all.chapters.length}
      onChange={event => onChange({ ...value, chapters: event.target.checked ? all.chapters : [] })} /><span className="text-sm">章节正文<span className="ml-2 text-xs text-[var(--text-tertiary)]">已选 {value.chapters.length} / {all.chapters.length} 章</span></span></label>
    {!!all.chapters.length && <details className="ml-11 text-sm"><summary className="cursor-pointer py-2 text-[var(--text-secondary)]">选择具体章节</summary>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-[var(--border-subtle)] p-2">{summary.volumes.map((volume, volumeIndex) => <div key={volumeIndex}>
        <p className="px-2 py-2 text-xs text-[var(--text-tertiary)]">{volume.title}</p>
        {volume.chapters.map((chapter, chapterIndex) => <label key={chapterIndex} className={row}><input type="checkbox" className="h-4 w-4 shrink-0"
          checked={value.chapters.some(item => item.volumeIndex === volumeIndex && item.chapterIndex === chapterIndex)}
          onChange={event => onChange({ ...value, chapters: event.target.checked ? [...value.chapters, { volumeIndex, chapterIndex }] : value.chapters.filter(item => item.volumeIndex !== volumeIndex || item.chapterIndex !== chapterIndex) })} /><span className="min-w-0 break-words">{chapter.title}</span></label>)}
      </div>)}</div></details>}
    {(['plans', 'memories'] as const).map(key => <div key={key}>
      <label className={row}><input type="checkbox" className="h-5 w-5" disabled={disabled || !all[key].length} ref={node => { if (node) node.indeterminate = value[key].length > 0 && value[key].length < all[key].length }} checked={!!all[key].length && value[key].length === all[key].length}
        onChange={event => onChange({ ...value, [key]: event.target.checked ? all[key] : [] })} /><span className="text-sm">{key === 'plans' ? '创作计划' : '创作记忆'}<span className="ml-2 text-xs text-[var(--text-tertiary)]">已选 {value[key].length} / {all[key].length} 项</span></span></label>
      {!!all[key].length && <details className="ml-11 text-sm"><summary className="cursor-pointer py-2 text-[var(--text-secondary)]">选择具体{key === 'plans' ? '计划' : '记忆'}</summary><div className="max-h-56 overflow-y-auto">
        {summary[key]?.map((item, index) => <label key={index} className={row}><input type="checkbox" className="h-4 w-4 shrink-0" checked={value[key].includes(index)}
          onChange={event => onChange({ ...value, [key]: event.target.checked ? [...value[key], index] : value[key].filter(i => i !== index) })} /><span className="min-w-0 break-words">{item.title}</span></label>)}
      </div></details>}
    </div>)}
    <label className={row}><input type="checkbox" className="h-5 w-5" disabled={disabled || !infoKeys.length} checked={infoChecked} onChange={event => {
      const next = { ...metadata }; for (const key of infoKeys) { if (event.target.checked) Object.assign(next, { [key]: summary.metadata[key] }); else delete next[key] }
      onChange({ ...value, metadataSelection: next })
    }} /><span className="min-w-0 text-sm">作品信息<span className="block text-xs text-[var(--text-tertiary)]">{summary.metadata.title ?? '书名、简介和标签'}{!infoKeys.length ? ' · 未识别' : ''}</span></span></label>
    {!!summary.artifacts?.some(item => item.coverCandidate) && <details className="rounded-xl px-3 text-sm"><summary className="cursor-pointer py-3">封面 · {metadata.coverArtifactId ? '已选择' : '保留现有封面'}</summary>
      <ImportCoverPicker novelId={novelId} jobId={jobId} summary={summary} report={report ?? undefined} selectedId={metadata.coverArtifactId} disabled={disabled} onSelect={id => {
        const next = { ...metadata }; if (id) next.coverArtifactId = id; else delete next.coverArtifactId; onChange({ ...value, metadataSelection: next })
      }} /></details>}
    {!hasImportSelection(value) && <p role="status" className="px-3 text-sm">请至少选择一项要导入的内容。</p>}
    <p className="px-3 pt-2 text-xs text-[var(--text-tertiary)]">仅导入勾选内容。同名章节、计划和记忆可能更新现有内容。</p>
  </fieldset>
}
