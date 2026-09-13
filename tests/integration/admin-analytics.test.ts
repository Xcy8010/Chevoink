import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { getAdminAnalyticsData } from '../../api/lib/data/admin-analytics.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const ready = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })
describe.skipIf(!ready)('admin analytics real SQL', () => {
  for (const period of ['day', 'week', 'month'] as const) {
    for (const scope of ['dashboard', 'creation'] as const) {
      it(`${scope}/${period} aggregates in SQL with finite serializable values`, async () => {
        const data = await getAdminAnalyticsData(period, scope)
        expect(data.labels).toHaveLength(period === 'day' ? 14 : 12)
        expect(data.metrics).toHaveLength(scope === 'dashboard' ? 8 : 7)
        for (const metric of data.metrics) {
          expect(metric.values).toHaveLength(data.labels.length)
          expect(Number.isFinite(metric.total)).toBe(true)
          expect(metric.total).toBeCloseTo(metric.values.reduce((a, b) => a + b, 0))
        }
        expect(() => JSON.stringify(data)).not.toThrow()
        for (const tool of data.tools) expect(tool.calls).toBe(tool.succeeded + tool.failed + tool.unknown)
      })
    }
  }
})
