import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { assertStoryProfilesState, readStoryProfilesState, storyProfilesMigrationName } from '../../scripts/verify-release-migration.mjs'
import { verifyTestDatabase } from '../support/database-preflight.js'

await verifyTestDatabase(true)
afterAll(async () => { await prisma.$disconnect() })

it('verifies both frozen catalogs around the real story profile SQL and keeps old cards usable', async () => {
  const schema = 'story_profile_release_' + randomBytes(6).toString('hex')
  const sql = readFileSync(`prisma/migrations/${storyProfilesMigrationName}/migration.sql`, 'utf8')
  const rollback = new Error('rollback isolated story profile catalog')
  await expect(prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    await tx.$executeRawUnsafe(`SET LOCAL search_path = "${schema}"`)
    await tx.$executeRaw`CREATE TYPE "ProjectMemoryType" AS ENUM ('novelSummary','worldbuilding','characterCard','chapterSummary','timelineEvent',
      'foreshadowing','stylePreference','continuityRule','volumeSummary','storyArc','sceneState','relationshipState','storyBible','authorProfile')`
    await tx.$executeRaw`CREATE TABLE chapters (id varchar(64) PRIMARY KEY)`
    await tx.$executeRaw`CREATE TABLE project_memory_entries (id varchar(64) PRIMARY KEY, novel_id varchar(64), memory_type "ProjectMemoryType")`
    await tx.$executeRaw`INSERT INTO project_memory_entries VALUES ('card','book','characterCard')`
    const before = await readStoryProfilesState(tx, 'before')
    assertStoryProfilesState(before, 'before')
    for (const statement of sql.split(';').map(s => s.trim()).filter(s => s && s !== 'BEGIN' && s !== 'COMMIT')) {
      await tx.$executeRawUnsafe(statement)
    }
    const after = await readStoryProfilesState(tx, 'after')
    assertStoryProfilesState(after, 'after', before)
    expect(await tx.$queryRaw`SELECT identity_key, aliases, profile_tracked FROM project_memory_entries WHERE id='card'`)
      .toEqual([{ identity_key: null, aliases: [], profile_tracked: false }])
    expect(() => assertStoryProfilesState({ ...after, ownedSequence: false }, 'after', before)).toThrow(/ownership/)
    expect(() => assertStoryProfilesState({ ...after, kinds: [...after.kinds].reverse() }, 'after', before)).toThrow(/enum/)
    await tx.$executeRaw`DROP INDEX project_memory_entries_novel_id_memory_type_identity_key_key`
    await tx.$executeRaw`CREATE INDEX project_memory_entries_novel_id_memory_type_identity_key_key ON project_memory_entries(identity_key)`
    const drift = await readStoryProfilesState(tx, 'after')
    expect(() => assertStoryProfilesState(drift, 'after', before)).toThrow(/identity index/)
    throw rollback
  })).rejects.toBe(rollback)
})
