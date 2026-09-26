import { useVoiceInput } from '../agent/hooks/useVoiceInput'

export default function VoicePackSettings() {
  const voice = useVoiceInput({ scopeKey: 'studio-voice-pack-settings', disabled: false, onTranscript: () => undefined })
  const busy = ['checking', 'downloading', 'deleting'].includes(voice.state)
  return (
    <section aria-label="语言包" className="space-y-4">
      <p className="text-sm font-medium">本机语音包</p>
      <p role="status" className="text-xs text-[var(--text-secondary)]">
        {voice.state === 'checking' ? '正在检查…' : voice.state === 'downloading' ? `正在下载 ${Math.round(voice.progress * 100)}%` : voice.state === 'deleting' ? '正在删除…' : voice.modelReady ? '已下载' : '未下载'}
      </p>
      {voice.error ? <p role="alert" className="text-xs text-red-500">{voice.error}</p> : null}
      <button type="button" disabled={busy} onClick={() => { void (voice.modelReady ? voice.removeModel() : voice.download()) }} className="min-h-11 rounded-lg border border-[var(--border-subtle)] px-4 text-sm disabled:opacity-50">
        {voice.modelReady ? '删除本机语音包' : '下载本机语音包'}
      </button>
      {voice.state === 'downloading' ? <button type="button" onClick={voice.cancel} className="ml-3 min-h-11 px-3 text-sm">取消下载</button> : null}
    </section>
  )
}
