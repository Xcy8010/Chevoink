import { useEffect, useRef, useState } from 'react'
import Button from '@/components/ui/Button'
import { AdminConfirmDialog, StatusPill } from '../AdminLayout'
import type { AdminModelDiagnosticRequest, AdminModelDiagnosticResult, AdminModelDiagnosticsClient } from '../../../../shared/contracts/admin-model-diagnostics.js'

const STATUS_LABELS: Record<AdminModelDiagnosticResult['status'], string> = { running: '诊断进行中', configuration_passed: '本地配置通过 · 连接未检测', succeeded: '本次能力检查通过', failed: '本次检查失败', blocked: '真实请求未开放', cancelled: '已取消', unknown: '结果未知，待核对' }
const FIELD_LABELS = { modelName: '模型 ID', baseUrl: '地址', apiKey: '密钥状态', protocol: '协议', capabilities: '能力参数', lifecycle: '目录状态' }
const milliseconds = (value: number | null) => value === null ? '未知' : `${Math.round(value)} ms`

/** Model rows can render this directly; the client always addresses the local admin API. */
export default function AdminModelDiagnostics({ modelConfigId, configRevision, client, initialResult, onResult }: {
  modelConfigId: string; configRevision: string; client: AdminModelDiagnosticsClient
  initialResult?: AdminModelDiagnosticResult | null; onResult?: (result: AdminModelDiagnosticResult) => void
}) {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<AdminModelDiagnosticResult | null>(initialResult ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pollStopped, setPollStopped] = useState(false)
  const [imageConfirmation, setImageConfirmation] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const pending = useRef(false)
  const key = useRef<{ modelId: string; requestKey: string } | null>(initialResult ? { modelId: initialResult.modelConfigId, requestKey: initialResult.requestKey } : null)
  const scope = `${modelConfigId}:${configRevision}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const current = result?.modelConfigId === modelConfigId ? result : null
  const stale = Boolean(current && (current.stale || current.configRevision !== configRevision))
  const liveEnabled = Boolean(current?.livePolicy.enabled && !stale)
  const blockedReason = current?.livePolicy.blockedReason ?? '平台测试单次费用上限与真实适配器尚未开放，目前只能检查本地配置。'
  const maximumFee = current?.livePolicy.maximumCostMicros ?? null

  const accept = (next: AdminModelDiagnosticResult) => { setResult(next); setUnconfirmed(false); onResult?.(next) }
  const refresh = async () => {
    if (pending.current || key.current?.modelId !== modelConfigId) return
    pending.current = true; setBusy(true)
    const requestedScope = scope
    try {
      const next = await client.get(modelConfigId, key.current.requestKey)
      if (scopeRef.current === requestedScope) { accept(next); setError(''); setPollStopped(false) }
    } catch {
      if (scopeRef.current === requestedScope) { setError('尚未取得可信结果。请手动刷新核对，系统不会重发能力请求。'); setPollStopped(true); setUnconfirmed(true) }
    } finally { pending.current = false; setBusy(false) }
  }
  useEffect(() => {
    if (!open || !current || current.status !== 'running' || pollStopped) return
    const requestedScope = scope
    const timer = window.setTimeout(() => {
      void client.get(modelConfigId, current.requestKey).then(next => {
        if (scopeRef.current !== requestedScope) return
        setResult(next); onResult?.(next)
      }).catch(() => {
        if (scopeRef.current !== requestedScope) return
        setPollStopped(true); setError('读取结果失败，请手动核对；没有重发能力请求。')
      })
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [open, current, pollStopped, client, modelConfigId, onResult, scope])

  const start = async (mode: AdminModelDiagnosticRequest['mode'], costConfirmed = false) => {
    setOpen(true)
    if (pending.current || unconfirmed || current?.status === 'running') return
    pending.current = true; setBusy(true); setError(''); setPollStopped(false)
    const requestedScope = scope
    const requestKey = crypto.randomUUID()
    key.current = { modelId: modelConfigId, requestKey }
    try {
      const next = await client.start(modelConfigId, { requestKey, mode, expectedRevision: configRevision, ...(costConfirmed ? { costConfirmed: true } : {}) })
      if (scopeRef.current === requestedScope) accept(next)
    } catch {
      if (scopeRef.current === requestedScope) { setError('请求结果尚未确认，请刷新结果核对。不要重新发起付费请求。'); setPollStopped(true); setUnconfirmed(true) }
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
  return <div className="min-w-0 space-y-2">
    <Button disabled={busy || unconfirmed || current?.status === 'running'} onClick={() => void start('configuration')}>检查配置</Button>
    {current ? <button type="button" className="inline-flex min-h-11 items-center px-2 text-sm underline" aria-expanded={open} onClick={() => setOpen(value => !value)}>{stale ? '检测已过期' : STATUS_LABELS[current.status]}</button> : null}
    {open ? <section aria-label="模型诊断结果" className="min-w-0 space-y-4 rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">模型诊断</h3><Button variant="ghost" onClick={() => setOpen(false)}>收起</Button></div>
      <p className="break-all text-[var(--text-secondary)]">配置 {modelConfigId} · 版本 {current?.configRevision ?? configRevision}</p>
      <p className="text-[var(--text-secondary)]">本地配置检查不会解析 DNS、请求上游或验证生成能力。真实请求费用由平台测试记录承担，不扣作者 Credits。</p>
      {error ? <p role="alert">{error}</p> : null}
      {stale ? <p role="status" className="text-[var(--color-warning)]">配置已改变，此结果仅供历史核对；不能代表当前连接状态。</p> : null}
      {current ? <>
        <StatusPill tone={current.status === 'failed' ? 'danger' : current.status === 'succeeded' ? 'success' : 'neutral'}>{STATUS_LABELS[current.status]}</StatusPill>
        <p className="text-[var(--text-secondary)]">记录时间 {new Date(current.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · UTC+8 · {current.provider} / {current.modelName}</p>
        {current.failure ? <p role="status">失败阶段：{current.failure.stage} · {current.failure.message}</p> : null}
        <ul className="divide-y divide-[var(--border-default)]">{current.checks.map(check => <li key={check.field} className="py-3"><p className="font-medium">{FIELD_LABELS[check.field]} · {check.passed ? '静态检查通过' : '需修正'}</p><p className="mt-1 text-[var(--text-secondary)]">{check.message}</p></li>)}</ul>
        {current.mode !== 'configuration' ? <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[['首字响应（正文）', milliseconds(current.metrics.firstTextMs)], ['总耗时', milliseconds(current.metrics.totalMs)], ['响应头', milliseconds(current.metrics.responseHeadersMs)], ['首流事件', milliseconds(current.metrics.firstEventMs)], ['首思考', milliseconds(current.metrics.firstThinkingMs)], ['输出速度', current.metrics.tokensPerSecond === null ? '未知 / 不适用' : `${current.metrics.tokensPerSecond.toFixed(1)} Token/s`]].map(([label,value]) => <div key={label}><dt className="text-[var(--text-secondary)]">{label}</dt><dd>{value}</dd></div>)}
        </dl> : null}
        <details><summary className="min-h-11 cursor-pointer py-3">测试费用记录</summary><p className="break-all">平台测试编号：{current.fee.identity}</p><p className="mt-2">费用：{current.fee.status === 'not_requested' ? '未请求上游' : current.fee.status === 'unknown' ? '未核定，不代表免费' : current.fee.amountMicros === null ? '未核定' : `${(current.fee.amountMicros / 1_000_000).toFixed(6)} CNY`}</p></details>
      </> : null}
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !key.current} onClick={() => void refresh()}>刷新结果</Button>{current?.status === 'running' ? <Button disabled={busy} onClick={() => void cancel()}>取消诊断</Button> : null}<Button disabled={!liveEnabled || busy || unconfirmed} aria-describedby={`diagnostic-policy-${modelConfigId}`} onClick={() => void start('gateway')}>网关访问检查</Button><Button disabled={!liveEnabled || busy || unconfirmed} aria-describedby={`diagnostic-policy-${modelConfigId}`} onClick={() => current?.modelKind === 'image_generation' ? setImageConfirmation(true) : void start('capability')}>最小能力请求</Button></div>
      {!liveEnabled ? <p id={`diagnostic-policy-${modelConfigId}`} className="text-[var(--text-secondary)]">{blockedReason}</p> : null}
      <p className="text-[var(--text-secondary)]">一次短测不代表全天稳定性或写作质量。首流事件与首思考均不代替首字响应。</p>
    </section> : null}
    <AdminConfirmDialog open={imageConfirmation} title="确认图片能力测试" description={`将由平台承担测试费用。单次上限 ${maximumFee === null ? '未知' : `${(maximumFee / 1_000_000).toFixed(6)} CNY`}；测试规格由受控适配器限定，不代表免费。`} confirmLabel="确认最小规格测试" tone="primary" onCancel={() => setImageConfirmation(false)} onConfirm={() => { setImageConfirmation(false); void start('capability', true) }} />
  </div>
}
