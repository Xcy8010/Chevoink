import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  generate: vi.fn<(...args: unknown[]) => Promise<string>>(),
  session: null as { id: string; userId: string; novelId: string; title: string } | null,
  read: vi.fn(), update: vi.fn(),
}))
vi.mock('../../api/lib/ai-service.js', () => ({ generateTextCompletion: mocks.generate }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: { agentSession: { findFirst: mocks.read, updateMany: mocks.update } } }))

import { autoNameSession, fallbackSessionTitle, isDefaultSessionTitle } from '../../api/lib/agent/session-title.js'

const input = { sessionId: 's', userId: 'u', novelId: 'n', prompt: '续写第一章，只要标题和正文' }
const reference = '## 第一章 压酱油瓶的那枚铜钱\n林辰这天走过巷口。\n请续写第二章，只要正文。'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session = { id: 's', userId: 'u', novelId: 'n', title: '新任务' }
  mocks.generate.mockResolvedValue('续写第一章正文')
  mocks.read.mockImplementation(async ({ where }) => {
    const row = mocks.session
    return row && Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value) ? { id: row.id, title: row.title } : null
  })
  mocks.update.mockImplementation(async ({ where, data }) => {
    const row = mocks.session
    if (!row || !Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)) return { count: 0 }
    row.title = data.title
    return { count: 1 }
  })
})

describe('Studio task naming', () => {
  it('accepts a concise model task summary with the existing accounting identity', async () => {
    await autoNameSession(input)
    expect(mocks.session?.title).toBe('续写第一章正文')
    expect(mocks.generate).toHaveBeenCalledTimes(1)
    expect(mocks.generate.mock.calls[0]?.[2]).toMatchObject({ userId: 'u', action: 'agentSessionAutoName', novelId: 'n', targetType: 'agentSession', targetId: 's', temperature: 0.3 })
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: 's', userId: 'u', novelId: 'n', title: '新任务' }, data: { title: '续写第一章正文' } })
  })

  it.each(['## 第一章 压酱油瓶的那枚铜钱 林辰这', '第一章压酱油瓶的那枚铜钱林辰走过巷口', '林辰这天走过巷口', '压酱油瓶的那枚铜钱', '未命名作品续写任务', '续写', '续写第二章正文\n这是解释'])('rejects invalid generated output %s without copying the reference prose', async generated => {
    mocks.generate.mockResolvedValue(generated)
    await autoNameSession({ ...input, prompt: reference })
    expect(mocks.session?.title).toBe('续写第二章正文')
  })

  it('summarizes the task locally when the model fails', async () => {
    mocks.generate.mockRejectedValue(new Error('unavailable'))
    await autoNameSession({ ...input, prompt: '## 第一章 压酱油瓶的那枚铜钱\n林辰这天走过巷口。' })
    expect(mocks.session?.title).toBe('整理第一章任务')
  })

  it.each(['正文整理笔记', '我的写作会话笔记', '## 作者自己取的名字'])('preserves the existing human name %s', async title => {
    mocks.session!.title = title
    await autoNameSession(input)
    expect(mocks.session?.title).toBe(title)
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('keeps a concurrent manual rename through compare-and-set', async () => {
    mocks.generate.mockImplementation(async () => { mocks.session!.title = '作者手动命名'; return '续写第一章正文' })
    await autoNameSession(input)
    expect(mocks.session?.title).toBe('作者手动命名')
  })

  it.each([{ userId: 'foreign' }, { novelId: 'foreign' }])('does not generate or write outside the owned session %j', async foreign => {
    await autoNameSession({ ...input, ...foreign })
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it.each([{ tier: 'custom', multiplierBps: 10000 }, { tier: 'speed', multiplierBps: 0 }])('preserves the resolved free/custom model route %j', async selection => {
    const runtime = { ...selection, provider: 'fixture', apiKey: 'fixture', baseUrl: 'https://provider.invalid', modelName: 'fixture' } as NonNullable<Parameters<typeof autoNameSession>[0]['modelRuntime']>
    await autoNameSession({ ...input, modelRuntime: runtime })
    expect(mocks.generate.mock.calls[0]?.[2]).toMatchObject({ modelRuntime: runtime })
  })

  it('keeps trailing author instructions in a bounded naming request', async () => {
    await autoNameSession({ ...input, prompt: `## 第一章\n${'参考正文'.repeat(300)}\n请修订第二章正文。` })
    const request = mocks.generate.mock.calls[0]?.[1] as string
    expect(request.length).toBeLessThanOrEqual(500)
    expect(request).toContain('请修订第二章正文。')
  })

  it.each(['续写第一章', '请修订章节', '检查人物设定', '请规划大纲', '未命名作品', '## 第一章 铜钱\n林辰走进巷口。'])('uses a 6–12 character task summary at model-free admission: %s', prompt => {
    const title = fallbackSessionTitle(prompt)
    expect(Array.from(title).length).toBeGreaterThanOrEqual(6)
    expect(Array.from(title).length).toBeLessThanOrEqual(12)
    expect(title).not.toMatch(/未命名作品|#|林辰|铜钱/)
  })

  it('recognizes only the system default title forms', () => {
    expect(isDefaultSessionTitle('新任务')).toBe(true)
    expect(isDefaultSessionTitle('雾港来信 写作会话')).toBe(true)
    expect(isDefaultSessionTitle('我的写作会话笔记')).toBe(false)
  })
})
