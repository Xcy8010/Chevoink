import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import SupplementForm from './SupplementForm'

import {
  allowedReasons,
  caseStatuses,
  governanceTargets,
  reportReasons,
  type CaseStatus,
  type ReportReason,
  type ReportTarget,
} from '../../../shared/contracts/governance-cases'
import { REPORT_EVENT, type ReportContext } from './ReportAction'
import { action, control, errorText, post } from './common'

type Receipt = { id: string; receipt: string; status: CaseStatus; message: string; needsMaterials?: boolean }
const targets: Record<ReportTarget, string> = {
  post: '社区帖子',
  profile: '个人主页',
  novel: '作品',
  comment: '评论',
  message: '具体私信',
  platform: '平台问题投诉',
}
function ReceiptView({ value }: { value: Receipt }) {
  return (
    <div role="status" className="space-y-3">
      <h3 className="font-semibold">{caseStatuses[value.status]}</h3>
      <p>{value.message}</p>
      <p>案件编号 {value.id}</p>
      <label>
        查询凭据，请自行保存
        <input
          className={control}
          readOnly
          value={value.id + ' / ' + value.receipt}
          onFocus={(e) => e.target.select()}
        />
      </label>
      <Link to="/report" className="underline">
        查看举报进度
      </Link>
    </div>
  )
}
function ReportForm({ target }: { target?: ReportContext }) {
  const [kind, setKind] = useState<ReportTarget>(target?.kind ?? 'platform'),
    [id, setId] = useState(target?.id ?? '')
  const [reason, setReason] = useState<ReportReason | ' '>(' '),
    [statement, setStatement] = useState(''),
    [key] = useState(() => crypto.randomUUID())
  const [value, setValue] = useState<Receipt | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    try {
      setValue(
        await post<Receipt>('/api/governance/reports', {
          requestKey: key,
          targetKind: kind,
          targetId: kind === 'platform' ? 'platform' : id,
          category: reason,
          statement,
        }),
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  if (value) return <ReceiptView value={value} />
  return (
    <form onSubmit={submit} className="space-y-4 text-sm">
      {target ? (
        <p>{targets[kind]}</p>
      ) : (
        <label>
          举报对象
          <select
            className={control}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ReportTarget)
              setId('')
              setReason(' ')
            }}
          >
            {governanceTargets
              .filter((t) => t !== 'message')
              .map((t) => (
                <option key={t} value={t}>
                  {targets[t]}
                </option>
              ))}
          </select>
        </label>
      )}
      {target?.messages ? (
        <label>
          选择要举报的一条私信
          <select required className={control} value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">请选择</option>
            {target.messages.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        !target &&
        kind !== 'platform' && (
          <label>
            对象编号
            <input
              required
              className={control}
              value={id}
              onChange={(e) => setId(e.target.value)}
              maxLength={128}
            />
          </label>
        )
      )}
      <label>
        主要理由
        <select
          className={control}
          required
          value={reason.trim()}
          onChange={(e) => setReason(e.target.value as ReportReason)}
        >
          <option value="">请选择</option>
          {allowedReasons(kind).map((r) => (
            <option key={r} value={r}>
              {reportReasons[r]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {reason === 'copyright' ? '权利依据与最小必要证明' : '补充说明'}
        <textarea
          className={control}
          rows={4}
          maxLength={4000}
          required={reason === 'other' || reason === 'copyright'}
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button className={action} disabled={busy}>
        {busy ? '提交中…' : '提交举报与投诉'}
      </button>
    </form>
  )
}
export function ReportDialogHost() {
  const dialog = useRef<HTMLDialogElement>(null),
    [target, setTarget] = useState<ReportContext | null>(null)
  useEffect(() => {
    const open = (e: Event) => setTarget((e as CustomEvent<ReportContext>).detail)
    window.addEventListener(REPORT_EVENT, open)
    return () => window.removeEventListener(REPORT_EVENT, open)
  }, [])
  useEffect(() => {
    if (target && !dialog.current?.open) dialog.current?.showModal()
  }, [target])
  return target ? (
    <dialog
      ref={dialog}
      onClose={() => setTarget(null)}
      aria-labelledby="report-title"
      className="m-auto max-h-[85dvh] w-[min(28rem,94vw)] overflow-y-auto rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-default)] p-6 text-[var(--text-primary)] shadow-lg backdrop:bg-black/45"
    >
      <header className="mb-4 flex items-center justify-between">
        <h2 id="report-title" className="text-xl font-semibold">
          举报与投诉
        </h2>
        <button type="button" className={action} onClick={() => dialog.current?.close()}>
          关闭
        </button>
      </header>
      <ReportForm target={target} />
    </dialog>
  ) : null
}
export default function PublicReports() {
  const [receipt, setReceipt] = useState(''),
    [result, setResult] = useState<Receipt | null>(null),
    [error, setError] = useState('')
  return (
    <main className="mx-auto max-w-xl space-y-5 px-5 py-10">
      <h1 className="text-2xl font-semibold">举报与投诉</h1>
      <p>
        公众可在此举报内容或投诉平台问题。我们会在 3 个工作日内确认受理，收到必要材料后 15
        个工作日内反馈结果或进展。紧急事项优先处理。
      </p>
      <ReportForm />
      <details className="space-y-3">
        <summary className="cursor-pointer">查询举报进度</summary>
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setError('')
            setResult(null)
            const [id, token] = receipt.split('/').map((s) => s.trim())
            try {
              setResult(await post<Receipt>('/api/governance/receipt', { id, receipt: token }))
            } catch (err) {
              setError(errorText(err))
            }
          }}
        >
          <label>
            查询凭据
            <input
              className={control}
              required
              value={receipt}
              onChange={(e) => setReceipt(e.target.value)}
            />
          </label>
          <button className={action}>查询</button>
        </form>
        {error && <p role="alert">{error}</p>}
        {result && (
          <>
            <p role="status">{result.message}</p>
            {result.needsMaterials && (
              <SupplementForm
                id={result.id}
                receipt={result.receipt}
                onSaved={async () => {
                  setResult(
                    await post<Receipt>('/api/governance/receipt', {
                      id: result.id,
                      receipt: result.receipt,
                    }),
                  )
                }}
              />
            )}
          </>
        )}
      </details>
      <Link to="/appeal" className="underline">
        账号处分与记录申诉
      </Link>
    </main>
  )
}
