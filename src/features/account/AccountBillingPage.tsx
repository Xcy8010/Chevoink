import { useQuery } from '@tanstack/react-query'
import { ChevronDown, LoaderCircle, ReceiptText, RefreshCcw } from 'lucide-react'
import { useMemo, useState } from 'react'

import Button from '@/components/ui/Button'
import AccountLayout from './AccountLayout'
import { fetchCreditUsage } from './credits-api'
import { formatCreditAmount, roundCreditAmount } from './credit-format'
import { ledgerLabel } from './ledger-label'
import type { CreditLedgerItem } from '../../../shared/contracts'

/** 账单口径与每日额度一致，按 UTC+8 自然月聚合 */
function monthKey(value: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date(value))
  return parts
}

function monthLabel(key: string): string {
  const [year, month] = key.split('-')
  return `${year} 年 ${Number(month)} 月`
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

type MonthGroup = {
  key: string
  items: CreditLedgerItem[]
  used: number
  earned: number
}

function BillingRow({ item }: { item: CreditLedgerItem }) {
  const displayedDelta = roundCreditAmount(item.delta)
  const positive = displayedDelta > 0
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-[#efefec] px-5 py-3.5 last:border-b-0 dark:border-[var(--border-subtle)]">
      <div className="min-w-0">
        <p className="truncate text-sm">{ledgerLabel(item)}</p>
        <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{formatTime(item.createdAt)}</p>
      </div>
      <span className={`text-sm font-medium tabular-nums ${positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--text-primary)]'}`}>
        {positive ? '+' : ''}{formatCreditAmount(displayedDelta)}
      </span>
    </li>
  )
}

export default function AccountBillingPage() {
  const usageQuery = useQuery({ queryKey: ['credits', 'usage'], queryFn: fetchCreditUsage, staleTime: 20_000 })
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(() => new Set())

  const groups = useMemo<MonthGroup[]>(() => {
    const ledger = usageQuery.data?.ledger ?? []
    const byMonth = new Map<string, CreditLedgerItem[]>()
    for (const item of ledger) {
      const key = monthKey(item.createdAt)
      const bucket = byMonth.get(key)
      if (bucket) bucket.push(item)
      else byMonth.set(key, [item])
    }
    return [...byMonth.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, items]) => ({
        key,
        items,
        used: items.reduce((sum, item) => {
          const delta = roundCreditAmount(item.delta)
          return delta <= 0 ? sum + -delta : sum
        }, 0),
        earned: items.reduce((sum, item) => {
          const delta = roundCreditAmount(item.delta)
          return delta > 0 ? sum + delta : sum
        }, 0),
      }))
  }, [usageQuery.data?.ledger])

  const currentKey = monthKey(new Date().toISOString())
  const current = groups.find((group) => group.key === currentKey)
  const totalUsed = groups.reduce((sum, group) => sum + group.used, 0)
  const totalEarned = groups.reduce((sum, group) => sum + group.earned, 0)

  function toggleMonth(key: string) {
    setExpandedMonths((currentSet) => {
      const next = new Set(currentSet)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (usageQuery.isLoading) {
    return <AccountLayout active="billing"><div className="flex min-h-[70vh] items-center justify-center"><LoaderCircle className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" /></div></AccountLayout>
  }
  if (usageQuery.isError || !usageQuery.data) {
    return (
      <AccountLayout active="billing">
        <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-sm text-[var(--text-secondary)]">暂时无法读取账单记录。</p>
          <Button onClick={() => void usageQuery.refetch()}><RefreshCcw className="h-4 w-4" />重新加载</Button>
        </div>
      </AccountLayout>
    )
  }

  return (
    <AccountLayout active="billing">
      <div className="px-5 py-9 sm:px-8 lg:px-12 lg:py-11">
        <div className="max-w-[1040px]">
          <header>
            <h1 className="text-2xl font-semibold tracking-[-.02em]">我的账单</h1>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">Credits 消耗与获得按 UTC+8 自然月汇总，展开月份可查看逐条明细。</p>
            <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">联网搜索与供应商网页抓取分别按成功请求计费：每次基础 2 Credits × 各自工具倍率。缓存复用、网页直读、失败、超时及空搜索不收工具费；预扣会退回。模型阅读结果的 Token 按所选模型另计。</p>
          </header>
          <section className="mt-8 grid gap-4 sm:grid-cols-3">
            <article className="rounded-[16px] border border-[#e9e9e6] bg-white p-5 dark:border-[var(--border-subtle)] dark:bg-[var(--surface-default)]">
              <p className="text-xs text-[var(--text-tertiary)]">本月已消耗</p>
              <p className="mt-2 text-xl font-semibold tabular-nums">{formatCreditAmount(current?.used ?? 0)} <span className="text-xs font-normal text-[var(--text-secondary)]">Credits</span></p>
            </article>
            <article className="rounded-[16px] border border-[#e9e9e6] bg-white p-5 dark:border-[var(--border-subtle)] dark:bg-[var(--surface-default)]">
              <p className="text-xs text-[var(--text-tertiary)]">本月已获得</p>
              <p className="mt-2 text-xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">+{formatCreditAmount(current?.earned ?? 0)} <span className="text-xs font-normal text-[var(--text-secondary)]">Credits</span></p>
            </article>
            <article className="rounded-[16px] border border-[#e9e9e6] bg-white p-5 dark:border-[var(--border-subtle)] dark:bg-[var(--surface-default)]">
              <p className="text-xs text-[var(--text-tertiary)]">累计（近 {usageQuery.data.ledger.length} 条记录）</p>
              <p className="mt-2 text-xl font-semibold tabular-nums">{formatCreditAmount(totalUsed)} <span className="text-xs font-normal text-[var(--text-secondary)]">消耗 / +{formatCreditAmount(totalEarned)} 获得</span></p>
            </article>
          </section>
          <section className="mt-8 space-y-4">
            {groups.length === 0 ? (
              <div className="rounded-[16px] border border-[#e9e9e6] bg-white py-16 text-center dark:border-[var(--border-subtle)] dark:bg-[var(--surface-default)]">
                <ReceiptText className="mx-auto h-6 w-6 text-[var(--text-tertiary)]" />
                <p className="mt-3 text-sm text-[var(--text-secondary)]">还没有产生任何 Credits 记录。</p>
              </div>
            ) : groups.map((group) => {
              const expanded = expandedMonths.has(group.key)
              return (
                <article key={group.key} className="overflow-hidden rounded-[16px] border border-[#e9e9e6] bg-white dark:border-[var(--border-subtle)] dark:bg-[var(--surface-default)]">
                  <button
                    type="button"
                    onClick={() => toggleMonth(group.key)}
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-[#fafaf8] dark:hover:bg-[var(--surface-muted)]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{monthLabel(group.key)}</p>
                      <p className="mt-1 text-xs text-[var(--text-tertiary)]">{group.items.length} 条记录</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-4 text-sm tabular-nums">
                      <span className="text-[var(--text-secondary)]">消耗 {formatCreditAmount(group.used)}</span>
                      {group.earned > 0 ? <span className="text-emerald-600 dark:text-emerald-400">+{formatCreditAmount(group.earned)}</span> : null}
                      <ChevronDown className={`h-4 w-4 text-[var(--text-tertiary)] transition-transform ${expanded ? 'rotate-180' : ''}`} />
                    </div>
                  </button>
                  {expanded ? (
                    <ul className="border-t border-[#efefec] dark:border-[var(--border-subtle)]">
                      {group.items.map((item) => <BillingRow key={item.id} item={item} />)}
                    </ul>
                  ) : null}
                </article>
              )
            })}
          </section>
        </div>
      </div>
    </AccountLayout>
  )
}
