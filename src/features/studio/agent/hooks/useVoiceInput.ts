import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { registerDesktopSave } from '@/lib/desktop-lifecycle'
import {
  deleteVoiceModel,
  disposeVoiceEngine,
  getVoiceModelStatus,
  prepareVoiceModel,
  transcribeAudio,
} from '../voice/speech-engine'

export type VoiceInputStatus = 'checking' | 'idle' | 'needs-download' | 'downloading' | 'requesting-permission' | 'recording' | 'transcribing' | 'deleting' | 'error'
export type VoiceInputOptions = { scopeKey: string; disabled: boolean; onTranscript: (text: string) => void; onNotice?: (message: string) => void }
export type VoiceInputController = {
  state: VoiceInputStatus
  /** Composer compatibility alias of state. */
  status: VoiceInputStatus
  active: boolean
  error: string | null
  progress: number
  elapsed: number
  levels: number[]
  modelReady: boolean
  disabled: boolean
  start: () => Promise<void>
  stop: () => Promise<void>
  cancel: () => void
  download: () => Promise<void>
  removeModel: () => Promise<void>
  /** Composer compatibility alias of removeModel. */
  deleteModel: () => Promise<void>
}

type Capture = {
  context: AudioContext
  stream?: MediaStream
  source?: MediaStreamAudioSourceNode
  worklet?: AudioWorkletNode
  timer?: ReturnType<typeof setInterval>
  flushTimer?: ReturnType<typeof setTimeout>
  finishFlush?: () => void
  chunks: Float32Array[]
  levels: number[]
  frames: number
  stopped: boolean
}

const MAX_SECONDS = 60
const EMPTY_LEVELS = Array<number>(28).fill(0)
const CAPTURE_WORKLET_URL = `${import.meta.env.BASE_URL}voice-capture-worklet.js?v=1`
// Bump the URL version and digest together whenever the public worklet changes.
const CAPTURE_WORKLET_SHA256 = '4b2fa0df2f96f020da5808431b16a71866c834e5364282e784007f13657dcd62'

async function prepareCaptureWorklet(signal: AbortSignal, cache: RequestCache = 'force-cache') {
  // The exact URL has immutable HTTP caching at the production origin. Do not use
  // Blob URLs (CSP), or rely on the model's CacheStorage to cache addModule requests.
  const response = await fetch(CAPTURE_WORKLET_URL, { cache, mode: 'same-origin', credentials: 'same-origin', signal })
  if (!response.ok) throw new Error('录音组件下载失败，请联网重试。')
  const bytes = await response.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
  if (hash !== CAPTURE_WORKLET_SHA256) throw new Error('录音组件校验失败，请刷新页面并重新下载。')
}

function stopTracks(capture: Capture) {
  capture.stream?.getTracks().forEach((track) => {
    track.onended = null
    track.stop()
  })
}

function releaseCapture(capture: Capture) {
  clearInterval(capture.timer)
  clearTimeout(capture.flushTimer)
  capture.finishFlush?.()
  capture.context.onstatechange = null
  stopTracks(capture)
  if (capture.worklet) {
    capture.worklet.port.onmessage = null
    capture.worklet.onprocessorerror = null
    capture.worklet.port.close()
    capture.worklet.disconnect()
  }
  capture.source?.disconnect()
  if (capture.context.state !== 'closed') void capture.context.close().catch(() => undefined)
  capture.chunks = []
}

function errorMessage(error: unknown): string {
  // DOMException may not inherit from this realm's Error (Safari/iframes/test DOM).
  if (error && typeof error === 'object') {
    const name = 'name' in error ? error.name : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') return '无法使用麦克风，请在浏览器或系统设置中允许麦克风权限后重试。'
    if (name === 'NotFoundError') return '没有找到麦克风，请连接设备后重试。'
    if (name === 'NotReadableError') return '麦克风可能被其他应用占用，请关闭占用后重试。'
    if ('message' in error && typeof error.message === 'string' && error.message) return error.message
  }
  return '语音输入失败，请重试。'
}

/** Local PCM capture only. The sole output is a draft callback, never a send action. */
export function useVoiceInput(options: VoiceInputOptions): VoiceInputController {
  const modelEventSource = useRef(Symbol('voice-pack-owner'))
  const [status, setStatus] = useState<VoiceInputStatus>('checking')
  const desktopStatus = useRef(status)
  desktopStatus.current = status
  useEffect(() => registerDesktopSave(() => !['requesting-permission', 'recording', 'transcribing', 'downloading', 'deleting'].includes(desktopStatus.current)), [])
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [levels, setLevels] = useState(EMPTY_LEVELS)
  const [modelReady, setModelReady] = useState(false)
  const latest = useRef(options)
  const mounted = useRef(false)
  const generation = useRef(0)
  const phase = useRef<VoiceInputStatus>('checking')
  const ready = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const ownsEngine = useRef(false)
  const capture = useRef<Capture | null>(null)
  const stopRef = useRef<() => Promise<void>>(async () => undefined)

  const transition = useCallback((next: VoiceInputStatus) => {
    phase.current = next
    if (mounted.current) setStatus(next)
  }, [])

  const invalidate = useCallback(() => {
    generation.current += 1
    const active = controller.current
    controller.current = null
    active?.abort()
    if (ownsEngine.current) disposeVoiceEngine()
    ownsEngine.current = false
    if (capture.current) releaseCapture(capture.current)
    capture.current = null
  }, [])

  const cancel = useCallback(() => {
    invalidate()
    transition('idle')
    if (mounted.current) {
      setError(null)
      setProgress(0)
      setElapsed(0)
      setLevels(EMPTY_LEVELS)
    }
  }, [invalidate, transition])

  const valid = useCallback((id: number, scope: string) => mounted.current && generation.current === id && latest.current.scopeKey === scope && !latest.current.disabled, [])

  const fail = useCallback((cause: unknown) => {
    invalidate()
    if (mounted.current) {
      const message = errorMessage(cause)
      if (latest.current.onNotice) { latest.current.onNotice(message); setError(null) }
      else setError(message)
      setLevels(EMPTY_LEVELS)
    }
    transition(latest.current.onNotice ? 'idle' : 'error')
  }, [invalidate, transition])

  useLayoutEffect(() => { latest.current = options })

  useLayoutEffect(() => {
    mounted.current = true
    cancel()
    const cacheCheck = new AbortController()
    transition('checking')
    // Cache inspection never downloads model assets or requests microphone access.
    let refreshSequence = 0
    const refreshModel = (event?: Event) => {
      if (event instanceof CustomEvent && event.detail === modelEventSource.current) return
      if (!['idle', 'checking', 'needs-download', 'error'].includes(phase.current)) return
      const id = generation.current
      const refresh = ++refreshSequence
      void getVoiceModelStatus().then(async (available) => {
      if (!mounted.current || id !== generation.current || refresh !== refreshSequence) return
      // HTTP cache can be evicted independently from the engine's CacheStorage.
      // only-if-cached guarantees mount/scope changes never silently download.
      if (available) {
        try { await prepareCaptureWorklet(cacheCheck.signal, 'only-if-cached') } catch { available = false }
      }
      if (!mounted.current || id !== generation.current || refresh !== refreshSequence) return
      ready.current = available
      setModelReady(available)
      if (phase.current === 'checking' || (available && phase.current === 'needs-download')) transition('idle')
    }).catch((cause: unknown) => {
      if (mounted.current && id === generation.current) fail(cause)
    })
    }
    refreshModel()
    window.addEventListener('chevoink:voice-pack-changed', refreshModel)
    const onHidden = () => { if (document.hidden) cancel() }
    const onPageHide = () => cancel()
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      mounted.current = false
      cacheCheck.abort()
      invalidate()
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('chevoink:voice-pack-changed', refreshModel)
    }
  }, [options.scopeKey, options.disabled, cancel, fail, invalidate, transition])

  const download = useCallback(async () => {
    if (latest.current.disabled || document.hidden || !['idle', 'needs-download', 'error'].includes(phase.current)) return
    invalidate()
    const id = generation.current
    const scope = latest.current.scopeKey
    const abort = new AbortController()
    controller.current = abort
    ownsEngine.current = true
    setError(null)
    setProgress(0)
    transition('downloading')
    try {
      await prepareVoiceModel((value) => {
        if (valid(id, scope) && Number.isFinite(value)) setProgress(Math.min(1, Math.max(0, value)))
      }, abort.signal)
      if (!valid(id, scope)) return
      await prepareCaptureWorklet(abort.signal)
      if (!valid(id, scope)) return
      ready.current = true
      setModelReady(true)
      setProgress(1)
      controller.current = null
      ownsEngine.current = false
      transition('idle')
      window.dispatchEvent(new CustomEvent('chevoink:voice-pack-changed', { detail: modelEventSource.current }))
    } catch (cause) {
      if (valid(id, scope)) fail(cause)
    }
  }, [fail, invalidate, transition, valid])

  const deleteModel = useCallback(async () => {
    if (latest.current.disabled || phase.current === 'deleting') return
    invalidate()
    const id = generation.current
    const scope = latest.current.scopeKey
    ready.current = false
    setModelReady(false)
    setError(null)
    transition('deleting')
    try {
      disposeVoiceEngine()
      await deleteVoiceModel()
      if (!valid(id, scope)) return
      setProgress(0)
      transition('needs-download')
      window.dispatchEvent(new CustomEvent('chevoink:voice-pack-changed', { detail: modelEventSource.current }))
    } catch (cause) {
      if (valid(id, scope)) fail(cause)
    }
  }, [fail, invalidate, transition, valid])

  const stop = useCallback(async () => {
    const recording = capture.current
    if (phase.current !== 'recording' || !recording) return
    if (document.hidden || latest.current.disabled) { cancel(); return }
    const id = generation.current
    const scope = latest.current.scopeKey
    transition('transcribing')
    clearInterval(recording.timer)
    recording.context.onstatechange = null
    stopTracks(recording)
    try {
      // Preserve the last partial PCM block; disconnect only after the worklet acknowledges.
      if (!recording.stopped) await new Promise<void>((resolve, reject) => {
        recording.finishFlush = resolve
        recording.flushTimer = setTimeout(() => reject(new Error('录音设备未响应，请重新录制。')), 1500)
        recording.worklet?.port.postMessage({ type: 'stop' })
      })
      if (!valid(id, scope)) return
      const samples = new Float32Array(recording.frames)
      let offset = 0
      for (const chunk of recording.chunks) { samples.set(chunk, offset); offset += chunk.length }
      const sampleRate = recording.context.sampleRate
      releaseCapture(recording)
      capture.current = null
      setLevels(EMPTY_LEVELS)
      if (!samples.length) throw new Error('没有录到音频，请重新录制。')
      ownsEngine.current = true
      const text = await transcribeAudio(samples, sampleRate, controller.current?.signal)
      if (!valid(id, scope) || document.hidden) return
      controller.current = null
      disposeVoiceEngine()
      ownsEngine.current = false
      transition('idle')
      setElapsed(0)
      if (text.trim()) latest.current.onTranscript(text.trim())
      else if (latest.current.onNotice) latest.current.onNotice('没有识别到语音，请靠近麦克风后重试。')
      else { setError('没有识别到语音，请靠近麦克风后重试。'); transition('error') }
    } catch (cause) {
      if (valid(id, scope)) fail(cause)
    }
  }, [cancel, fail, transition, valid])

  useLayoutEffect(() => { stopRef.current = stop }, [stop])

  const start = useCallback(async () => {
    if (latest.current.disabled || document.hidden || !['checking', 'idle', 'error', 'needs-download'].includes(phase.current)) return
    if (!ready.current) { setError(null); transition('needs-download'); return }
    invalidate()
    const id = generation.current
    const scope = latest.current.scopeKey
    controller.current = new AbortController()
    setError(null)
    setElapsed(0)
    setLevels(EMPTY_LEVELS)
    transition('requesting-permission')
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) {
        throw new Error('当前环境不支持设备端录音，请使用 HTTPS 下的新版浏览器或更新应用。')
      }
      const context = new AudioContext()
      const recording: Capture = { context, chunks: [], levels: [...EMPTY_LEVELS], frames: 0, stopped: false }
      capture.current = recording
      if (!context.audioWorklet) throw new Error('当前浏览器不支持设备端录音，请更新浏览器或应用。')
      // resume must be initiated during the original click, before awaiting permission (iOS).
      await Promise.all([
        context.resume(),
        context.audioWorklet.addModule(CAPTURE_WORKLET_URL, { credentials: 'same-origin' }),
        navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false }).then((stream) => {
          if (!valid(id, scope)) { stream.getTracks().forEach((track) => track.stop()); return }
          recording.stream = stream
        }),
      ])
      if (!valid(id, scope)) return
      const worklet = new AudioWorkletNode(context, 'voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      recording.worklet = worklet
      worklet.port.onmessage = (event: MessageEvent<{ type: string; samples?: Float32Array }>) => {
        if (!valid(id, scope)) return
        if (event.data.type === 'pcm' && event.data.samples instanceof Float32Array) {
          const remaining = Math.max(0, Math.floor(context.sampleRate * MAX_SECONDS) - recording.frames)
          const chunk = event.data.samples.subarray(0, remaining)
          if (!chunk.length) return
          recording.chunks.push(chunk)
          recording.frames += chunk.length
          let energy = 0
          for (const value of chunk) energy += value * value
          const rms = Math.min(1, Math.sqrt(energy / chunk.length) * 4)
          // Audio packets arrive ~24 times/second at 48 kHz; publish to React only at 10 Hz.
          recording.levels.shift()
          recording.levels.push(rms)
        } else if (event.data.type === 'stopped') {
          recording.stopped = true
          recording.finishFlush?.()
          if (phase.current === 'recording') void stopRef.current()
        }
      }
      worklet.onprocessorerror = () => { if (valid(id, scope)) fail(new Error('录音处理失败，请重试。')) }
      recording.source = context.createMediaStreamSource(recording.stream!)
      recording.source.connect(worklet)
      // The worklet writes silence to its output, so this keeps processing alive without feedback.
      worklet.connect(context.destination)
      recording.stream!.getTracks().forEach((track) => {
        track.onended = () => { if (valid(id, scope)) fail(new Error('麦克风已断开，请重新录制。')) }
      })
      context.onstatechange = () => {
        if (valid(id, scope) && phase.current === 'recording' && context.state !== 'running') cancel()
      }
      transition('recording')
      const started = performance.now()
      recording.timer = setInterval(() => {
        if (!valid(id, scope)) return
        const seconds = Math.min(MAX_SECONDS, (performance.now() - started) / 1000)
        setElapsed(Math.floor(seconds))
        setLevels([...recording.levels])
        if (seconds >= MAX_SECONDS) void stopRef.current()
      }, 100)
    } catch (cause) {
      if (valid(id, scope)) fail(cause)
    }
  }, [cancel, fail, invalidate, transition, valid])

  return { state: status, status, active: status !== 'idle', error, progress, elapsed, levels, modelReady, disabled: options.disabled, start, stop, cancel, download, removeModel: deleteModel, deleteModel }
}
