import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ count: vi.fn(), findMany: vi.fn() }))

/** 状态筛选落在 prisma.user.count/findMany 的 where 构造上：替换为桩，保留其余真实导出 */
vi.mock('../../api/lib/prisma.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/lib/prisma.js')>()
  return {
    ...actual,
    prisma: { ...actual.prisma, user: { count: mocks.count, findMany: mocks.findMany } },
  }
})

import { listAdminUsersData } from '../../api/lib/data/admin.js'

const NOW = 1_789_000_000_000
const FIVE_MINUTES_MS = 5 * 60 * 1000

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user_1',
    nickname: '顾云',
    avatarUrl: null,
    phone: '13800000000',
    email: null,
    role: 'user',
    bannedAt: null,
    createdAt: new Date(NOW - 86_400_000),
    lastActiveAt: new Date(NOW - 60_000),
    novelCount: 1,
    postCount: 2,
    followerCount: 3,
    ...overrides,
  }
}

function capturedWhere(): Record<string, unknown> {
  return (mocks.count.mock.calls[0][0] as { where: Record<string, unknown> }).where
}

beforeEach(() => {
  mocks.count.mockReset().mockResolvedValue(0)
  mocks.findMany.mockReset().mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('listAdminUsersData 状态筛选（在线/封禁）', () => {
  it('在线：where 收窄为「未封禁 + 5 分钟窗口」，行内 isOnline 与窗口判定一致', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mocks.count.mockResolvedValue(2)
    mocks.findMany.mockResolvedValue([
      baseRecord({ id: 'online_user' }),
      baseRecord({ id: 'stale_user', lastActiveAt: new Date(NOW - 6 * 60 * 1000) }),
    ])

    const payload = await listAdminUsersData({ online: true, page: 1, pageSize: 20 })

    const where = capturedWhere()
    expect(where.bannedAt).toBeNull()
    expect((where.lastActiveAt as { gte: Date }).gte.getTime()).toBe(NOW - FIVE_MINUTES_MS)
    expect(payload.items.map((item) => item.isOnline)).toEqual([true, false])
  })

  it('默认不带状态筛选时不施加任何额外条件（列表行为保持不变）', async () => {
    await listAdminUsersData({ page: 1, pageSize: 20 })

    const where = capturedWhere()
    expect(where.bannedAt).toBeUndefined()
    expect(where.lastActiveAt).toBeUndefined()
  })

  it('封禁维度回归：banned=true 只收窄 bannedAt，不下发在线条件', async () => {
    await listAdminUsersData({ banned: true, page: 1, pageSize: 20 })

    const where = capturedWhere()
    expect(where.bannedAt).toEqual({ not: null })
    expect(where.lastActiveAt).toBeUndefined()
  })
})
