import { PrismaClient } from '@prisma/client'
import { assertTestDatabaseTarget } from './database-target.js'
import { databaseUrlWithUtcSession } from '../../api/lib/prisma.js'

/** The reserved address is literal application behavior. Give its HTTP test a private
 * PostgreSQL session so existing accounts and verification rows never participate. */
export async function openReservedAdminFixture() {
  const url = assertTestDatabaseTarget(process.env.DATABASE_URL!, process.env.TEST_DATABASE_ALLOWED_HOSTS)
  const source = url.searchParams.get('schema') ?? 'public'
  url.searchParams.set('schema', 'pg_temp')
  url.searchParams.set('connection_limit', '1')
  const client = new PrismaClient({ datasourceUrl: databaseUrlWithUtcSession(url.href) })
  try {
    const tables = ['users', 'account_restrictions', 'account_device_sessions', 'email_verification_codes', 'chapters', 'volumes', 'posts',
      'comments', 'conversations', 'conversation_members', 'cover_assets', 'novels']
    const statements = await client.$queryRaw<{ ddl: string }[]>`
      SELECT format('CREATE TEMP TABLE %I (LIKE %I.%I INCLUDING ALL)', name, ${source}::text, name) AS ddl
      FROM unnest(${tables}::text[]) AS name`
    for (const { ddl } of statements) await client.$executeRawUnsafe(ddl)

    // Prisma qualifies both table and enum names. Retain real enum labels and
    // defaults while keeping their columns and comparison operators in the same schema.
    const enumDdl = await client.$queryRaw<{ ddl: string }[]>`
      WITH columns AS (
        SELECT c.relname, a.attname, t.oid, t.typname, pg_get_expr(d.adbin, d.adrelid) AS default_value
        FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
        JOIN pg_type t ON a.atttypid = t.oid
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE c.relnamespace = pg_my_temp_schema() AND c.relkind = 'r' AND t.typtype = 'e' AND NOT a.attisdropped
      ), steps AS (
        SELECT 1 AS step, format('CREATE TYPE pg_temp.%I AS ENUM (%s)', e.typname,
          string_agg(quote_literal(v.enumlabel), ', ' ORDER BY v.enumsortorder)) AS ddl
        FROM (SELECT DISTINCT oid, typname FROM columns) e JOIN pg_enum v ON v.enumtypid = e.oid GROUP BY e.typname
        UNION ALL
        SELECT 2, format('ALTER TABLE pg_temp.%I ALTER %I DROP DEFAULT, ALTER %I TYPE pg_temp.%I USING %I::text::pg_temp.%I',
          relname, attname, attname, typname, attname, typname) FROM columns
        UNION ALL
        SELECT 3, format('ALTER TABLE pg_temp.%I ALTER %I SET DEFAULT (%s)::text::pg_temp.%I',
          relname, attname, default_value, typname) FROM columns WHERE default_value IS NOT NULL
      ) SELECT ddl FROM steps ORDER BY step`
    for (const { ddl } of enumDdl) await client.$executeRawUnsafe(ddl)
    return client
  } catch (error) {
    await client.$disconnect()
    throw error
  }
}
