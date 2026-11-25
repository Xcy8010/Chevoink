import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, CalendarClock, Gift } from 'lucide-react'
import type { CreditAccountSummary, CreditActivityPayload } from '../../../../shared/contracts/credits'
import { fetchCreditActivity, fetchCreditUsage } from '@/features/account/credits-api'
import { formatCreditAmount } from '@/features/account/credit-format'
import { ledgerLabel } from '@/features/account/ledger-label'
import { isNativeApp } from '@/lib/native-app'
import { useStudioCredits } from '../hooks/useStudioCredits'

const clock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
})

function creditAmount(value: number) {
  return value > 0 && value < 0.5 ? '<1' : formatCreditAmount(value)
}

function ReadError({ label, retry }: { label: string; retry: () => void }) {
  return <div role="alert" className="studio-usage-notice">
    <span>{label}</span><button type="button" className="studio-settings-button" onClick={retry}>重试</button>
  </div>
}

function Balance({ account }: { account: CreditAccountSummary }) {
  const dailyLabel = account.publicBetaEnabled ? '每日额度' : '基础额度'
  const remainingPercent = account.dailyAllowance > 0
    ? Math.round(account.dailyRemaining / account.dailyAllowance * 100)
    : null

  return <section aria-label="额度余额" className="studio-usage-balance">
    <div className="studio-usage-total">
      <div><h2>当前可用额度</h2>
        <p className="studio-usage-amount">{creditAmount(account.totalRemaining)} <span>Credits</span></p>
      </div>
      <span className="studio-usage-plan">{account.planLabel}</span>
    </div>
    {account.reserved !== undefined && account.reserved > 0 && <p className="studio-usage-reserved">
      {account.balance !== undefined && <>账面余额 {creditAmount(account.balance)} · </>}
      待结算预留 {creditAmount(account.reserved)} Credits
    </p>}
    <div className="studio-usage-sources">
      <section className="studio-usage-source">
        <h3><CalendarClock size={16} aria-hidden="true" />{dailyLabel}</h3>
        <p className="studio-usage-source-amount">{creditAmount(account.dailyRemaining)} <span>{remainingPercent !== null && <>/ {creditAmount(account.dailyAllowance)} </>}Credits</span></p>
        {remainingPercent !== null && <div className="studio-usage-progress">
          <meter aria-label={dailyLabel + '剩余'} min={0} max={account.dailyAllowance} value={account.dailyRemaining}
            aria-valuetext={'剩余 ' + remainingPercent + '%'} />
          <span>剩余 {remainingPercent}%</span>
        </div>}
        <p className="studio-usage-source-note">{account.publicBetaEnabled
          ? <><time dateTime={account.resetsAt}>{clock.format(new Date(account.resetsAt))}</time> 重置（{account.resetTimeZone}）</>
          : <>已用 {creditAmount(account.dailyUsed)} Credits</>}</p>
      </section>
      <section className="studio-usage-source">
        <h3><Gift size={16} aria-hidden="true" />奖励额度</h3>
        <p className="studio-usage-source-amount">{creditAmount(account.bonusRemaining)} <span>Credits</span></p>
        <p className="studio-usage-source-note">长期有效</p>
      </section>
    </div>
  </section>
}

function RecentActivity({ stats }: { stats: CreditActivityPayload['stats'] }) {
  const [selected, setSelected] = useState<string | null>(null)
  const activity = new Map(stats.activity.map(day => [day.date, day]))
  const end = Date.parse(stats.activityEndsAt + 'T00:00:00Z')
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(end - (6 - index) * 86_400_000).toISOString().slice(0, 10)
    return activity.get(date) ?? { date, creditsSpent: 0, eventCount: 0 }
  }).filter(day => day.date >= stats.activityStartedAt)
  const total = days.reduce((sum, day) => sum + day.creditsSpent, 0)
  const peak = Math.max(0, ...days.map(day => day.creditsSpent))
  const selectedDay = days.find(day => day.date === selected)
  const shortDate = (date: string) => date.slice(5).replace('-', '/')

  return <div className="studio-usage-activity">
    <div className="studio-usage-chart-header">
      <div><p className="studio-usage-caption">近 7 天消耗</p>
        <p className="studio-usage-chart-total">{creditAmount(total)} <span>Credits</span></p></div>
      {days.length > 0 && <span className="studio-usage-caption">{shortDate(days[0].date)} – {shortDate(stats.activityEndsAt)}</span>}
    </div>
    {peak > 0 ? <>
      <div className="studio-usage-bars" role="group" aria-label="每日 Credits 消耗">
        {days.map(day => <button key={day.date} type="button" className="studio-usage-bar"
          aria-label={day.date + '，消耗 ' + creditAmount(day.creditsSpent) + ' Credits，' + day.eventCount + ' 次计费'}
          aria-pressed={day.date === selected} onClick={() => setSelected(day.date)}>
          <span className="studio-usage-bar-track" aria-hidden="true">
            <span style={{ height: (day.creditsSpent / peak * 100) + '%' }} />
          </span>
          <span>{shortDate(day.date)}</span>
        </button>)}
      </div>
      <p className="studio-usage-chart-detail" aria-live="polite">{selectedDay
        ? shortDate(selectedDay.date) + ' · ' + creditAmount(selectedDay.creditsSpent) + ' Credits · ' + selectedDay.eventCount + ' 次计费'
        : '按 UTC+8 汇总'}</p>
    </> : <p className="studio-usage-empty">最近 7 天没有消耗记录</p>}
    <dl className="studio-usage-stats">
      <div><dt>累计消耗</dt><dd>{creditAmount(stats.cumulativeSpent)} <span>Credits</span></dd></div>
      <div><dt>模型调用</dt><dd>{stats.totalModelCalls.toLocaleString('zh-CN')} <span>次</span></dd></div>
      <div><dt>活跃天数</dt><dd>{stats.activeDays.toLocaleString('zh-CN')} <span>天</span></dd></div>
    </dl>
  </div>
}

function UsageOverview() {
  const summary = useStudioCredits()
  const activity = useQuery({ queryKey: ['credits', 'activity'], queryFn: fetchCreditActivity, staleTime: 20_000 })

  return <>
    {summary.isError && <ReadError label="无法更新额度余额" retry={() => void summary.refetch()} />}
    {summary.data ? <Balance account={summary.data} /> : summary.isPending && <p role="status" className="studio-usage-notice">正在读取额度余额…</p>}
    <section aria-label="使用活动" className="studio-usage-section">
      <h2>使用活动</h2>
      {activity.isError && <ReadError label="无法更新使用活动" retry={() => void activity.refetch()} />}
      {activity.data ? <RecentActivity stats={activity.data.stats} /> : activity.isPending && <p role="status" className="studio-usage-notice">正在读取使用活动…</p>}
    </section>
  </>
}

type LedgerFilter = 'all' | 'out' | 'in'

function Ledger() {
  const ledger = useQuery({ queryKey: ['credits', 'usage'], queryFn: fetchCreditUsage, staleTime: 20_000 })
  const [filter, setFilter] = useState<LedgerFilter>('all')
  const [limit, setLimit] = useState(15)
  const rows = ledger.data?.ledger.filter(row => filter === 'all' || (filter === 'in' ? row.delta > 0 : row.delta < 0))

  return <section className="studio-usage-section" aria-label="额度流水">
    <div className="studio-usage-ledger-head">
      <h2>最近变动</h2>
      <select aria-label="流水类型" value={filter} onChange={event => {
        setFilter(event.target.value as LedgerFilter)
        setLimit(15)
      }}>
        <option value="all">全部变动</option><option value="out">支出</option><option value="in">收入</option>
      </select>
    </div>
    {ledger.isError && <ReadError label="无法更新额度流水" retry={() => void ledger.refetch()} />}
    {ledger.isPending && <p role="status" className="studio-usage-notice">正在读取额度流水…</p>}
    {rows && (rows.length > 0 ? <ul className="studio-usage-ledger">
      {rows.slice(0, limit).map(item => <li key={item.id}>
        <div><strong>{ledgerLabel(item)}</strong>
          <p><time dateTime={item.createdAt}>{clock.format(new Date(item.createdAt))}（UTC+8）</time>{item.estimatedUsage && ' · 估算结算'}</p></div>
        <span className="studio-usage-delta" data-income={item.delta > 0}>{item.delta > 0 ? '+' : item.delta < 0 ? '−' : ''}{creditAmount(Math.abs(item.delta))}</span>
      </li>)}
    </ul> : <p className="studio-usage-empty">{filter === 'all' ? '暂无额度流水' : filter === 'in' ? '暂无收入记录' : '暂无支出记录'}</p>)}
    <div className="studio-usage-ledger-actions">
      {rows && rows.length > limit && <button type="button" className="studio-settings-button" onClick={() => setLimit(limit + 15)}>加载更多</button>}
      <a href="/account/usage" target={isNativeApp() ? undefined : '_blank'} rel="noopener noreferrer">账户用量明细<ArrowUpRight size={14} aria-hidden="true" /></a>
    </div>
  </section>
}

export default function StudioUsageSettings() {
  const [view, setView] = useState<'overview' | 'ledger'>('overview')
  return <div className="studio-usage">
    <div className="studio-usage-tabs" role="group" aria-label="使用情况视图">
      <button type="button" aria-pressed={view === 'overview'} onClick={() => setView('overview')}>额度概览</button>
      <button type="button" aria-pressed={view === 'ledger'} onClick={() => setView('ledger')}>额度流水</button>
    </div>
    {view === 'overview' ? <UsageOverview /> : <Ledger />}
  </div>
}
