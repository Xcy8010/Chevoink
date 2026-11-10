import { beforeEach, expect, it, vi } from 'vitest'

import { synthesizeLocalTts } from '../../api/lib/tts-local.js'

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), input: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }))
vi.mock('../../api/config/env.js', () => ({ env: { appEnv: 'test', ttsLocalModelDir: 'model', ttsTimeoutMs: 30000 } }))

type Finish = (error: Error | null) => void
const children: Finish[] = []

beforeEach(() => {
  children.length = 0
  mocks.input.mockClear()
  mocks.execFile.mockReset().mockImplementation((_file, _args, _options, finish: Finish) => {
    children.push(finish)
    return { stdin: { on: vi.fn(), end: mocks.input } }
  })
})

const speaker = 'zh-CN-local-21'

it('runs one speech child at a time, bounds waiting requests and pipes the text through stdin', async () => {
  const first = synthesizeLocalTts('合成样句一。', speaker, 'first.wav')
  const second = synthesizeLocalTts('合成样句二。', speaker, 'second.wav')
  const third = synthesizeLocalTts('合成样句三。', speaker, 'third.wav')
  await expect(synthesizeLocalTts('合成样句四。', speaker, 'fourth.wav')).rejects.toMatchObject({ code: 'TTS_BUSY' })
  await vi.waitFor(() => expect(children).toHaveLength(1))
  const [, args, options] = mocks.execFile.mock.calls[0]
  expect(args).not.toContain('合成样句一。')
  expect(options.env).not.toHaveProperty('DATABASE_URL')
  expect(mocks.input).toHaveBeenCalledWith('合成样句一。')

  children[0](null)
  await first
  await vi.waitFor(() => expect(children).toHaveLength(2))
  children[1](null)
  await second
  await vi.waitFor(() => expect(children).toHaveLength(3))
  children[2](null)
  await third
})

it('reports a killed synthesis as timed out and starts the next queued batch', async () => {
  const first = synthesizeLocalTts('合成样句一。', speaker, 'first.wav')
  const second = synthesizeLocalTts('合成样句二。', speaker, 'second.wav')
  await vi.waitFor(() => expect(children).toHaveLength(1))
  expect(mocks.execFile.mock.calls[0][2]).toMatchObject({ killSignal: 'SIGKILL', timeout: expect.any(Number) })
  const failed = expect(first).rejects.toMatchObject({ code: 'TTS_UNAVAILABLE', message: '语音合成超时，请稍后重试。' })
  children[0](Object.assign(new Error('Child timed out'), { killed: true }))
  await failed
  await vi.waitFor(() => expect(children).toHaveLength(2))
  children[1](null)
  await second
})
