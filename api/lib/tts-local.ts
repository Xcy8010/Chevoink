import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { TtsVoice } from '../../shared/contracts/index.js'
import { env } from '../config/env.js'
import { DataAccessError } from './prisma.js'

const MODEL_DIRECTORY = 'vits-icefall-zh-aishell3'
const MODEL_FILES = ['model.onnx', 'lexicon.txt', 'tokens.txt', 'phone.fst', 'date.fst', 'number.fst']
const WORKER = fileURLToPath(new URL('./tts-local-worker.cjs', import.meta.url))

export const LOCAL_TTS_CACHE_NAMESPACE = 'sherpa-onnx-aishell3-vits-2024-04-06-v1'
export const LOCAL_TTS_VOICES: TtsVoice[] = [
  { id: 'zh-CN-local-21', label: '本地普通话 · 音色一', gender: 'male', recommended: true },
  { id: 'zh-CN-local-33', label: '本地普通话 · 音色二', gender: 'female' },
]

function modelDirectory(): string {
  if (env.ttsLocalModelDir) return path.resolve(env.ttsLocalModelDir)

  const directory = env.appEnv === 'production' ? '../../shared/tts-models' : '.local-storage/tts-models'
  return path.resolve(process.cwd(), directory, MODEL_DIRECTORY)
}

export function isLocalTtsReady(): boolean {
  const directory = modelDirectory()
  return MODEL_FILES.every(file => existsSync(path.join(directory, file)))
}

let queue = Promise.resolve()
let pending = 0

export async function synthesizeLocalTts(text: string, voiceId: string, outputPath: string): Promise<void> {
  // One CPU-bound child at a time leaves the other production vCPU for the API.
  // The two waiting slots absorb overlapping playback and next-batch prefetch.
  if (pending >= 3) throw new DataAccessError(503, 'TTS_BUSY', '听书请求较多，请稍后再试。')

  pending += 1
  const deadline = performance.now() + env.ttsTimeoutMs
  const next = queue.then(() => {
    const timeout = Math.ceil(deadline - performance.now())
    const timeoutError = () => new DataAccessError(503, 'TTS_UNAVAILABLE', '语音合成超时，请稍后重试。')
    if (timeout <= 0) throw timeoutError()

    const speaker = voiceId.slice('zh-CN-local-'.length)
    return new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, [WORKER, modelDirectory(), speaker, outputPath], {
        timeout,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 64 * 1024,
        env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, Path: process.env.Path } : {},
      }, error => {
        if (!error) resolve()
        else reject(error.killed ? timeoutError() : new Error('Local TTS worker failed'))
      })
      // If the native worker exits during startup, execFile reports the failure.
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(text)
    })
  })
  queue = next.then(() => undefined, () => undefined)
  try {
    await next
  } finally {
    pending -= 1
  }
}
