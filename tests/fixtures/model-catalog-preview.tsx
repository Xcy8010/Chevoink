import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '../../src/components/ui/Toast'
import { AgentComposer } from '../../src/features/studio/agent/components/AgentComposer'
import { BUILT_IN_MODEL_TIERS, type CreditModelOption, type CreditModelTier, type ModelReasoningEffort } from '../../shared/contracts/credits'
import { modelPublicCopy } from '../../shared/model-public-copy'
import '../../src/index.css'

// Public synthetic fixture: actual composer and popup; no backend, provider or manuscript data.
const query = new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark', query.has('dark'))
document.documentElement.classList.toggle('light', !query.has('dark'))
window.fetch = async () => new Response(JSON.stringify({ success: false, error: { code: 'LOCAL_PREVIEW_ONLY', message: '本地交互预览不调用真实接口。' } }), { status: 403, headers: { 'content-type': 'application/json' } })
const options: CreditModelOption[] = BUILT_IN_MODEL_TIERS.map((tier, index) => ({
  ...modelPublicCopy(tier, null), tier, label: ['轻量', '极速', '标准', '性能', '极致'][index],
  multiplier: [0, query.has('promotion') ? 0.9 : 1.5, 1.2, 1.6, 2.5][index], baseMultiplier: [0, query.has('promotion') ? 1.8 : 1.5, 1.2, 1.6, 2.5][index],
  available: true, selectedByDefault: tier === 'speed', reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', visionEnabled: false,
  ...(tier === 'speed' && query.has('promotion') ? { activity: { name: '夜间折扣', revision: 1, timezone: 'Asia/Shanghai' as const, asOf: '2026-11-07T00:00:00Z', nextSwitchAt: '2026-11-08T00:00:00Z', rules: [] } } : {}),
}))
export function Preview() {
  const [tier, setTier] = useState<CreditModelTier>('speed')
  const [efforts, setEfforts] = useState<Record<string, ModelReasoningEffort>>({})
  const [lastAction, setLastAction] = useState('尚未选择')
  return <main className="studio-workspace min-h-screen bg-[var(--surface-default)] p-6 text-[var(--text-primary)]">
    <header style={{ maxWidth: 860, marginInline: 'auto' }} className="flex items-center justify-between gap-4 text-sm"><span>模型选择交互预览 · 合成数据</span><a href={query.has('dark') ? '?' : '?dark'} className="underline">切换主题</a></header>
    <section className="mx-auto mt-20 max-w-[720px] space-y-5 leading-8 text-[var(--text-secondary)]"><h1 className="text-xl font-semibold text-[var(--text-primary)]">把想法写成故事</h1><p>选择适合当前创作的模型，构思情节、整理线索，或打磨一段文字。</p><output role="status">{lastAction}</output></section>
    <div style={{ position: 'fixed', width: 'min(860px, calc(100vw - 32px))', left: '50%', transform: 'translateX(-50%)', bottom: 20 }} className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-default)] p-3 shadow-lg">
      <AgentComposer novelId="public-model-preview" voiceScopeKey="public-model-preview" voiceDisabled running={false} onSend={() => setLastAction('仅本地预览，不发送内容')} onStop={() => {}} creativeFreedom="balanced" onCreativeFreedomChange={() => {}} qualityMode="premium"
        modelTier={tier} modelOptions={options} onModelTierChange={value => { setTier(value); setLastAction('已选择：' + (options.find(option => option.tier === value)?.label ?? '自定义模型')) }}
        customModels={[]} customModelId={null} onCustomModelChange={() => {}} reasoningSelections={efforts}
        onReasoningEffortChange={(key, effort) => { setEfforts(value => ({ ...value, [key]: effort })); setLastAction('已调整思考强度') }}
        onOpenModelSettings={() => setLastAction('自定义模型设置入口')} referenceOptions={[]} />
    </div>
  </main>
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider><Preview /></ToastProvider></QueryClientProvider>)
