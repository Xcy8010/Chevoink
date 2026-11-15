import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resampleVoicePcm } from '../src/features/studio/agent/voice/voice-pcm';
import { VOICE_MANIFEST, VOICE_MODEL_DOWNLOAD_BYTES } from '../src/features/studio/agent/voice/voice-manifest';
import { voiceAssetUrl, voicePackFingerprint } from '../src/features/studio/agent/voice/voice-cache';
import { deleteVoiceModel, disposeVoiceEngine, getVoiceModelStatus, prepareVoiceModel, transcribeAudio } from '../src/features/studio/agent/voice/speech-engine';
vi.mock('../src/features/studio/agent/voice/native-speech', () => ({
  getNativeSpeech: vi.fn(async () => undefined), nativeOperation: vi.fn(), prepareNativeSpeech: vi.fn(), transcribeNativeSpeech: vi.fn(),
}));

describe('voice PCM resampling', () => {
  it.each([16000, 44100, 48000, 8000])('preserves duration and DC at %i Hz', rate => {
    const result = resampleVoicePcm(new Float32Array(rate / 10).fill(0.25), rate);
    expect(result.length).toBe(1600);
    expect(result[800]).toBeCloseTo(0.25, 5);
  });
  it('suppresses frequencies above target Nyquist', () => {
    const wave = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(2 * Math.PI * 12000 * i / 48000));
    const result = resampleVoicePcm(wave, 48000).slice(100, -100);
    expect(Math.sqrt(result.reduce((sum, v) => sum + v * v, 0) / result.length)).toBeLessThan(0.01);
  });
  it('rejects NaN, invalid rate and excessive duration', () => {
    expect(() => resampleVoicePcm(new Float32Array([NaN]), 16000)).toThrow();
    expect(() => resampleVoicePcm(new Float32Array(1), 0)).toThrow();
    expect(() => resampleVoicePcm(new Float32Array(16000 * 121), 16000)).toThrow();
  });
  it('clamps without mutating caller PCM', () => {
    const input = new Float32Array([2, -2]);
    expect([...resampleVoicePcm(input, 16000)]).toEqual([1, -1]);
    expect([...input]).toEqual([2, -2]);
  });
});

class WorkerMock {
  static instances: WorkerMock[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string }) => void;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { WorkerMock.instances.push(this); }
  reply(value: unknown) { this.onmessage?.({ data: { value } }); }
}
describe('voice main-thread contract', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', WorkerMock);
    vi.stubGlobal('location', new URL('https://chevoink.test'));
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('caches', {
      has: vi.fn(async () => false),
      open: vi.fn(),
      keys: vi.fn(async () => ['chevoink-voice-old', 'unrelated-cache']),
      delete: vi.fn(async () => true),
    });
    WorkerMock.instances = [];
  });
  afterEach(() => { disposeVoiceEngine(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('checks metadata without queueing behind an in-flight transcription', async () => {
    const transcription = transcribeAudio(new Float32Array([0.25]), 16000);
    await Promise.resolve();
    const worker = WorkerMock.instances[0];
    expect(await getVoiceModelStatus()).toBe(false);
    expect(WorkerMock.instances).toHaveLength(1);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply('你好');
    expect(await transcription).toBe('你好');
  });
  it('pins all sizes/hashes and total download', () => {
    expect(VOICE_MODEL_DOWNLOAD_BYTES).toBe(252062335);
    expect(VOICE_MODEL_DOWNLOAD_BYTES).toBe(VOICE_MANIFEST.files.reduce((sum, file) => sum + file.bytes, 0));
    for (const license of VOICE_MANIFEST.licenses) {
      expect(VOICE_MANIFEST.files).toContainEqual({
        name: `licenses/${license.name}`, bytes: license.bytes, sha256: license.sha256, type: 'text/plain',
      });
    }
    for (const file of VOICE_MANIFEST.files) expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('reads the verified installation marker and metadata without a worker', async () => {
    const files = new Map(VOICE_MANIFEST.files.map(file => [voiceAssetUrl(file.name), new Response(null, {
      headers: { 'Content-Length': String(file.bytes), 'X-Voice-Sha256': file.sha256 },
    })]));
    files.set(voiceAssetUrl('.verified'), new Response(voicePackFingerprint));
    vi.mocked(caches.has).mockResolvedValue(true);
    vi.mocked(caches.open).mockResolvedValue({ match: async (url: string) => files.get(url)?.clone() } as Cache);
    expect(await getVoiceModelStatus()).toBe(true);
    files.delete(voiceAssetUrl(VOICE_MANIFEST.files.at(-1)!.name));
    expect(await getVoiceModelStatus()).toBe(false);
    expect(WorkerMock.instances).toHaveLength(0);
  });
  it('does not detach caller buffer', async () => {
    const samples = new Float32Array([0.25]);
    const result = transcribeAudio(samples, 48000);
    await Promise.resolve();
    const worker = WorkerMock.instances[0];
    expect(worker.postMessage.mock.calls[0][0].samples).not.toBe(samples);
    expect(worker.postMessage.mock.calls[0][0].sampleRate).toBe(48000);
    worker.reply('你好 hello');
    expect(await result).toBe('你好 hello');
    expect(samples[0]).toBe(0.25);
  });
  it('abort terminates synchronous inference and rejects pending request', async () => {
    const controller = new AbortController();
    const result = transcribeAudio(new Float32Array([0]), 16000, controller.signal);
    await Promise.resolve();
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    expect(WorkerMock.instances[0].terminate).toHaveBeenCalled();
  });
  it('already aborted prepare does not launch worker', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareVoiceModel(vi.fn(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(WorkerMock.instances).toHaveLength(0);
  });
  it('deletion terminates old worker and preserves unrelated caches', async () => {
    const pending = transcribeAudio(new Float32Array([0.25]), 16000);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    const deletion = deleteVoiceModel();
    expect(WorkerMock.instances[0].terminate).toHaveBeenCalled();
    await deletion;
    await cancelled;
    expect(caches.delete).toHaveBeenCalledWith('chevoink-voice-old');
    expect(caches.delete).not.toHaveBeenCalledWith('unrelated-cache');
  });
});
