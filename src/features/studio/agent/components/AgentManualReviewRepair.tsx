import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ManualReviewRepairPreview, ManualReviewRepairQuote, ManualReviewRepairStatus } from '../../../../../shared/contracts/manual-review-repair.js'
import { fetchManualReviewRepair, quoteManualReviewRepair, submitManualReviewRepair } from '../agentApi'

/** A separate author action: ordinary Continue cannot grant another review. */
export function AgentManualReviewRepair({ runId, onStatusChange }: {
  runId: string
  onStatusChange: (status: ManualReviewRepairStatus) => void
}) {
  const [preview, setPreview] = useState<ManualReviewRepairPreview | null>(null)
  const [quote, setQuote] = useState<ManualReviewRepairQuote | null>(null)
  const [busy, setBusy] = useState<'quote' | 'submit' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const epoch = useRef(0)
  const pending = useRef(false)
  const notified = useRef('')
  const acceptedStatus = useRef<ManualReviewRepairStatus | null>(null)
  const callback = useRef(onStatusChange)
  callback.current = onStatusChange

  useLayoutEffect(() => {
    const owner = ++epoch.current
    pending.current = false
    notified.current = ''
    acceptedStatus.current = null
    setPreview(null)
    setQuote(null)
    setBusy(null)
    setNotice(null)
    setUncertain(false)
    return () => { epoch.current = owner + 1 }
  }, [runId])

  const accept = useCallback((result: ManualReviewRepairPreview) => {
    const prior = acceptedStatus.current
    if (prior && (!result.status || (prior.operationId === result.status.operationId
      && ['complete', 'incomplete'].includes(prior.state) && !prior.canResume && !prior.needsContinuation
      && !['complete', 'incomplete'].includes(result.status.state)))) return
    acceptedStatus.current = result.status
    setPreview(result)
    if (!result.status) return
    setQuote(null)
    setUncertain(false)
    const key = `${result.status.operationId}:${result.status.state}:${result.status.terminalCommitted}:${result.status.needsContinuation}`
    if (key !== notified.current) {
      notified.current = key
      callback.current(result.status)
    }
  }, [])

  useEffect(() => {
    const owner = epoch.current
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const read = async () => {
      try {
        const result = await fetchManualReviewRepair(runId)
        if (cancelled || owner !== epoch.current) return
        accept(result)
        if (result.status?.state === 'running' || result.status?.state === 'unknown') timer = setTimeout(() => void read(), 3000)
      } catch {
        // No paid request is retried. A refresh can read the durable operation.
        if (owner === epoch.current && notified.current) setNotice('暂时无法核对修复状态，请刷新查看；不要重复提交。')
      }
    }
    void read()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [runId, preview?.status?.state, accept])

  const requestQuote = async () => {
    if (pending.current || uncertain || preview?.status || !preview?.eligible) return
    pending.current = true
    const owner = epoch.current
    setBusy('quote')
    setNotice(null)
    try {
      const result = await quoteManualReviewRepair(runId)
      if (owner === epoch.current) setQuote(result)
    } catch (error) {
      if (owner === epoch.current) setNotice(error instanceof Error ? error.message : '暂时无法获取修复费用。')
    } finally {
      if (owner === epoch.current) { pending.current = false; setBusy(null) }
    }
  }

  const submit = async (approvedQuote = quote) => {
    if (pending.current || !approvedQuote || uncertain) return
    if (preview?.status && !(preview.status.canResume && approvedQuote.recoveryOnly && approvedQuote.maxProviderDispatches === 0
      && approvedQuote.maximumCreditMilli === 0 && approvedQuote.operationId === preview.status.operationId)) return
    if (Date.parse(approvedQuote.expiresAt) <= Date.now()) { setQuote(null); setNotice('费用确认已过期，请重新查看。'); return }
    pending.current = true
    const owner = epoch.current
    setBusy('submit')
    setNotice(null)
    // A lost response is not permission to send the same paid action again.
    setUncertain(true)
    try {
      const status = await submitManualReviewRepair(runId, approvedQuote.quoteToken)
      if (owner === epoch.current) accept({ eligible: false, status, message: status.message })
    } catch {
      if (owner !== epoch.current) return
      setQuote(null)
      setNotice('提交结果尚未确认，正在核对已保存状态；请勿重复提交。')
      try {
        const result = await fetchManualReviewRepair(runId)
        if (owner === epoch.current) accept(result)
      } catch { /* Keep the uncertain state until a fresh durable read. */ }
    } finally {
      if (owner === epoch.current) { pending.current = false; setBusy(null) }
    }
  }

  const resumeKnownResult = async () => {
    if (pending.current || uncertain || !preview?.status?.canResume) return
    pending.current = true
    const owner = epoch.current
    setBusy('quote')
    setNotice(null)
    try {
      const recoveryQuote = await quoteManualReviewRepair(runId)
      if (owner !== epoch.current) return
      if (!recoveryQuote.recoveryOnly || recoveryQuote.maxProviderDispatches !== 0 || recoveryQuote.maximumCreditMilli !== 0
        || recoveryQuote.operationId !== preview.status.operationId) {
        setNotice('原结果暂时不能复用，未提交新的检查。')
        return
      }
      pending.current = false
      await submit(recoveryQuote)
    } catch (error) {
      if (owner === epoch.current) setNotice(error instanceof Error ? error.message : '暂时无法核对原结果。')
    } finally {
      if (owner === epoch.current) { pending.current = false; setBusy(null) }
    }
  }
  if (!preview?.eligible && !preview?.status && !uncertain) return null
  const status = preview?.status
  const actionClass = 'rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] disabled:cursor-wait disabled:opacity-50'
  return <section aria-label="旧复查修复" className="mx-4 mb-2 space-y-2 rounded-[14px] border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">
    <p role="status">{status?.message ?? (uncertain ? '正在核对修复请求，原报告和正文已保留。' : preview?.message)}</p>
    {notice ? <p role="alert">{notice}</p> : null}
    {status || uncertain ? null : quote ? <>
      <p>{quote.model.label} · 最多 {Math.ceil(quote.maximumCreditMilli / 1000).toLocaleString('zh-CN')} Credits · 额外完整检查一次，按实际用量结算。</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy !== null} onClick={() => void submit()} className={actionClass}>修复旧复查，额外完整检查一次</button>
        <button type="button" disabled={busy !== null} onClick={() => setQuote(null)} className={actionClass}>取消</button>
      </div>
    </> : <button type="button" disabled={busy !== null} onClick={() => void requestQuote()} className={actionClass}>{busy === 'quote' ? '正在读取费用…' : '查看修复费用'}</button>}
    {status?.canResume && !uncertain ? <div className="space-y-2">
      <p>复用已收到的原修复结果，不再调用模型。</p>
      <button type="button" disabled={busy !== null} onClick={() => void resumeKnownResult()} className={actionClass}>继续完成修复</button>
    </div> : null}
    {busy === 'submit' ? <p>正在提交修复请求…</p> : null}
  </section>
}