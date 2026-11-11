import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'dotenv'

import { assertTestDatabaseTarget } from './database-target.js'

/** Explicit process/CI settings win over the local test file; development .env is never read. */
export function resolveTestEnvironment(inherited: NodeJS.ProcessEnv, fromFile: Record<string, string>, filePath: string): NodeJS.ProcessEnv {
  const candidate: NodeJS.ProcessEnv = { ...fromFile }
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) candidate[key] = value
  }
  candidate.APP_ENV ??= 'test'
  if (candidate.APP_ENV !== 'test') throw new Error('[test-guard] APP_ENV must be test.')
  candidate.DATABASE_URL ??= 'postgresql://127.0.0.1:5432/chevoink_test'
  assertTestDatabaseTarget(candidate.DATABASE_URL, candidate.TEST_DATABASE_ALLOWED_HOSTS)
  for (const key of ['DIRECT_URL', 'SHADOW_DATABASE_URL']) {
    if (candidate[key]) assertTestDatabaseTarget(candidate[key], candidate.TEST_DATABASE_ALLOWED_HOSTS)
  }
  candidate.AUTH_SESSION_SECRET ??= 'chevoink-test-session-secret-placeholder'
  // Prisma's generated module can hydrate otherwise-unset variables from .env.
  // Keep local development provider secrets out of ordinary hermetic tests.
  for (const key of [
    'AI_TEXT_API_KEY', 'AI_IMAGE_API_KEY', 'AI_VISION_API_KEY', 'WEB_SEARCH_BOCHA_API_KEY',
    'FIRECRAWL_API_KEY', 'JINA_READER_API_KEY', 'SMS_TENCENT_SECRET_ID',
    'SMS_TENCENT_SECRET_KEY', 'EMAIL_TENCENT_SECRET_ID', 'EMAIL_TENCENT_SECRET_KEY', 'MODEL_CONFIG_ENCRYPTION_KEY',
  ]) candidate[key] ??= ''
  candidate.DOTENV_PATH = filePath
  return candidate
}

export function loadTestEnvironment(): URL {
  const filePath = resolve(process.cwd(), 'tests/.env.test')
  const fromFile = existsSync(filePath) ? parse(readFileSync(filePath)) : {}
  const resolved = resolveTestEnvironment(process.env, fromFile, filePath)
  Object.assign(process.env, resolved)
  return assertTestDatabaseTarget(resolved.DATABASE_URL!, resolved.TEST_DATABASE_ALLOWED_HOSTS)
}
