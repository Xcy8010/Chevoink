import express from 'express'
import request from 'supertest'
import { beforeEach, expect, it, vi } from 'vitest'
import { DataAccessError } from '../../api/lib/prisma.js'
import type { Prisma } from '@prisma/client'

const mocks = vi.hoisted(() => ({ users: vi.fn(), accounts: vi.fn(), create: vi.fn(), update: vi.fn(), auth: vi.fn(), request: vi.fn() }))
vi.mock('../../api/lib/admin-auth.js', async original => ({ ...await original<object>(), requireAdmin: mocks.auth }))
vi.mock('../../src/app/api-client', () => ({ requestJson: mocks.request }))
vi.mock('../../api/lib/credit-policy.js', async original => ({ ...await original<object>(),
  lockCreditPolicy: vi.fn(async () => ({ publicBetaEnabled: true, publicBetaRevision: 1, globallyPaused: false, resetHourUtc8: 15, dailyAllowanceMilli: 450000 })),
  creditTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({ user: { findMany: mocks.users }, creditAccount: { findMany: mocks.accounts, createMany: mocks.create, updateMany: mocks.update } }),
}))
import { getAdminCreditsManagement } from '../../api/lib/admin-credit-model.js'
import { getAdminCreditsManagement as fetchCredits } from '../../src/features/admin/api'
import { adminUserSearchWhere } from '../../api/lib/admin-user-search.js'
import adminRouter from '../../api/routes/admin.js'

const accounts = Array.from({ length: 35 }, (_, index) => ({
  user: { id: 'user-' + index, nickname: '作者' + index, avatarUrl: null },
  dailyAllowanceMilli: 450000, dailyUsedMilli: 35000 - index * 1000,
  bonusBalanceMilli: 2000, periodEndsAt: new Date('2026-11-01T00:00:00Z'), suspendedAt: null,
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.accounts.mockResolvedValue(accounts)
  mocks.users.mockImplementation(async (args: { where?: Prisma.UserWhereInput }) => args.where ? [{ id: 'user-29' }, { id: 'user-3' }] : accounts.map(row => ({ id: row.user.id })))
  mocks.auth.mockResolvedValue({ id: 'synthetic-admin', role: 'admin' })
  mocks.request.mockResolvedValue({})
})
it.each(['user-29', '笔名', 'MAIL+tag@example.invalid', '13800000000'])('searches all users by existing admin fields without a page bound: %s', async keyword => {
  const all = await getAdminCreditsManagement()
  mocks.users.mockClear()
  const found = await getAdminCreditsManagement('  ' + keyword + '  ')
  expect(mocks.users).toHaveBeenLastCalledWith({ where: { OR: [
    { id: { contains: keyword, mode: 'insensitive' } }, { nickname: { contains: keyword, mode: 'insensitive' } },
    { phone: { contains: keyword } }, { email: { contains: keyword, mode: 'insensitive' } },
  ] }, select: { id: true } })
  expect(found.users.map(row => row.user.id)).toEqual(['user-3', 'user-29'])
  expect(found.summary).toEqual(all.summary)
  expect(found.summary.users).toBe(35)
  expect(mocks.accounts).toHaveBeenLastCalledWith({ include: { user: { select: { id: true, nickname: true, avatarUrl: true } } }, orderBy: [{ dailyUsedMilli: 'desc' }, { updatedAt: 'desc' }] })
})
it('clearing restores all accounts and an empty match does not alter global totals or execute credit mutations', async () => {
  const all = await getAdminCreditsManagement('   ')
  expect(all.users).toHaveLength(35)
  expect(adminUserSearchWhere('   ')).toEqual({})
  mocks.users.mockImplementation(async (args: { where?: unknown }) => args.where ? [] : accounts.map(row => ({ id: row.user.id })))
  const empty = await getAdminCreditsManagement('not-found')
  expect(empty.users).toEqual([])
  expect(empty.summary).toEqual(all.summary)
  expect(mocks.update.mock.calls.every(([args]) => !('suspendedAt' in args.data))).toBe(true)
})
it('passes the search through the authenticated HTTP endpoint and keeps auth denial unchanged', async () => {
  const app = express().use('/api/admin', adminRouter)
  const response = await request(app).get('/api/admin/credits').query({ search: 'user-29' })
  expect(response.status).toBe(200)
  expect(response.body.data.users.map((row: { user: { id: string } }) => row.user.id)).toEqual(['user-3', 'user-29'])
  expect(mocks.auth).toHaveBeenCalledOnce()
  mocks.users.mockClear(); mocks.accounts.mockClear()
  mocks.auth.mockRejectedValue(new DataAccessError(403, 'ADMIN_REQUIRED', '无管理权限'))
  expect((await request(app).get('/api/admin/credits').query({ search: 'user-29' })).status).toBe(403)
  expect(mocks.users).not.toHaveBeenCalled(); expect(mocks.accounts).not.toHaveBeenCalled()
})
it('encodes the existing search parameter and removes it when cleared', async () => {
  await fetchCredits('邮箱+tag@example.invalid & 名字')
  expect(mocks.request).toHaveBeenLastCalledWith('/api/admin/credits?' + new URLSearchParams({ search: '邮箱+tag@example.invalid & 名字' }).toString())
  await fetchCredits()
  expect(mocks.request).toHaveBeenLastCalledWith('/api/admin/credits')
})
