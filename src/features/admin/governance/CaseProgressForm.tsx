import { useState } from 'react'
import type { CaseRow } from '../../../../shared/contracts/governance-cases'
import { control, action, post, errorText } from '@/features/governance/common'
export default function CaseProgressForm({ item, onSaved }: { item: CaseRow; onSaved: () => void }) {
  const [kind, setKind] = useState('request_materials'),
    [text, setText] = useState(''),
    [until, setUntil] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  return (
    <details>
      <summary className="cursor-pointer">补材料或通知延期</summary>
      <form
        className="space-y-2"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setMessage('')
          try {
            await post('/api/admin/governance/cases/' + item.id + '/progress', {
              action: kind,
              reason: text,
              until: kind === 'extend' ? new Date(until).toISOString() : undefined,
            })
            setMessage('进展通知已记录。')
            setText('')
            onSaved()
          } catch (error) {
            setMessage(errorText(error))
          } finally {
            setBusy(false)
          }
        }}
      >
        <label>
          通知类型
          <select className={control} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="request_materials">请求必要材料</option>
            <option value="extend">反馈延期进展</option>
          </select>
        </label>
        {kind === 'extend' && (
          <label>
            预计完成时间
            <input
              required
              type="datetime-local"
              className={control}
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </label>
        )}
        <label>
          告知当事人的原因与所需材料
          <textarea
            required
            className={control}
            value={text}
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button className={action} disabled={busy}>
          确认并通知
        </button>
        {message && <p role="status">{message}</p>}
      </form>
    </details>
  )
}
