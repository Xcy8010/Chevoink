type NativeStatus = { ready: boolean; checking?: boolean; sdkReady: boolean; busy?: boolean; downloadBytes: number };
type Listener = { remove(): Promise<void> };
type NativeSpeech = {
  status(): Promise<NativeStatus>;
  download(): Promise<{ ready: boolean }>;
  transcribe(options: { pcmBase64: string; sampleRate: number }): Promise<{ text: string }>;
  cancel(): Promise<void>;
  deleteModel(): Promise<{ ready: boolean }>;
  addListener(event: 'progress', listener: (event: { progress: number }) => void): Promise<Listener>;
};
let detection: Promise<NativeSpeech | undefined> | undefined;

export function getNativeSpeech(): Promise<NativeSpeech | undefined> {
  detection ??= import('@capacitor/core').then(({ Capacitor, registerPlugin }) => {
    if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('ChevoinkSpeech')) return undefined;
    const proxy = registerPlugin<NativeSpeech>('ChevoinkSpeech');
    // Capacitor's Proxy synthesizes a function for EVERY unknown property, including
    // `then`. Resolving that proxy through a Promise invokes a nonexistent native
    // then() method and never settles. Return an explicit non-thenable facade.
    return {
      status: () => proxy.status(),
      download: () => proxy.download(),
      transcribe: options => proxy.transcribe(options),
      cancel: () => proxy.cancel(),
      deleteModel: () => proxy.deleteModel(),
      addListener: (event, listener) => proxy.addListener(event, listener),
    };
  });
  return detection;
}

export async function nativeOperation<T>(native: NativeSpeech, action: () => Promise<T>, signal?: AbortSignal, timeoutMs = 180_000, cancelOnTimeout = true): Promise<T> {
  if (signal?.aborted) throw new DOMException('语音操作已取消', 'AbortError');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => { void native.cancel().catch(() => {}); reject(new DOMException('语音操作已取消', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { if (cancelOnTimeout) void native.cancel().catch(() => {}); reject(new DOMException('原生语音操作超时', 'TimeoutError')); }, timeoutMs);
  });
  try { return await Promise.race([action(), cancelled]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export async function prepareNativeSpeech(native: NativeSpeech, progress: (value: number) => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('语音操作已取消', 'AbortError');
  const listener = await native.addListener('progress', event => { try { progress(Math.max(0, Math.min(1, event.progress))); } catch { /* UI only */ } });
  try { await nativeOperation(native, () => native.download(), signal, 15 * 60_000); }
  finally { await listener.remove(); }
}

export async function transcribeNativeSpeech(native: NativeSpeech, pcm: { pcmBase64: string; sampleRate: number }, signal?: AbortSignal): Promise<string> {
  const result = await nativeOperation(native, () => native.transcribe(pcm), signal);
  return result.text;
}
