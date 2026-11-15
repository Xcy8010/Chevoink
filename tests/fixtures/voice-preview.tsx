import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { CreditModelOption, CreditModelTier, ModelReasoningEffort } from '../../shared/contracts/index'
import { AgentVoiceInputBar } from '../../src/features/studio/agent/components/AgentVoiceInputBar'
import { AgentComposer } from '../../src/features/studio/agent/components/AgentComposer'
import { ToastProvider } from '../../src/components/ui/Toast'
import type { VoiceInputController, VoiceInputStatus } from '../../src/features/studio/agent/hooks/useVoiceInput'
import '../../src/index.css'

const noop = () => undefined
const asyncNoop = async () => undefined

function controller(state: VoiceInputStatus): VoiceInputController {
  return {
    state, status: state, active: state !== 'idle', modelReady: state !== 'needs-download', disabled: false,
    error: null, progress: 0.42, packProgress: state === 'downloading' ? 0.42 : null, elapsed: 12,
    // Fixed synthetic amplitudes for layout QA, not microphone measurements.
    levels: [0, 0.1, 0.2, 0.4, 0.2, 0.1, 0, 0.1, 0.3, 0.8, 0.6, 0.2, 0.4, 0.7, 0.4, 0.2, 0, 0.2, 0.5, 0.8, 0.6, 0.2, 0.1, 0, 0.2, 0.5, 0.3, 0.1],
    start: asyncNoop, stop: asyncNoop, cancel: noop, download: asyncNoop, cancelDownload: noop, removeModel: asyncNoop, deleteModel: asyncNoop,
  }
}

export function Preview() {
  const [tier, setTier] = useState<CreditModelTier>('speed')
  const [reasoning, setReasoning] = useState<Record<string, ModelReasoningEffort>>({})
  const models: CreditModelOption[] = (['lite', 'speed', 'standard', 'performance', 'ultimate', 'basic'] as const).map((tier, index) => ({ tier, label: ['轻量', '极速', '标准', '性能', '旗舰', '基础'][index], multiplier: index + 1, available: true, selectedByDefault: tier === 'speed', reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', visionEnabled: false }))
  return (
  <ToastProvider><main className="mx-auto max-w-xl space-y-5 p-2 text-[var(--text-primary)]">
    <h1 className="text-sm">语音栏布局测试 · 固定模拟状态，不是实录</h1>
    <section aria-label="完整 Composer">
      <h2 className="mb-2 text-xs">完整 Composer 工具条</h2>
      <AgentComposer
        novelId="preview" voiceScopeKey="preview:user:novel:task" running={false}
        onSend={noop} onStop={noop} creativeFreedom="balanced" onCreativeFreedomChange={noop}
        qualityMode="premium" modelTier={tier} modelOptions={models}
        onModelTierChange={setTier} customModels={[]} customModelId={null} onCustomModelChange={noop}
        reasoningSelections={reasoning} onReasoningEffortChange={(key, value) => setReasoning(previous => ({ ...previous, [key]: value }))} onOpenModelSettings={noop} referenceOptions={[]}
      />
    </section>
    {(['recording', 'transcribing', 'needs-download', 'downloading'] as const).map((state) => (
      <section key={state} aria-label={state} className="rounded-[20px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-2.5">
        <h2 className="mb-2 text-xs text-[var(--text-secondary)]">{state}</h2>
        <AgentVoiceInputBar voice={controller(state)} />
      </section>
    ))}
  </main></ToastProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Preview />)
