import { useState } from 'react'
import { usageCategories } from '../../../../shared/contracts/governance-cases'
import { action, control, errorText, post } from '@/features/governance/common'
export default function ManualUsageCase({ onCreated }: { onCreated: () => void }) {
  const [key, setKey] = useState(() => crypto.randomUUID()),
    [user, setUser] = useState(''),
    [category, setCategory] = useState('resale'),
    [risk, setRisk] = useState('observe'),
    [evidence, setEvidence] = useState(''),
    [statement, setStatement] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  return (
    <details>
      <summary className="cursor-pointer">登记人工核查案件</summary>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try {
            const result = await post<{ id: string }>('/api/admin/governance/usage-cases', {
              requestKey: key,
              userId: user,
              category,
              risk,
              evidence: evidence
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean),
              statement,
            })
            setMessage('已登记 ' + result.id)
            setKey(crypto.randomUUID())
            setEvidence('')
            setStatement('')
            onCreated()
          } catch (e) {
            setMessage(errorText(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        <label>
          关联账号编号
          <input className={control} required value={user} onChange={(e) => setUser(e.target.value)} />
        </label>
        <label>
          核查主题
          <select className={control} value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(usageCategories).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          风险
          <select className={control} value={risk} onChange={(e) => setRisk(e.target.value)}>
            <option value="observe">观察</option>
            <option value="review">需要复核</option>
            <option value="urgent">紧急复核</option>
          </select>
        </label>
        <label>
          可核实的证据引用（每行一项）
          <textarea
            className={control}
            required
            rows={3}
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
          />
        </label>
        <label>
          需核查的事实
          <textarea
            className={control}
            required
            rows={3}
            maxLength={4000}
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
          />
        </label>
        <p>正常额度消耗、请求量、单一网络标识或对账差异不能单独证明恶意。疑似盗号时优先保护账号。</p>
        <button className={action} disabled={busy}>
          登记核查
        </button>
        {message && <p role="status">{message}</p>}
      </form>
    </details>
  )
}
