import { prepareVoiceModel } from './speech-engine'

export const VOICE_PACK_CHANGED = 'chevoink:voice-pack-changed'
// Both the installed artifact and the legacy entry use this immutable public resource.
// Bump its URL version and digest together when the worklet changes.
export const CAPTURE_WORKLET_URL = '/voice-capture-worklet.js?v=1'
const CAPTURE_WORKLET_SHA256 = '4b2fa0df2f96f020da5808431b16a71866c834e5364282e784007f13657dcd62'

let download: { controller: AbortController; promise: Promise<void> } | undefined
let progress: number | null = null
const listeners = new Set<() => void>()

export const voicePackProgress = () => progress
export function subscribeVoicePackProgress(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function publishProgress(value: number | null) {
  progress = value
  for (const listener of listeners) listener()
}

async function warmCaptureWorklet(signal: AbortSignal) {
  const response = await fetch(CAPTURE_WORKLET_URL, { cache: 'force-cache', mode: 'same-origin', credentials: 'same-origin', signal })
  if (!response.ok) throw new Error('录音组件下载失败，请联网重试。')
  const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer())
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
  if (hash !== CAPTURE_WORKLET_SHA256) throw new Error('录音组件校验失败，请刷新页面后重试。')
}

/** A download belongs to the app, so changing or unmounting a composer leaves it running. */
export function downloadVoicePack(): Promise<void> {
  if (download) return download.promise
  const controller = new AbortController()
  const { signal } = controller
  const promise = warmCaptureWorklet(signal).then(() => {
    signal.throwIfAborted()
    return prepareVoiceModel(value => {
      if (!signal.aborted && Number.isFinite(value)) publishProgress(Math.max(0, Math.min(0.999, value)))
    }, signal)
  }).then(() => { signal.throwIfAborted() }).finally(() => {
    download = undefined
    publishProgress(null)
    window.dispatchEvent(new Event(VOICE_PACK_CHANGED))
  })
  download = { controller, promise }
  publishProgress(0)
  return promise
}

export function cancelVoicePackDownload() {
  download?.controller.abort()
}
