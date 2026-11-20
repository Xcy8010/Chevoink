import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { assertDeviceSessionsState, deviceSessionsMigrationName, readDeviceSessionsState } from '../../scripts/verify-release-migration.mjs'
import { verifyTestDatabase } from '../support/database-preflight.js'

await verifyTestDatabase(true)
afterAll(async () => { await prisma.$disconnect() })

it('checks the exact device session DDL and rejects partial installs and drift', async () => {
  const schema = 'device_release_' + randomBytes(6).toString('hex')
  const sql = readFileSync(`prisma/migrations/${deviceSessionsMigrationName}/migration.sql`, 'utf8')
  const rollback = new Error('rollback isolated device catalog fixture')
  await expect(prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    await tx.$executeRawUnsafe(`SET LOCAL search_path = "${schema}"`)
    await tx.$executeRaw`CREATE TABLE users (id varchar(64) PRIMARY KEY)`
    const before = await readDeviceSessionsState(tx, 'before')
    assertDeviceSessionsState(before, 'before')
    await tx.$executeRaw`CREATE INDEX account_device_sessions_user_id_token_version_idx ON users(id)`
    await expect(readDeviceSessionsState(tx, 'before')).rejects.toThrow(/index names/)
    await tx.$executeRaw`DROP INDEX account_device_sessions_user_id_token_version_idx`
    for (const ddl of sql.split(';').map(part => part.trim()).filter(Boolean)) await tx.$executeRawUnsafe(ddl)
    const observed = await readDeviceSessionsState(tx, 'after')
    // Production uses public. Translate only the isolated fixture's qualified table name.
    const after = { ...observed, indexes: observed.indexes.map(index => ({
      ...index, definition: index.definition.replace(` ON ${schema}.account_device_sessions `, ' ON public.account_device_sessions '),
    })) }
    assertDeviceSessionsState(after, 'after', before)
    expect(() => assertDeviceSessionsState({ ...after, constraints: after.constraints.filter(c => c.kind !== 'f') }, 'after', before)).toThrow(/mismatch/)
    expect(() => assertDeviceSessionsState({ ...after, rowCount: 1 }, 'after', before)).toThrow(/mismatch/)
    expect(() => assertDeviceSessionsState({ ...after, columns: after.columns.slice(1) }, 'after', before)).toThrow(/mismatch/)
    throw rollback
  })).rejects.toBe(rollback)
})
