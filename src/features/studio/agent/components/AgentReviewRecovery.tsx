import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentReviewReplacementQuote, AgentReviewReplacementStatus } from '../../../../../shared/contracts'
import { AgentApiError, fetchAgentReviewReplacementStatus, fetchLatestAgentReviewReplacementStatus, quoteAgentReviewReplacement,
  submitAgentReviewReplacement, type ContinueAgentLoopRunModel } from '../agentApi'

type Props = { runId: string; sessionId: string | null; enabled: boolean; model: ContinueAgentLoopRunModel | null; onReady: () => void }
const selectionKey = (model: ContinueAgentLoopRunModel | null) => JSON.stringify(model)

/** Loading and polling only read receipts. One explicit confirmation submits
 * the same signed quote once; ambiguous responses never generate a new quote. */
export function AgentReviewRecovery({ runId, sessionId, enabled, model, onReady }: Props) {
  const [quote, setQuote] = useState<AgentReviewReplacementQuote | null>(null)
  const [retryQuote, setRetryQuote] = useState<AgentReviewReplacementQuote | null>(null)
  const [status, setStatus] = useState<AgentReviewReplacementStatus | null>(null)
  const [busy, setBusy] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const epoch = useRef(0), locked = useRef(false), notified = useRef(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const quotedSelection = useRef(''), currentSelection = useRef(selectionKey(model))
  currentSelection.current = selectionKey(model)
  const readyCallback = useRef(onReady)
  readyCallback.current = onReady
  const receive = useCallback((value: AgentReviewReplacementStatus) => {
    setStatus(value)
    setMessage(value.message)
    if (value.state === 'complete' && !notified.current) {
      notified.current = true
      readyCallback.current()
    }
  }, [])

  useLayoutEffect(() => {
    const owner = ++epoch.current
    locked.current = false; notified.current = false
    setQuote(null); setRetryQuote(null); setStatus(null); setMessage(null); setBusy(true)
    void fetchLatestAgentReviewReplacementStatus(runId).then(value => {
      if (epoch.current === owner && value) receive(value)
    }).catch(error => {
      if (epoch.current === owner) setMessage(error instanceof Error ? error.message : '暂时无法读取检查状态，请再次核对。')
    }).finally(() => { if (epoch.current === owner) setBusy(false) })
    return () => { epoch.current = owner + 1 }
  }, [runId, sessionId, receive])

  const authorizationId = status?.authorizationId
  const polling = status?.state === 'running' || status?.state === 'waiting_confirmation'
  useEffect(() => {
    if (!authorizationId || !polling) return
    const owner = epoch.current
    let disposed = false, inFlight = false
    const check = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const value = await fetchAgentReviewReplacementStatus(runId, authorizationId)
        if (!disposed && epoch.current === owner) receive(value)
      } catch {
        if (!disposed && epoch.current === owner) setMessage('检查状态暂未确认，正在核对原记录；不会自动重新发起检查。')
      } finally { inFlight = false }
    }
    const timer = window.setInterval(() => { void check() }, 5000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [runId, authorizationId, polling, receive])

  useEffect(() => {
    if (!quote) return
    const element = dialog.current
    element?.showModal()
    return () => { if (element?.open) element.close() }
  }, [quote])

  const preview = async () => {
    if (locked.current || !enabled || polling) return
    const owner = epoch.current, modelKey = currentSelection.current
    locked.current = true; setBusy(true); setMessage(null)
    try {
      const value = await quoteAgentReviewReplacement(runId, model)
      if (owner !== epoch.current) return
      if (modelKey !== currentSelection.current) { setMessage('模型选择已改变，请按当前模型重新核对价格。'); return }
      quotedSelection.current = modelKey
      setRetryQuote(null)
      setQuote(value)
    } catch (error) {
      if (owner === epoch.current) setMessage(error instanceof Error ? error.message : '暂时无法核对价格，请稍后重试。')
    } finally {
      if (owner === epoch.current) { locked.current = false; setBusy(false) }
    }
  }

  const confirm = async () => {
    if (!quote || locked.current) return
    if (quotedSelection.current !== currentSelection.current || Date.parse(quote.expiresAt) <= Date.now()) {
      setQuote(null); setRetryQuote(null); setMessage('模型选择或报价已改变，请重新核对当前价格。'); return
    }
    const owner = epoch.current, currentQuote = quote
    locked.current = true; setBusy(true); setQuote(null); setRetryQuote(null)
    // Retain the signed action identity even if the POST response is lost.
    const uncertain: AgentReviewReplacementStatus = { authorizationId: currentQuote.authorizationId,
      state: 'waiting_confirmation', message: '正在核对这次检查的记录；不会自动重新发起检查。' }
    receive(uncertain)
    try {
      const value = await submitAgentReviewReplacement(runId, currentQuote.quoteToken)
      if (owner === epoch.current) receive(value)
    } catch (submissionError) {
      try {
        const value = await fetchAgentReviewReplacementStatus(runId, currentQuote.authorizationId)
        if (owner === epoch.current) receive(value)
      } catch (statusError) {
        if (owner !== epoch.current) return
        if (statusError instanceof AgentApiError && statusError.code === 'REVIEW_REPLACEMENT_NOT_FOUND') {
          // Only a definitive owned absence permits another human action.
          // An uncertain submit reuses this quote; a known rejection requotes.
          setStatus(null)
          if (submissionError instanceof AgentApiError && submissionError.status >= 400 && submissionError.status < 500) {
            setMessage(submissionError.message)
          } else {
            setRetryQuote(currentQuote)
            setMessage('已核实没有创建这次检查。可再次确认同一份报价；不会自动发送。')
          }
        } else setMessage('提交结果暂未确认，正在核对这次记录。请保留当前任务，避免重复收费。')
      }
    } finally {
      if (owner === epoch.current) { locked.current = false; setBusy(false) }
    }
  }

  return <div className="mx-4 mb-2 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
    {message ? <p role="status" className="text-xs leading-5 text-[var(--text-secondary)]">{message}</p> : null}
    {status?.state === 'complete' ? <p className="text-xs leading-5">本次检查已保存。点击“继续”恢复原任务；检查发现的问题仍需处理。</p> : null}
    {retryQuote && enabled && !polling ? <button type="button" disabled={busy} onClick={() => { setQuote(retryQuote) }}
      className="mt-1 rounded-lg px-2 py-1 text-xs">再次确认这次检查</button> : null}
    {enabled && !retryQuote && !polling && status?.state !== 'complete' ? <button type="button" disabled={busy} onClick={() => { void preview() }}
      className="mt-1 rounded-lg px-2 py-1 text-xs disabled:opacity-50">{busy ? '正在核对检查记录…' : '按当前模型重新检查'}</button> : null}
    <dialog ref={dialog} onCancel={() => setQuote(null)} className="max-w-md rounded-2xl bg-[var(--surface-default)] p-5 text-[var(--text-primary)] backdrop:bg-black/30">
      {quote ? <>
        <h3 className="text-base font-semibold">按当前模型重新检查</h3>
        <p className="mt-3 text-sm leading-6">{quote.currentModel.modelName} · Credits 倍率 {(quote.currentModel.multiplierBps / 10000).toLocaleString('zh-CN')} 倍</p>
        <p className="mt-2 text-sm leading-6">按实际用量计费，本次最多 {(quote.maximumCreditMilli / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 })} Credits，无额外检查费。</p>
        <p className="mt-2 text-sm leading-6">原请求的结果或费用尚未确认，原费用预留保留。这将新发起一次第 {quote.currentRevision} 版质量检查；正文保留，完成后由你点击“继续”。</p>
        <div className="mt-4 flex justify-end gap-3">
          <button type="button" onClick={() => setQuote(null)}>取消</button>
          <button type="button" disabled={busy} onClick={() => { void confirm() }}>确认检查</button>
        </div>
      </> : null}
    </dialog>
  </div>
}
