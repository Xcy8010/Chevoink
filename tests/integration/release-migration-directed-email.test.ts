import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { directedEmailMigrations, readDirectedEmailCatalog } from '../../scripts/verify-release-migration.mjs'
import { verifyTestDatabase } from '../support/database-preflight.js'

await verifyTestDatabase(true)
afterAll(() => prisma.$disconnect())

it('verifies the three reviewed mail migrations and fails on unexpected audience data', async () => {
  const schema = 'email_release_' + randomBytes(6).toString('hex')
  const rollback = new Error('rollback isolated mail catalog fixture')
  await expect(prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    await tx.$executeRawUnsafe(`SET LOCAL search_path = "${schema}"`)
    expect(await readDirectedEmailCatalog(tx, 'before')).toEqual({ objects: 0 })
    for (const [migration] of directedEmailMigrations) {
      const sql = readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8')
      for (const ddl of sql.split(';').map(part => part.trim()).filter(Boolean)) await tx.$executeRawUnsafe(ddl)
    }
    expect(await readDirectedEmailCatalog(tx, 'after')).toMatchObject({
      tables: expect.arrayContaining(['admin_email_batches', 'admin_email_permissions', 'admin_email_recipients']),
    })
    await tx.$executeRaw`INSERT INTO admin_email_permissions (purpose,email,updated_at)
      VALUES ('creator_return','release@example.test',CURRENT_TIMESTAMP)`
    await expect(readDirectedEmailCatalog(tx, 'after')).rejects.toThrow('Unexpected directed mail data')
    throw rollback
  })).rejects.toBe(rollback)
})
