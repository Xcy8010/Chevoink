import { hasCachedVoicePack } from './voice-cache';
import { VOICE_MODEL_DOWNLOAD_BYTES } from './voice-manifest';
import { getNativeSpeech, nativeOperation, prepareNativeSpeech, transcribeNativeSpeech } from './native-speech';

export { VOICE_MODEL_DOWNLOAD_BYTES };

type Operation = 'prepare' | 'transcribe' | 'prepare-native';
type Reply = { value?: unknown; progress?: number; error?: string; name?: string };
const activeTranscripts = new Set<AbortController>();
let deleting: Promise<void> | undefined;

function abortError() { return new DOMException('语音操作已取消', 'AbortError'); }

/** Terminates in-flight inference without interrupting an installation. */
export function disposeVoiceEngine(): void {
  for (const transcript of activeTranscripts) transcript.abort();
}

function call<T>(
  operation: Operation,
  payload: Record<string, unknown> = {},
  signal?: AbortSignal,
  progress?: (value: number) => void,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!globalThis.isSecureContext || !globalThis.Worker || !globalThis.caches || !globalThis.crypto?.subtle) {
    return Promise.reject(new Error('离线语音需要 HTTPS、Web Worker 和浏览器本地缓存支持'));
  }
  // Each operation owns its classic Vite worker, including synchronous WASM work.
  const worker = new Worker(new URL('./voice-worker-runtime.js', import.meta.url));
  return new Promise<T>((resolve, reject) => {
    const clear = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    const fail = (error: unknown) => { clear(); reject(error); };
    const abort = () => fail(abortError());
    const timeout = setTimeout(() => fail(new DOMException('离线语音操作超时，请缩短录音或重试', 'TimeoutError')),
      operation === 'prepare' ? 15 * 60_000 : operation === 'transcribe' ? 180_000 : 30_000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<Reply>) => {
      if (data.progress !== undefined) {
        try { progress?.(data.progress); } catch { /* UI callbacks must not break RPC. */ }
        return;
      }
      if (data.error) fail(new DOMException(data.error, data.name || 'OperationError'));
      else { clear(); resolve(data.value as T); }
    };
    worker.onerror = (event) => fail(new Error(event.message || '语音组件加载失败，请检查网络后重试。'));
    try {
      const samples = payload.samples as Float32Array | undefined;
      worker.postMessage({ operation, ...payload }, samples ? [samples.buffer] : []);
    } catch (error) { fail(error); }
  });
}

/** Checks the selected backend's installation metadata without initializing WASM. */
export async function getVoiceModelStatus(): Promise<boolean> {
  try {
    if (deleting) return false;
    const native = await getNativeSpeech();
    if (native) {
      const state = await nativeOperation(native, () => native.status(), undefined, 3000, false);
      return state.ready && state.sdkReady && !state.checking;
    }
    return await hasCachedVoicePack();
  } catch { return false; }
}

/** Explicit same-origin download. Progress reaches 1 only after verified cache commit. */
export async function prepareVoiceModel(onProgress: (progress: number) => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (deleting) await deleting;
  const native = await getNativeSpeech();
  if (native) return prepareNativeSpeech(native, onProgress, signal);
  await call<void>('prepare', {}, signal, onProgress);
}

/** Actual selected backend's download estimate; UI may use the WASM constant as an upper bound. */
export async function getVoiceDownloadBytes(): Promise<number> {
  const native = await getNativeSpeech();
  if (native) return (await nativeOperation(native, () => native.status())).downloadBytes;
  return VOICE_MODEL_DOWNLOAD_BYTES;
}

/** Actual sample rate is required. PCM stays on-device and caller's buffer is never detached. */
export async function transcribeAudio(samples: Float32Array, sampleRate: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortError();
  if (!(samples instanceof Float32Array) || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || samples.length > sampleRate * 120) {
    throw new Error('无效语音格式或录音超过 120 秒');
  }
  if (!samples.length) return '';
  if (deleting) await deleting;
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  activeTranscripts.add(controller);
  try {
    const native = await getNativeSpeech();
    if (native) {
      const pcm = await call<{ pcmBase64: string; sampleRate: number }>('prepare-native', { samples: samples.slice(), sampleRate }, controller.signal);
      return await transcribeNativeSpeech(native, pcm, controller.signal);
    }
    return await call<string>('transcribe', { samples: samples.slice(), sampleRate }, controller.signal);
  } finally {
    signal?.removeEventListener('abort', abort);
    activeTranscripts.delete(controller);
  }
}

/** Stops in-flight inference before removing only this application's voice caches. */
export async function deleteVoiceModel(): Promise<void> {
  if (deleting) return deleting;
  disposeVoiceEngine();
  deleting = (async () => {
    const native = await getNativeSpeech();
    if (native) await nativeOperation(native, () => native.deleteModel());
    // A device with the native backend may still have a WASM cache from an older version.
    if (globalThis.caches) {
      for (const name of await caches.keys()) if (name.startsWith('chevoink-voice-')) await caches.delete(name);
    }
  })();
  try { await deleting; } finally { deleting = undefined; }
}
