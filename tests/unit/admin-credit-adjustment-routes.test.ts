import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { beforeEach, expect, it, vi } from 'vitest'
import { DataAccessError } from '../../api/lib/prisma.js'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), captcha: vi.fn(), adjust: vi.fn() }))
vi.mock('../../api/lib/admin-auth.js', async original => ({ ...await original<object>(), requireAdmin: mocks.auth }))
vi.mock('../../api/lib/auth-captcha.js', async original => ({ ...await original<object>(), verifyAuthCaptchaChallenge: mocks.captcha }))
vi.mock('../../api/lib/admin-credit-adjustment.js', () => ({ adjustAdminBonusCredits: mocks.adjust }))
import router from '../../api/routes/admin.js'
const app = express().use(express.json()).use('/api/admin', router)
const payload = () => ({ mode: 'add', amountMilli: 1000, expectedBonusBalanceMilli: 0, reason: ' 客服补偿 ', requestKey: randomUUID(), captchaId: 'test-captcha', captchaAnswer: 'abcd', confirmation: 'ADJUST_CREDITS' })
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ id: 'admin', isSuperAdmin: true }); mocks.adjust.mockResolvedValue({ bonusBalanceMilli: 1000 }) })
it('authenticates and requires superadmin before parsing or consuming captcha', async () => {
  mocks.auth.mockRejectedValueOnce(new DataAccessError(401, 'AUTH_REQUIRED', '请登录'))
  expect((await request(app).post('/api/admin/credits/users/user/adjust-bonus').send({})).status).toBe(401)
  mocks.auth.mockResolvedValueOnce({ id: 'admin', isSuperAdmin: false })
  expect((await request(app).post('/api/admin/credits/users/user/adjust-bonus').send(payload())).status).toBe(403)
  expect(mocks.captcha).not.toHaveBeenCalled(); expect(mocks.adjust).not.toHaveBeenCalled()
})
it('rejects malformed amount, missing identity, unexpected properties and confirmation before mutation', async () => {
  for (const patch of [{ amountMilli: -1 }, { amountMilli: 1.1 }, { requestKey: '' }, { reason: '' }, { confirmation: 'RESET_USER' }, { extra: 'bad' }]) expect((await request(app).post('/api/admin/credits/users/user/adjust-bonus').send({ ...payload(), ...patch })).status).toBe(400)
  expect(mocks.adjust).not.toHaveBeenCalled()
})
it('verifies captcha then forwards validated reward adjustment without separate audit side effects', async () => {
  const body = payload()
  expect((await request(app).post('/api/admin/credits/users/user/adjust-bonus').send(body)).status).toBe(200)
  expect(mocks.captcha).toHaveBeenCalledWith('test-captcha', 'abcd')
  expect(mocks.adjust).toHaveBeenCalledWith('admin', 'user', expect.objectContaining({ ...body, reason: '客服补偿' }), expect.anything())
  mocks.captcha.mockImplementationOnce(() => { throw new DataAccessError(400, 'CAPTCHA_INVALID', '验证码错误') })
  mocks.adjust.mockClear()
  expect((await request(app).post('/api/admin/credits/users/user/adjust-bonus').send(payload())).status).toBe(400)
  expect(mocks.adjust).not.toHaveBeenCalled()
})
