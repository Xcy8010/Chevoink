import { useState } from 'react'
import Button from '@/components/ui/Button'

export default function CreatePlanDialog({ onCreate, onClose }: { onCreate: (kind: 'outline' | 'detail') => Promise<void>; onClose: () => void }) {
  const [kind, setKind] = useState<'outline' | 'detail'>('outline')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[rgba(15,23,42,0.18)] p-4" onClick={() => { if (!busy) onClose() }}>
    <div role="dialog" aria-modal="true" aria-label="新建计划" className="w-full max-w-sm space-y-5 rounded-[24px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5 shadow-xl" onClick={event => event.stopPropagation()}>
      <h3 className="font-semibold">新建计划</h3>
      <div className="flex gap-3" role="group" aria-label="计划类型">{(['outline', 'detail'] as const).map(value => <Button key={value} variant={kind === value ? 'primary' : 'secondary'} aria-pressed={kind === value} onClick={() => setKind(value)}>{value === 'outline' ? '大纲' : '细纲'}</Button>)}</div>
      {error ? <p role="alert" className="text-sm text-[rgb(153,27,27)]">{error}</p> : null}
      <div className="flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button><Button disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await onCreate(kind); onClose() } catch (failure) { setError(failure instanceof Error ? failure.message : '新建失败，请重试。') } finally { setBusy(false) } }}>{busy ? '新建中…' : '新建'}</Button></div>
    </div>
  </div>
}
