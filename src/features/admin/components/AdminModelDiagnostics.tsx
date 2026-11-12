import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiClientError } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { AdminConfirmDialog, StatusPill } from '../AdminLayout'
import { useAdminDialog } from '../admin-dialog'
import type { AdminModelDiagnosticRequest, AdminModelDiagnosticResult, AdminModelDiagnosticsClient } from '../../../../shared/contracts/admin-model-diagnostics.js'

const STATUS_LABELS: Record<AdminModelDiagnosticResult['status'], string> = { running: '诊断进行中', configuration_passed: '本地配置通过 · 连接未检测', succeeded: '本次能力检查通过', failed: '本次检查失败', blocked: '真实请求未开放', cancelled: '已取消', unknown: '结果未知，待核对' }
const FIELD_LABELS = { modelName: '模型 ID', baseUrl: '地址', apiKey: '密钥状态', protocol: '协议', capabilities: '能力参数', lifecycle: '目录状态' }
const milliseconds = (value: number | null) => value === null ? '未知' : `${Math.round(value)} ms`
const statusLabel = (result: AdminModelDiagnosticResult) => result.mode === 'connection' && result.status === 'succeeded' ? '连接测试通过' : STATUS_LABELS[result.status]

/** Model rows can render this directly; the client always addresses the local admin API. */
export default function AdminModelDiagnostics({ modelConfigId, configRevision, client, initialResult, onResult, connection, storageKey }: {
  modelConfigId: string; configRevision: string; client: AdminModelDiagnosticsClient
  initialResult?: AdminModelDiagnosticResult | null; onResult?: (result: AdminModelDiagnosticResult) => void
  connection?: { name: string; disabled?: boolean; showIdle?: boolean }
  storageKey?: string
}) {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<AdminModelDiagnosticResult | null>(initialResult ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pollStopped, setPollStopped] = useState(false)
  const [imageConfirmation, setImageConfirmation] = useState(false)
  const [retained] = useState(() => {
    try { return storageKey ? sessionStorage.getItem(storageKey) : null }
    catch { return null }
  })
  const [unconfirmed, setUnconfirmed] = useState(Boolean(retained && !initialResult))
  const missing = useRef(false)
  const pending = useRef(false)
  const initialKey = retained ?? initialResult?.requestKey
  const key = useRef<{ modelId: string; requestKey: string } | null>(initialKey ? { modelId: modelConfigId, requestKey: initialKey } : null)
  const dialogTitle = useId()
  const dialogRef = useAdminDialog(Boolean(connection && open), () => setOpen(false))
  const scope = `${modelConfigId}:${configRevision}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const isConnection = Boolean(connection)
  const current = result?.modelConfigId === modelConfigId ? result : null
  const stale = Boolean(current && (current.stale || current.configRevision !== configRevision))
  const liveEnabled = Boolean(current?.livePolicy.enabled && !stale)
  const blockedReason = current?.livePolicy.blockedReason ?? '平台测试单次费用上限与真实适配器尚未开放，目前只能检查本地配置。'
  const maximumFee = current?.livePolicy.maximumCostMicros ?? null

  const accept = (next: AdminModelDiagnosticResult) => { missing.current = false; setResult(next); setUnconfirmed(false); onResult?.(next) }
  const refresh = async () => {
    if (pending.current || key.current?.modelId !== modelConfigId) return
    pending.current = true; setBusy(true)
    const requestedScope = scope
    try {
      const next = await client.get(modelConfigId, key.current.requestKey)
      if (scopeRef.current === requestedScope) { accept(next); setError(''); setPollStopped(false) }
    } catch (error) {
      if (scopeRef.current === requestedScope) {
        const absent = isConnection && error instanceof ApiClientError && error.code === 'MODEL_DIAGNOSTIC_NOT_FOUND'
        missing.current = absent
        setError(absent ? '服务器暂无这次测试记录。可再次点击测试连接，沿用原请求编号。' : '尚未取得可信结果，请刷新核对原请求。')
        setPollStopped(true); setUnconfirmed(!absent)
      }
    } finally { pending.current = false; setBusy(false) }
  }
  useEffect(() => {
    const recoveryKey = !current && isConnection && unconfirmed ? key.current?.requestKey : undefined
    const requestKey = recoveryKey ?? (current?.status === 'running' && (open || isConnection) ? current.requestKey : undefined)
    if (!requestKey || pollStopped || busy) return
    const requestedScope = scope
    const timer = window.setTimeout(() => {
      void client.get(modelConfigId, requestKey).then(next => {
        if (scopeRef.current !== requestedScope || key.current?.requestKey !== requestKey) return
        missing.current = false; setResult(next); setUnconfirmed(false); setError(''); onResult?.(next)
      }).catch(error => {
        if (scopeRef.current !== requestedScope || key.current?.requestKey !== requestKey) return
        const absent = isConnection && error instanceof ApiClientError && error.code === 'MODEL_DIAGNOSTIC_NOT_FOUND'
        missing.current = absent
        setPollStopped(true); setUnconfirmed(!absent)
        setError(absent ? '服务器暂无这次测试记录。可再次点击测试连接，沿用原请求编号。' : '读取结果失败，请刷新结果核对原请求。')
      })
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [open, current, isConnection, unconfirmed, busy, pollStopped, client, modelConfigId, onResult, scope])

  const start = async (mode: AdminModelDiagnosticRequest['mode'], costConfirmed = false) => {
    setOpen(true)
    if (pending.current || unconfirmed || current?.status === 'running') return
    pending.current = true; setBusy(true); setError(''); setPollStopped(false)
    const requestedScope = scope
    const requestKey = mode === 'connection' && missing.current && key.current ? key.current.requestKey : crypto.randomUUID()
    missing.current = false
    key.current = { modelId: modelConfigId, requestKey }
    setResult(null)
    try { if (mode === 'connection' && storageKey) sessionStorage.setItem(storageKey, requestKey) }
    catch { /* The request key remains available in this view. */ }
    try {
      const next = await client.start(modelConfigId, { requestKey, mode, expectedRevision: configRevision, ...(costConfirmed ? { costConfirmed: true } : {}) })
      if (scopeRef.current === requestedScope) accept(next)
    } catch (error) {
      if (scopeRef.current === requestedScope) {
        const rejected = error instanceof ApiClientError && [400, 401, 403, 404, 409, 429].includes(error.status)
        if (rejected) {
          key.current = null
          try { if (mode === 'connection' && storageKey && sessionStorage.getItem(storageKey) === requestKey) sessionStorage.removeItem(storageKey) }
          catch { /* The in-memory receipt is authoritative for this view. */ }
        }
        setError(rejected ? error.message : '请求结果尚未确认，请刷新结果核对原请求。')
        setPollStopped(true)
        setUnconfirmed(!rejected)
      }
    } finally { pending.current = false; setBusy(false) }
  }
  const cancel = async () => {
    if (pending.current || !current) return
    pending.current = true; setBusy(true)
    const requestedScope = scope
    try {
      const next = await client.cancel(modelConfigId, current.requestKey)
      if (scopeRef.current === requestedScope) { accept(next); setError('') }
    } catch {
      if (scopeRef.current === requestedScope) { setPollStopped(true); setUnconfirmed(true); setError('取消结果尚未确认，请刷新核对；已产生的未知费用保留待核。') }
    } finally { pending.current = false; setBusy(false) }
  }
  const details = open ? <section aria-label="模型诊断结果" className="min-w-0 space-y-4 rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 id={dialogTitle} className="font-semibold">{connection ? `测试连接 · ${connection.name}` : '模型诊断'}</h3><Button variant="ghost" onClick={() => setOpen(false)}>{connection ? '关闭' : '收起'}</Button></div>
      {connection ? <p className="text-[var(--text-secondary)]">测试已保存配置 · 上游费用由平台承担</p> : <p className="text-[var(--text-secondary)]">本地配置检查不会请求上游。真实请求费用由平台承担。</p>}
      {error ? <p role="alert">{error}</p> : null}
      {busy && !current ? <p role="status">正在提交连接测试…</p> : null}
      {stale ? <p role="status" className="text-[var(--color-warning)]">配置已改变，此结果仅供历史核对；不能代表当前连接状态。</p> : null}
      {current ? <>
        <span role="status"><StatusPill tone={current.status === 'failed' ? 'danger' : current.status === 'succeeded' ? 'success' : 'neutral'}>{statusLabel(current)}</StatusPill></span>
        <p className="text-[var(--text-secondary)]">记录时间 {new Date(current.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · UTC+8 · {current.provider} / {current.modelName}</p>
        {current.failure ? <p role="status">失败阶段：{current.failure.stage} · {current.failure.message}</p> : null}
        {(!connection || current.checks.some(check => !check.passed)) ? <ul className="divide-y divide-[var(--border-default)]">{current.checks.map(check => <li key={check.field} className="py-3"><p className="font-medium">{FIELD_LABELS[check.field]} · {check.passed ? '静态检查通过' : '需修正'}</p><p className="mt-1 text-[var(--text-secondary)]">{check.message}</p></li>)}</ul> : null}
        {current.mode === 'connection' ? <dl className="grid grid-cols-2 gap-3">
          <div><dt>上游 HTTP 状态</dt><dd>{current.upstreamHttpStatus ?? '未取得'}</dd></div>
          <div><dt>总耗时</dt><dd>{milliseconds(current.metrics.totalMs)}</dd></div>
          {current.metrics.outputTokens !== null ? <div><dt>输出 Token</dt><dd>{current.metrics.outputTokens}</dd></div> : null}
        </dl> : current.mode !== 'configuration' ? <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[['首字响应（正文）', milliseconds(current.metrics.firstTextMs)], ['总耗时', milliseconds(current.metrics.totalMs)], ['响应头', milliseconds(current.metrics.responseHeadersMs)], ['首流事件', milliseconds(current.metrics.firstEventMs)], ['首思考', milliseconds(current.metrics.firstThinkingMs)], ['输出速度', current.metrics.tokensPerSecond === null ? '未知 / 不适用' : `${current.metrics.tokensPerSecond.toFixed(1)} Token/s`]].map(([label,value]) => <div key={label}><dt className="text-[var(--text-secondary)]">{label}</dt><dd>{value}</dd></div>)}
        </dl> : null}
        <details><summary className="min-h-11 cursor-pointer py-3">测试费用记录</summary><p className="break-all">平台测试编号：{current.fee.identity}</p><p className="mt-2">费用：{current.fee.status === 'not_requested' ? '未请求上游' : current.fee.status === 'unknown' ? '未核定，不代表免费' : current.fee.amountMicros === null ? '未核定' : `${(current.fee.amountMicros / 1_000_000).toFixed(6)} CNY`}</p></details>
      </> : null}
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !key.current} onClick={() => void refresh()}>刷新结果</Button>{current?.status === 'running' ? <Button disabled={busy} onClick={() => void cancel()}>取消诊断</Button> : null}{!connection ? <><Button disabled={!liveEnabled || busy || unconfirmed} aria-describedby={`diagnostic-policy-${modelConfigId}`} onClick={() => void start('gateway')}>网关访问检查</Button><Button disabled={!liveEnabled || busy || unconfirmed} aria-describedby={`diagnostic-policy-${modelConfigId}`} onClick={() => current?.modelKind === 'image_generation' ? setImageConfirmation(true) : void start('capability')}>最小能力请求</Button></> : null}</div>
      {!connection && !liveEnabled ? <p id={`diagnostic-policy-${modelConfigId}`} className="text-[var(--text-secondary)]">{blockedReason}</p> : null}
    </section> : null
  const buttonLabel = connection ? '测试连接' : '检查配置'
  return <div className={connection?.showIdle ? 'flex flex-col items-start' : connection ? 'flex flex-wrap items-center gap-2' : 'min-w-0 space-y-2'}>
    <Button className="whitespace-nowrap" disabled={connection?.disabled || busy || unconfirmed || current?.status === 'running'} onClick={() => void start(connection ? 'connection' : 'configuration')}
      aria-label={connection ? `测试连接 ${connection.name}` : undefined} title={connection ? '向已保存的上游发送一次测试，可能产生费用' : undefined}>{buttonLabel}</Button>
    {current || connection && (unconfirmed || error) ? <button type="button" className="inline-flex min-h-11 items-center text-sm underline" aria-expanded={open} onClick={() => setOpen(value => !value)}>{current ? stale ? '检测已过期' : statusLabel(current) : '查看测试结果'}</button> : null}
    {connection?.showIdle && !current && !unconfirmed && !error && !busy ? <span className="mt-1 text-xs text-[var(--text-secondary)]">未检测</span> : null}
    {details && connection ? createPortal(<div role="dialog" aria-modal="true" aria-labelledby={dialogTitle} ref={dialogRef} tabIndex={-1}
      className="admin-portal fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-4"><div className="max-h-[85dvh] w-full max-w-xl overflow-y-auto">{details}</div></div>, document.body) : details}
    <AdminConfirmDialog open={imageConfirmation} title="确认图片能力测试" description={`将由平台承担测试费用。单次上限 ${maximumFee === null ? '未知' : `${(maximumFee / 1_000_000).toFixed(6)} CNY`}；测试规格由受控适配器限定，不代表免费。`} confirmLabel="确认最小规格测试" tone="primary" onCancel={() => setImageConfirmation(false)} onConfirm={() => { setImageConfirmation(false); void start('capability', true) }} />
  </div>
}
