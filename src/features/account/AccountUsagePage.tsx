import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { CalendarDays, Gift, LoaderCircle, RefreshCcw, UserPlus } from 'lucide-react'

import Button from '@/components/ui/Button'
import { fetchCreditUsage, fetchReferral, fetchTaskCreditUsage } from './credits-api'
import InviteCreditsDialog from './InviteCreditsDialog'
import { formatCreditAmount, roundCreditAmount } from './credit-format'
import { ledgerLabel } from './ledger-label'
import AccountLayout from './AccountLayout'
import type { CreditLedgerItem } from '../../../shared/contracts'

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

function LedgerRow({ item, onTask }: { item: CreditLedgerItem; onTask?: (runId: string) => void }) {
  const displayedDelta = roundCreditAmount(item.delta)
  const positive = displayedDelta > 0
  const cacheTotal = item.promptCacheHitTokens !== null && item.promptCacheMissTokens !== null
    ? item.promptCacheHitTokens + item.promptCacheMissTokens
    : null
  const cacheLabel = cacheTotal !== null && cacheTotal > 0
    ? ` · 缓存命中 ${Math.round(((item.promptCacheHitTokens ?? 0) / cacheTotal) * 100)}%（${new Intl.NumberFormat('zh-CN').format(item.promptCacheHitTokens ?? 0)}）`
    : ''
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-[#efefec] px-5 py-4 last:border-b-0 dark:border-[var(--border-subtle)]">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{ledgerLabel(item)}</p>
        {item.taskRunId && onTask && <button type="button" onClick={() => onTask(item.taskRunId!)}
          className="mt-1 text-xs underline underline-offset-4">查看所属任务费用</button>}
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">
          {formatDateTime(item.createdAt)}
          {item.requestTokens !== null || item.responseTokens !== null ? ` · 输入 ${new Intl.NumberFormat('zh-CN').format(item.requestTokens ?? 0)} / 输出 ${new Intl.NumberFormat('zh-CN').format(item.responseTokens ?? 0)}` : ''}
          {cacheLabel}
          {item.estimatedUsage && ' · 异常估算结算（非供应商实测）'}
        </p>
        {item.pricing && <p className="mt-1 break-words text-xs leading-5 text-[var(--text-tertiary)]">
          分项计费 · 输入 {item.pricing.inputPerMillion} / 缓存 {item.pricing.cachePerMillion} / 输出 {item.pricing.outputPerMillion} Credits/百万 Token
          <span className="block">按本次费率版本结算，已含档位倍率</span>
          {item.pricing.v1CeilingMultiplier !== undefined && <span className="block">单次费用不超过原V1价格（冻结倍率 {item.pricing.v1CeilingMultiplier}）</span>}
        </p>}
      </div>
      <span className={`text-sm font-medium tabular-nums ${positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--text-primary)]'}`}>
        {positive ? '+' : ''}{formatCreditAmount(displayedDelta)}
      </span>
    </li>
  )
}

function TaskUsage({ runId, onClose }: { runId: string; onClose: () => void }) {
  const sectionRef = useRef<HTMLElement>(null)
  useEffect(() => { sectionRef.current?.focus() }, [])
  const query = useInfiniteQuery({ queryKey: ['credits', 'task', runId], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchTaskCreditUsage(runId, pageParam), getNextPageParam: page => page.nextCursor ?? undefined,
    staleTime: 20_000 })
  const summary = query.data?.pages[0]
  return <section ref={sectionRef} tabIndex={-1} aria-label="任务费用明细" className="mt-5 rounded-2xl border border-[var(--border-subtle)] p-4">
    <div className="flex items-center justify-between gap-3"><h3 className="font-medium">任务费用（含续跑）</h3>
      <Button onClick={onClose}>关闭</Button></div>
    {query.isPending && <p role="status" className="mt-3 flex items-center gap-2 text-sm"><LoaderCircle className="h-4 w-4 animate-spin" />正在读取账单…</p>}
    {summary && <>
      <p className="mt-3 text-sm leading-6">已扣 {formatCreditAmount(summary.charged)} · 已退 {formatCreditAmount(summary.refunded)} · 净扣 {formatCreditAmount(summary.netCharged)} Credits</p>
      {summary.pendingRefund > 0 && <p className="text-sm">待退款 {formatCreditAmount(summary.pendingRefund)} Credits（尚未计入已退）</p>}
      {(summary.pendingModelSettlements ?? 0) > 0 && <p className="text-sm">{summary.pendingModelSettlements} 次模型调用待核实或结算，未计入已扣额度，不代表免费。</p>}
      <p className="mt-1 text-xs text-[var(--text-tertiary)]">账单截至 {formatDateTime(summary.asOf)}；供应商成本不等于用户扣费。
        {summary.unresolvedProviderAttempts === null ? '旧任务无完整供应商对账记录。' : summary.unresolvedProviderAttempts > 0 ? `仍有 ${summary.unresolvedProviderAttempts} 次调用待核实，金额并非最终结算。` : ''}</p>
      <ul>{query.data!.pages.flatMap(page => page.ledger).map(item => <LedgerRow key={item.id} item={item} />)}</ul>
      {summary.ledger.length === 0 && <p className="py-3 text-sm">暂无已记录的费用。</p>}
      {query.hasNextPage && <Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? '加载中…' : '加载更多任务记录'}</Button>}
    </>}
    {query.isError && <div role="alert" className="mt-3 text-sm">任务费用暂时无法读取。<Button onClick={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())}>重试</Button></div>}
  </section>
}

export default function AccountUsagePage() {
  const [taskRunId, setTaskRunId] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [ledgerFilter, setLedgerFilter] = useState<'used' | 'earned'>('used')
  const autoCopyInviteRef = useRef(false)
  const usageQuery = useQuery({ queryKey: ['credits', 'usage'], queryFn: fetchCreditUsage, staleTime: 20_000 })
  const referralQuery = useQuery({ queryKey: ['credits', 'referral'], queryFn: fetchReferral, staleTime: 60_000 })
  const usage = usageQuery.data
  const summary = usage?.account
  const resetLabel = useMemo(() => (summary ? formatDateTime(summary.resetsAt) : '—'), [summary])
  const filteredLedger = useMemo(
    () => (usage?.ledger ?? []).filter((item) => (ledgerFilter === 'earned' ? roundCreditAmount(item.delta) > 0 : roundCreditAmount(item.delta) <= 0)),
    [ledgerFilter, usage?.ledger],
  )
  // 记录增量渲染：初始只展示 20 条，点「加载更多」每次 +20，避免一次性全量渲染卡顿
  const [visibleLedgerCount, setVisibleLedgerCount] = useState(20)
  useEffect(() => { setVisibleLedgerCount(20) }, [ledgerFilter])
  const visibleLedger = useMemo(() => filteredLedger.slice(0, visibleLedgerCount), [filteredLedger, visibleLedgerCount])
  const hasMoreLedger = filteredLedger.length > visibleLedgerCount

  useEffect(() => { if (!inviteOpen) setCopied(false) }, [inviteOpen])
  const copyInviteLink = useCallback(async () => {
    const url = referralQuery.data?.inviteUrl
    if (!url || !navigator.clipboard) return
    await navigator.clipboard.writeText(url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }, [referralQuery.data?.inviteUrl])
  const openInvite = useCallback(async () => {
    setInviteOpen(true)
    autoCopyInviteRef.current = true
    if (referralQuery.data?.inviteUrl && navigator.clipboard) {
      autoCopyInviteRef.current = false
      try { await navigator.clipboard.writeText(referralQuery.data.inviteUrl); setCopied(true) } catch { /* 弹窗仍提供显式复制 */ }
    }
  }, [referralQuery.data?.inviteUrl])
  useEffect(() => {
    if (!inviteOpen || !autoCopyInviteRef.current || !referralQuery.data?.inviteUrl) return
    autoCopyInviteRef.current = false
    void copyInviteLink()
  }, [copyInviteLink, inviteOpen, referralQuery.data?.inviteUrl])

  if (usageQuery.isLoading) {
    return <AccountLayout active="usage"><div className="flex min-h-[70vh] items-center justify-center"><LoaderCircle className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" /></div></AccountLayout>
  }
  if (!summary || !usage || usageQuery.isError) {
    return (
      <AccountLayout active="usage">
        <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-sm text-[var(--text-secondary)]">暂时无法读取额度信息。</p>
          <Button onClick={() => void usageQuery.refetch()}><RefreshCcw className="h-4 w-4" />重新加载</Button>
        </div>
      </AccountLayout>
    )
  }

  const dailyRemaining = Math.max(0, summary.dailyAllowance - summary.dailyUsed)
  return (
    <AccountLayout active="usage">
      <div className="px-5 py-9 sm:px-8 lg:px-12 lg:py-11">
        <div className="max-w-[1040px]">
          <header>
            <p className="text-xs text-[var(--text-tertiary)]">{summary.planLabel}</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-.03em]">用量明细</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">{summary.publicBetaEnabled ? '每日额度在 UTC+8 15:00 重置；邀请奖励独立累计，不随每日重置清零。' : '邀请奖励独立累计，长期有效。'}</p>
          </header>
          {summary.models.some(model => model.pricing) && <section className="mt-6 rounded-[16px] border border-[var(--border-subtle)] p-5" aria-label="当前分项费率">
            <h2 className="text-sm font-semibold">当前分项费率</h2>
            <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">单位为 Credits / 百万 Token，已含档位倍率。按非缓存输入、缓存输入和输出分别计算，每次调用合计后向上取整至 0.001 Credit；历史调用按原费率结算。</p>
            {summary.models.some(model => model.pricing?.v1CeilingMultiplier !== undefined) && <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">缓存输入按普通输入的25%计价，单次不超过冻结的原V1价格。调用前临时预留，实际结算后释放余量；单笔预留不超过25 Credits及余额的25%，最长30分钟。缺少最终用量但已收到输出时，按已发送输入与已收到输出估算并标注：ASCII字符约4个/Token，其他字符约1个/Token，向上取整；不计未收到的内部思考，未知缓存按优惠价。没有执行证据的记录保留待核，不按预留全额扣费。联网搜索每次2 Credits，缓存复用不重复收费。</p>}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs tabular-nums">
                <thead><tr>{['档位', '输入', '缓存输入', '输出'].map(label => <th key={label} className="px-2 py-2 font-medium">{label}</th>)}</tr></thead>
                <tbody>{summary.models.filter(model => model.pricing).map(model => <tr key={model.tier} className="border-t border-[var(--border-subtle)]">
                  <td className="px-2 py-2">{model.label}</td><td className="px-2 py-2">{model.pricing!.inputPerMillion}</td><td className="px-2 py-2">{model.pricing!.cachePerMillion}</td><td className="px-2 py-2">{model.pricing!.outputPerMillion}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </section>}
          <section className="mt-8 grid gap-4 xl:grid-cols-2">
            <article className="rounded-[16px] border border-[#e9e9e6] bg-white p-5 sm:p-6 dark:border-[var(--border-subtle)] dark:bg-[var(--surface-default)]">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold">{summary.publicBetaEnabled ? '每日公测额度' : '基础额度'}</h2>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">用于内置模型与 Agent 工具</p>
                </div>
                <span className="text-sm text-[var(--text-secondary)]">剩余 <strong className="text-[var(--text-primary)]">{formatCreditAmount(dailyRemaining)}</strong></span>
              </div>
              <p className="mt-7 text-xl font-semibold tabular-nums">
                {formatCreditAmount(summary.dailyUsed)} <span className="text-sm font-normal text-[var(--text-secondary)]">/ {formatCreditAmount(summary.dailyAllowance)}{summary.publicBetaEnabled ? ` · 已使用 ${summary.usedPercent}%` : ''}</span>
              </p>
              {summary.publicBetaEnabled ? <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#f0f0ee] dark:bg-[var(--border-subtle)]">
                <div className="h-full rounded-full bg-[#171b24] transition-[width] duration-500 dark:bg-white" style={{ width: `${Math.min(100, Math.max(0, summary.usedPercent))}%` }} />
              </div> : null}
              {summary.publicBetaEnabled ? <p className="mt-4 inline-flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]"><CalendarDays className="h-3.5 w-3.5" />下次重置 {resetLabel}</p> : null}
            </article>
            <article className="rounded-[16px] border border-[#e9e9e6] bg-white p-5 sm:p-6 dark:border-[var(--border-subtle)] dark:bg-[var(--surface-default)]">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold">奖励额度</h2>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">邀请奖励长期有效</p>
                </div>
                <span className="text-sm text-[var(--text-secondary)]">剩余 <strong className="text-[var(--text-primary)]">{formatCreditAmount(summary.bonusRemaining)}</strong></span>
              </div>
              <p className="mt-7 text-xl font-semibold tabular-nums">当前总可用 {formatCreditAmount(summary.totalRemaining)} Credits</p>
              {(summary.reserved ?? 0) > 0 && <p className="mt-2 text-xs text-[var(--text-secondary)]">余额 {formatCreditAmount(summary.balance ?? summary.totalRemaining)} · 待结算预留 {formatCreditAmount(summary.reserved ?? 0)} Credits（非最终扣费）</p>}
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#f0f0ee] dark:bg-[var(--border-subtle)]">
                <div className="h-full w-full rounded-full bg-emerald-500/75" />
              </div>
              <p className="mt-4 text-xs text-[var(--text-tertiary)]">{summary.publicBetaEnabled ? '奖励额度会在每日额度用完后继续抵扣。' : '奖励额度长期有效。'}</p>
            </article>
          </section>
          <section className="mt-5 flex flex-col justify-between gap-5 rounded-[16px] border border-[#e9e9e6] bg-white p-5 sm:flex-row sm:items-center sm:p-6 dark:border-[var(--border-subtle)] dark:bg-[var(--surface-default)]">
            <div className="flex items-start gap-3">
              <Gift className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <h2 className="text-base font-semibold">邀请好友获得额外额度</h2>
                <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">每位成功注册的新好友为你增加 300 Credits，不受每日重置影响。</p>
              </div>
            </div>
            <Button variant="primary" onClick={() => void openInvite()} className="sm:shrink-0"><UserPlus className="h-4 w-4" />邀请好友</Button>
          </section>
          <section className="mt-10">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold tracking-[-.02em]">Credits 记录</h2>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">已显示 {visibleLedger.length} / 最近 {filteredLedger.length} 条记录</p>
              </div>
              <div className="inline-flex rounded-[9px] bg-[#ececea] p-1 dark:bg-[var(--surface-muted)]">
                <button type="button" onClick={() => setLedgerFilter('used')} className={`h-8 rounded-[7px] px-3 text-xs transition-colors ${ledgerFilter === 'used' ? 'bg-white font-medium shadow-sm dark:bg-[var(--surface-default)]' : 'text-[var(--text-secondary)]'}`}>已使用</button>
                <button type="button" onClick={() => setLedgerFilter('earned')} className={`h-8 rounded-[7px] px-3 text-xs transition-colors ${ledgerFilter === 'earned' ? 'bg-white font-medium shadow-sm dark:bg-[var(--surface-default)]' : 'text-[var(--text-secondary)]'}`}>已获得</button>
              </div>
            </div>
            <div className="mt-4 overflow-hidden rounded-[16px] border border-[#e9e9e6] bg-white dark:border-[var(--border-subtle)] dark:bg-[var(--surface-default)]">
              {filteredLedger.length > 0 ? (
                <>
                  <ul>{visibleLedger.map((item) => <LedgerRow key={item.id} item={item} onTask={setTaskRunId} />)}</ul>
                  {hasMoreLedger ? (
                    <div className="border-t border-[#efefec] p-3 dark:border-[var(--border-subtle)]">
                      <button
                        type="button"
                        onClick={() => setVisibleLedgerCount((count) => count + 20)}
                        className="h-9 w-full rounded-[9px] text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[#f4f4f2] hover:text-[var(--text-primary)] dark:hover:bg-[var(--surface-muted)]"
                      >
                        加载更多记录（还剩 {filteredLedger.length - visibleLedgerCount} 条）
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="py-12 text-center text-sm text-[var(--text-tertiary)]">暂无{ledgerFilter === 'used' ? '使用' : '获得'}记录</div>
              )}
            </div>
          </section>
          {taskRunId && <TaskUsage key={taskRunId} runId={taskRunId} onClose={() => setTaskRunId(null)} />}
        </div>
      </div>
      <InviteCreditsDialog open={inviteOpen} referral={referralQuery.data ?? null} copied={copied} onCopy={() => void copyInviteLink()} onClose={() => { autoCopyInviteRef.current = false; setInviteOpen(false) }} />
    </AccountLayout>
  )
}
