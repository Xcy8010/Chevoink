// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVoiceInput } from '../../src/features/studio/agent/hooks/useVoiceInput'
import * as engine from '../../src/features/studio/agent/voice/speech-engine'

vi.mock('../../src/features/studio/agent/voice/speech-engine', () => ({
  getVoiceModelStatus: vi.fn(), prepareVoiceModel: vi.fn(), transcribeAudio: vi.fn(),
  disposeVoiceEngine: vi.fn(), deleteVoiceModel: vi.fn(), VOICE_MODEL_DOWNLOAD_BYTES: 252035688,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const tracks: { stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }[] = []
function makeStream() {
  const track = { stop: vi.fn(), onended: null as (() => void) | null }
  tracks.push(track)
  return { getTracks: () => [track] } as unknown as MediaStream
}
const contexts: ContextMock[] = []
const worklets: WorkletMock[] = []
let permission: ReturnType<typeof vi.fn>
let addModule: ReturnType<typeof vi.fn>

class ContextMock {
  state = 'running'
  sampleRate = 48000
  destination = {}
  onstatechange: (() => void) | null = null
  audioWorklet = { addModule: (...args: unknown[]) => addModule(...args) }
  source = { connect: vi.fn(), disconnect: vi.fn() }
  resume = vi.fn().mockResolvedValue(undefined)
  close = vi.fn(async () => { this.state = 'closed' })
  createMediaStreamSource = vi.fn(() => this.source)
  constructor() { contexts.push(this) }
}

class WorkletMock {
  connect = vi.fn()
  disconnect = vi.fn()
  onprocessorerror: (() => void) | null = null
  autoFlush = true
  port = {
    onmessage: null as ((event: { data: { type: string; samples?: Float32Array } }) => void) | null,
    close: vi.fn(),
    postMessage: vi.fn((message: { type: string }) => {
      if (message.type === 'stop' && this.autoFlush) this.emit('stopped')
    }),
  }
  constructor() { worklets.push(this) }
  emit(type: string, samples?: Float32Array) { this.port.onmessage?.({ data: { type, samples } }) }
}

beforeEach(() => {
  vi.resetAllMocks()
  tracks.length = 0
  contexts.length = 0
  worklets.length = 0
  permission = vi.fn().mockImplementation(async () => makeStream())
  addModule = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: permission } })
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('AudioContext', ContextMock)
  vi.stubGlobal('AudioWorkletNode', WorkletMock)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(readFileSync(resolve('public/voice-capture-worklet.js')), { status: 200 })))
  vi.mocked(engine.getVoiceModelStatus).mockResolvedValue(true)
  vi.mocked(engine.prepareVoiceModel).mockResolvedValue(undefined)
  vi.mocked(engine.deleteVoiceModel).mockResolvedValue(undefined)
  vi.mocked(engine.transcribeAudio).mockResolvedValue('你好 world')
})

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

async function setup() {
  const onTranscript = vi.fn()
  const hook = renderHook((props: { scopeKey: string; disabled: boolean }) => useVoiceInput({ ...props, onTranscript }), {
    initialProps: { scopeKey: 'user:novel:task1', disabled: false },
  })
  await waitFor(() => expect(hook.result.current.state).toBe('idle'))
  return { ...hook, onTranscript }
}

async function record() {
  const hook = await setup()
  await act(async () => hook.result.current.start())
  expect(hook.result.current.state).toBe('recording')
  act(() => worklets[0].emit('pcm', new Float32Array([0.1, -0.3, 0.2])))
  await waitFor(() => expect(hook.result.current.levels.at(-1)).toBeGreaterThan(0))
  return hook
}

describe('useVoiceInput local PCM lifecycle', () => {
  it('opens first-use download immediately while metadata is still pending', async () => {
    const pending = deferred<boolean>()
    vi.mocked(engine.getVoiceModelStatus).mockReturnValue(pending.promise)
    const hook = renderHook(() => useVoiceInput({ scopeKey: 'task', disabled: false, onTranscript: vi.fn() }))
    expect(hook.result.current.state).toBe('checking')
    await act(async () => hook.result.current.start())
    expect(hook.result.current.state).toBe('needs-download')
    await act(async () => pending.resolve(false))
    expect(hook.result.current.state).toBe('needs-download')
    expect(permission).not.toHaveBeenCalled()
  })

  it('reports silence via toast without leaving an error bar or changing draft', async () => {
    vi.mocked(engine.transcribeAudio).mockResolvedValue('')
    const onNotice = vi.fn()
    const onTranscript = vi.fn()
    const hook = renderHook(() => useVoiceInput({ scopeKey: 'task', disabled: false, onTranscript, onNotice }))
    await waitFor(() => expect(hook.result.current.state).toBe('idle'))
    await act(async () => hook.result.current.start())
    act(() => worklets[0].emit('pcm', new Float32Array([0.1, 0.2])))
    await act(async () => hook.result.current.stop())
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('没有识别到语音'))
    expect(hook.result.current.state).toBe('idle')
    expect(hook.result.current.error).toBeNull()
    expect(onTranscript).not.toHaveBeenCalled()
  })
  it('inspects cache without downloading or requesting microphone; aliases stay compatible', async () => {
    const { result } = await setup()
    expect(result.current.active).toBe(false)
    expect(result.current.status).toBe(result.current.state)
    expect(result.current.deleteModel).toBe(result.current.removeModel)
    expect(permission).not.toHaveBeenCalled()
    expect(engine.prepareVoiceModel).not.toHaveBeenCalled()
  })

  it('requires explicit download and a second user click before microphone permission', async () => {
    vi.mocked(engine.getVoiceModelStatus).mockResolvedValue(false)
    const { result } = await setup()
    await act(async () => result.current.start())
    expect(result.current.state).toBe('needs-download')
    expect(result.current.active).toBe(true)
    expect(permission).not.toHaveBeenCalled()
    expect(engine.prepareVoiceModel).not.toHaveBeenCalled()
    await act(async () => result.current.download())
    expect(result.current.modelReady).toBe(true)
    expect(result.current.state).toBe('idle')
    expect(permission).not.toHaveBeenCalled()
    const [cachedUrl, options] = vi.mocked(fetch).mock.calls[0]
    expect(options).toMatchObject({ cache: 'force-cache', credentials: 'same-origin' })
    expect(cachedUrl).toBe('/voice-capture-worklet.js?v=1')
    // Going offline after an explicit download must not invoke another preload fetch.
    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'))
    await act(async () => result.current.start())
    expect(permission).toHaveBeenCalledOnce()
    expect(addModule.mock.calls[0][0]).toBe(cachedUrl)
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('refreshes another mounted controller after language-pack settings change without requesting the microphone', async () => {
    vi.mocked(engine.getVoiceModelStatus).mockResolvedValue(false)
    const hook = await setup()
    await act(async () => hook.result.current.start())
    expect(hook.result.current.state).toBe('needs-download')
    vi.mocked(engine.getVoiceModelStatus).mockResolvedValue(true)
    await act(async () => window.dispatchEvent(new CustomEvent('chevoink:voice-pack-changed', { detail: Symbol('settings') })))
    await waitFor(() => expect(hook.result.current.modelReady).toBe(true))
    expect(hook.result.current.state).toBe('idle')
    expect(permission).not.toHaveBeenCalled()
    expect(engine.prepareVoiceModel).not.toHaveBeenCalled()
    vi.mocked(engine.getVoiceModelStatus).mockResolvedValue(false)
    await act(async () => window.dispatchEvent(new CustomEvent('chevoink:voice-pack-changed', { detail: Symbol('settings') })))
    await waitFor(() => expect(hook.result.current.modelReady).toBe(false))
  })

  it('passes actual mono PCM and sampleRate, preserves the final worklet block and only emits draft text', async () => {
    const { result, onTranscript } = await record()
    expect(addModule.mock.calls[0][0]).toBe('/voice-capture-worklet.js?v=1')
    expect(result.current.levels.at(-1)).toBeGreaterThan(0)
    worklets[0].autoFlush = false
    let stopping!: Promise<void>
    act(() => { stopping = result.current.stop() })
    expect(result.current.state).toBe('transcribing')
    expect(tracks[0].stop).toHaveBeenCalledOnce()
    expect(engine.transcribeAudio).not.toHaveBeenCalled()
    await act(async () => {
      worklets[0].emit('pcm', new Float32Array([0.5]))
      worklets[0].emit('stopped')
      await stopping
    })
    expect(engine.transcribeAudio).toHaveBeenCalledWith(new Float32Array([0.1, -0.3, 0.2, 0.5]), 48000, expect.any(AbortSignal))
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith('你好 world')
    expect(contexts[0].close).toHaveBeenCalledOnce()
    expect(worklets[0].port.close).toHaveBeenCalledOnce()
  })

  it('silence produces zero waveform amplitude, not decorative animation', async () => {
    const { result } = await record()
    act(() => worklets[0].emit('pcm', new Float32Array(2048)))
    await waitFor(() => expect(result.current.levels.at(-1)).toBe(0))
  })

  it('cancels recording without transcription and releases all capture resources', async () => {
    const { result, onTranscript } = await record()
    act(() => result.current.cancel())
    expect(tracks[0].stop).toHaveBeenCalledOnce()
    expect(contexts[0].close).toHaveBeenCalledOnce()
    expect(worklets[0].disconnect).toHaveBeenCalledOnce()
    expect(engine.transcribeAudio).not.toHaveBeenCalled()
    expect(onTranscript).not.toHaveBeenCalled()
    expect(result.current.state).toBe('idle')
  })

  it('discards permission arriving after cancellation', async () => {
    const pending = deferred<MediaStream>()
    permission.mockReturnValue(pending.promise)
    const { result } = await setup()
    let starting!: Promise<void>
    act(() => { starting = result.current.start() })
    expect(contexts[0].resume).toHaveBeenCalledOnce()
    act(() => result.current.cancel())
    await act(async () => { pending.resolve(makeStream()); await starting })
    expect(tracks[0].stop).toHaveBeenCalledOnce()
    expect(worklets).toHaveLength(0)
    expect(result.current.state).toBe('idle')
  })

  it('discards a late worklet load after scope changes', async () => {
    const pending = deferred<void>()
    addModule.mockReturnValue(pending.promise)
    const { result, rerender } = await setup()
    let starting!: Promise<void>
    act(() => { starting = result.current.start() })
    await waitFor(() => expect(addModule).toHaveBeenCalled())
    rerender({ scopeKey: 'user:novel:task2', disabled: false })
    await act(async () => { pending.resolve(); await starting })
    expect(worklets).toHaveLength(0)
    expect(tracks[0].stop).toHaveBeenCalledOnce()
  })

  it.each(['cancel', 'scope', 'disabled', 'unmount'] as const)('invalidates old transcriptions on %s and aborts owned engine', async (action) => {
    const pending = deferred<string>()
    vi.mocked(engine.transcribeAudio).mockReturnValue(pending.promise)
    const { result, onTranscript, rerender, unmount } = await record()
    let stopping!: Promise<void>
    await act(async () => { stopping = result.current.stop(); await Promise.resolve() })
    const signal = vi.mocked(engine.transcribeAudio).mock.calls[0][2]!
    if (action === 'cancel') act(() => result.current.cancel())
    if (action === 'scope') rerender({ scopeKey: 'user:novel:task2', disabled: false })
    if (action === 'disabled') rerender({ scopeKey: 'user:novel:task1', disabled: true })
    if (action === 'unmount') unmount()
    expect(signal.aborted).toBe(true)
    expect(engine.disposeVoiceEngine).toHaveBeenCalled()
    await act(async () => { pending.resolve('迟到旧结果'); await stopping })
    expect(onTranscript).not.toHaveBeenCalled()
  })

  it('ignores stale download progress/completion after cancellation', async () => {
    vi.mocked(engine.getVoiceModelStatus).mockResolvedValue(false)
    const pending = deferred<void>()
    vi.mocked(engine.prepareVoiceModel).mockReturnValue(pending.promise)
    const { result } = await setup()
    let downloading!: Promise<void>
    act(() => { downloading = result.current.download() })
    const [progress, signal] = vi.mocked(engine.prepareVoiceModel).mock.calls[0]
    act(() => progress(0.5))
    expect(result.current.progress).toBe(0.5)
    act(() => result.current.cancel())
    expect(signal?.aborted).toBe(true)
    await act(async () => { progress(1); pending.resolve(); await downloading })
    expect(result.current.progress).toBe(0)
    expect(result.current.modelReady).toBe(false)
  })

  it('stops automatically at sixty seconds exactly once', async () => {
    const { result, onTranscript } = await setup()
    vi.useFakeTimers()
    await act(async () => result.current.start())
    act(() => worklets[0].emit('pcm', new Float32Array([0.2])))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(engine.transcribeAudio).toHaveBeenCalledOnce()
    expect(onTranscript).toHaveBeenCalledOnce()
    expect(tracks[0].stop).toHaveBeenCalled()
  })

  it('backgrounding cancels capture without automatically transcribing', async () => {
    const { result } = await record()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(tracks[0].stop).toHaveBeenCalled()
    expect(result.current.state).toBe('idle')
    expect(engine.transcribeAudio).not.toHaveBeenCalled()
  })

  it('deleting cache changes readiness and never requests microphone', async () => {
    const { result } = await setup()
    await act(async () => result.current.removeModel())
    expect(engine.deleteVoiceModel).toHaveBeenCalledOnce()
    expect(result.current.modelReady).toBe(false)
    expect(result.current.state).toBe('needs-download')
    expect(permission).not.toHaveBeenCalled()
  })

  it('inactive desktop/mobile sibling unmount does not dispose the active engine', async () => {
    const pending = deferred<string>()
    vi.mocked(engine.transcribeAudio).mockReturnValue(pending.promise)
    const active = await record()
    const sibling = await setup()
    let stopping!: Promise<void>
    await act(async () => { stopping = active.result.current.stop(); await Promise.resolve() })
    vi.mocked(engine.disposeVoiceEngine).mockClear()
    sibling.unmount()
    expect(engine.disposeVoiceEngine).not.toHaveBeenCalled()
    await act(async () => { pending.resolve('正确结果'); await stopping })
    expect(active.onTranscript).toHaveBeenCalledWith('正确结果')
  })

  it('reports denied permission and unsupported secure context without leaking resources', async () => {
    permission.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'))
    const { result } = await setup()
    await act(async () => result.current.start())
    expect(result.current.error).toContain('权限')
    expect(contexts[0].close).toHaveBeenCalledOnce()
    vi.stubGlobal('isSecureContext', false)
    permission.mockClear()
    await act(async () => result.current.start())
    expect(result.current.error).toContain('HTTPS')
    expect(permission).not.toHaveBeenCalled()
  })

  it('rejects empty speech without draft output', async () => {
    vi.mocked(engine.transcribeAudio).mockResolvedValue('  ')
    const { result, onTranscript } = await record()
    await act(async () => result.current.stop())
    expect(result.current.state).toBe('error')
    expect(result.current.error).toContain('没有识别到语音')
    expect(onTranscript).not.toHaveBeenCalled()
  })

  it('requires repair when worklet HTTP cache was evicted, without downloading on mount', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 504 }))
    const { result } = await setup()
    expect(fetch).toHaveBeenCalledWith('/voice-capture-worklet.js?v=1', expect.objectContaining({ cache: 'only-if-cached', mode: 'same-origin' }))
    expect(result.current.modelReady).toBe(false)
    expect(engine.prepareVoiceModel).not.toHaveBeenCalled()
    await act(async () => result.current.start())
    expect(result.current.state).toBe('needs-download')
    expect(permission).not.toHaveBeenCalled()
  })

  it('does not declare download ready when the worklet hash is invalid', async () => {
    vi.mocked(engine.getVoiceModelStatus).mockResolvedValue(false)
    vi.mocked(fetch).mockResolvedValue(new Response('unexpected script', { status: 200 }))
    const { result } = await setup()
    await act(async () => result.current.download())
    expect(result.current.state).toBe('error')
    expect(result.current.error).toContain('校验失败')
    expect(result.current.modelReady).toBe(false)
    expect(permission).not.toHaveBeenCalled()
  })
})
