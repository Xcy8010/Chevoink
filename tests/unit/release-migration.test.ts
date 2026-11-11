import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertMigrationEnvironment, assertDatabaseIdentity, assertFindingIndex, assertMigrationState, migrationChecksum, migrationName, releaseMigrationPlan,
  fetchMigrationName, fetchMigrationChecksum, fetchSeedEvidence, assertFetchSeed,
  webToolBillingMigrationName, webToolBillingMigrationChecksum, assertWebToolBillingState,
  adminModelLifecycleMigrationName, adminModelLifecycleMigrationChecksum, lifecycleColumns, lifecycleIndexes, assertAdminModelLifecycleState,
  adminExperiencePlan, adminExperienceMigrations, assertAdminExperienceState, readAdminExperienceState,
  appReleaseRetentionMigrationName, appReleaseRetentionMigrationChecksum, retentionColumns, retentionIndexes, retentionConstraints, assertAppReleaseRetentionState, readAppReleaseRetentionState,
  announcementReadsMigrationName, announcementReadsMigrationChecksum, assertAnnouncementReadsState,
  userNotificationsMigrationName, userNotificationsMigrationChecksum,
  emailAccountMigrationName, emailAccountMigrationChecksum } from '../../scripts/verify-release-migration.mjs'

// Static catalog captured after the four frozen SQL files in isolated PostgreSQL.
const experienceCatalog = {
  tables: [
    {"name":"app_release_channels","kind":"r"},
    {"name":"app_release_operations","kind":"r"},
    {"name":"app_releases","kind":"r"},
    {"name":"credit_accounts","kind":"r"},
    {"name":"image_operations","kind":"r"},
    {"name":"site_content_versions","kind":"r"},
    {"name":"site_contents","kind":"r"},
    {"name":"tester_entitlements","kind":"r"},
    {"name":"user_legal_consents","kind":"r"},
  ],
  columns: [
    {"table":"app_release_channels","name":"channel","type":"character varying(16)","required":true,"defaultValue":null},
    {"table":"app_release_channels","name":"release_id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"app_release_channels","name":"revision","type":"integer","required":true,"defaultValue":"1"},
    {"table":"app_release_channels","name":"updated_at","type":"timestamp(3) without time zone","required":true,"defaultValue":null},
    {"table":"app_release_channels","name":"enabled","type":"boolean","required":true,"defaultValue":"true"},
    {"table":"app_release_operations","name":"id","type":"character varying(100)","required":true,"defaultValue":null},
    {"table":"app_release_operations","name":"request_hash","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"app_release_operations","name":"action","type":"character varying(24)","required":true,"defaultValue":null},
    {"table":"app_release_operations","name":"actor_id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"app_release_operations","name":"release_id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"app_release_operations","name":"previous_release_id","type":"character varying(64)","required":false,"defaultValue":null},
    {"table":"app_release_operations","name":"status","type":"character varying(24)","required":true,"defaultValue":null},
    {"table":"app_release_operations","name":"result","type":"jsonb","required":false,"defaultValue":null},
    {"table":"app_release_operations","name":"created_at","type":"timestamp(3) without time zone","required":true,"defaultValue":"CURRENT_TIMESTAMP"},
    {"table":"app_release_operations","name":"updated_at","type":"timestamp(3) without time zone","required":true,"defaultValue":null},
    {"table":"app_releases","name":"id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"app_releases","name":"label","type":"character varying(100)","required":true,"defaultValue":null},
    {"table":"app_releases","name":"source_sha","type":"character varying(40)","required":true,"defaultValue":null},
    {"table":"app_releases","name":"artifact_sha256","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"app_releases","name":"manifest","type":"jsonb","required":true,"defaultValue":null},
    {"table":"app_releases","name":"public_notes","type":"jsonb","required":true,"defaultValue":null},
    {"table":"app_releases","name":"compatibility_version","type":"integer","required":true,"defaultValue":null},
    {"table":"app_releases","name":"verified_at","type":"timestamp(3) without time zone","required":false,"defaultValue":null},
    {"table":"app_releases","name":"registered_by_id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"app_releases","name":"created_at","type":"timestamp(3) without time zone","required":true,"defaultValue":"CURRENT_TIMESTAMP"},
    {"table":"app_releases","name":"validation_state","type":"character varying(24)","required":true,"defaultValue":"'draft'::character varying"},
    {"table":"credit_accounts","name":"tester_topup_sequence","type":"integer","required":true,"defaultValue":"0"},
    {"table":"image_operations","name":"id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"image_operations","name":"user_id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"image_operations","name":"operation_id","type":"character varying(100)","required":true,"defaultValue":null},
    {"table":"image_operations","name":"request_hash","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"image_operations","name":"input_snapshot","type":"jsonb","required":true,"defaultValue":null},
    {"table":"image_operations","name":"state","type":"character varying(24)","required":true,"defaultValue":"'prepared'::character varying"},
    {"table":"image_operations","name":"route_index","type":"integer","required":true,"defaultValue":"0"},
    {"table":"image_operations","name":"result","type":"jsonb","required":false,"defaultValue":null},
    {"table":"image_operations","name":"error_code","type":"character varying(100)","required":false,"defaultValue":null},
    {"table":"image_operations","name":"created_at","type":"timestamp(3) without time zone","required":true,"defaultValue":"CURRENT_TIMESTAMP"},
    {"table":"image_operations","name":"updated_at","type":"timestamp(3) without time zone","required":true,"defaultValue":null},
    {"table":"site_content_versions","name":"id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"site_content_versions","name":"content_id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"site_content_versions","name":"content_version","type":"integer","required":true,"defaultValue":null},
    {"table":"site_content_versions","name":"payload","type":"jsonb","required":true,"defaultValue":null},
    {"table":"site_content_versions","name":"hash","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"site_content_versions","name":"published_at","type":"timestamp(3) without time zone","required":true,"defaultValue":"CURRENT_TIMESTAMP"},
    {"table":"site_content_versions","name":"effective_at","type":"timestamp(3) without time zone","required":false,"defaultValue":null},
    {"table":"site_contents","name":"id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"site_contents","name":"kind","type":"character varying(24)","required":true,"defaultValue":null},
    {"table":"site_contents","name":"key","type":"character varying(80)","required":true,"defaultValue":null},
    {"table":"site_contents","name":"revision","type":"integer","required":true,"defaultValue":"1"},
    {"table":"site_contents","name":"draft","type":"jsonb","required":true,"defaultValue":null},
    {"table":"site_contents","name":"withdrawn","type":"boolean","required":true,"defaultValue":"false"},
    {"table":"site_contents","name":"deleted_at","type":"timestamp(3) without time zone","required":false,"defaultValue":null},
    {"table":"site_contents","name":"published_version_id","type":"character varying(64)","required":false,"defaultValue":null},
    {"table":"site_contents","name":"created_at","type":"timestamp(3) without time zone","required":true,"defaultValue":"CURRENT_TIMESTAMP"},
    {"table":"site_contents","name":"updated_at","type":"timestamp(3) without time zone","required":true,"defaultValue":null},
    {"table":"tester_entitlements","name":"user_id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"tester_entitlements","name":"enabled","type":"boolean","required":true,"defaultValue":"true"},
    {"table":"tester_entitlements","name":"revision","type":"integer","required":true,"defaultValue":"1"},
    {"table":"tester_entitlements","name":"reason","type":"character varying(500)","required":true,"defaultValue":null},
    {"table":"tester_entitlements","name":"granted_by_id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"tester_entitlements","name":"expires_at","type":"timestamp(3) without time zone","required":false,"defaultValue":null},
    {"table":"tester_entitlements","name":"created_at","type":"timestamp(3) without time zone","required":true,"defaultValue":"CURRENT_TIMESTAMP"},
    {"table":"tester_entitlements","name":"updated_at","type":"timestamp(3) without time zone","required":true,"defaultValue":null},
    {"table":"user_legal_consents","name":"id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"user_legal_consents","name":"user_id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"user_legal_consents","name":"version_id","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"user_legal_consents","name":"kind","type":"character varying(24)","required":true,"defaultValue":null},
    {"table":"user_legal_consents","name":"hash","type":"character varying(64)","required":true,"defaultValue":null},
    {"table":"user_legal_consents","name":"accepted_at","type":"timestamp(3) without time zone","required":true,"defaultValue":"CURRENT_TIMESTAMP"},
  ],
  indexes: [
    {"table":"app_release_channels","name":"app_release_channels_pkey","definition":"CREATE UNIQUE INDEX app_release_channels_pkey ON public.app_release_channels USING btree (channel)","valid":true,"ready":true},
    {"table":"app_release_operations","name":"app_release_operations_pkey","definition":"CREATE UNIQUE INDEX app_release_operations_pkey ON public.app_release_operations USING btree (id)","valid":true,"ready":true},
    {"table":"app_releases","name":"app_releases_pkey","definition":"CREATE UNIQUE INDEX app_releases_pkey ON public.app_releases USING btree (id)","valid":true,"ready":true},
    {"table":"image_operations","name":"image_operations_pkey","definition":"CREATE UNIQUE INDEX image_operations_pkey ON public.image_operations USING btree (id)","valid":true,"ready":true},
    {"table":"image_operations","name":"image_operations_user_id_operation_id_key","definition":"CREATE UNIQUE INDEX image_operations_user_id_operation_id_key ON public.image_operations USING btree (user_id, operation_id)","valid":true,"ready":true},
    {"table":"site_content_versions","name":"site_content_versions_content_id_content_version_key","definition":"CREATE UNIQUE INDEX site_content_versions_content_id_content_version_key ON public.site_content_versions USING btree (content_id, content_version)","valid":true,"ready":true},
    {"table":"site_content_versions","name":"site_content_versions_effective_at_idx","definition":"CREATE INDEX site_content_versions_effective_at_idx ON public.site_content_versions USING btree (effective_at)","valid":true,"ready":true},
    {"table":"site_content_versions","name":"site_content_versions_pkey","definition":"CREATE UNIQUE INDEX site_content_versions_pkey ON public.site_content_versions USING btree (id)","valid":true,"ready":true},
    {"table":"site_contents","name":"site_contents_kind_key_key","definition":"CREATE UNIQUE INDEX site_contents_kind_key_key ON public.site_contents USING btree (kind, key)","valid":true,"ready":true},
    {"table":"site_contents","name":"site_contents_pkey","definition":"CREATE UNIQUE INDEX site_contents_pkey ON public.site_contents USING btree (id)","valid":true,"ready":true},
    {"table":"tester_entitlements","name":"tester_entitlements_pkey","definition":"CREATE UNIQUE INDEX tester_entitlements_pkey ON public.tester_entitlements USING btree (user_id)","valid":true,"ready":true},
    {"table":"user_legal_consents","name":"user_legal_consents_pkey","definition":"CREATE UNIQUE INDEX user_legal_consents_pkey ON public.user_legal_consents USING btree (id)","valid":true,"ready":true},
    {"table":"user_legal_consents","name":"user_legal_consents_user_id_kind_key","definition":"CREATE UNIQUE INDEX user_legal_consents_user_id_kind_key ON public.user_legal_consents USING btree (user_id, kind)","valid":true,"ready":true},
  ],
  constraints: [
    {"table":"app_release_channels","name":"app_release_channels_pkey","kind":"p","definition":"PRIMARY KEY (channel)","valid":true},
    {"table":"app_release_channels","name":"app_release_channels_release_id_fkey","kind":"f","definition":"FOREIGN KEY (release_id) REFERENCES app_releases(id)","valid":true},
    {"table":"app_release_operations","name":"app_release_operations_pkey","kind":"p","definition":"PRIMARY KEY (id)","valid":true},
    {"table":"app_releases","name":"app_releases_pkey","kind":"p","definition":"PRIMARY KEY (id)","valid":true},
    {"table":"app_releases","name":"app_releases_validation_state_check","kind":"c","definition":"CHECK (((validation_state)::text = ANY ((ARRAY['draft'::character varying, 'verified'::character varying])::text[])))","valid":true},
    {"table":"image_operations","name":"image_operations_pkey","kind":"p","definition":"PRIMARY KEY (id)","valid":true},
    {"table":"site_content_versions","name":"site_content_versions_content_id_fkey","kind":"f","definition":"FOREIGN KEY (content_id) REFERENCES site_contents(id) ON UPDATE CASCADE ON DELETE RESTRICT","valid":true},
    {"table":"site_content_versions","name":"site_content_versions_content_version_check","kind":"c","definition":"CHECK ((content_version > 0))","valid":true},
    {"table":"site_content_versions","name":"site_content_versions_pkey","kind":"p","definition":"PRIMARY KEY (id)","valid":true},
    {"table":"site_contents","name":"site_contents_pkey","kind":"p","definition":"PRIMARY KEY (id)","valid":true},
    {"table":"site_contents","name":"site_contents_revision_check","kind":"c","definition":"CHECK ((revision > 0))","valid":true},
    {"table":"tester_entitlements","name":"tester_entitlements_pkey","kind":"p","definition":"PRIMARY KEY (user_id)","valid":true},
    {"table":"tester_entitlements","name":"tester_entitlements_user_id_fkey","kind":"f","definition":"FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE","valid":true},
    {"table":"user_legal_consents","name":"user_legal_consents_kind_check","kind":"c","definition":"CHECK (((kind)::text = ANY ((ARRAY['terms'::character varying, 'privacy'::character varying])::text[])))","valid":true},
    {"table":"user_legal_consents","name":"user_legal_consents_pkey","kind":"p","definition":"PRIMARY KEY (id)","valid":true},
    {"table":"user_legal_consents","name":"user_legal_consents_user_id_fkey","kind":"f","definition":"FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT","valid":true},
    {"table":"user_legal_consents","name":"user_legal_consents_version_id_fkey","kind":"f","definition":"FOREIGN KEY (version_id) REFERENCES site_content_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT","valid":true},
  ],
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'chevoink-release-migration-'))
  const candidate = path.join(root, 'candidate'), baseline = path.join(root, 'baseline')
  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  const oldSchema = schema.replace('@@unique([reportId, source, signal, startOffset, endOffset, evidenceHash], map: "quality_findings_report_source_signal_span_key")', '@@unique([reportId, source, signal, evidenceHash])')
  for (const folder of [candidate, baseline]) {
    mkdirSync(path.join(folder, 'prisma/migrations/old'), { recursive: true })
    writeFileSync(path.join(folder, 'prisma/schema.prisma'), oldSchema)
    writeFileSync(path.join(folder, 'prisma/migrations/old/migration.sql'), 'SELECT 1;\n')
  }
  const allow = () => {
    writeFileSync(path.join(candidate, 'prisma/schema.prisma'), schema)
    mkdirSync(path.join(candidate, `prisma/migrations/${migrationName}`))
    writeFileSync(path.join(candidate, `prisma/migrations/${migrationName}/migration.sql`), readFileSync(`prisma/migrations/${migrationName}/migration.sql`))
  }
  return { candidate, baseline, allow }
}

describe('exact reviewed production migration', () => {
  const retentionFixture = () => {
    const f = fixture()
    const baseline = readFileSync(new URL('../fixtures/release-admin-experience.schema.prisma', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
    // Frozen additive delta; future application schema edits cannot broaden this approval.
    const model = `/// Durable, irreversible claim made before deleting an obsolete application artifact.
model AppReleaseRetirement {
  releaseId String @id @map("release_id") @db.VarChar(64)
  operationId String @unique @map("operation_id") @db.VarChar(36)
  artifactSha256 String @map("artifact_sha256") @db.VarChar(64)
  quarantineName String @map("quarantine_name") @db.VarChar(128)
  triggerOperationId String? @map("trigger_operation_id") @db.VarChar(100)
  state String @default("pending") @db.VarChar(24)
  errorCode String? @map("error_code") @db.VarChar(80)
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  completedAt DateTime? @map("completed_at")
  release AppRelease @relation(fields: [releaseId], references: [id], onDelete: Restrict)
  @@index([state, createdAt])
  @@map("app_release_retirements")
}
`
    const candidate = baseline.replace('  channels AppReleaseChannel[]\n', '  channels AppReleaseChannel[]\n  retirement AppReleaseRetirement?\n')
      .replace('model AppReleaseChannel {', model + 'model AppReleaseChannel {')
    writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), baseline)
    writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), candidate)
    mkdirSync(path.join(f.candidate, `prisma/migrations/${appReleaseRetentionMigrationName}`))
    writeFileSync(path.join(f.candidate, `prisma/migrations/${appReleaseRetentionMigrationName}/migration.sql`), readFileSync(`prisma/migrations/${appReleaseRetentionMigrationName}/migration.sql`))
    return f
  }
  it('permits only the exact frozen retention schema pair and single SQL', () => {
    const f = retentionFixture()
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe(appReleaseRetentionMigrationName)
  })
  it.each(['schema', 'baseline', 'history', 'sql', 'crlf-sql', 'extra', 'additional', 'missing', 'already-present'])('rejects retention %s outside its frozen approval', kind => {
    const f = retentionFixture()
    const relative = `prisma/migrations/${appReleaseRetentionMigrationName}/migration.sql`, sql = path.join(f.candidate, relative)
    if (kind === 'schema') writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'baseline') writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'history') writeFileSync(path.join(f.candidate, 'prisma/migrations/old/migration.sql'), 'SELECT 2;')
    if (kind === 'sql') writeFileSync(sql, 'SELECT 2;')
    if (kind === 'crlf-sql') writeFileSync(sql, readFileSync(sql, 'utf8').replaceAll('\n', '\r\n'))
    if (kind === 'extra') writeFileSync(path.join(f.candidate, `prisma/migrations/${appReleaseRetentionMigrationName}/extra.sql`), 'SELECT 2;')
    if (kind === 'additional') { mkdirSync(path.join(f.candidate, 'prisma/migrations/unreviewed')); writeFileSync(path.join(f.candidate, 'prisma/migrations/unreviewed/migration.sql'), 'SELECT 2;') }
    if (kind === 'missing') rmSync(sql)
    if (kind === 'already-present') { mkdirSync(path.dirname(path.join(f.baseline, relative))); writeFileSync(path.join(f.baseline, relative), readFileSync(sql)) }
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow()
  })
  const announcementFixture = () => {
    const f = retentionFixture()
    const schema = readFileSync(path.join(f.candidate, 'prisma/schema.prisma'), 'utf8')
    const retentionFile = `prisma/migrations/${appReleaseRetentionMigrationName}/migration.sql`
    mkdirSync(path.dirname(path.join(f.baseline, retentionFile)))
    writeFileSync(path.join(f.baseline, retentionFile), readFileSync(path.join(f.candidate, retentionFile)))
    writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), schema)
    const model = `model SiteAnnouncementRead {
  userId    String @map("user_id") @db.VarChar(64)
  versionId String @map("version_id") @db.VarChar(64)
  user      User @relation(fields: [userId], references: [id], onDelete: Cascade)
  version   SiteContentVersion @relation(fields: [versionId], references: [id], onDelete: Cascade)

  @@id([userId, versionId])
  @@index([versionId])
  @@map("site_announcement_reads")
}

`
    const candidate = schema
      .replace('  legalConsents UserLegalConsent[]\n', '  legalConsents UserLegalConsent[]\n  announcementReads SiteAnnouncementRead[]\n')
      .replace('  consents       UserLegalConsent[]\n', '  consents       UserLegalConsent[]\n  announcementReads SiteAnnouncementRead[]\n')
      .replace('model UserLegalConsent {', model + 'model UserLegalConsent {')
    writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), candidate)
    const relative = `prisma/migrations/${announcementReadsMigrationName}/migration.sql`
    const sql = path.join(f.candidate, relative)
    mkdirSync(path.dirname(sql))
    // Compare the exact archive bytes, independent of Windows checkout EOL.
    writeFileSync(sql, readFileSync(relative, 'utf8').replaceAll('\r\n', '\n'))
    return { ...f, sql }
  }
  it('accepts only the exact announcement-read schema pair and sole reviewed migration', () => {
    const f = announcementFixture()
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe(announcementReadsMigrationName)
    expect(readFileSync('deploy/deploy-production.sh', 'utf8')).toContain('"$MIGRATION_PLAN" == "20261108120000_site_announcement_reads"')
  })
  it.each(['baseline', 'schema', 'history', 'sql', 'additional'])('rejects announcement-read %s outside its exact approval', kind => {
    const f = announcementFixture()
    if (kind === 'baseline') writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'schema') writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'history') writeFileSync(path.join(f.candidate, 'prisma/migrations/old/migration.sql'), 'SELECT 2;')
    if (kind === 'sql') writeFileSync(f.sql, 'SELECT 2;')
    if (kind === 'additional') writeFileSync(path.join(path.dirname(f.sql), 'extra.sql'), 'SELECT 2;')
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow()
  })
  const notificationFixture = () => {
    const f = announcementFixture()
    const announcementPath = `prisma/migrations/${announcementReadsMigrationName}/migration.sql`
    mkdirSync(path.join(f.baseline, 'prisma/migrations', announcementReadsMigrationName))
    writeFileSync(path.join(f.baseline, announcementPath), readFileSync(f.sql))
    const previous = readFileSync(path.join(f.candidate, 'prisma/schema.prisma'), 'utf8')
    writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), previous)
    // This approved historical schema must remain independent of future schema changes.
    const model = `model UserNotification {
  id        String   @id @default(cuid()) @db.VarChar(64)
  userId    String   @map("user_id") @db.VarChar(64)
  title     String   @db.VarChar(160)
  body      String
  createdAt DateTime @default(now()) @map("created_at")
  readAt    DateTime? @map("read_at")
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
  @@map("user_notifications")
}

`
    const schema = previous
      .replace('  announcementReads SiteAnnouncementRead[]\n', '  announcementReads SiteAnnouncementRead[]\n  notifications     UserNotification[]\n')
      .replace('model UserLegalConsent {', model + 'model UserLegalConsent {')
    writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), schema)
    const relative = `prisma/migrations/${userNotificationsMigrationName}/migration.sql`
    mkdirSync(path.dirname(path.join(f.candidate, relative)))
    const sql = readFileSync(relative, 'utf8').replaceAll('\r\n', '\n')
    writeFileSync(path.join(f.candidate, relative), sql)
    return { ...f, announcementPath, relative, sql, schema }
  }
  it('accepts only the exact successor notification schema and additive migration', () => {
    const f = notificationFixture()
    const { announcementPath, relative, sql } = f
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe(userNotificationsMigrationName)
    expect(readFileSync('deploy/deploy-production.sh', 'utf8')).toContain('"$MIGRATION_PLAN" == "20261108140000_user_notifications"')
    writeFileSync(path.join(f.candidate, relative), sql + 'SELECT 1;')
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow()
    writeFileSync(path.join(f.candidate, relative), sql)
    writeFileSync(path.join(f.candidate, announcementPath), 'SELECT 1;')
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow()
  })
  const emailAccountFixture = () => {
    const f = notificationFixture()
    writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), f.schema)
    mkdirSync(path.dirname(path.join(f.baseline, f.relative)))
    writeFileSync(path.join(f.baseline, f.relative), f.sql)
    const verificationModel = `model EmailVerificationCode {
  id                String                     @id @db.VarChar(64)
  email             String                     @db.VarChar(255)
  purpose           EmailVerificationPurpose
  userId            String?                    @map("user_id") @db.VarChar(64)
  requesterKey      String                     @map("requester_key") @db.VarChar(64)
  codeHash          String                     @map("code_hash") @db.VarChar(64)
  expiresAt         DateTime                   @map("expires_at")
  consumedAt        DateTime?                  @map("consumed_at")
  attempts          Int                        @default(0)
  sendState         AccountVerificationSendState @default(pending) @map("send_state")
  providerRequestId String?                    @map("provider_request_id") @db.VarChar(128)
  createdAt         DateTime                   @default(now()) @map("created_at")
  user              User?                      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([email, createdAt])
  @@index([requesterKey, createdAt])
  @@index([expiresAt])
  @@index([userId])
  @@map("email_verification_codes")
}

`
    const schema = f.schema
      .replace('  admin_bind\n}', `  admin_bind
  bind_phone
  change_password
}

enum EmailVerificationPurpose {
  register
  login
  bind
  reset_password
  change_password
}

enum AccountVerificationSendState {
  pending
  accepted
  rejected
  unknown
  suppressed
}`)
      .replace('  passwordHash               String', `  emailVerifiedAt            DateTime?               @map("email_verified_at")
  phoneVerifiedAt            DateTime?               @map("phone_verified_at")
  accountSetupStep           Int?                    @map("account_setup_step")
  accountSetupSkippedSteps   Int[]                   @default([]) @map("account_setup_skipped_steps")
  accountSetupFinishedAt     DateTime?               @map("account_setup_finished_at")
  emailVerificationCodes     EmailVerificationCode[]
  passwordHash               String`)
      .replace('model SmsVerificationCode {', verificationModel + 'model SmsVerificationCode {')
      .replace('  provider   String                 @default("tencentcloud") @db.VarChar(32)\n',
        '  provider   String                 @default("tencentcloud") @db.VarChar(32)\n  sendState  AccountVerificationSendState? @map("send_state")\n')
    writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), schema)
    const relative = `prisma/migrations/${emailAccountMigrationName}/migration.sql`
    const migrationPath = path.join(f.candidate, relative)
    mkdirSync(path.dirname(migrationPath))
    writeFileSync(migrationPath, readFileSync(relative, 'utf8').replaceAll('\r\n', '\n'))
    return { ...f, migrationPath }
  }

  it('admits the exact email account schema and migration', () => {
    const f = emailAccountFixture()
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe(emailAccountMigrationName)
    const deploy = readFileSync('deploy/deploy-production.sh', 'utf8')
    expect(deploy).toContain('"$MIGRATION_PLAN" == "20261112090000_email_account_auth" && "$PUBLICATION" != api-only')
    expect(deploy.indexOf('email account migration requires API-only deployment')).toBeLessThan(deploy.indexOf('phase migrating'))
  })

  it.each(['schema', 'history', 'sql', 'extra'])('rejects email account %s outside its frozen approval', change => {
    const f = emailAccountFixture()
    if (change === 'schema') writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), '// unrelated')
    if (change === 'history') writeFileSync(path.join(f.candidate, f.relative), 'SELECT 1;')
    if (change === 'sql') writeFileSync(f.migrationPath, 'SELECT 1;')
    if (change === 'extra') writeFileSync(path.join(path.dirname(f.migrationPath), 'extra.sql'), 'SELECT 1;')
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow()
  })
  it('rejects a preexisting announcement receipt table before migration', () => {
    const before = { tables: [], columns: [], indexes: [], constraints: [], rowCount: null }
    expect(() => assertAnnouncementReadsState(before, 'before')).not.toThrow()
    expect(() => assertAnnouncementReadsState({ ...before, tables: [{ name: 'site_announcement_reads', kind: 'r' }] }, 'before')).toThrow()
    expect(() => assertAnnouncementReadsState(before, 'after', before)).toThrow()
  })
  it.each([
    [appReleaseRetentionMigrationName, appReleaseRetentionMigrationChecksum],
    [announcementReadsMigrationName, announcementReadsMigrationChecksum],
    [userNotificationsMigrationName, userNotificationsMigrationChecksum],
    [emailAccountMigrationName, emailAccountMigrationChecksum],
  ])('requires only %s pending, one exact successful row afterwards and unchanged full history', (migration, checksum) => {
    const old = { migration_name: 'old', checksum: 'a'.repeat(64), finished_at: new Date(), rolled_back_at: null, applied_steps_count: 1, historyHash: 'a'.repeat(32) }
    const target = { ...old, migration_name: migration, checksum }
    const checksums = [['old', 'b'.repeat(64)], [migration, checksum]]
    const assert = (rows: unknown[], phase: string, before?: unknown[]) => assertMigrationState(rows, checksums, phase, before, migration)
    expect(() => assert([old], 'before')).not.toThrow()
    expect(() => assert([old, target], 'after', JSON.parse(JSON.stringify([old])))).not.toThrow()
    for (const rows of [[], [old, target], [old, old], [{ ...old, finished_at: null }], [{ ...old, historyHash: undefined }]]) expect(() => assert(rows, 'before')).toThrow()
    for (const changed of [{ checksum: 'c'.repeat(64) }, { finished_at: null }, { rolled_back_at: new Date() }, { applied_steps_count: 0 }, { historyHash: undefined }])
      expect(() => assert([old, { ...target, ...changed }], 'after', [old])).toThrow()
    for (const rows of [[old], [old, target, target], [old, target, { ...old, migration_name: 'extra' }], [{ ...old, historyHash: 'b'.repeat(32) }, target]]) expect(() => assert(rows, 'after', [old])).toThrow()
    expect(() => assert([old, target], 'after', [old, target])).toThrow()
  })
  it('requires exact retention catalog, restrict FK, valid full indexes and an empty claim table before restart', async () => {
    const before = { tables: [], columns: [], indexes: [], constraints: [], rowCount: null }
    const after = { tables: [{ name: 'app_release_retirements', kind: 'r' }], columns: retentionColumns, indexes: retentionIndexes, constraints: retentionConstraints, rowCount: 0 }
    expect(() => assertAppReleaseRetentionState(before, 'before')).not.toThrow()
    expect(() => assertAppReleaseRetentionState(after, 'after', before)).not.toThrow()
    expect(() => assertAppReleaseRetentionState(after, 'before')).toThrow()
    expect(() => assertAppReleaseRetentionState(after, 'after', after)).toThrow()
    expect(() => assertAppReleaseRetentionState(before, 'invalid')).toThrow()
    for (const key of ['tables', 'columns', 'indexes', 'constraints'] as const) {
      expect(() => assertAppReleaseRetentionState({ ...after, [key]: after[key].slice(1) }, 'after', before)).toThrow()
      expect(() => assertAppReleaseRetentionState({ ...after, [key]: [...after[key], after[key][0]] }, 'after', before)).toThrow()
    }
    for (const changed of [
      { ...after, rowCount: 1 }, { ...after, tables: [{ name: 'app_release_retirements', kind: 'v' }] },
      { ...after, columns: after.columns.map(row => row.name === 'state' ? { ...row, defaultValue: "'complete'::character varying" } : row) },
      { ...after, columns: after.columns.map(row => row.name === 'trigger_operation_id' ? { ...row, required: true } : row) },
      { ...after, indexes: after.indexes.map(row => ({ ...row, valid: false })) },
      { ...after, indexes: after.indexes.map(row => ({ ...row, definition: row.definition.replace('btree', 'hash') })) },
      { ...after, constraints: after.constraints.map(row => ({ ...row, definition: row.definition.replace('DELETE RESTRICT', 'DELETE CASCADE') })) },
    ]) expect(() => assertAppReleaseRetentionState(changed, 'after', before)).toThrow()
    const statements: string[] = []
    const tx = { $queryRawUnsafe: async (sql: string) => { statements.push(sql); return [after.tables, after.columns, after.indexes, after.constraints, [{ count: 0 }]][statements.length - 1] } }
    expect(await readAppReleaseRetentionState(tx, 'after')).toEqual(after)
    expect(statements).toHaveLength(5)
    expect(statements[4]).toBe('SELECT count(*)::int AS count FROM app_release_retirements')
    for (const sql of statements) expect(sql.trim()).toMatch(/^SELECT /)
    expect(readFileSync('deploy/deploy-production.sh', 'utf8')).toContain('"$MIGRATION_PLAN" == "20261107010000_app_release_retention"')
  })

  it('accepts the PostgreSQL SELECT projection key order without weakening retention values', async () => {
    const before = { tables: [], columns: [], indexes: [], constraints: [], rowCount: null }
    // This is the actual SELECT projection order, different from the frozen
    // expectation object's insertion order: definition precedes columns.
    const indexes = retentionIndexes.map(({ name, unique, columns, definition, ...flags }) => ({ name, unique, definition, columns, ...flags }))
    const expected = { tables: [{ name: 'app_release_retirements', kind: 'r' }], columns: retentionColumns, indexes: retentionIndexes, constraints: retentionConstraints, rowCount: 0 }
    let query = 0
    const statements: string[] = []
    const tx = { $queryRawUnsafe: async (sql: string) => { statements.push(sql); return [expected.tables, expected.columns, indexes, expected.constraints, [{ count: 0 }]][query++] } }
    const actual = await readAppReleaseRetentionState(tx, 'after')
    expect(statements[2].indexOf('AS definition')).toBeLessThan(statements[2].indexOf('AS columns'))
    expect(actual).toEqual(expected)
    expect(() => assertAppReleaseRetentionState(actual, 'after', before)).not.toThrow()
    const reversedIndexColumns = { ...actual, indexes: indexes.map(row => ({ ...row, columns: [...row.columns].reverse() })) }
    expect(() => assertAppReleaseRetentionState(reversedIndexColumns, 'after', before)).toThrow(/indexes/)
    expect(() => assertAppReleaseRetentionState({ ...actual, indexes: indexes.map(row => ({ ...row, unexpected: true })) }, 'after', before)).toThrow(/indexes/)
    expect(() => assertAppReleaseRetentionState({ ...actual, rowCount: 1 }, 'after', before)).toThrow(/rowCount/)
  })

  const experienceFixture = () => {
    const f = fixture()
    writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), readFileSync(new URL('../fixtures/release-admin-model-lifecycle.schema.prisma', import.meta.url)))
    writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), readFileSync(new URL('../fixtures/release-admin-experience.schema.prisma', import.meta.url)))
    for (const [name] of adminExperienceMigrations) {
      mkdirSync(path.join(f.candidate, `prisma/migrations/${name}`))
      writeFileSync(path.join(f.candidate, `prisma/migrations/${name}/migration.sql`), readFileSync(`prisma/migrations/${name}/migration.sql`))
    }
    return f
  }
  it('permits only the frozen four-migration admin experience batch', () => {
    const f = experienceFixture()
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe(adminExperiencePlan)
  })
  it.each(['schema', 'baseline', 'history', 'sql', 'crlf-sql', 'extra', 'additional', 'missing', 'already-present'])('rejects admin experience %s outside the exact batch', kind => {
    const f = experienceFixture()
    const [name] = adminExperienceMigrations[0]
    const sql = path.join(f.candidate, `prisma/migrations/${name}/migration.sql`)
    if (kind === 'schema') writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'baseline') writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'history') writeFileSync(path.join(f.candidate, 'prisma/migrations/old/migration.sql'), 'SELECT 2;')
    if (kind === 'sql') writeFileSync(sql, 'SELECT 2;')
    if (kind === 'crlf-sql') writeFileSync(sql, readFileSync(sql, 'utf8').replaceAll('\n', '\r\n'))
    if (kind === 'extra') writeFileSync(path.join(f.candidate, `prisma/migrations/${name}/extra.sql`), 'SELECT 2;')
    if (kind === 'additional') {
      mkdirSync(path.join(f.candidate, 'prisma/migrations/unreviewed'))
      writeFileSync(path.join(f.candidate, 'prisma/migrations/unreviewed/migration.sql'), 'SELECT 2;')
    }
    if (kind === 'missing') rmSync(sql)
    if (kind === 'already-present') {
      mkdirSync(path.join(f.baseline, `prisma/migrations/${name}`))
      writeFileSync(path.join(f.baseline, `prisma/migrations/${name}/migration.sql`), readFileSync(sql))
    }
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow()
  })
  it('requires all four pending before, all four exact successful receipts after, and full historical row preservation', () => {
    const old = { migration_name: 'old', checksum: 'a'.repeat(64), finished_at: new Date(), rolled_back_at: null, applied_steps_count: 1, historyHash: 'a'.repeat(32) }
    const complete = adminExperienceMigrations.map(([migration_name, checksum]) => ({ ...old, migration_name, checksum }))
    const sums = [['old', 'b'.repeat(64)], ...adminExperienceMigrations]
    const before = [old], after = [old, ...complete]
    expect(() => assertMigrationState(before, sums, 'before', undefined, adminExperiencePlan)).not.toThrow()
    expect(() => assertMigrationState(after, sums, 'after', JSON.parse(JSON.stringify(before)), adminExperiencePlan)).not.toThrow()
    for (const rows of [[], [old, complete[0]], after, [old, old]])
      expect(() => assertMigrationState(rows, sums, 'before', undefined, adminExperiencePlan)).toThrow()
    for (let i = 0; i < complete.length; i++) {
      for (const change of [{ checksum: 'c'.repeat(64) }, { finished_at: null }, { rolled_back_at: new Date() }, { applied_steps_count: 0 }]) {
        const changed = complete.map((row, j) => j === i ? { ...row, ...change } : row)
        expect(() => assertMigrationState([old, ...changed], sums, 'after', before, adminExperiencePlan)).toThrow()
      }
      expect(() => assertMigrationState([old, ...complete.filter((_, j) => j !== i)], sums, 'after', before, adminExperiencePlan)).toThrow()
    }
    expect(() => assertMigrationState([...after, { ...old, migration_name: 'extra' }], sums, 'after', before, adminExperiencePlan)).toThrow()
    expect(() => assertMigrationState([{ ...old, historyHash: 'b'.repeat(32) }, ...complete], sums, 'after', before, adminExperiencePlan)).toThrow()
    expect(() => assertMigrationState([{ ...old, historyHash: undefined }], sums, 'before', undefined, adminExperiencePlan)).toThrow()
    expect(() => assertMigrationState(before, sums.slice(0, -1), 'before', undefined, adminExperiencePlan)).toThrow()
    expect(() => assertMigrationState(after, sums, 'after', [old, complete[0]], adminExperiencePlan)).toThrow()
  })
  it('pins all eight new table catalogs and the sequence column without inspecting dynamic rows', async () => {
    const before = { tables: [{ name: 'credit_accounts', kind: 'r' }], columns: [], indexes: [], constraints: [] }
    expect(() => assertAdminExperienceState(before, 'before')).not.toThrow()
    expect(() => assertAdminExperienceState(experienceCatalog, 'after', before)).not.toThrow()
    expect(() => assertAdminExperienceState(experienceCatalog, 'before')).toThrow()
    expect(() => assertAdminExperienceState({ ...before, tables: [] }, 'before')).toThrow()
    expect(() => assertAdminExperienceState(experienceCatalog, 'after', experienceCatalog)).toThrow()
    for (const key of ['tables', 'columns', 'indexes', 'constraints'] as const) {
      expect(() => assertAdminExperienceState({ ...experienceCatalog, [key]: experienceCatalog[key].slice(1) }, 'after', before)).toThrow()
      expect(() => assertAdminExperienceState({ ...experienceCatalog, [key]: [...experienceCatalog[key], experienceCatalog[key][0]] }, 'after', before)).toThrow()
    }
    for (const [table, name] of [['credit_accounts', 'tester_topup_sequence'], ['app_releases', 'verified_at'], ['app_releases', 'validation_state'], ['app_release_channels', 'enabled']]) {
      const columns = experienceCatalog.columns.map(row => row.table === table && row.name === name ? { ...row, required: !row.required, defaultValue: 'wrong' } : row)
      expect(() => assertAdminExperienceState({ ...experienceCatalog, columns }, 'after', before)).toThrow()
    }
    for (const key of ['indexes', 'constraints'] as const) {
      const rows = experienceCatalog[key].map(row => ({ ...row, valid: false }))
      expect(() => assertAdminExperienceState({ ...experienceCatalog, [key]: rows }, 'after', before)).toThrow()
    }
    const statements: string[] = []
    const state = await readAdminExperienceState({ $queryRawUnsafe: async (sql: string) => {
      statements.push(sql)
      return [experienceCatalog.tables, experienceCatalog.columns, experienceCatalog.indexes, experienceCatalog.constraints][statements.length - 1]
    } })
    expect(state).toEqual(experienceCatalog)
    expect(statements).toHaveLength(4)
    for (const sql of statements) {
      expect(sql.trim()).toMatch(/^SELECT /)
      expect(sql).toMatch(/FROM pg_(class|attribute|index|constraint) /)
      expect(sql).not.toMatch(/FROM "?(credit_accounts|users|site_contents|ai_model_configs)"?\s/i)
    }
    const script = readFileSync('deploy/deploy-production.sh', 'utf8')
    expect(script).toContain('"$MIGRATION_PLAN" == "20261106_admin_model_experience"')
  })

  const lifecycleFixture = () => {
    const f = fixture()
    writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), readFileSync(new URL('../fixtures/release-web-tool-billing.schema.prisma', import.meta.url)))
    writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), readFileSync(new URL('../fixtures/release-admin-model-lifecycle.schema.prisma', import.meta.url)))
    mkdirSync(path.join(f.candidate, `prisma/migrations/${adminModelLifecycleMigrationName}`))
    // Production uses Git archive bytes, independent of Windows checkout line endings.
    writeFileSync(path.join(f.candidate, `prisma/migrations/${adminModelLifecycleMigrationName}/migration.sql`), readFileSync(`prisma/migrations/${adminModelLifecycleMigrationName}/migration.sql`, 'utf8').replaceAll('\r\n', '\n'))
    return f
  }
  it('permits only the frozen lifecycle schema pair and exact SQL', () => {
    const f = lifecycleFixture()
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe(adminModelLifecycleMigrationName)
    const old = { migration_name: 'old', checksum: 'a'.repeat(64), finished_at: new Date(), rolled_back_at: null, applied_steps_count: 1 }
    const complete = { ...old, migration_name: adminModelLifecycleMigrationName, checksum: adminModelLifecycleMigrationChecksum }
    const checksums = [['old', 'b'.repeat(64)], [adminModelLifecycleMigrationName, adminModelLifecycleMigrationChecksum]]
    expect(() => assertMigrationState([old], checksums, 'before', undefined, adminModelLifecycleMigrationName)).not.toThrow()
    expect(() => assertMigrationState([old, complete], checksums, 'after', [old], adminModelLifecycleMigrationName)).not.toThrow()
    expect(() => assertMigrationState([old, { ...complete, checksum: 'c'.repeat(64) }], checksums, 'after', [old], adminModelLifecycleMigrationName)).toThrow()
  })
  it.each(['schema', 'baseline', 'history', 'sql', 'crlf-sql', 'extra', 'already-present'])('rejects lifecycle %s outside the frozen approval', kind => {
    const f = lifecycleFixture()
    if (kind === 'schema') writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'baseline') writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'history') writeFileSync(path.join(f.candidate, 'prisma/migrations/old/migration.sql'), 'SELECT 2;')
    if (kind === 'sql') writeFileSync(path.join(f.candidate, `prisma/migrations/${adminModelLifecycleMigrationName}/migration.sql`), 'SELECT 2;')
    if (kind === 'crlf-sql') {
      const sqlPath = path.join(f.candidate, `prisma/migrations/${adminModelLifecycleMigrationName}/migration.sql`)
      writeFileSync(sqlPath, readFileSync(sqlPath, 'utf8').replaceAll('\n', '\r\n'))
    }
    if (kind === 'extra') writeFileSync(path.join(f.candidate, `prisma/migrations/${adminModelLifecycleMigrationName}/extra.sql`), 'SELECT 2;')
    if (kind === 'already-present') {
      mkdirSync(path.join(f.baseline, `prisma/migrations/${adminModelLifecycleMigrationName}`))
      writeFileSync(path.join(f.baseline, `prisma/migrations/${adminModelLifecycleMigrationName}/migration.sql`), 'SELECT 1;')
    }
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow()
  })
  it('verifies lifecycle schema defaults, initial nulls, six ID bindings and protected catalog preservation', () => {
    const roles = ['basic', 'speed', 'tool:image-generation', 'tool:image-vision', 'tool:web-fetch', 'tool:web-search'].map((role, i) => ({ role, id: `config-${i}` }))
    const before = { tables: [], columns: [], roles, catalog: { count: 8, hash: 'a'.repeat(32) } }
    const after = { ...before, tables: ['admin_model_diagnostics', 'ai_model_config_versions', 'ai_model_system_bindings'], columns: lifecycleColumns, indexes: lifecycleIndexes,
      foreignKeys: ['ai_model_config_versions', 'ai_model_system_bindings'].map(table => ({ table, columns: ['model_config_id'], target: 'ai_model_configs', targetColumns: ['id'], onDelete: 'a', onUpdate: 'a', valid: true })),
      bindings: roles.map(row => ({ ...row, revision: 1, hasUpdatedAt: true })), invalid: { configs: 0, runs: 0, schedules: 0, calls: 0, diagnostics: 0, versions: 0 } }
    expect(() => assertAdminModelLifecycleState(before, 'before')).not.toThrow()
    expect(() => assertAdminModelLifecycleState(after, 'after', JSON.parse(JSON.stringify(before)))).not.toThrow()
    expect(() => assertAdminModelLifecycleState({ ...before, roles: roles.slice(1) }, 'before')).toThrow()
    expect(() => assertAdminModelLifecycleState({ ...before, tables: after.tables }, 'before')).toThrow()
    for (const changed of [
      { ...after, tables: after.tables.slice(1) }, { ...after, catalog: { ...after.catalog, hash: 'b'.repeat(32) } },
      { ...after, columns: after.columns.map(row => row.name === 'revision' ? { ...row, defaultValue: '2' } : row) },
      { ...after, columns: after.columns.map(row => row.name === 'model_config_id' ? { ...row, required: !row.required } : row) },
      { ...after, indexes: after.indexes.map(row => ({ ...row, valid: false })) },
      { ...after, foreignKeys: after.foreignKeys.map(row => ({ ...row, onDelete: 'c' })) },
      { ...after, bindings: after.bindings.map((row, i) => i === 0 ? { ...row, id: 'wrong-config' } : row) },
      { ...after, invalid: { ...after.invalid, runs: 1 } }, { ...after, invalid: { ...after.invalid, versions: 1 } },
    ]) expect(() => assertAdminModelLifecycleState(changed, 'after', before)).toThrow()
  })
  const billingFixture = () => {
    const f = fixture()
    // This approval is historical and must not follow newer application schema.
    const schema = readFileSync(new URL('../fixtures/release-web-tool-billing.schema.prisma', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
    const begin = schema.indexOf('/// Frozen fixed-price dispatch receipt.')
    const end = schema.indexOf('model ReferralCode {', begin)
    expect(begin).toBeGreaterThan(0)
    const baseline = (schema.slice(0, begin) + schema.slice(end)).replace('  webToolCalls       WebToolCall[]\n', '')
    writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), baseline)
    writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), schema)
    mkdirSync(path.join(f.candidate, `prisma/migrations/${webToolBillingMigrationName}`))
    writeFileSync(path.join(f.candidate, `prisma/migrations/${webToolBillingMigrationName}/migration.sql`), readFileSync(`prisma/migrations/${webToolBillingMigrationName}/migration.sql`))
    return f
  }
  it('permits only the frozen billing schema and exact SQL with unchanged historical files', () => {
    const f = billingFixture()
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe(webToolBillingMigrationName)
    const old = { migration_name: 'old', checksum: 'a'.repeat(64), finished_at: new Date(), rolled_back_at: null, applied_steps_count: 1 }
    const sums = [['old', 'b'.repeat(64)], [webToolBillingMigrationName, webToolBillingMigrationChecksum]]
    const completed = { ...old, migration_name: webToolBillingMigrationName, checksum: webToolBillingMigrationChecksum }
    expect(() => assertMigrationState([old], sums, 'before', undefined, webToolBillingMigrationName)).not.toThrow()
    expect(() => assertMigrationState([old, completed], sums, 'after', [old], webToolBillingMigrationName)).not.toThrow()
    expect(() => assertMigrationState([old, { ...completed, checksum: 'c'.repeat(64) }], sums, 'after', [old], webToolBillingMigrationName)).toThrow()
  })
  it('does not reuse historical billing approval for the current model-lifecycle schema', () => {
    const f = billingFixture()
    writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), readFileSync('prisma/schema.prisma'))
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow('Unapproved schema change')
  })
  it.each(['schema', 'baseline', 'history', 'sql', 'extra'])('rejects unrelated %s in billing release', kind => {
    const f = billingFixture()
    if (kind === 'schema') writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'baseline') writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'history') writeFileSync(path.join(f.candidate, 'prisma/migrations/old/migration.sql'), 'SELECT 2;')
    if (kind === 'sql') writeFileSync(path.join(f.candidate, `prisma/migrations/${webToolBillingMigrationName}/migration.sql`), 'SELECT 2;')
    if (kind === 'extra') writeFileSync(path.join(f.candidate, `prisma/migrations/${webToolBillingMigrationName}/extra.sql`), 'SELECT 2;')
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow()
  })
  it('requires two initial 1.0 prices, protected config preservation, exact audit and no unrelated catalog changes', () => {
    const before = { targets: ['tool:web-fetch', 'tool:web-search'].map(key => ({ key, multiplierBps: 20000, protectedHash: 'a'.repeat(32), updatedAt: '2026-01-01T00:00:00Z' })), others: { count: 5, hash: 'b'.repeat(32) } }
    const after = { targets: before.targets.map(row => ({ ...row, multiplierBps: 10000, updatedAt: '2026-10-20T00:00:00Z' })), others: before.others, calls: 0,
      audit: before.targets.map(row => ({ key: row.key, previousMultiplier: row.multiplierBps, previousUpdatedAt: row.updatedAt, appliedAt: '2026-10-20T00:00:00Z' })) }
    expect(() => assertWebToolBillingState(after, before)).not.toThrow()
    for (const changed of [{ ...after, others: { count: 4, hash: 'c'.repeat(32) } }, { ...after, calls: 1 }, { ...after, audit: [] },
      { ...after, targets: [{ ...after.targets[0], multiplierBps: 20000 }, after.targets[1]] },
      { ...after, targets: [{ ...after.targets[0], protectedHash: 'd'.repeat(32) }, after.targets[1]] }]) {
      expect(() => assertWebToolBillingState(changed, before)).toThrow()
    }
  })
  const fetchFixture = () => {
    const f = fixture()
    mkdirSync(path.join(f.candidate, `prisma/migrations/${fetchMigrationName}`))
    writeFileSync(path.join(f.candidate, `prisma/migrations/${fetchMigrationName}/migration.sql`), readFileSync(`prisma/migrations/${fetchMigrationName}/migration.sql`))
    return f
  }
  it('permits the exact disabled Fetch seed only with unchanged schema and history', () => {
    const f = fetchFixture()
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe(fetchMigrationName)
    const old = { migration_name: 'old', checksum: 'a'.repeat(64), finished_at: new Date(), rolled_back_at: null, applied_steps_count: 1 }
    const seeded = { ...old, migration_name: fetchMigrationName, checksum: fetchMigrationChecksum }
    const sums = [['old', 'b'.repeat(64)], [fetchMigrationName, fetchMigrationChecksum]]
    expect(() => assertMigrationState([old], sums, 'before', undefined, fetchMigrationName)).not.toThrow()
    expect(() => assertMigrationState([old, seeded], sums, 'after', [old], fetchMigrationName)).not.toThrow()
    expect(() => assertMigrationState([old, { ...seeded, checksum: 'c'.repeat(64) }], sums, 'after', [old], fetchMigrationName)).toThrow()
    expect(() => assertMigrationState([old], sums, 'after', [old], fetchMigrationName)).toThrow()
  })
  it.each(['schema', 'history', 'sql', 'extra'])('rejects unrelated %s with Fetch seed', kind => {
    const f = fetchFixture()
    if (kind === 'schema') writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'history') writeFileSync(path.join(f.candidate, 'prisma/migrations/old/migration.sql'), 'SELECT 2;')
    if (kind === 'sql') writeFileSync(path.join(f.candidate, `prisma/migrations/${fetchMigrationName}/migration.sql`), 'SELECT 2;')
    if (kind === 'extra') writeFileSync(path.join(f.candidate, `prisma/migrations/${fetchMigrationName}/extra.sql`), 'SELECT 2;')
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow()
  })
  it('requires disabled keyless insertion or exact preservation of a preexisting Fetch configuration', () => {
    const row = { id: 'tool-web-fetch', key: 'tool:web-fetch', ownerUserId: null, provider: 'unconfigured', modelName: 'unconfigured',
      baseUrl: null, apiKeyCiphertext: null, tier: 'tool_fetch', enabled: false, selectable: false, isDefault: false,
      multiplierBps: 10000, metadata: { modelKind: 'web_fetch' } }
    expect(() => assertFetchSeed(fetchSeedEvidence(row), null)).not.toThrow()
    expect(() => assertFetchSeed(null, null)).toThrow()
    for (const changed of [{ enabled: true }, { apiKeyCiphertext: 'secret' }, { ownerUserId: 'user' }, { selectable: true }]) {
      const evidence = fetchSeedEvidence({ ...row, ...changed })
      expect(() => assertFetchSeed(evidence, null)).toThrow()
      expect(JSON.stringify(evidence)).not.toContain('secret')
    }
    const existing = fetchSeedEvidence({ ...row, enabled: true, apiKeyCiphertext: 'protected-existing-key' })
    expect(() => assertFetchSeed(existing, existing)).not.toThrow()
    expect(() => assertFetchSeed(fetchSeedEvidence(row), existing)).toThrow()
  })
  it('keeps unchanged releases routine and permits only the exact index migration', () => {
    const f = fixture()
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe('routine')
    f.allow()
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe(migrationName)
  })
  it.each(['schema', 'history', 'sql', 'extra'])('rejects unapproved %s changes', kind => {
    const f = fixture(); f.allow()
    if (kind === 'schema') writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), readFileSync(path.join(f.candidate, 'prisma/schema.prisma'), 'utf8') + '\n// unrelated\n')
    if (kind === 'history') writeFileSync(path.join(f.candidate, 'prisma/migrations/old/migration.sql'), 'SELECT 2;\n')
    if (kind === 'sql') writeFileSync(path.join(f.candidate, `prisma/migrations/${migrationName}/migration.sql`), 'DELETE FROM quality_findings;')
    if (kind === 'extra') writeFileSync(path.join(f.candidate, `prisma/migrations/${migrationName}/extra.sql`), 'SELECT 2;')
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow()
  })
  const history = { migration_name: 'old', checksum: 'a'.repeat(64), finished_at: new Date(), rolled_back_at: null, applied_steps_count: 1 }
  const target = { ...history, migration_name: migrationName, checksum: migrationChecksum }
  const checksums = [['old', 'b'.repeat(64)], [migrationName, migrationChecksum]]
  it('requires exactly the target pending before and completed afterwards', () => {
    expect(() => assertMigrationState([history], checksums, 'before')).not.toThrow()
    expect(() => assertMigrationState([history, target], checksums, 'after', [history])).not.toThrow()
    for (const rows of [[], [history, target], [history, history], [{ ...history, checksum: 'changed' }], [{ ...history, finished_at: null }], [{ ...history, rolled_back_at: new Date() }], [{ ...history, applied_steps_count: undefined }]])
      expect(() => assertMigrationState(rows, checksums, 'before')).toThrow()
    expect(() => assertMigrationState([history], checksums, 'after', [history])).toThrow()
    expect(() => assertMigrationState([{ ...history, checksum: 'c'.repeat(64) }, target], checksums, 'after', [history])).toThrow()
    expect(() => assertMigrationState([history, { ...target, checksum: 'd'.repeat(64) }], checksums, 'after', [history])).toThrow()
    expect(() => assertMigrationState([history, target], checksums, 'after', JSON.parse(JSON.stringify([history])))).not.toThrow()
  })
  it('verifies real unique index columns and validity rather than migration success text', () => {
    const old = { name: 'quality_findings_report_id_source_signal_evidence_hash_key', table_name: 'quality_findings',
      is_unique: true, is_valid: true, is_ready: true, has_predicate: false, has_expression: false,
      columns: ['report_id', 'source', 'signal', 'evidence_hash'] }
    const current = { ...old, name: 'quality_findings_report_source_signal_span_key', columns: ['report_id', 'source', 'signal', 'start_offset', 'end_offset', 'evidence_hash'] }
    expect(() => assertFindingIndex([old], 'before')).not.toThrow()
    expect(() => assertFindingIndex([current], 'after')).not.toThrow()
    for (const rows of [[old], [old, current], [{ ...current, is_valid: false }], [{ ...current, has_predicate: true }], [{ ...current, columns: old.columns }]])
      expect(() => assertFindingIndex(rows, 'after')).toThrow()
  })
  it('pins inherited CLI environment and actual database to the shared production file without exposing its URL', () => {
    const shared = { APP_ENV: 'production', DATABASE_URL: 'postgresql://user:secret@db.example/chevoink?schema=public' }
    expect(assertMigrationEnvironment(shared, shared)).toEqual({ database: 'chevoink', schema: 'public' })
    for (const environment of [{ ...shared, DATABASE_URL: 'postgresql://user:secret@other/chevoink' },
      { ...shared, APP_ENV: 'test' }, { APP_ENV: 'production' }]) expect(() => assertMigrationEnvironment(environment, shared)).toThrow()
    expect(() => assertDatabaseIdentity({ database: 'other', schema: 'public' }, { database: 'chevoink', schema: 'public' })).toThrow()
    expect(() => assertDatabaseIdentity({ database: 'chevoink', schema: 'other' }, { database: 'chevoink', schema: 'public' })).toThrow()
    expect(() => assertDatabaseIdentity({ database: 'chevoink', schema: 'public' }, { database: 'chevoink', schema: 'public' })).not.toThrow()
  })
  it('runs one migration after the build and verification but before stopping the live process', () => {
    const script = readFileSync('deploy/deploy-production.sh', 'utf8')
    const migrate = script.indexOf('npx prisma migrate deploy')
    expect(script.match(/npx prisma migrate deploy/g)).toHaveLength(1)
    expect(script.indexOf('npm run build:client')).toBeLessThan(migrate)
    expect(script.indexOf('verify-release-migration.mjs before')).toBeLessThan(migrate)
    expect(script.indexOf('verify-release-migration.mjs after')).toBeGreaterThan(migrate)
    expect(script.indexOf('pm2 stop 0')).toBeGreaterThan(migrate)
    expect(script).toContain('node scripts/production-process-snapshot.mjs')
    expect(script).not.toContain('pm2 jlist')
  })
})
