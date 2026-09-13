import { useId, useState } from 'react'
import type { NovelImportArtifactDescriptor, NovelImportPreviewSummary, NovelImportReportDto } from '../../../../shared/contracts/novel-import-preview.js'
import { safeImportArtifactUrl } from '../lib/import-artifact'
import { ImportArtifactViewer } from './import-artifact-viewer'

export function ImportCoverPicker({ novelId, jobId, summary, report, selectedId, disabled, onSelect }: {
  novelId: string; jobId: string; summary: NovelImportPreviewSummary; report?: NovelImportReportDto
  selectedId?: string; disabled: boolean; onSelect: (id?: string) => void
}) {
  const group = useId()
  const [viewed, setViewed] = useState<NovelImportArtifactDescriptor | null>(null)
  const candidates = (summary.artifacts ?? []).filter(artifact => artifact.coverCandidate)
  const problem = (artifact: NovelImportArtifactDescriptor) => {
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > 3 * 1024 * 1024) return '封面上限 3 MiB，此候选不可选。'
    if (!safeImportArtifactUrl(novelId, jobId, artifact)) return '候选图片不属于当前任务，不可选。'
    if (!report || report.manifestHash !== summary.manifestHash || report.manifestRevision !== summary.manifestRevision || report.sourceHash !== summary.sourceHash) return '来源报告尚未核对，不可选。'
    const evidence = report.items.find(item => item.artifactId === artifact.id)
    if (!evidence) return '缺少候选来源记录，不可选。'
    const visited = new Set<string>()
    let item: typeof evidence | undefined = evidence
    while (item && !visited.has(item.id)) {
      visited.add(item.id)
      if (item.status === 'excluded' || report.decisions.some(decision => decision.itemId === item!.id && decision.action === 'exclude')) return '此图片或上级来源已排除，不可选。'
      item = report.items.find(parent => parent.id === item?.parentId)
    }
    return null
  }
  return <section className="space-y-2 rounded-lg border border-[var(--border-subtle)] p-3" aria-label="可选导入封面">
    <h3 className="text-sm font-medium">封面选择（默认保留现有封面）</h3>
    <p className="text-xs">应用封面后作为作品封面公开可访问，不发布新正文。查看候选图不会应用；取消选择只保留现有封面，不会删除封面。保存预览后，仍须最终确认导入。</p>
    <label className="flex min-h-11 items-center gap-3 text-sm"><input type="radio" className="h-5 w-5" name={group} disabled={disabled} checked={!selectedId} onChange={() => { if (!disabled) onSelect(undefined) }} />保留现有封面（取消候选选择）</label>
    {candidates.length === 0 && <p className="text-xs">未识别到封面候选，现有封面不变。</p>}
    {candidates.map(artifact => {
      const issue = problem(artifact)
      return <div key={artifact.id} className="min-w-0 space-y-1 rounded-lg bg-[var(--surface-muted)] p-2">
        <label className="flex min-h-11 items-center gap-3 text-sm"><input type="radio" className="h-5 w-5 shrink-0" name={group} disabled={disabled || !!issue} checked={selectedId === artifact.id} onChange={() => { if (!disabled && !issue) onSelect(artifact.id) }} /><span className="min-w-0 break-all">使用封面：{artifact.source}</span></label>
        <p className="text-xs">{(artifact.bytes / 1024 / 1024).toFixed(2)} MiB · {artifact.width} × {artifact.height}。当前作品封面 → {selectedId === artifact.id ? '此候选（尚待确认导入）' : '未选择此候选'}</p>
        {issue && <p className="text-xs">{issue}</p>}
        <button type="button" className="min-h-11 rounded border border-[var(--border-subtle)] px-3 text-sm" onClick={() => setViewed(artifact)}>查看候选：{artifact.source}</button>
      </div>
    })}
    {viewed && <ImportArtifactViewer novelId={novelId} jobId={jobId} artifact={viewed} onClose={() => setViewed(null)} />}
  </section>
}
