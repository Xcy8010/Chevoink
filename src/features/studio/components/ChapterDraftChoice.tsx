import { useState } from 'react'
import type { ChapterCopy } from '../lib/chapter-recovery'
import ConfirmDialog from './ConfirmDialog'

export default function ChapterDraftChoice({ copies, choose, conflict, open = true }: { open?: boolean; copies: ChapterCopy[]; conflict?: boolean; choose: (copy: ChapterCopy | null) => void }) {
  const [slot, setSlot] = useState(copies[0].slot)
  const selected = copies.find(copy => copy.slot === slot) ?? copies[0]
  return <ConfirmDialog open={open} title="选择要恢复的章节草稿"
    description={conflict ? '此章已有新版本。恢复后，所选草稿的标题、简介和正文将替换已同步的版本。' : '此章节有多个未同步的本地副本。可以查看正文后再选择。'}
    confirmLabel="恢复所选草稿" cancelLabel="查看已同步正文"
    onConfirm={() => choose(selected)} onCancel={() => choose(null)}>
    {copies.length > 1 && <select aria-label="本地草稿" value={selected.slot} onChange={event => setSlot(event.target.value)}
      className="mt-4 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-default)] p-2 text-sm">
      {copies.map((copy, index) => <option key={copy.slot} value={copy.slot}>
        {index + 1}. {copy.edits.title} · {new Date(copy.time).toLocaleString()} · {copy.edits.content.length} 字
      </option>)}
    </select>}
    <textarea aria-label="所选草稿正文" readOnly value={selected.edits.content}
      className="mt-2 h-40 w-full resize-y rounded-md bg-[var(--surface-muted)] p-3 text-sm" />
  </ConfirmDialog>
}
