import { useState } from 'react'
import { action, control, errorText, post } from './common'
export default function SupplementForm({
  id,
  proof,
  receipt,
  onSaved,
}: {
  id: string
  proof?: string
  receipt?: string
  onSaved: () => Promise<void>
}) {
  const [statement, setStatement] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError('')
        try {
          await post(
            '/api/governance/' + (proof ? 'appeal' : 'reports') + '/' + encodeURIComponent(id) + '/materials',
            { statement, receipt },
            proof ? { 'X-Appeal-Proof': proof } : undefined,
          )
          setStatement('')
          await onSaved()
        } catch (e) {
          setError(errorText(e))
        } finally {
          setBusy(false)
        }
      }}
    >
      <label>
        补充必要材料
        <textarea
          rows={3}
          className={control}
          required
          maxLength={4000}
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
        />
      </label>
      <button className={action} disabled={busy}>
        提交补充材料
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}
