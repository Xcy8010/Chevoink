import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const migrationName = '20261009010000_quality_finding_span_identity'
export const migrationChecksum = 'ca2151daa4f4e496269b4e6d481918ad44572958313cec7d5febd14e92b3b6d0'
const oldIndex = 'quality_findings_report_id_source_signal_evidence_hash_key'
const newIndex = 'quality_findings_report_source_signal_span_key'
const oldDeclaration = '@@unique([reportId, source, signal, evidenceHash])'
const newDeclaration = '@@unique([reportId, source, signal, startOffset, endOffset, evidenceHash], map: "quality_findings_report_source_signal_span_key")'
const digest = value => createHash('sha256').update(value).digest('hex')
function files(root, relative = '') {
  return readdirSync(path.join(root, relative)).sort().flatMap(name => {
    const key = relative ? `${relative}/${name}` : name
    const stat = lstatSync(path.join(root, key))
    if (stat.isDirectory()) return files(root, key)
    if (!stat.isFile()) throw Error('Unexpected migration filesystem entry')
    return [[key, digest(readFileSync(path.join(root, key)))]]
  })
}

/** Ordinary releases stay byte-identical. This single reviewed exception cannot
 * authorize unrelated schema edits, historical checksum changes or extra SQL. */
export function releaseMigrationPlan(candidate, baseline) {
  const next = readFileSync(path.join(candidate, 'prisma/schema.prisma'), 'utf8')
  const previous = readFileSync(path.join(baseline, 'prisma/schema.prisma'), 'utf8')
  const currentFiles = files(path.join(candidate, 'prisma/migrations'))
  const oldFiles = files(path.join(baseline, 'prisma/migrations'))
  if (next === previous && JSON.stringify(currentFiles) === JSON.stringify(oldFiles)) return 'routine'
  if (previous.split(oldDeclaration).length !== 2 || next !== previous.replace(oldDeclaration, newDeclaration)) throw Error('Unapproved schema change')
  const target = `${migrationName}/migration.sql`
  if (oldFiles.some(([name]) => name === target)
    || JSON.stringify(currentFiles.filter(([name]) => name !== target)) !== JSON.stringify(oldFiles)
    || currentFiles.find(([name]) => name === target)?.[1] !== migrationChecksum) throw Error('Unapproved migration change')
  return migrationName
}

export function assertMigrationState(rows, checksums, phase, before) {
  if (!['before', 'after'].includes(phase)) throw Error('Invalid migration verification phase')
  const expected = new Map(checksums)
  if (phase === 'before') expected.delete(migrationName)
  if (rows.length !== expected.size) throw Error('Unexpected pending, duplicate or additional migration')
  if (phase === 'after') assertMigrationState(before, checksums, 'before')
  const previous = new Map((before ?? []).map(row => [row.migration_name, row]))
  for (const row of rows) {
    if (!expected.has(row.migration_name) || !/^[a-f0-9]{64}$/.test(row.checksum)
      || !row.finished_at || row.rolled_back_at || !Number.isInteger(row.applied_steps_count) || row.applied_steps_count < 1) throw Error('Migration history is not fully verified')
    if (phase === 'after') {
      if (row.migration_name === migrationName) {
        if (row.checksum !== migrationChecksum) throw Error('New migration checksum mismatch')
      } else {
        const old = previous.get(row.migration_name)
        if (!old || row.checksum !== old.checksum || new Date(row.finished_at).toISOString() !== new Date(old.finished_at).toISOString()
          || row.applied_steps_count !== old.applied_steps_count) throw Error('Historical migration changed during deployment')
      }
    }
    expected.delete(row.migration_name)
  }
  if (expected.size) throw Error('Historical migration is pending')
}

export function assertMigrationEnvironment(environment, shared) {
  if (environment.APP_ENV !== 'production' || shared.APP_ENV !== 'production'
    || !shared.DATABASE_URL || environment.DATABASE_URL !== shared.DATABASE_URL) throw Error('Production migration environment mismatch')
  const url = new URL(shared.DATABASE_URL)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw Error('Invalid production database identity')
  return { database: decodeURIComponent(url.pathname.slice(1)), schema: url.searchParams.get('schema') || 'public' }
}

export function assertDatabaseIdentity(actual, expected) {
  if (actual.database !== expected.database || actual.schema !== expected.schema) throw Error('Production database identity mismatch')
}

export function assertFindingIndex(rows, phase) {
  const name = phase === 'before' ? oldIndex : newIndex
  const columns = ['report_id', 'source', 'signal', ...(phase === 'before' ? [] : ['start_offset', 'end_offset']), 'evidence_hash']
  if (rows.length !== 1 || rows[0].name !== name || rows[0].table_name !== 'quality_findings'
    || !rows[0].is_unique || !rows[0].is_valid || !rows[0].is_ready || rows[0].has_predicate || rows[0].has_expression
    || JSON.stringify(rows[0].columns) !== JSON.stringify(columns)) throw Error('Quality finding index mismatch')
}

async function main() {
  const [phase, candidate, baseline, receipt] = process.argv.slice(2)
  const plan = releaseMigrationPlan(candidate, baseline)
  if (phase === 'plan') { process.stdout.write(`${plan}\n`); return }
  if (!['before', 'after'].includes(phase) || plan !== migrationName || !receipt) throw Error('No authorized migration verification')
  const sharedPath = '/opt/chevoink/shared/app.env'
  if (realpathSync(path.join(candidate, '.env')) !== sharedPath) throw Error('Shared production environment path mismatch')
  const { parse } = await import('dotenv')
  const expectedDatabase = assertMigrationEnvironment(process.env, parse(readFileSync(sharedPath)))
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient()
  try {
    const evidence = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      const [database] = await tx.$queryRawUnsafe('SELECT current_database() AS database, current_schema() AS schema')
      assertDatabaseIdentity(database, expectedDatabase)
      const rows = await tx.$queryRawUnsafe('SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count FROM "_prisma_migrations" ORDER BY migration_name')
      const checksums = files(path.join(candidate, 'prisma/migrations')).filter(([name]) => name.endsWith('/migration.sql'))
        .map(([name, hash]) => [name.slice(0, -'/migration.sql'.length), hash])
      const before = phase === 'after' ? JSON.parse(readFileSync(path.join(candidate, '.release-migration-before.json'), 'utf8')) : null
      if (before && (before.migration !== migrationName || before.checksum !== migrationChecksum || before.phase !== 'before')) throw Error('Migration preflight receipt mismatch')
      if (before) assertDatabaseIdentity(database, before.database)
      assertMigrationState(rows, checksums, phase, before?.migrations)
      const indexes = await tx.$queryRawUnsafe(`SELECT c.relname AS name, t.relname AS table_name, i.indisunique AS is_unique,
        i.indisvalid AS is_valid, i.indisready AS is_ready, i.indpred IS NOT NULL AS has_predicate, i.indexprs IS NOT NULL AS has_expression,
        ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord) AS columns
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname=current_schema() AND c.relname IN ('${oldIndex}', '${newIndex}')`)
      assertFindingIndex(indexes, phase)
      return { migration: migrationName, checksum: migrationChecksum, phase, checkedAt: new Date().toISOString(), database, migrations: rows, indexes }
    })
    writeFileSync(receipt, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    process.stdout.write(`[chevoink] migration ${phase} verified\n`)
  } finally { await db.$disconnect() }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()