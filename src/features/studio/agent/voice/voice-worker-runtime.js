import { VOICE_MANIFEST, VOICE_CACHE_NAME, VOICE_MODEL_DOWNLOAD_BYTES } from './voice-manifest';
import { hasCachedVoicePack, voiceAssetUrl, voicePackFingerprint } from './voice-cache';
import { resampleVoicePcm } from './voice-pcm';

let recognizer;
let vad;
const markerUrl = voiceAssetUrl('.verified');

async function verify(buffer, file) {
  if (buffer.byteLength !== file.bytes) return false;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return Array.from(hash, value => value.toString(16).padStart(2, '0')).join('') === file.sha256;
}

async function cachedFile(cache, file) {
  const response = await cache.match(voiceAssetUrl(file.name));
  if (!response) return undefined;
  const buffer = await response.arrayBuffer();
  if (await verify(buffer, file)) return buffer;
  await cache.delete(voiceAssetUrl(file.name));
  await cache.delete(markerUrl);
  return undefined;
}

async function prepare() {
  if (!globalThis.caches || !crypto?.subtle) throw new Error('浏览器不支持离线模型缓存，请更新浏览器或应用');
  const simd = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
  if (!globalThis.WebAssembly || !WebAssembly.validate(simd)) throw new Error('浏览器不支持 WASM SIMD，请更新浏览器或 Android 应用');
  if (await hasCachedVoicePack()) return;
  if (navigator.storage?.estimate) {
    let estimate;
    try { estimate = await navigator.storage.estimate(); } catch { /* Unsupported/private browsing: let cache writes report quota errors. */ }
    if (estimate?.quota !== undefined && estimate?.usage !== undefined && estimate.quota - estimate.usage < VOICE_MODEL_DOWNLOAD_BYTES * 2) {
      throw new Error('离线模型至少需要约 505 MB 可用浏览器存储空间，请清理空间后重试');
    }
  }
  const cache = await caches.open(VOICE_CACHE_NAME);
  let completed = 0;
  const progress = loaded => self.postMessage({ progress: Math.min(0.99, loaded / VOICE_MODEL_DOWNLOAD_BYTES) });
  progress(0);
  for (const file of VOICE_MANIFEST.files) {
    if (!await cachedFile(cache, file)) {
      const url = voiceAssetUrl(file.name);
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error' });
      if (!response.ok || !response.body) throw new Error(`语音资源未部署或下载失败 (${response.status}): ${file.name}`);
      const reader = response.body.getReader();
      const bytes = new Uint8Array(file.bytes);
      let offset = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (offset + value.byteLength > file.bytes) throw new Error(`语音资源大小错误: ${file.name}`);
          bytes.set(value, offset);
          offset += value.byteLength;
          progress(completed + offset);
        }
      } finally { await reader.cancel(); }
      if (offset !== file.bytes || !await verify(bytes.buffer, file)) throw new Error(`语音资源 SHA-256 校验失败: ${file.name}`);
      await cache.put(url, new Response(bytes, { headers: { 'Content-Type': file.type, 'Content-Length': String(file.bytes), 'X-Voice-Sha256': file.sha256 } }));
    }
    completed += file.bytes;
    progress(completed);
  }
  await cache.put(markerUrl, new Response(voicePackFingerprint));
  self.postMessage({ progress: 1 });
}

async function initialize() {
  if (recognizer) return;
  const cache = await caches.open(VOICE_CACHE_NAME);
  const buffers = new Map();
  for (const file of VOICE_MANIFEST.files) {
    const buffer = await cachedFile(cache, file);
    if (!buffer) throw new Error('请先下载完整离线语音模型');
    buffers.set(file.name, buffer);
  }
  // No hidden network fetch: .wasm and .data are supplied directly from verified CacheStorage.
  const prefix = 'sherpa-onnx-wasm-main-vad-asr';
  const urls = [];
  try {
    await new Promise((resolve, reject) => {
      self.Module = {
        wasmBinary: buffers.get(`${prefix}.wasm`),
        getPreloadedPackage: () => buffers.get(`${prefix}.data`),
        locateFile: name => new URL(VOICE_MANIFEST.baseUrl + name, self.location.origin).href,
        print: () => {}, printErr: () => {},
        onAbort: reason => reject(new Error(`WASM 初始化失败: ${reason}`)),
        onRuntimeInitialized: resolve,
      };
      const runtimeUrl = URL.createObjectURL(new Blob([buffers.get(`${prefix}.js`)], { type: 'text/javascript' }));
      urls.push(runtimeUrl);
      importScripts(runtimeUrl);
    });
    const adapterUrl = URL.createObjectURL(new Blob([
      '(function(){\n',
      buffers.get('sherpa-onnx-asr.js'),
      '\nself.createVoiceRecognizer = (config) => new OfflineRecognizer(config, self.Module);\n})();',
    ], { type: 'text/javascript' }));
    urls.push(adapterUrl);
    importScripts(adapterUrl);
    recognizer = self.createVoiceRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        tokens: './tokens.txt', numThreads: 1, debug: 0, provider: 'cpu',
        senseVoice: { model: './sense-voice.onnx', language: 'auto', useInverseTextNormalization: 1 },
      },
      decodingMethod: 'greedy_search',
    });
    if (!recognizer.handle) { recognizer = undefined; throw new Error('设备内存不足或 SenseVoice 初始化失败'); }
    // Isolate the upstream adapters: both define different freeConfig functions.
    const vadUrl = URL.createObjectURL(new Blob([
      '(function(){\n', buffers.get('sherpa-onnx-vad.js'),
      '\nself.createVoiceVad = (config) => createVad(self.Module, config);\n})();',
    ], { type: 'text/javascript' }));
    urls.push(vadUrl);
    importScripts(vadUrl);
    vad = self.createVoiceVad({
      sileroVad: { model: './silero_vad.onnx', threshold: 0.5, minSilenceDuration: 0.35, minSpeechDuration: 0.15, maxSpeechDuration: 18, windowSize: 512 },
      sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 125,
    });
    if (!vad.handle) { recognizer.free(); recognizer = undefined; throw new Error('语音活动检测初始化失败'); }
    self.Module.wasmBinary = undefined;
    self.Module.getPreloadedPackage = undefined;
  } finally { for (const url of urls) URL.revokeObjectURL(url); }
}

async function transcribe(samples, sampleRate) {
  const pcm = resampleVoicePcm(samples, sampleRate);
  if (!pcm.length) return '';
  const power = pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length;
  if (power < 1e-8) return ''; // Digital silence must never hallucinate words.
  await initialize();
  let result = '';
  vad.reset();
  for (let offset = 0; offset < pcm.length; offset += 512) vad.acceptWaveform(pcm.subarray(offset, offset + 512));
  vad.flush();
  const segments = [];
  while (!vad.isEmpty()) {
    const segment = vad.front(); vad.pop();
    segments.push({ start: segment.start, end: segment.start + segment.samples.length });
  }
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    // Non-overlapping midpoint-clamped padding. Never delete text based on repetition.
    const left = index ? Math.floor((segments[index - 1].end + segment.start) / 2) : 0;
    const right = index + 1 < segments.length ? Math.floor((segment.end + segments[index + 1].start) / 2) : pcm.length;
    const start = Math.max(left, segment.start - 3200, 0);
    const end = Math.min(right, segment.end + 3200, pcm.length);
    const stream = recognizer.createStream();
    try {
      stream.acceptWaveform(16000, pcm.subarray(start, end));
      recognizer.decode(stream);
      const text = (recognizer.getResult(stream).text || '').replace(/<\|[^|]*\|>/g, '').trim();
      if (text) result += (result ? ' ' : '') + text;
    } finally { stream.free(); }
  }
  return result.trim();
}

self.onmessage = async ({ data }) => {
  try {
    let value;
    if (data.operation === 'prepare') await prepare();
    else if (data.operation === 'transcribe') value = await transcribe(data.samples, data.sampleRate);
    else if (data.operation === 'prepare-native') {
      const pcm = resampleVoicePcm(data.samples, data.sampleRate);
      const bytes = new Uint8Array(pcm.length * 4);
      const view = new DataView(bytes.buffer);
      for (let index = 0; index < pcm.length; index++) view.setFloat32(index * 4, pcm[index], true);
      let binary = '';
      for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      value = { pcmBase64: btoa(binary), sampleRate: 16000 };
    }
    else throw new Error('未知语音操作');
    self.postMessage({ value });
  } catch (error) {
    self.postMessage({ error: error.message || String(error), name: error.name });
  }
};
