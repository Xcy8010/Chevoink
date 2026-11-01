import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { listAdminAuditLogsData } from '../../api/lib/data-access.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(async () => { await prisma.$disconnect() })

describe.runIf(available)('server audit filters and response redaction on isolated PostgreSQL', () => {
  it('filters the complete matching set at UTC+8 day boundaries, pages stably and retains stored evidence', async () => {
    const adminId = randomUUID(), prefix = randomUUID()
    const from = new Date('2026-11-01T00:00:00+08:00'), to = new Date('2026-11-01T23:59:59.999+08:00')
    const times = [new Date(from.getTime()-1), from, to, new Date(to.getTime()+1)]
    const ids = times.map(() => randomUUID())
    const detail = { requestTokens: 12, apiKeyConfigured: true, secret: 'synthetic-private-secret', nested: { password: 'synthetic-password', enabled: true }, baseUrl: 'https://example.invalid/v1/private?token=synthetic-query' }
    await prisma.user.create({data:{id:adminId,nickname:`审计合成-${prefix}`,passwordHash:'synthetic-no-login',role:'admin'}})
    try {
      await prisma.adminAuditLog.createMany({data:times.map((createdAt,i)=>({id:ids[i],adminId,action:'models.update',targetType:'aiModelConfig',targetId:prefix,detail,createdAt}))})
      const query = {operator:`审计合成-${prefix}`,objectId:prefix,action:'models.update',targetType:'aiModelConfig',from,to,page:1,pageSize:1}
      const first = await listAdminAuditLogsData(query)
      const second = await listAdminAuditLogsData({...query,page:2})
      expect(first.pagination).toMatchObject({total:2,pageSize:1,hasMore:true})
      expect(first.items.map(row=>row.id)).toEqual([ids[2]])
      expect(second.items.map(row=>row.id)).toEqual([ids[1]])
      expect(first.items[0].detail).toMatchObject({requestTokens:12,apiKeyConfigured:true,nested:{enabled:true},baseUrl:{origin:'https://example.invalid'}})
      const serialized = JSON.stringify(first)
      for(const secret of ['synthetic-private-secret','synthetic-password','synthetic-query','/v1/private']) expect(serialized).not.toContain(secret)
      expect((await prisma.adminAuditLog.findUniqueOrThrow({where:{id:ids[2]}})).detail).toEqual(detail)
      expect((await listAdminAuditLogsData({...query,operator:adminId})).pagination.total).toBe(2)
      expect((await listAdminAuditLogsData({...query,objectId:'no-match-'+prefix})).pagination.total).toBe(0)
    } finally {
      await prisma.adminAuditLog.deleteMany({where:{id:{in:ids}}})
      await prisma.user.delete({where:{id:adminId}})
    }
  })
})
