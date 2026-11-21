import { createHmac } from 'node:crypto'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildSessionTokens, evictUserBanCache, getUserAuthState, issueDeviceVerification, readDeviceVerification, verifySessionToken } from '../../api/lib/auth-session.js'
import { env } from '../../api/config/env.js'
import { prisma } from '../../api/lib/prisma.js'

/** P2 用例需控制 DB 行为：替换 prisma 为桩（保留 DataAccessError 等真实导出） */
vi.mock('../../api/lib/prisma.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/lib/prisma.js')>()
  return {
    ...actual,
    prisma: {
      user: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    },
  }
})

const USER_ID = 'user_test_123'
const TOKEN_VERSION = 3

function signV1(userId: string, expiresAt: number): string {
  const signature = createHmac('sha256', env.authSessionSecret).update(`${userId}.${expiresAt}`).digest('hex')
  return `${userId}.${expiresAt}.${signature}`
}

afterEach(() => {
  vi.useRealTimers()
})

describe('v2 会话令牌', () => {
  it('签发 access/refresh 均可按各自 kind 验证通过', () => {
    const tokens = buildSessionTokens(USER_ID, TOKEN_VERSION)
    const access = verifySessionToken(tokens.accessToken, 'access')
    const refresh = verifySessionToken(tokens.refreshToken, 'refresh')
    expect(access).toEqual({ userId: USER_ID, tokenVersion: TOKEN_VERSION })
    expect(refresh).toEqual({ userId: USER_ID, tokenVersion: TOKEN_VERSION })
  })

  it('v2 令牌为 6 段格式（v2.userId.expiresAt.version.kind.sig）', () => {
    const tokens = buildSessionTokens(USER_ID, TOKEN_VERSION)
    expect(tokens.accessToken.split('.')).toHaveLength(6)
    expect(tokens.accessToken.split('.')[0]).toBe('v2')
    expect(tokens.accessToken.split('.')[4]).toBe('access')
    expect(tokens.refreshToken.split('.')[4]).toBe('refresh')
  })

  it('access 与 refresh 不得混用（kind 校验）', () => {
    const tokens = buildSessionTokens(USER_ID, TOKEN_VERSION)
    expect(verifySessionToken(tokens.refreshToken, 'access')).toBeNull()
    expect(verifySessionToken(tokens.accessToken, 'refresh')).toBeNull()
  })

  it('篡改任意段（含 tokenVersion 提权/降权）验签失败', () => {
    const tokens = buildSessionTokens(USER_ID, TOKEN_VERSION)
    const segments = tokens.accessToken.split('.')
    // tokenVersion 3 → 9（模拟旧版本令牌伪造更高版本）
    segments[3] = '9'
    expect(verifySessionToken(segments.join('.'), 'access')).toBeNull()

    const tamperedUser = tokens.accessToken.replace(USER_ID, 'user_other_999')
    expect(verifySessionToken(tamperedUser, 'access')).toBeNull()
  })

  it('access（24h）过期后失效，refresh（30d）仍有效', () => {
    const tokens = buildSessionTokens(USER_ID, TOKEN_VERSION)
    vi.setSystemTime(new Date(Date.now() + 25 * 3600 * 1000))
    expect(verifySessionToken(tokens.accessToken, 'access')).toBeNull()
    expect(verifySessionToken(tokens.refreshToken, 'refresh')).not.toBeNull()
  })

  it('垃圾输入一律拒绝', () => {
    expect(verifySessionToken('', 'access')).toBeNull()
    expect(verifySessionToken(undefined, 'access')).toBeNull()
    expect(verifySessionToken('v2.only.three', 'access')).toBeNull()
    expect(verifySessionToken('a.b.c.d.e.f.g', 'access')).toBeNull()
    expect(verifySessionToken('v2.u.123.0.access.deadbeef', 'access')).toBeNull()
    expect(verifySessionToken('v2.u.notanumber.0.access.x'.padEnd(40, '.'), 'access')).toBeNull()
  })
})

describe('device-bound signing', () => {
  it('binds remote sign-out verification to the account, login and credential version until its fixed deadline', () => {
    vi.useFakeTimers()
    const identity = { userId: USER_ID, deviceId: 'first-login', tokenVersion: TOKEN_VERSION }
    const append = vi.fn()
    const start = Date.now()
    const deadline = issueDeviceVerification({ append } as unknown as Response, identity)
    const cookie = append.mock.calls[0][1].split(';')[0]
    const req = { headers: { cookie } } as Request
    expect(deadline).toBe(start + 600_000)
    vi.setSystemTime(deadline - 1)
    expect(readDeviceVerification(req, identity)).toBe(deadline)
    for (const change of [{ userId: 'another-account' }, { deviceId: 'another-login' }, { tokenVersion: TOKEN_VERSION + 1 }]) {
      expect(readDeviceVerification(req, { ...identity, ...change })).toBeNull()
    }
    vi.setSystemTime(deadline)
    expect(readDeviceVerification(req, identity)).toBeNull()
  })
  it('signs the device, account, credential kind and account version together', () => {
    const tokens = buildSessionTokens(USER_ID, TOKEN_VERSION, 'phone-fixture')
    expect(verifySessionToken(tokens.accessToken, 'access')).toEqual({ userId: USER_ID, tokenVersion: TOKEN_VERSION, deviceId: 'phone-fixture' })
    expect(verifySessionToken(tokens.refreshToken, 'access')).toBeNull()
    expect(verifySessionToken(tokens.accessToken.replace('phone-fixture', 'desktop-fixture'), 'access')).toBeNull()
  })
})

describe('v1 存量令牌双读兼容', () => {
  it('合法 v1 令牌按 access 语义读取，tokenVersion 为 null', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const token = signV1(USER_ID, expiresAt)
    expect(verifySessionToken(token, 'access')).toEqual({ userId: USER_ID, tokenVersion: null })
    // v1 无 kind 段，refresh 语义同样放行（与闸口读取顺序兼容）
    expect(verifySessionToken(token, 'refresh')).toEqual({ userId: USER_ID, tokenVersion: null })
  })

  it('过期 v1 令牌拒绝', () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 1
    expect(verifySessionToken(signV1(USER_ID, expiresAt), 'access')).toBeNull()
  })

  it('签名不匹配的 v1 令牌拒绝', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    expect(verifySessionToken(`${USER_ID}.${expiresAt}.deadbeef`, 'access')).toBeNull()
  })
})

describe('R03 会话状态缓存与故障拒绝', () => {
  const findUnique = vi.mocked(prisma.user.findUnique)

  beforeEach(() => {
    vi.useRealTimers()
    findUnique.mockReset()
  })

  it('DB 正常路径：成功状态写缓存，60s 内复用不重复查库', async () => {
    findUnique.mockResolvedValue({ bannedAt: null, tokenVersion: 3 } as never)
    const first = await getUserAuthState('p2-normal')
    expect(first).toEqual(expect.objectContaining({ banned: false, tokenVersion: 3 }))
    const second = await getUserAuthState('p2-normal')
    expect(second?.tokenVersion).toBe(3)
    expect(findUnique).toHaveBeenCalledTimes(1)
    evictUserBanCache('p2-normal')
  })

  it('DB 故障 + 过期缓存（60s~10 分钟）→ 拒绝使用历史状态', async () => {
    vi.useFakeTimers()
    const base = Date.now()
    findUnique.mockResolvedValueOnce({ bannedAt: new Date(), tokenVersion: 5 } as never)
    const warm = await getUserAuthState('p2-stale')
    expect(warm?.banned).toBe(true)

    // 超过TTL的历史状态不能充当当前授权依据。
    vi.setSystemTime(base + 5 * 60_000)
    findUnique.mockRejectedValueOnce(new Error('db down'))
    await expect(getUserAuthState('p2-stale')).rejects.toMatchObject({ status: 503, code: 'AUTH_SESSION_UNAVAILABLE' })
    vi.useRealTimers()
    evictUserBanCache('p2-stale')
  })

  it('DB 故障 + 缓存年龄超过10分钟仍拒绝，不变成匿名或已认证', async () => {
    vi.useFakeTimers()
    const base = Date.now()
    findUnique.mockResolvedValueOnce({ bannedAt: null, tokenVersion: 2 } as never)
    await getUserAuthState('p2-expired')

    vi.setSystemTime(base + 11 * 60_000)
    findUnique.mockRejectedValueOnce(new Error('db down'))
    await expect(getUserAuthState('p2-expired')).rejects.toMatchObject({ status: 503 })
    vi.useRealTimers()
    evictUserBanCache('p2-expired')
  })

  it('DB 故障 + 无历史缓存 → 明确不可核实', async () => {
    findUnique.mockRejectedValueOnce(new Error('db down'))
    await expect(getUserAuthState('p2-cold')).rejects.toMatchObject({ status: 503 })
  })

  it('缓存超5000条淘汰最旧项；诊断缓存不改变新请求实时核实策略', async () => {
    findUnique.mockImplementation(async () => ({ bannedAt: null, tokenVersion: 1 }) as never)
    for (let index = 0; index < 5001; index += 1) {
      await getUserAuthState(`p2-cap-${index}`)
    }

    // 最旧项已淘汰，无法查库就返回不可核实。
    findUnique.mockRejectedValueOnce(new Error('db down'))
    await expect(getUserAuthState('p2-cap-0')).rejects.toMatchObject({ status: 503 })

    // 最新项的只读诊断缓存仍在TTL内；授权入口另测fresh:true不使用此缓存。
    const last = await getUserAuthState('p2-cap-5000')
    expect(last?.tokenVersion).toBe(1)

    for (let index = 1; index <= 5000; index += 1) {
      evictUserBanCache(`p2-cap-${index}`)
    }
  })
})
