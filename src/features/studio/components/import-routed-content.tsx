import type { NovelImportPreview } from '../../../../shared/contracts/novel-import.js'


/** Show the actual destinations before approving writes, including non-chapter imports. */
export function ImportRoutedContent({ preview }: { preview: Pick<NovelImportPreview, 'plans' | 'memories'> }) {
  const groups = [
    { name: '计划', items: preview.plans ?? [] },
    { name: '创作记忆', items: preview.memories ?? [] },
  ]
  if (!groups.some(group => group.items.length)) return null
  return <section aria-label="计划与记忆导入预览" className="space-y-3 rounded-xl border border-[var(--border-subtle)] p-3 text-sm">
    <h3 className="font-medium">其他导入内容</h3>
    <p className="text-[var(--text-secondary)]">以下内容不会写入章节。同名计划、记忆可能更新现有内容，请展开核对后再确认导入。</p>
    {groups.filter(group => group.items.length).map(group => <details key={group.name}>
      <summary className="min-h-11 cursor-pointer py-3">{group.name} · {group.items.length} 项</summary>
      <div className="max-h-80 space-y-2 overflow-y-auto overscroll-contain">
        {group.items.map((item, index) => <details key={index} className="rounded-lg bg-[var(--surface-muted)] p-3">
          <summary className="min-h-11 cursor-pointer break-words py-2">{item.title} · {item.content.length.toLocaleString()} 字符</summary>
          <p className="break-all text-xs text-[var(--text-tertiary)]">来源：{item.source?.memberPath ?? item.source?.filename ?? '旧预览未记录定位，建议重新解析'}</p>
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-sans">{item.content}</pre>
        </details>)}
      </div>
    </details>)}
  </section>
}
