import { useQuery } from '@tanstack/react-query'
import { fetchPublicCreditPolicy } from './credits-api'
import { Check, Megaphone, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'

import AccountLayout from './AccountLayout'

const PLAN_FEATURES = [
  '每日公测 Credits 额度，UTC+8 15:00 自动重置',
  '内置文本模型与写作 Agent 全能力',
  '多窗口协作：主窗口调度子窗口并行写章',
  'AI 封面生成与联网搜索工具',
  '阅读、书架、划线笔记与听书',
  '社区发帖、互动与私聊',
]

export default function AccountPlanPage() {
  const policy = useQuery({ queryKey: ['credits', 'public-policy'], queryFn: fetchPublicCreditPolicy, staleTime: 20_000, refetchInterval: 60_000 })
  const betaEnabled = policy.data?.publicBetaEnabled === true
  const planLabel = policy.data?.planLabel ?? '—'
  return (
    <AccountLayout withSidebar={false}>
      <div className="px-5 py-12 sm:px-8 lg:px-14 lg:py-16">
        <div className="mx-auto max-w-[1080px]">
          <h1 className="text-3xl font-semibold tracking-[-.03em] sm:text-4xl">价格</h1>
          <div className="mt-5 space-y-2">
            <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
              <Megaphone className="h-4 w-4 shrink-0" />
              {policy.isError ? '暂时无法读取套餐。' : `${planLabel}：无需付费、无需绑卡。`}
            </p>
            <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
              <Megaphone className="h-4 w-4 shrink-0" />
              邀请好友注册可叠加长期有效的奖励额度，不受每日重置影响。
            </p>
          </div>

          <div className="mt-12 grid gap-5 md:grid-cols-2">
            <article className="flex flex-col rounded-[18px] border border-emerald-600/40 bg-white p-6 sm:p-7 dark:border-emerald-400/35 dark:bg-[var(--surface-default)]">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">{planLabel}</h2>
                <span className="rounded-full bg-emerald-600/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">当前套餐</span>
              </div>
              <p className="mt-4 text-3xl font-semibold tabular-nums">¥0 <span className="text-sm font-normal text-[var(--text-secondary)]">/ 月</span></p>
              <p className="mt-2 text-xs text-[var(--text-tertiary)]">{betaEnabled ? '注册即享，公测期结束前持续有效' : '注册即享'}</p>
              <p className="mt-6 text-xs text-[var(--text-tertiary)]">包括：</p>
              <ul className="mt-3 space-y-2.5">
                {PLAN_FEATURES.filter((_, index) => betaEnabled || index !== 0).map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-7">
                <button type="button" disabled className="h-10 w-full cursor-default rounded-[10px] bg-[#ececea] text-sm font-medium text-[var(--text-secondary)] dark:bg-[var(--surface-muted)]">
                  你当前的订阅计划
                </button>
              </div>
            </article>
            <article className="flex flex-col rounded-[18px] border border-dashed border-[#d9d9d5] bg-transparent p-6 sm:p-7 dark:border-[var(--border-subtle)]">
              <h2 className="text-lg font-semibold text-[var(--text-secondary)]">更多套餐</h2>
              <p className="mt-4 text-sm leading-6 text-[var(--text-tertiary)]">{betaEnabled ? '公测结束后，我们会推出' : '后续计划推出'}面向重度创作者的付费套餐：更高的每日额度、更长的上下文与优先体验权。</p>
              <ul className="mt-5 space-y-2.5">
                {['更高每日额度与奖励额度池', '优先体验新模型与新功能', betaEnabled ? '公测用户的优惠续订通道' : '参与过公测的用户优惠续订通道'].map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-[var(--text-tertiary)]">
                    <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-7">
                <Link to="/account/docs?doc=plan" className="flex h-10 w-full items-center justify-center rounded-[10px] border border-[#e0e0dc] text-sm text-[var(--text-secondary)] transition-colors hover:bg-[#efefec] dark:border-[var(--border-subtle)] dark:hover:bg-[var(--surface-muted)]">
                  了解套餐规划
                </Link>
              </div>
            </article>
          </div>

          <p className="mt-8 text-xs leading-6 text-[var(--text-tertiary)]">{planLabel}额度用于内置模型与 Agent 工具调用；额度明细与消耗记录可在<Link to="/account/usage" className="mx-1 text-[var(--text-secondary)] underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--text-primary)]">用量明细</Link>查看。</p>
        </div>
      </div>
    </AccountLayout>
  )
}
