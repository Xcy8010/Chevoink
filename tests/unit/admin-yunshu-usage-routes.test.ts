import express from 'express'
import request from 'supertest'
import { beforeEach, expect, it, vi } from 'vitest'
import { DataAccessError } from '../../api/lib/prisma.js'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }))
vi.mock('../../api/lib/admin-auth.js', async original => ({ ...await original<object>(), requireAdmin: mocks.auth }))
vi.mock('../../api/lib/admin-yunshu-usage.js', () => ({ getAdminYunshuModelUsage: mocks.read }))
import router from '../../api/routes/admin.js'
const app = express().use('/api/admin', router)
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ id: 'fixture-admin' }); mocks.read.mockResolvedValue({ source: 'yunshu_admin_logs', state: 'unconfigured' }) })
it('authenticates before validating period or reading upstream', async () => {
  mocks.auth.mockRejectedValueOnce(new DataAccessError(403, 'ADMIN_REQUIRED', '需要管理员权限。'))
  expect((await request(app).get('/api/admin/yunshu-model-usage?period=bad')).status).toBe(403)
  expect(mocks.read).not.toHaveBeenCalled()
})
it('validates bounded period queries and forwards cancellation without any secrets in the client request', async () => {
  for (const query of ['period=bad', 'period=month&key=secret', 'period=today&period=week']) expect((await request(app).get('/api/admin/yunshu-model-usage?' + query)).status).toBe(400)
  expect(mocks.read).not.toHaveBeenCalled()
  const response = await request(app).get('/api/admin/yunshu-model-usage?period=week')
  expect(response.status).toBe(200); expect(mocks.read).toHaveBeenCalledWith('week', expect.any(AbortSignal))
})
