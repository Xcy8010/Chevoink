import { describe, expect, it, vi } from 'vitest'

import { readWithIdleTimeout } from '../../api/lib/ai-sse.js'

describe('流式静默看门狗', () => {
  it('静默超过窗口时以调用方错误快速失败，不占用整次调用等待上限', async () => {
    vi.useFakeTimers()
    try {
      const stream = new ReadableStream<Uint8Array>({ start() { /* 永不产生 chunk，模拟网关挂死 */ } })
      const reader = stream.getReader()
      const error = new Error('idle-timeout')
      const guard = readWithIdleTimeout(reader, 90_000, () => error)
      const assertion = expect(guard).rejects.toBe(error)
      await vi.advanceTimersByTimeAsync(90_000)
      await assertion
      await reader.cancel().catch(() => {})
    } finally { vi.useRealTimers() }
  })

  it('窗口内到达的 chunk 正常透传并清理计时器', async () => {
    vi.useFakeTimers()
    try {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) } })
      const chunk = await readWithIdleTimeout(stream.getReader(), 90_000, () => new Error('idle-timeout'))
      expect(chunk.done).toBe(false)
      expect(chunk.value).toEqual(new Uint8Array([1, 2, 3]))
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('读取错误原样透传，不被超时语义覆盖', async () => {
    const failure = new Error('stream-broken')
    const reader = { read: () => Promise.reject(failure) } as unknown as ReadableStreamDefaultReader<Uint8Array>
    await expect(readWithIdleTimeout(reader, 90_000, () => new Error('idle-timeout'))).rejects.toBe(failure)
  })
})
