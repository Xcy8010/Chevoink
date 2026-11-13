import { FileText } from 'lucide-react'
import type { AgentMessagePart } from '../../../../../shared/contracts/index.js'

export function AuthorRequestBubble({ parts, onPreview }: {
  parts: readonly AgentMessagePart[]
  onPreview: (image: { url: string; name: string }) => void
}) {
  const attachments = parts.filter(part => part.type === 'attachment')
  return (
    <div className="flex max-w-full flex-col items-end gap-1.5">
      {attachments.length > 0 ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {attachments.map((part, index) => part.kind === 'image' ? (
            <button key={index} type="button" onClick={() => onPreview({ url: part.url, name: part.name })}
              className="cursor-zoom-in overflow-hidden rounded-[10px] border border-[var(--border-subtle)] transition hover:opacity-90"
              aria-label={`放大查看图片 ${part.name}`}>
              <img src={part.url} alt={part.name} className="h-16 w-16 object-cover" loading="lazy" />
            </button>
          ) : (
            <a key={index} href={part.url} target="_blank" rel="noopener noreferrer"
              className="inline-flex max-w-52 items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-2 py-1 text-[11px] text-[var(--text-primary)] transition hover:bg-[var(--surface-default)] hover:underline"
              title={`打开文件 ${part.name}`}>
              <FileText className="h-3 w-3 shrink-0 text-[var(--text-secondary)]" />
              <span className="truncate">{part.name}</span>
            </a>
          ))}
        </div>
      ) : null}
      <div className="whitespace-pre-wrap break-words rounded-[20px] bg-[var(--surface-contrast)] px-4 py-3 text-sm leading-7 text-[var(--text-contrast)]">
        {parts.map(part => part.type === 'text' ? part.text : '').join('')}
      </div>
    </div>
  )
}
